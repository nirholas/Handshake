// @ts-check
// Provenance for a changelog entry: which commits actually produced it.
//
// The holder channel carries two feeds that describe the same work and have
// never known about each other (api/_lib/changelog-push.js posts the sentence,
// api/_lib/commit-feed-push.js posts the code). This module is the join: it
// reads recent commits once per process window and hands each release note the
// count and sha range of the work behind it, so the announcement can point at
// the diff instead of leaving a reader to guess which of that afternoon's
// thirty commits it meant.
//
// Every part of it is best-effort by design. A release announcement must go out
// even when GitHub is rate-limited, so every failure here resolves to null and
// the caller posts the message it would have posted anyway.

import { linkCommits, entryKey, fetchGitHubCommits } from '../../packages/shipfeed/src/index.js';
import { fetchUpstream } from './upstream-fetch.js';

const REPO = 'nirholas/three.ws';
const COMMIT_LIMIT = 300;
const CACHE_TTL_MS = 5 * 60_000;

/** Process-local cache: one GitHub read serves every entry in a cron tick. */
let cache = { at: 0, commits: null };

const boundedFetch = (url, init) =>
	fetchUpstream(url, init, {
		name: 'github-commits',
		timeoutMs: 12_000,
		attempts: 2,
		okWhen: () => true,
	});

/**
 * Recent commits on main, or null when GitHub cannot be read right now.
 * @param {{now?: number}} [options]
 */
export async function recentCommits(options = {}) {
	const now = options.now ?? Date.now();
	if (cache.commits && now - cache.at < CACHE_TTL_MS) return cache.commits;
	try {
		const commits = await fetchGitHubCommits({
			repo: REPO,
			branch: 'main',
			limit: COMMIT_LIMIT,
			token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
			fetchImpl: boundedFetch,
			userAgent: 'three.ws-shipfeed',
		});
		cache = { at: now, commits };
		return commits;
	} catch (err) {
		console.warn(`[ship-provenance] commit read failed: ${err?.message || err}`);
		return null;
	}
}

/**
 * Map each entry key to the work behind it.
 *
 * @param {{date: string, title: string, summary?: string, tags?: string[], link?: string}[]} entries
 * @param {{commits?: object[]|null}} [options] injected commits (tests, callers that already read them)
 * @returns {Promise<Map<string, {count: number, range: string, compareUrl: string}>>}
 *   empty when commits are unavailable, so callers need no special case
 */
export async function provenanceByEntry(entries, options = {}) {
	const out = new Map();
	if (!Array.isArray(entries) || entries.length === 0) return out;

	// `commits` present but null means "the caller already tried and failed";
	// absent means "read them yourself". Coalescing the two would send a test,
	// or a caller handling its own outage, back out to the network.
	const commits = 'commits' in options ? options.commits : await recentCommits();
	if (!commits || commits.length === 0) return out;

	const { byEntry } = linkCommits(entries, commits);
	for (const entry of entries) {
		const bucket = byEntry.get(entryKey(entry));
		if (!bucket || bucket.commits.length === 0) continue;
		const first = bucket.commits[0];
		const last = bucket.commits[bucket.commits.length - 1];
		const range = `${first.shortSha}..${last.shortSha}`;
		out.set(entryKey(entry), {
			count: bucket.commits.length,
			range,
			// A one-commit range has nothing to compare against, so link the commit.
			compareUrl:
				bucket.commits.length === 1
					? `https://github.com/${REPO}/commit/${first.sha}`
					: `https://github.com/${REPO}/compare/${first.sha}...${last.sha}`,
		});
	}
	return out;
}

/** Reset the process cache. Tests use this; production never needs it. */
export function resetProvenanceCache() {
	cache = { at: 0, commits: null };
}
