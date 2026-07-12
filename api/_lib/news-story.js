// Resolve one news article by its canonical (month, id16) address — the
// lookup behind the story pages (/markets/news/<YYYY-MM>/<id>) and their
// sitemap. Live-feed cache first for recent months (richer record: image,
// author, feed-provided full text), then the archive month file, which covers
// the full corpus back to September 2017 with a single GCS fetch.

import { findArticle } from './news.js';
import { loadMonth } from './news-archive-store.js';

const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/;
const ID_RE = /^[a-f0-9]{16}$/;

export function validStoryKey(month, id) {
	return MONTH_RE.test(String(month || '')) && ID_RE.test(String(id || ''));
}

function recentMonths() {
	// Previous, current AND next month: publishers have shipped future-dated
	// stories (the aggregator now clamps those, but already-minted links carry
	// the bogus month), so a next-month URL must still reach the live lookup.
	const now = new Date();
	const cur = now.toISOString().slice(0, 7);
	const shift = (n) => {
		const d = new Date(now);
		d.setUTCDate(1);
		d.setUTCMonth(d.getUTCMonth() + n);
		return d.toISOString().slice(0, 7);
	};
	return [cur, shift(-1), shift(1)];
}

function adjacentMonths(month) {
	const d = new Date(`${month}-01T00:00:00Z`);
	const shift = (n) => {
		const c = new Date(d);
		c.setUTCMonth(c.getUTCMonth() + n);
		return c.toISOString().slice(0, 7);
	};
	return [shift(-1), shift(1)];
}

/**
 * @returns {Promise<{article: object, origin: 'live'|'archive'} | null>}
 * The live record wins for recent months (it carries image/author and, for
 * some publishers, the feed's full body); everything older comes from the
 * archive month file. Ids are content-addressed (sha of the publisher link),
 * so a hit is always the right story — but its month can drift by one when a
 * publisher revises pub_date across a boundary or a link was minted from a
 * differently-parsed date. The adjacent-month fallback recovers those; the
 * story-page handler 301s to the canonical path when the months differ.
 */
export async function resolveStory(month, id) {
	if (!validStoryKey(month, id)) return null;

	if (recentMonths().includes(month)) {
		const live = await findArticle({ id }).catch(() => null);
		if (live) return { article: live, origin: 'live' };
	}

	const records = await loadMonth(month).catch(() => null);
	const archived = records?.find((a) => a.id === id) || null;
	if (archived) return { article: archived, origin: 'archive' };

	for (const near of adjacentMonths(month)) {
		const nearRecords = await loadMonth(near).catch(() => null);
		const hit = nearRecords?.find((a) => a.id === id) || null;
		if (hit) return { article: hit, origin: 'archive' };
	}
	return null;
}
