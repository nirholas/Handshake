#!/usr/bin/env node
// Post a single one-off tweet (or reply) from the @trythreews X account.
//
// scripts/changelog-x.mjs handles the chained release thread; this script is
// for standalone announcements that aren't a changelog entry (community
// channel launches, milestones, partnerships).
//
// Env (reads .env.local -> .env -> environment) — same OAuth 1.0a user
// context as changelog-x.mjs, from a developer.x.com app with Read+Write
// access to @trythreews:
//   X_API_KEY            app consumer key
//   X_API_SECRET         app consumer secret
//   X_ACCESS_TOKEN       user access token for @trythreews
//   X_ACCESS_SECRET      user access token secret for @trythreews
//
// Usage:
//   node scripts/post-tweet.mjs --text "..."
//   node scripts/post-tweet.mjs --file path/to/tweet.txt
//   node scripts/post-tweet.mjs --text "..." --reply-to 1234567890
//   node scripts/post-tweet.mjs --text "..." --dry-run

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

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
	if (a) return a.split('=').slice(1).join('=');
	const i = args.indexOf(`--${name}`);
	return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const dryRun = flag('dry-run');
const filePath = opt('file');
const replyTo = opt('reply-to');
let text = opt('text');

if (!text && filePath) text = readFileSync(resolve(process.cwd(), filePath), 'utf8').trim();
if (!text) {
	console.error('Usage: node scripts/post-tweet.mjs --text "..." [--reply-to <tweetId>] [--dry-run]');
	console.error('   or: node scripts/post-tweet.mjs --file path/to/tweet.txt');
	process.exit(1);
}

// X counts every URL as 23 chars (t.co wrapping) and each emoji/astral
// codepoint as 2.
const URL_WEIGHT = 23;
const weightedLength = (s) =>
	[...s.replace(/https?:\/\/\S+/g, 'x'.repeat(URL_WEIGHT))].reduce(
		(n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1),
		0,
	);

const weight = weightedLength(text);
if (weight > 280) {
	console.error(`Tweet is ${weight} weighted chars, over the 280 limit. Trim it.`);
	process.exit(1);
}

console.log(`--- tweet (${weight} weighted chars)${replyTo ? `, reply to ${replyTo}` : ''}${dryRun ? ' — DRY RUN' : ''} ---`);
console.log(text);

if (dryRun) process.exit(0);

const creds = {
	appKey: process.env.X_API_KEY,
	appSecret: process.env.X_API_SECRET,
	accessToken: process.env.X_ACCESS_TOKEN,
	accessSecret: process.env.X_ACCESS_SECRET,
};
if (!(creds.appKey && creds.appSecret && creds.accessToken && creds.accessSecret)) {
	console.error('\nX_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET must be set (see .env.example). Use --dry-run to preview without credentials.');
	process.exit(1);
}

const { TwitterApi } = await import('twitter-api-v2');
const client = new TwitterApi(creds);

try {
	const payload = replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : undefined;
	const { data } = await client.v2.tweet(text, payload);
	console.log(`\nposted  https://x.com/trythreews/status/${data.id}`);
} catch (err) {
	console.error(`\nFAILED: ${err.message}`);
	process.exit(1);
}
