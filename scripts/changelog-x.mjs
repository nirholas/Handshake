#!/usr/bin/env node
// Push new changelog entries to the @trythreews X (Twitter) account as one
// continuous thread.
//
// Instead of bloating the profile feed with a standalone tweet per release,
// the account keeps a single anchor post ("everything we ship lands in this
// thread") and every changelog entry is posted as a reply chained to the
// previous entry. The profile shows one post; followers who open it see the
// full running release history. Pin the anchor for maximum effect.
//
// Reads the generated feed (public/changelog.json — run `npm run build:pages`
// first if it's stale), diffs it against data/changelog-x-state.json, and
// posts each unposted entry as the next reply in the chain via twitter-api-v2.
// The state file records posted entries AND the thread ids (anchor + last
// reply) — commit it so the chain continues correctly across machines and
// agents.
//
// Env (reads .env.local → .env → environment) — OAuth 1.0a user context for
// the @trythreews account, from a developer.x.com app with Read+Write access:
//   X_API_KEY            app consumer key
//   X_API_SECRET         app consumer secret
//   X_ACCESS_TOKEN       user access token for @trythreews
//   X_ACCESS_SECRET      user access token secret for @trythreews
//
// Usage:
//   node scripts/changelog-x.mjs                    # chain unposted entries from the last 2 days
//   node scripts/changelog-x.mjs --since=2026-06-01
//   node scripts/changelog-x.mjs --all              # every unposted entry (full backfill)
//   node scripts/changelog-x.mjs --dry-run          # print the would-be chain, send nothing
//   node scripts/changelog-x.mjs --limit=3          # cap posts per run (default 5)
//   node scripts/changelog-x.mjs --anchor=1234567   # adopt an existing tweet as the thread anchor
//   node scripts/changelog-x.mjs --standalone       # one-off: post unchained (big announcements)
//
// First real (non-dry) run with no recorded thread posts the anchor tweet
// automatically, then chains entries under it. The anchor counts against the
// same rate budget as one entry.
//
// The X free API tier allows ~17 posts per 24h per user — keep --limit small
// and run the backfill over several days.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const feedFile = resolve(root, 'public/changelog.json');
const stateFile = resolve(root, 'data/changelog-x-state.json');

const ANCHOR_TEXT = [
	'everything we ship at three.ws lands in this thread. one reply per release, straight from the changelog.',
	'',
	'full log: https://three.ws/changelog',
].join('\n');

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
const standalone = flag('standalone');
const includeLaunches = flag('include-launches');
const since = opt('since');
const limit = Number(opt('limit') || 5);
const anchorOverride = opt('anchor');

const creds = {
	appKey: process.env.X_API_KEY,
	appSecret: process.env.X_API_SECRET,
	accessToken: process.env.X_ACCESS_TOKEN,
	accessSecret: process.env.X_ACCESS_SECRET,
};
if (!dryRun && !(creds.appKey && creds.appSecret && creds.accessToken && creds.accessSecret)) {
	console.error('X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET must be set (see .env.example). Use --dry-run to preview without credentials.');
	process.exit(1);
}

let feed;
try {
	feed = JSON.parse(readFileSync(feedFile, 'utf8'));
} catch {
	console.error(`Missing or unreadable ${feedFile} — run \`npm run build:pages\` first.`);
	process.exit(1);
}

let state = { posted: [], thread: null };
try {
	state = { thread: null, ...JSON.parse(readFileSync(stateFile, 'utf8')) };
} catch {
	// First run — state file gets created below.
}
const posted = new Set(state.posted);
// thread = { anchor: '<tweet id of the pinned anchor post>', last: '<tweet id the next entry replies to>' }
let thread = state.thread;

if (anchorOverride) {
	if (thread && thread.anchor !== anchorOverride) {
		console.log(`Rebasing thread: anchor ${thread.anchor} → ${anchorOverride} (new entries chain under the new anchor).`);
	}
	thread = { anchor: anchorOverride, last: anchorOverride, ...(thread && thread.anchor === anchorOverride ? thread : {}) };
}

const saveState = () => {
	writeFileSync(stateFile, JSON.stringify({ posted: [...posted], thread }, null, '\t') + '\n');
};

const entryKey = (e) => `${e.date}:${e.title}`;

const defaultSince = (() => {
	const d = new Date(Date.now() - 2 * 86400000);
	return d.toISOString().slice(0, 10);
})();
const cutoff = pushAll ? '0000-00-00' : (since || defaultSince);

const pending = feed.entries
	.filter((e) => !posted.has(entryKey(e)) && e.date >= cutoff && (includeLaunches || e.type !== 'launch'))
	.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
	.slice(0, limit);

if (pending.length === 0) {
	if (anchorOverride && !dryRun) saveState();
	console.log(`Nothing new to post (cutoff ${cutoff}, ${posted.size} already posted).`);
	process.exit(0);
}

function slugify(title, date) {
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
	return date + '-' + slug;
}

// X counts every URL as 23 chars (t.co wrapping) and each emoji/astral
// codepoint as 2. Compose title + summary + link within the 280 budget,
// trimming the summary on a word boundary when it overflows.
const URL_WEIGHT = 23;
const weightedLength = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1), 0);

function formatTweet(e) {
	const detailUrl = `https://three.ws/changelog/${slugify(e.title, e.date)}`;
	const suffix = `\n\n${detailUrl}`;
	const suffixWeight = 2 + URL_WEIGHT;
	const budget = 280 - suffixWeight;

	let body = `${e.title}\n\n${e.summary}`;
	if (weightedLength(body) > budget) {
		// Keep the full title; trim the summary to fit, ellipsis included.
		const titlePart = `${e.title}\n\n`;
		const summaryBudget = budget - weightedLength(titlePart) - 1; // 1 for the ellipsis
		let summary = e.summary;
		while (weightedLength(summary) > summaryBudget && summary.includes(' ')) {
			summary = summary.slice(0, summary.lastIndexOf(' '));
		}
		if (weightedLength(summary) > summaryBudget) summary = summary.slice(0, summaryBudget);
		body = `${titlePart}${summary.replace(/[\s,.;:]+$/, '')}…`;
	}
	return `${body}${suffix}`;
}

async function postTweet(client, text, replyToId) {
	const payload = replyToId ? { reply: { in_reply_to_tweet_id: replyToId } } : undefined;
	const { data } = await client.v2.tweet(text, payload);
	return data.id;
}

console.log(`${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} to post (cutoff ${cutoff})${dryRun ? ' — DRY RUN' : ''}${standalone ? ' — STANDALONE (unchained)' : ''}:`);

let client = null;
if (!dryRun) {
	const { TwitterApi } = await import('twitter-api-v2');
	client = new TwitterApi(creds);
}

// Space posts out — the free tier caps user writes at ~17/24h and
// burst-posting reads as bot spam to followers anyway.
const PACE_MS = 10000;

if (!standalone && !thread) {
	if (dryRun) {
		console.log(`\n--- thread anchor (would be posted first, then pinned by the owner) ---\n${ANCHOR_TEXT}`);
	} else {
		try {
			const id = await postTweet(client, ANCHOR_TEXT);
			thread = { anchor: id, last: id };
			saveState();
			console.log(`anchor  https://x.com/trythreews/status/${id} — pin this post on the profile.`);
			await new Promise((r) => setTimeout(r, PACE_MS));
		} catch (err) {
			console.error(`FAILED to post the thread anchor: ${err.message}`);
			process.exit(1);
		}
	}
}

let sent = 0;
let dryPrev = thread ? thread.last : '<anchor>';
for (const e of pending) {
	const text = formatTweet(e);
	if (dryRun) {
		const chainNote = standalone ? 'standalone' : `reply to ${dryPrev}`;
		console.log(`\n--- ${entryKey(e)} (${weightedLength(text.replace(/https:\/\/\S+/g, 'x'.repeat(URL_WEIGHT)))} weighted chars, ${chainNote}) ---\n${text}`);
		dryPrev = `<${entryKey(e)}>`;
		continue;
	}
	try {
		const replyTo = standalone ? null : thread.last;
		const id = await postTweet(client, text, replyTo);
		posted.add(entryKey(e));
		if (!standalone) thread = { ...thread, last: id };
		sent++;
		// Persist after every post so a hard kill mid-run can't double-post
		// or fork the chain on the next run.
		saveState();
		console.log(`posted  ${entryKey(e)} → https://x.com/trythreews/status/${id}${standalone ? '' : ` (in thread ${thread.anchor})`}`);
		await new Promise((r) => setTimeout(r, PACE_MS));
	} catch (err) {
		saveState();
		console.error(`FAILED ${entryKey(e)}: ${err.message}`);
		console.error(`${sent} posted before the failure; state saved. Re-run to resume the chain.`);
		process.exit(1);
	}
}

if (!dryRun) {
	saveState();
	console.log(`\nDone — ${sent} posted, state saved to data/changelog-x-state.json (commit it).`);
	if (thread) console.log(`Thread anchor: https://x.com/trythreews/status/${thread.anchor}`);
}
