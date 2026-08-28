// Burst grouping: commits land in clusters, and a cluster is what a human
// would call "a ship". Anything that is not claimed by a changelog entry still
// deserves to be readable, so it gets grouped by time gap and headlined by its
// own strongest commit rather than dumped as a flat list.

import { parseCommit, headline, summaryLine } from './parse.js';
import { classify } from './classify.js';

const MINUTE_MS = 60_000;

/**
 * Cluster commits into ships. A new ship starts whenever more than `gapMinutes`
 * of quiet separates two consecutive commits.
 *
 * @param {object[]} commits raw or parsed commits, any order
 * @param {{gapMinutes?: number, options?: object}} [opts]
 * @returns {{id: string, start: string, end: string, title: string, summary: string,
 *   authors: string[], commits: object[], signal: number}[]} newest ship first
 */
export function groupIntoShips(commits, opts = {}) {
	const gap = (opts.gapMinutes ?? 90) * MINUTE_MS;
	const parsed = commits
		.map((c) => (c.subject !== undefined ? c : parseCommit(c)))
		.filter((c) => c.sha)
		.sort((a, b) => String(a.committedAt).localeCompare(String(b.committedAt)));

	const ships = [];
	let current = null;
	for (const commit of parsed) {
		const t = Date.parse(commit.committedAt || commit.authoredAt || '');
		if (!current || !Number.isFinite(t) || t - current.lastAt > gap) {
			current = { commits: [commit], lastAt: Number.isFinite(t) ? t : 0 };
			ships.push(current);
		} else {
			current.commits.push(commit);
			current.lastAt = t;
		}
	}

	return ships
		.map((ship) => {
			const scored = ship.commits.map((c) => ({ commit: c, cls: classify(c, opts.options) }));
			const lead = scored.reduce((best, x) => (x.cls.signal > best.cls.signal ? x : best), scored[0]);
			const authors = [...new Set(ship.commits.map((c) => c.author.login || c.author.name))];
			const start = ship.commits[0].committedAt;
			const end = ship.commits[ship.commits.length - 1].committedAt;
			return {
				id: `${ship.commits[0].shortSha}..${ship.commits[ship.commits.length - 1].shortSha}`,
				start,
				end,
				title: headline(lead.commit),
				summary: summaryLine(lead.commit),
				authors,
				signal: lead.cls.signal,
				commits: ship.commits,
			};
		})
		.reverse();
}
