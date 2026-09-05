// One searchable read model over every ready-made asset library three.ws
// publishes: the CC0 object/prop library, the ready-made character library, and
// the motion-clip library. Each of those already has a browse page and a REST
// endpoint of its own, but nothing joined them, so an agent could not ask "what
// does three.ws already have that I can drop in?" without knowing which of three
// manifests to read and how each one names its fields.
//
// The manifests live on R2 and are read here directly (same keys the
// /api/objects/library, /api/avatars/library and /api/animations/library
// handlers use) rather than over HTTP against our own origin: a self-call would
// add a round trip, a TLS handshake, and a second failure mode for data we can
// read from storage in one hop.
//
// Every item is normalized to ONE shape so a caller filters, ranks, and renders
// all three kinds with the same code:
//
//   { id, kind, name, title, categories[], tags[], license, url, thumb, bytes, ... }
//
// `id` is `<kind>:<name>` and is the stable handle every consumer quotes back.

import { getObjectBuffer } from './r2.js';

// Each source: the R2 manifest key, the array field inside it, and the kind the
// rows become. The generated animation catalog is a separate object that may not
// exist yet, exactly as api/animations/library.js treats it.
const SOURCES = [
	{ kind: 'object', key: 'objects/library/manifest.json', field: 'objects' },
	{ kind: 'character', key: 'avatars/library/manifest.json', field: 'avatars' },
	{ kind: 'animation', key: 'animations/library/manifest.json', field: 'clips' },
	{ kind: 'animation', key: 'animations/library/generated/manifest.json', field: 'clips' },
];

export const KINDS = ['object', 'character', 'animation'];

// Manifests change only when a publish job runs, so a short process-local TTL
// removes almost every storage read while keeping a fresh publish visible within
// minutes. Concurrent misses share one load (INFLIGHT) instead of each firing
// four R2 GETs.
const TTL_MS = 5 * 60 * 1000;
let CACHE = null;
let INFLIGHT = null;

function asArray(parsed, field) {
	if (Array.isArray(parsed)) return parsed;
	if (parsed && Array.isArray(parsed[field])) return parsed[field];
	return [];
}

async function readManifest({ key, field }) {
	try {
		const buf = await getObjectBuffer(key);
		const parsed = JSON.parse(buf.toString('utf8'));
		return { rows: asArray(parsed, field), generatedAt: parsed?.generated_at || null };
	} catch (err) {
		// A manifest that was never published is the expected steady state for the
		// generated catalog, so it degrades to empty. Anything else is logged and
		// also degrades: a catalog missing one kind is far more useful to the
		// caller than a hard failure that hides the other two.
		const code = err?.$metadata?.httpStatusCode;
		if (err?.name !== 'NoSuchKey' && code !== 404) {
			console.error('[asset-catalog]', key, err?.message || err);
		}
		return { rows: [], generatedAt: null };
	}
}

function cleanList(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) {
		const s = String(entry ?? '').trim();
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

// The object manifest folds provenance into `categories` as "collection: x".
// That is browse metadata, not a category a caller would ever filter on, so it
// is lifted out to `collection` and dropped from the facet list.
function splitCategories(raw) {
	const categories = [];
	let collection = null;
	for (const entry of cleanList(raw)) {
		const m = /^collection:\s*(.+)$/i.exec(entry);
		if (m) {
			if (!collection) collection = m[1].trim();
			continue;
		}
		categories.push(entry);
	}
	return { categories, collection };
}

function normalize(row, kind) {
	const name = String(row?.name ?? '').trim();
	if (!name) return null;
	const title = String(row?.label || row?.name || '').trim() || name;
	const { categories, collection } = splitCategories(row?.categories);
	const base = {
		id: `${kind}:${name}`,
		kind,
		name,
		title,
		categories,
		tags: cleanList(row?.tags),
		license: String(row?.license || '').trim() || null,
		url: typeof row?.url === 'string' ? row.url : null,
		thumb: typeof row?.thumb === 'string' ? row.thumb : null,
		bytes: Number.isFinite(row?.bytes) ? row.bytes : null,
	};
	if (collection) base.collection = collection;

	if (kind === 'animation') {
		base.format = 'three-animation-clip-json';
		base.duration_seconds = Number.isFinite(row?.duration) ? row.duration : null;
		base.loop = row?.loop !== false;
		if (row?.icon) base.icon = row.icon;
	} else {
		base.format = 'glb';
		if (kind === 'character') {
			base.rigged = true;
			base.skins = Number.isFinite(row?.skins) ? row.skins : null;
			base.baked_animations = Number.isFinite(row?.animations) ? row.animations : null;
			base.source = row?.source || null;
		}
	}
	return base;
}

/**
 * Load and normalize every library, deduped by id (a curated clip wins over a
 * generated one of the same name, matching /api/animations/library) and sorted
 * by kind then title so paging is stable across calls.
 *
 * @returns {Promise<{ items: object[], generated_at: object, counts: object }>}
 */
async function loadCatalog() {
	const results = await Promise.all(SOURCES.map((s) => readManifest(s)));
	const byId = new Map();
	const generatedAt = {};
	for (let i = 0; i < SOURCES.length; i++) {
		const { kind } = SOURCES[i];
		const { rows, generatedAt: at } = results[i];
		if (at && !generatedAt[kind]) generatedAt[kind] = at;
		for (const row of rows) {
			const item = normalize(row, kind);
			if (item && !byId.has(item.id)) byId.set(item.id, item);
		}
	}
	const items = [...byId.values()].sort(
		(a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title),
	);
	const counts = {};
	for (const kind of KINDS) counts[kind] = items.filter((i) => i.kind === kind).length;
	return { items, generated_at: generatedAt, counts, total: items.length };
}

/** The cached catalog, refreshed at most once per TTL. Concurrent misses share one load. */
export async function getCatalog({ force = false } = {}) {
	const fresh = CACHE && !force && Date.now() - CACHE.at < TTL_MS;
	if (fresh) return CACHE.value;
	if (INFLIGHT) return INFLIGHT;
	INFLIGHT = loadCatalog()
		.then((value) => {
			CACHE = { at: Date.now(), value };
			return value;
		})
		.finally(() => {
			INFLIGHT = null;
		});
	return INFLIGHT;
}

/** Drop the memo. Used by tests to re-read a changed manifest without waiting out the TTL. */
export function resetCatalogCache() {
	CACHE = null;
	INFLIGHT = null;
}

function tokenize(query) {
	return String(query || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}

// Weighted term match. A title hit ranks above a tag hit, which ranks above a
// category hit, and a whole-word match ranks above a substring one, so "wrench"
// puts "Adjustable Wrench" above a chair tagged "wrenched metal". Every term
// must land somewhere or the item is not a result at all (AND across terms),
// which keeps a two-word query from returning everything that matches either.
function scoreItem(item, terms, { requireAll = true } = {}) {
	if (!terms.length) return 1;
	const title = item.title.toLowerCase();
	const name = item.name.toLowerCase();
	const tags = item.tags.map((t) => t.toLowerCase());
	const cats = item.categories.map((c) => c.toLowerCase());
	let total = 0;
	let matched = 0;
	for (const term of terms) {
		let best = 0;
		if (title === term) best = 10;
		else if (title.split(/\s+/).includes(term)) best = 8;
		else if (title.includes(term)) best = 6;
		if (best < 5 && (name === term || name.split(/[-_]/).includes(term))) best = 5;
		if (best < 4 && tags.includes(term)) best = 4;
		if (best < 3 && tags.some((t) => t.includes(term))) best = 3;
		if (best < 2 && cats.some((c) => c.includes(term))) best = 2;
		if (best < 1 && name.includes(term)) best = 1;
		if (!best && requireAll) return 0;
		if (best) matched++;
		total += best;
	}
	// Under OR, an item matching more of the terms still outranks one matching
	// fewer, so "office lamp" puts a lamp tagged office above a bare lamp.
	return requireAll ? total : matched ? total + matched * 4 : 0;
}

/**
 * Search the joined catalog.
 *
 * @param {object} opts
 * @param {string} [opts.q]        Free text over title, name, tags, categories.
 * @param {string} [opts.kind]     One of KINDS.
 * @param {string} [opts.category] Exact (case-insensitive) category match.
 * @param {string} [opts.tag]      Exact (case-insensitive) tag match.
 * @param {number} [opts.limit]    Page size (default 12).
 * @param {number} [opts.offset]   Page offset (default 0).
 * @returns {Promise<{ items, total, matched, relaxed, offset, next_offset, facets, generated_at }>}
 */
export async function searchCatalog({ q, kind, category, tag, limit = 12, offset = 0 } = {}) {
	const catalog = await getCatalog();
	const terms = tokenize(q);
	const wantKind = kind ? String(kind).toLowerCase() : null;
	const wantCategory = category ? String(category).toLowerCase() : null;
	const wantTag = tag ? String(tag).toLowerCase() : null;

	const candidates = catalog.items.filter((item) => {
		if (wantKind && item.kind !== wantKind) return false;
		if (wantCategory && !item.categories.some((c) => c.toLowerCase() === wantCategory)) return false;
		if (wantTag && !item.tags.some((t) => t.toLowerCase() === wantTag)) return false;
		return true;
	});

	const rank = (requireAll) => {
		const out = [];
		for (const item of candidates) {
			const score = scoreItem(item, terms, { requireAll });
			if (score) out.push({ item, score });
		}
		// Ties break on title so two calls with the same query return the same
		// order, which is what makes offset paging safe.
		out.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
		return out;
	};

	// Every term must land (AND), because that is what makes a two-word query
	// precise. But a caller who types "office lamp" against a library that tags
	// neither word together deserves the lamps, not an empty page, so a query
	// that finds nothing under AND is retried under OR and the response says so.
	let scored = rank(true);
	let relaxed = false;
	if (!scored.length && terms.length > 1) {
		scored = rank(false);
		relaxed = scored.length > 0;
	}

	const start = Math.max(0, offset);
	const page = scored.slice(start, start + Math.max(1, limit)).map((s) => s.item);
	return {
		items: page,
		matched: scored.length,
		relaxed,
		total: catalog.total,
		offset: start,
		next_offset: start + page.length < scored.length ? start + page.length : null,
		facets: facetsFor(scored.map((s) => s.item)),
		generated_at: catalog.generated_at,
	};
}

/** Kind counts plus the most common categories and tags across a result set. */
function facetsFor(items) {
	const kinds = {};
	const categories = new Map();
	const tags = new Map();
	for (const item of items) {
		kinds[item.kind] = (kinds[item.kind] || 0) + 1;
		for (const c of item.categories) categories.set(c, (categories.get(c) || 0) + 1);
		for (const t of item.tags) tags.set(t, (tags.get(t) || 0) + 1);
	}
	const top = (map, n) =>
		[...map.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
			.map(([value, count]) => ({ value, count }));
	return { kinds, categories: top(categories, 12), tags: top(tags, 12) };
}

/** One item by `<kind>:<name>` id, or null. A bare name is accepted and resolved across kinds. */
export async function getCatalogItem(id) {
	const catalog = await getCatalog();
	const raw = String(id || '').trim();
	if (!raw) return null;
	const exact = catalog.items.find((i) => i.id === raw);
	if (exact) return exact;
	return catalog.items.find((i) => i.name === raw) || null;
}

/**
 * Up to `limit` other items of the same kind that share the most tags and
 * categories with `item`. Used to answer "what else goes with this?" without a
 * second search round trip.
 */
export async function relatedItems(item, limit = 6) {
	if (!item) return [];
	const catalog = await getCatalog();
	const tags = new Set(item.tags.map((t) => t.toLowerCase()));
	const cats = new Set(item.categories.map((c) => c.toLowerCase()));
	const scored = [];
	for (const other of catalog.items) {
		if (other.id === item.id || other.kind !== item.kind) continue;
		let score = 0;
		for (const t of other.tags) if (tags.has(t.toLowerCase())) score += 2;
		for (const c of other.categories) if (cats.has(c.toLowerCase())) score += 1;
		if (score) scored.push({ other, score });
	}
	scored.sort((a, b) => b.score - a.score || a.other.title.localeCompare(b.other.title));
	return scored.slice(0, limit).map((s) => s.other);
}
