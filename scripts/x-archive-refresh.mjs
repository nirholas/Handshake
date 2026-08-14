#!/usr/bin/env node
/**
 * Refresh archived X posts with exact metrics from the X API v2.
 *
 * The timeline scraper is the only way to recover posts we never recorded, but
 * its counters are what the page happened to render: like counts arrive late,
 * so a scroll-based scrape captures real posts at "0 likes", and every count
 * past 999 is abbreviated to two significant figures. GET /2/tweets returns
 * public_metrics exactly, for up to 100 ids per call, so one pass over the
 * archive replaces every rounded or missing number with a measured one.
 *
 * Usage:
 *   node scripts/x-archive-refresh.mjs                     # every post in the archive
 *   node scripts/x-archive-refresh.mjs --handle trythreews
 *   node scripts/x-archive-refresh.mjs --suspect-only      # only posts with unbelievable counters
 *   node scripts/x-archive-refresh.mjs --limit 100         # cap the API spend on a first run
 *
 * Output: data/x-archive/<handle>-api-<YYYY-MM-DD>.json, in the same shape as a
 * scrape file, so `npm run x:archive:import` and `npm run x:archive:analyze`
 * read it with no special casing and the newer measurement wins.
 *
 * Requires X_API_BEARER (same credential scripts/refresh-tweet-metrics.mjs uses).
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ARCHIVE_DIR, isMetricsSuspect, listArchiveFiles, mergeScrapes, readScrapeFile } from './x-archive-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch {
		// Absent env files are normal outside a configured checkout.
	}
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : null;
};

const ONLY_HANDLE = value('handle');
const SUSPECT_ONLY = flag('suspect-only');
const LIMIT = Number(value('limit') || 0) || Infinity;

async function fetchBatch(ids, bearer) {
	const url = new URL('https://api.x.com/2/tweets');
	url.searchParams.set('ids', ids.join(','));
	url.searchParams.set('tweet.fields', 'public_metrics,created_at,text,entities,referenced_tweets');
	url.searchParams.set('expansions', 'author_id');
	url.searchParams.set('user.fields', 'username');

	const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
	if (res.status === 429) {
		const reset = Number(res.headers.get('x-rate-limit-reset') || 0) * 1000;
		const waitMs = Math.max(5_000, reset - Date.now() + 1_000);
		console.warn(`rate limited; waiting ${Math.round(waitMs / 1000)}s`);
		await new Promise((r) => setTimeout(r, waitMs));
		return fetchBatch(ids, bearer);
	}
	if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 400)}`);
	return res.json();
}

async function main() {
	const bearer = process.env.X_API_BEARER;
	if (!bearer) {
		console.error('X_API_BEARER is not set. Add it to .env / .env.local, or read it off the Cloud Run service.');
		process.exitCode = 3;
		return;
	}

	const files = await listArchiveFiles(path.resolve(REPO_ROOT, ARCHIVE_DIR));
	if (!files.length) throw new Error(`no scrape files in ${ARCHIVE_DIR}`);

	const byHandle = new Map();
	for (const file of files) {
		const scrape = await readScrapeFile(file);
		if (ONLY_HANDLE && scrape.handle !== ONLY_HANDLE.replace(/^@/, '')) continue;
		if (!byHandle.has(scrape.handle)) byHandle.set(scrape.handle, []);
		byHandle.get(scrape.handle).push(scrape);
	}

	for (const [handle, scrapes] of byHandle) {
		const { posts } = mergeScrapes(scrapes);
		const targets = posts
			.filter((p) => !SUSPECT_ONLY || isMetricsSuspect(p) || !p.viewsExact)
			.slice(0, LIMIT);
		if (!targets.length) {
			console.log(`@${handle}: nothing to refresh`);
			continue;
		}

		const byId = new Map(targets.map((p) => [p.tweetId, p]));
		const refreshed = [];
		const missing = [];
		const now = new Date().toISOString();

		for (let i = 0; i < targets.length; i += 100) {
			const batch = targets.slice(i, i + 100).map((p) => p.tweetId);
			const body = await fetchBatch(batch, bearer);
			const users = new Map((body.includes?.users || []).map((u) => [u.id, u.username]));
			for (const t of body.data || []) {
				const prior = byId.get(t.id);
				const m = t.public_metrics || {};
				refreshed.push({
					id: t.id,
					url: `https://x.com/${users.get(t.author_id) || prior?.authorHandle || handle}/status/${t.id}`,
					text: t.text ?? prior?.text ?? '',
					timestamp: t.created_at || prior?.postedAt,
					metrics: {
						likes: String(m.like_count ?? ''),
						retweets: String((m.retweet_count ?? 0) + (m.quote_count ?? 0)),
						replies: String(m.reply_count ?? ''),
						views: String(m.impression_count ?? ''),
					},
					media: {
						hasImage: prior?.hasImage || false,
						hasVideo: prior?.hasVideo || false,
						hasCard: prior?.hasCard || false,
					},
					type: {
						isRetweet: (t.referenced_tweets || []).some((r) => r.type === 'retweeted'),
						isReply: (t.referenced_tweets || []).some((r) => r.type === 'replied_to') || prior?.isReply || false,
						isPinned: prior?.isPinned || false,
					},
					extracted: {
						hashtags: (t.entities?.hashtags || []).map((h) => `#${h.tag}`),
						mentions: (t.entities?.mentions || []).map((u) => `@${u.username}`),
						urls: (t.entities?.urls || []).map((u) => u.expanded_url).filter(Boolean),
					},
					scrapedAt: now,
				});
			}
			for (const err of body.errors || []) if (err.resource_id) missing.push(err.resource_id);
			console.log(`  batch ${i / 100 + 1}: ${body.data?.length || 0} refreshed, ${body.errors?.length || 0} unavailable`);
		}

		const out = {
			profile: handle,
			profileUrl: `https://x.com/${handle}`,
			scrapedAt: now,
			source: 'x-api-v2',
			totalTweets: refreshed.length,
			unavailable: missing,
			tweets: refreshed,
		};
		const outPath = path.resolve(REPO_ROOT, ARCHIVE_DIR, `${handle}-api-${now.slice(0, 10)}.json`);
		await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
		console.log(`@${handle}: ${refreshed.length} posts refreshed, ${missing.length} unavailable -> ${path.relative(REPO_ROOT, outPath)}`);
		console.log('Next: npm run x:archive:import && npm run x:archive:analyze');
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exitCode = 1;
});
