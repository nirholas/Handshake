// The unified stream: curated release notes with the code that produced them
// underneath, and everything the notes never mentioned grouped beside them.
//
// This is the whole point of the package. A changelog alone hides the work; a
// commit log alone buries it. One structure holds both, and every commit in it
// knows whether it is spoken for.

import { parseCommit, headline, summaryLine } from './parse.js';
import { classify, AUDIENCE_RANK } from './classify.js';
import { linkCommits, entryKey, entrySlug } from './link.js';
import { groupIntoShips } from './group.js';

export const FEED_VERSION = 1;

function serializeCommit(commit, cls, provenance) {
	return {
		sha: commit.sha,
		shortSha: commit.shortSha,
		url: commit.url,
		date: commit.committedAt,
		author: commit.author.login || commit.author.name,
		type: commit.type,
		scope: commit.scope,
		breaking: commit.breaking,
		headline: headline(commit),
		summary: summaryLine(commit),
		audience: cls.audience,
		signal: cls.signal,
		issues: commit.issues,
		...(provenance ? { confidence: provenance.score, why: provenance.reasons } : {}),
	};
}

/**
 * Build the unified ship feed.
 *
 * @param {{
 *   commits: object[],
 *   entries?: object[],
 *   repo?: string,
 *   siteUrl?: string,
 *   now?: number,
 *   minAudience?: 'holder'|'developer'|'internal',
 *   link?: object,
 *   classify?: object,
 *   velocityDays?: number
 * }} input
 */
export function buildShipFeed(input) {
	const {
		commits: rawCommits = [],
		entries = [],
		repo = '',
		siteUrl = '',
		now = Date.now(),
		minAudience = 'internal',
		velocityDays = 30,
	} = input;

	const commits = rawCommits.map((c) => (c.subject !== undefined ? c : parseCommit(c)));
	const classifications = new Map(commits.map((c) => [c.sha, classify(c, input.classify)]));
	const floor = AUDIENCE_RANK[minAudience] || 1;
	const visible = commits.filter(
		(c) => AUDIENCE_RANK[classifications.get(c.sha).audience] >= floor,
	);

	const { byEntry, byCommit, orphans } = linkCommits(entries, visible, input.link);

	// A changelog can hold years of entries while a feed window holds days. Keep
	// only the entries the commits could possibly speak to, plus one window of
	// slack on each side, so an entry that legitimately found no code still
	// shows up (which is itself worth seeing) and 2,000 historical ones do not.
	const windowDays = input.link?.windowDays ?? 4;
	const times = commits
		.map((c) => Date.parse(c.committedAt || c.authoredAt || ''))
		.filter((t) => Number.isFinite(t));
	const oldest = times.length ? Math.min(...times) - windowDays * 86_400_000 : -Infinity;
	const newest = times.length ? Math.max(...times) + windowDays * 86_400_000 : Infinity;
	const inWindow = entries.filter((entry) => {
		const t = Date.parse(`${entry.date}T12:00:00Z`);
		return !Number.isFinite(t) || (t >= oldest && t <= newest);
	});

	const releases = inWindow
		.map((entry) => {
			const bucket = byEntry.get(entryKey(entry));
			const linked = bucket ? bucket.commits : [];
			const authors = [...new Set(linked.map((c) => c.author.login || c.author.name))];
			return {
				key: entryKey(entry),
				slug: entrySlug(entry),
				date: entry.date,
				title: entry.title,
				summary: entry.summary || '',
				tags: Array.isArray(entry.tags) ? entry.tags : [],
				link: entry.link || null,
				url: siteUrl ? `${siteUrl}/changelog/${entrySlug(entry)}` : null,
				commits: linked.map((c) =>
					serializeCommit(c, classifications.get(c.sha), byCommit.get(c.sha)),
				),
				stats: {
					commits: linked.length,
					authors: authors.length,
					range: linked.length
						? `${linked[0].shortSha}..${linked[linked.length - 1].shortSha}`
						: null,
				},
			};
		})
		.sort((a, b) => String(b.date).localeCompare(String(a.date)));

	const ships = groupIntoShips(orphans, { options: input.classify }).map((ship) => ({
		...ship,
		commits: ship.commits.map((c) => serializeCommit(c, classifications.get(c.sha))),
	}));

	const byType = {};
	const byAuthor = {};
	const byAudience = { holder: 0, developer: 0, internal: 0 };
	const velocity = new Map();
	const since = now - velocityDays * 86_400_000;
	for (const c of commits) {
		const cls = classifications.get(c.sha);
		byType[c.type || 'other'] = (byType[c.type || 'other'] || 0) + 1;
		const who = c.author.login || c.author.name;
		byAuthor[who] = (byAuthor[who] || 0) + 1;
		byAudience[cls.audience]++;
		const t = Date.parse(c.committedAt || '');
		if (Number.isFinite(t) && t >= since) {
			const day = new Date(t).toISOString().slice(0, 10);
			velocity.set(day, (velocity.get(day) || 0) + 1);
		}
	}

	return {
		version: FEED_VERSION,
		generatedAt: new Date(now).toISOString(),
		repo,
		siteUrl: siteUrl || null,
		releases,
		ships,
		stats: {
			commits: commits.length,
			hidden: commits.length - visible.length,
			releases: releases.length,
			entriesConsidered: entries.length,
			linked: byCommit.size,
			orphans: orphans.length,
			coverage: visible.length ? Number((byCommit.size / visible.length).toFixed(3)) : 0,
			byType,
			byAudience,
			topAuthors: Object.entries(byAuthor)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10)
				.map(([name, count]) => ({ name, count })),
			velocity: [...velocity.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([date, count]) => ({ date, count })),
		},
	};
}
