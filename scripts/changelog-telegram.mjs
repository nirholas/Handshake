#!/usr/bin/env node
// Push new changelog entries to the three.ws community Telegram channel.
//
// NOTE: routine delivery is AUTOMATIC now: /api/cron/changelog-push (Cloud
// Scheduler) posts new entries after every deploy, with its own DB state.
// This script's file state is separate, so a manual push here can double-post
// what the cron also sees. Use it for --dry-run previews and owner-directed
// backfills only (see api/_lib/changelog-push.js).
//
// Reads the generated feed (public/changelog.json — run `npm run build:pages`
// first if it's stale), diffs it against data/changelog-telegram-state.json,
// and posts each unposted entry to Telegram via the Bot API. Successfully
// posted entries are recorded in the state file — commit it so pushes stay
// idempotent across machines and agents.
//
// Env (reads .env.local → .env → environment):
//   TELEGRAM_BOT_TOKEN              bot token from @BotFather (already used by
//                                   /api/pump/deliver-telegram)
//   TELEGRAM_CHANGELOG_CHAT_ID      channel id (@handle or -100… numeric). The
//                                   bot must be an admin of the channel.
//
// Usage:
//   node scripts/changelog-telegram.mjs                 # push unposted entries from the last 2 days
//   node scripts/changelog-telegram.mjs --since=2026-06-01
//   node scripts/changelog-telegram.mjs --all           # push every unposted entry (full backfill)
//   node scripts/changelog-telegram.mjs --dry-run       # print what would be sent, send nothing
//   node scripts/changelog-telegram.mjs --limit=5       # cap messages per run
//   node scripts/changelog-telegram.mjs --seed-before=2026-07-14
//                                       # mark every entry dated before 2026-07-14 as
//                                       # posted WITHOUT sending — use once to retire a
//                                       # backlog so only new entries ever go out

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const feedFile = resolve(root, 'public/changelog.json');
const stateFile = resolve(root, 'data/changelog-telegram-state.json');

function loadEnvFile(path) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch {
		return;
	}
	for (const line of raw.split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
		if (!m) continue;
		const [, k, v] = m;
		if (process.env[k]) continue;
		process.env[k] = v.replace(/^["']|["']$/g, '');
	}
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.env'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
	const a = args.find((x) => x.startsWith(`--${name}=`));
	return a ? a.split('=')[1] : null;
};

const dryRun = flag('dry-run');
const pushAll = flag('all');
const includeLaunches = flag('include-launches');
const since = opt('since');
const limit = Number(opt('limit') || 10);

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHANGELOG_CHAT_ID;
if (!dryRun && !opt('seed-before') && (!botToken || !chatId)) {
	console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHANGELOG_CHAT_ID must be set (see .env.example). Use --dry-run to preview without credentials.');
	process.exit(1);
}

let feed;
try {
	feed = JSON.parse(readFileSync(feedFile, 'utf8'));
} catch {
	console.error(`Missing or unreadable ${feedFile} — run \`npm run build:pages\` first.`);
	process.exit(1);
}

let state = { posted: [] };
try {
	state = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch {
	// First run — state file gets created below.
}
const posted = new Set(state.posted);

const entryKey = (e) => `${e.date}:${e.title}`;

const seedBefore = opt('seed-before');
if (seedBefore) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(seedBefore)) {
		console.error('--seed-before expects a YYYY-MM-DD date.');
		process.exit(1);
	}
	let seeded = 0;
	for (const e of feed.entries) {
		if (e.date < seedBefore && !posted.has(entryKey(e))) {
			posted.add(entryKey(e));
			seeded++;
		}
	}
	writeFileSync(stateFile, JSON.stringify({ posted: [...posted] }, null, '\t') + '\n');
	console.log(`Seeded ${seeded} entr${seeded === 1 ? 'y' : 'ies'} dated before ${seedBefore} as posted (nothing sent). State saved — commit data/changelog-telegram-state.json.`);
	process.exit(0);
}

const defaultSince = (() => {
	const d = new Date(Date.now() - 2 * 86400000);
	return d.toISOString().slice(0, 10);
})();
const cutoff = pushAll ? '0000-00-00' : (since || defaultSince);

const unposted = feed.entries
	.filter((e) => !posted.has(entryKey(e)) && e.date >= cutoff && (includeLaunches || e.type !== 'launch'))
	.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
// Keep the NEWEST entries when over the limit (posted in chronological order).
// Taking the oldest here made every capped run drain the backlog and never
// reach current updates.
const pending = unposted.slice(-limit);
if (unposted.length > pending.length) {
	console.log(`Backlog: ${unposted.length - pending.length} older unposted entr${unposted.length - pending.length === 1 ? 'y' : 'ies'} skipped by --limit=${limit} (newest win). Use --limit or --since to include them, or seed them into the state file.`);
}

if (pending.length === 0) {
	console.log(`Nothing new to post (cutoff ${cutoff}, ${posted.size} already posted).`);
	process.exit(0);
}

const escapeHtml = (s) =>
	String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

function slugify(title, date) {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
	return date + '-' + slug;
}

function formatMessage(e) {
	const detailUrl = `https://three.ws/changelog/${slugify(e.title, e.date)}`;
	const label = e.type === 'launch' ? 'New on three.ws' : 'Update';
	const hashtags = (e.type === 'launch' ? ['launch'] : e.tags).map((t) => `#${t}`).join(' ');
	return [
		`<b>${escapeHtml(label)} — ${escapeHtml(e.title)}</b>`,
		'',
		escapeHtml(e.summary),
		'',
		`<a href="${detailUrl}">${escapeHtml(detailUrl.replace('https://', ''))}</a> · ${escapeHtml(e.date)} · ${escapeHtml(hashtags)}`,
	].join('\n');
}

async function sendMessage(text) {
	const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
			link_preview_options: { is_disabled: false, prefer_small_media: true },
		}),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.ok) {
		throw new Error(`Telegram sendMessage failed (${res.status}): ${body.description || 'unknown error'}`);
	}
}

console.log(`${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} to post (cutoff ${cutoff})${dryRun ? ' — DRY RUN' : ''}:`);

let sent = 0;
for (const e of pending) {
	const msg = formatMessage(e);
	if (dryRun) {
		console.log(`\n--- ${entryKey(e)} ---\n${msg}`);
		continue;
	}
	try {
		await sendMessage(msg);
		posted.add(entryKey(e));
		sent++;
		console.log(`posted  ${entryKey(e)}`);
		// Bot API allows ~20 messages/minute per chat — stay well under it.
		await new Promise((r) => setTimeout(r, 3500));
	} catch (err) {
		// Persist what made it out so a retry doesn't double-post.
		writeFileSync(stateFile, JSON.stringify({ posted: [...posted] }, null, '\t') + '\n');
		console.error(`FAILED ${entryKey(e)}: ${err.message}`);
		console.error(`${sent} posted before the failure; state saved. Re-run to resume.`);
		process.exit(1);
	}
}

if (!dryRun) {
	writeFileSync(stateFile, JSON.stringify({ posted: [...posted] }, null, '\t') + '\n');
	console.log(`\nDone — ${sent} posted, state saved to data/changelog-telegram-state.json (commit it).`);
}
