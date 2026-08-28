// Provenance without metadata: work out which commits produced which changelog
// entry, on a repo where nobody remembered to write that down.
//
// The honest way to link a release note to its code is a trailer in the commit
// (`Changelog: <slug>`), and this module always prefers one when it is there.
// Almost no repository has them, so the fallback has to earn its answer:
//
//   1. a time window, because an entry is written the day its work lands;
//   2. IDF-weighted term overlap, so shared rare words ("meshopt", "settle",
//      "fingerspelling") count and shared common ones ("agent", "the", "fix")
//      do not;
//   3. agreement between the entry's tags and the commit's conventional type;
//   4. the entry's `link` path, which usually names the surface that changed.
//
// Every link carries its score and the reasons behind it, so a wrong link is
// visible and arguable rather than mysterious. Pure and synchronous.

import { parseCommit } from './parse.js';

const STOPWORDS = new Set(
	('a an and are as at be been but by for from has have how in into is it its of on or that the ' +
		'their then there these they this to was were what when which who will with you your now not ' +
		'can could should would we our us also more most other some such only own same than too very ' +
		'just add adds added update updates updated make makes made use uses used new')
		.split(' ')
		.filter(Boolean),
);

const DAY_MS = 86_400_000;

/** Lowercase word tokens, minus stopwords and single characters. */
export function tokenize(text) {
	return String(text || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Slug used by three.ws changelog permalinks, and by `Changelog:` trailers. */
export function entrySlug(entry) {
	const slug = String(entry?.title || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
	return `${entry?.date || ''}-${slug}`;
}

export const entryKey = (entry) => `${entry?.date || ''}:${entry?.title || ''}`;

/**
 * Inverse document frequency over a token corpus. Rare terms carry the signal;
 * without this step every commit "matches" every entry through words like
 * "agent" that appear in half the repository.
 */
export function buildIdf(documents) {
	const df = new Map();
	for (const tokens of documents) {
		for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
	}
	const n = Math.max(1, documents.length);
	const idf = new Map();
	for (const [term, count] of df) idf.set(term, Math.log((n + 1) / (count + 0.5)));
	return idf;
}

// Similarity between an entry and a commit, in IDF-weighted term mass.
//
// Two normalizations, because either one alone is wrong. Against the entry's
// mass, a commit that explains only part of a long release note scores low,
// which is right for ranking but punishes the normal case: a release note is a
// paragraph and a commit is a sentence. Against the smaller of the two (the
// overlap coefficient), a short commit whose few meaningful words all appear in
// the entry scores high, which is right for containment but too eager on its
// own. The blend keeps both signals and neither dominates.
function weightedOverlap(entryTokens, commitTokens, idf) {
	const weight = (term) => idf.get(term) ?? Math.log(2);
	const commitSet = new Set(commitTokens);
	const entrySet = new Set(entryTokens);
	let shared = 0;
	let entryMass = 0;
	let commitMass = 0;
	const matched = [];
	for (const term of entrySet) {
		entryMass += weight(term);
		if (commitSet.has(term)) {
			shared += weight(term);
			matched.push(term);
		}
	}
	for (const term of commitSet) commitMass += weight(term);
	if (entryMass === 0 || commitMass === 0) return { score: 0, matched };

	const coverage = shared / entryMass;
	const containment = shared / Math.min(entryMass, commitMass);
	matched.sort((a, b) => weight(b) - weight(a));
	return { score: 0.6 * coverage + 0.4 * containment, matched: matched.slice(0, 6) };
}

const TAG_TYPES = {
	feature: ['feat'],
	improvement: ['perf', 'refactor', 'feat'],
	fix: ['fix', 'revert'],
	security: ['security', 'fix'],
	docs: ['docs'],
	sdk: ['feat', 'build'],
	infra: ['build', 'ci', 'chore', 'perf'],
};

function commitText(commit) {
	const firstParagraph = String(commit.body || '').split('\n\n')[0] || '';
	return `${commit.subject} ${commit.scope || ''} ${firstParagraph}`;
}

function entryText(entry) {
	const linkWords = String(entry.link || '').replace(/[/-]/g, ' ');
	return `${entry.title} ${entry.summary || ''} ${linkWords}`;
}

/**
 * Link changelog entries to the commits that produced them.
 *
 * @param {{date: string, title: string, summary?: string, tags?: string[], link?: string}[]} entries
 * @param {object[]} commits raw GitHub commits or parseCommit() records
 * @param {{windowDays?: number, threshold?: number, maxPerEntry?: number, leadDays?: number}} [options]
 * @returns {{
 *   byEntry: Map<string, {entry: object, commits: object[]}>,
 *   byCommit: Map<string, {entryKey: string, score: number, reasons: string[]}>,
 *   orphans: object[]
 * }}
 */
export function linkCommits(entries, commits, options = {}) {
	const windowDays = options.windowDays ?? 4;
	const leadDays = options.leadDays ?? 1;
	const threshold = options.threshold ?? 0.26;
	const maxPerEntry = options.maxPerEntry ?? 40;

	const parsed = commits.map((c) => (c.subject !== undefined ? c : parseCommit(c)));
	const commitTokens = new Map(parsed.map((c) => [c.sha, tokenize(commitText(c))]));
	const entryTokens = new Map(entries.map((e) => [entryKey(e), tokenize(entryText(e))]));
	const idf = buildIdf([...commitTokens.values(), ...entryTokens.values()]);

	const slugIndex = new Map();
	for (const e of entries) {
		slugIndex.set(entrySlug(e), e);
		slugIndex.set(String(e.title || '').toLowerCase(), e);
	}

	const byEntry = new Map(entries.map((e) => [entryKey(e), { entry: e, commits: [] }]));
	const byCommit = new Map();

	for (const commit of parsed) {
		const when = Date.parse(commit.committedAt || commit.authoredAt || '');
		let best = null;

		const declared = commit.trailers?.changelog;
		if (declared) {
			const target =
				slugIndex.get(String(declared).toLowerCase()) ||
				slugIndex.get(
					String(declared)
						.toLowerCase()
						.replace(/^\/?changelog\//, ''),
				);
			if (target) {
				best = {
					entryKey: entryKey(target),
					score: 1,
					reasons: [`declared by trailer "Changelog: ${declared}"`],
				};
			}
		}

		if (!best && Number.isFinite(when)) {
			for (const entry of entries) {
				const entryDay = Date.parse(`${entry.date}T23:59:59Z`);
				if (!Number.isFinite(entryDay)) continue;
				const ageDays = (entryDay - when) / DAY_MS;
				if (ageDays < -leadDays || ageDays > windowDays) continue;

				const key = entryKey(entry);
				const { score: overlap, matched } = weightedOverlap(
					entryTokens.get(key) || [],
					commitTokens.get(commit.sha) || [],
					idf,
				);
				const reasons = [];
				let score = overlap;
				if (overlap > 0) reasons.push(`shared terms: ${matched.join(', ')}`);

				const tags = Array.isArray(entry.tags) ? entry.tags : [];
				if (commit.type && tags.some((t) => (TAG_TYPES[t] || []).includes(commit.type))) {
					score += 0.08;
					reasons.push(`type "${commit.type}" matches tag`);
				}

				// Same-day work is far likelier to be the work being described.
				const proximity = Math.max(0, 1 - Math.abs(ageDays) / (windowDays + leadDays));
				score += proximity * 0.1;
				reasons.push(`${ageDays < 0 ? 'after' : 'before'} the entry by ${Math.abs(ageDays).toFixed(1)}d`);

				if (!best || score > best.score) best = { entryKey: key, score, reasons };
			}
		}

		if (best && best.score >= threshold) {
			best.score = Number(best.score.toFixed(3));
			byCommit.set(commit.sha, best);
			byEntry.get(best.entryKey)?.commits.push(commit);
		}
	}

	for (const bucket of byEntry.values()) {
		bucket.commits.sort(
			(a, b) => (byCommit.get(b.sha)?.score || 0) - (byCommit.get(a.sha)?.score || 0),
		);
		if (bucket.commits.length > maxPerEntry) {
			for (const dropped of bucket.commits.slice(maxPerEntry)) byCommit.delete(dropped.sha);
			bucket.commits = bucket.commits.slice(0, maxPerEntry);
		}
		bucket.commits.sort((a, b) =>
			String(a.committedAt).localeCompare(String(b.committedAt)),
		);
	}

	const orphans = parsed.filter((c) => !byCommit.has(c.sha));
	return { byEntry, byCommit, orphans };
}
