#!/usr/bin/env node
// Push new changelog entries to the @trythreews X (Twitter) account.
//
// Reads the generated feed (public/changelog.json — run `npm run build:pages`
// first if it's stale), diffs it against data/changelog-x-state.json, and
// posts each unposted entry as a tweet via twitter-api-v2. Successfully
// posted entries are recorded in the state file — commit it so pushes stay
// idempotent across machines and agents.
//
// Env (reads .env.local → .env → environment) — OAuth 1.0a user context for
// the @trythreews account, from a developer.x.com app with Read+Write access:
//   X_API_KEY            app consumer key
//   X_API_SECRET         app consumer secret
//   X_ACCESS_TOKEN       user access token for @trythreews
//   X_ACCESS_SECRET      user access token secret for @trythreews
//
// Usage:
//   node scripts/changelog-x.mjs                 # push unposted entries from the last 2 days
//   node scripts/changelog-x.mjs --since=2026-06-01
//   node scripts/changelog-x.mjs --all           # push every unposted entry (full backfill)
//   node scripts/changelog-x.mjs --dry-run       # print what would be tweeted, send nothing
//   node scripts/changelog-x.mjs --limit=3       # cap tweets per run (default 5)
//
// The X free API tier allows ~17 posts per 24h per user — keep --limit small
// and run the backfill over several days, or post a single digest instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const feedFile = resolve(root, 'public/changelog.json');
const stateFile = resolve(root, 'data/changelog-x-state.json');

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
const limit = Number(opt('limit') || 5);

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

let state = { posted: [] };
try {
	state = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch {
	// First run — state file gets created below.
}
const posted = new Set(state.posted);

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

async function postTweet(client, text) {
	const { data } = await client.v2.tweet(text);
	return data.id;
}

console.log(`${pending.length} entr${pending.length === 1 ? 'y' : 'ies'} to post (cutoff ${cutoff})${dryRun ? ' — DRY RUN' : ''}:`);

let client = null;
if (!dryRun) {
	const { TwitterApi } = await import('twitter-api-v2');
	client = new TwitterApi(creds);
}

let sent = 0;
for (const e of pending) {
	const text = formatTweet(e);
	if (dryRun) {
		console.log(`\n--- ${entryKey(e)} (${weightedLength(text.replace(/https:\/\/\S+/g, 'x'.repeat(URL_WEIGHT)))} weighted chars) ---\n${text}`);
		continue;
	}
	try {
		const id = await postTweet(client, text);
		posted.add(entryKey(e));
		sent++;
		console.log(`posted  ${entryKey(e)} → https://x.com/trythreews/status/${id}`);
		// Space posts out — the free tier caps user writes at ~17/24h and
		// burst-posting reads as bot spam to followers anyway.
		await new Promise((r) => setTimeout(r, 10000));
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
	console.log(`\nDone — ${sent} posted, state saved to data/changelog-x-state.json (commit it).`);
}
