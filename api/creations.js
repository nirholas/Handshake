// Creations: the creator-gallery + remix-economy backend.
//
// This is the discovery/remix surface layered ON TOP OF the existing Loom
// gallery (api/loom.js): Loom remains the single source of truth for "a creation
// is a forged GLB + prompt + attribution", and this endpoint enriches that feed
// with the things a *creator-facing* product needs and Loom deliberately omits:
//
//   · gallery metadata:        title, tags, license, type/style, creator binding
//   · remix lineage:           parent to child edges, ancestry + descendants
//   · creator aggregates:      per-creator creation count, remixes earned, follows
//   · discovery ranking:       trending (most-remixed) assets, top creators
//   · signed-ready provenance: an append-only per-creation trail (origin + remix)
//
// It never forks Loom: it imports Loom's storage + validators directly so a
// publish writes one canonical record to the same feed every other surface
// reads, then attaches the overlay metadata keyed by that record's id. The Loom
// HTTP/MCP contract is unchanged.
//
// ── Storage (Upstash Redis when configured, in-process maps otherwise) ─────────
//   cre:meta:<id>            : gallery overlay JSON for a creation
//   cre:children:<parentId>  : list of child creation ids (remix lineage)
//   cre:prov:<id>            : append-only provenance entries for a creation
//   cre:creator:<key>        : creator aggregate record
//   cre:followers:<key>      : set (list) of follower ids
//   cre:remixfeed            : capped list of recent remix events (for trending window)
// In dev / tests without Redis the same operations run against module-level maps
// so the endpoint is fully functional offline, mirroring api/loom.js exactly.

import { randomUUID } from 'node:crypto';
import { cors, json, error, readJson, wrap, method, setRateLimitHeaders } from './_lib/http.js';
import { getRedis } from './_lib/redis.js';
import { clientIp } from './_lib/rate-limit.js';
import {
	writeCreation,
	readOne as loomReadOne,
	readFeed as loomReadFeed,
	validateGlbUrl,
	sanitizePrompt,
	sanitizeAuthor,
	sanitizeOptionalString,
} from './loom.js';

// ── keys + limits ─────────────────────────────────────────────────────────────
const META_KEY = (id) => `cre:meta:${id}`;
const CHILDREN_KEY = (id) => `cre:children:${id}`;
const PROV_KEY = (id) => `cre:prov:${id}`;
const CREATOR_KEY = (key) => `cre:creator:${key}`;
const FOLLOWERS_KEY = (key) => `cre:followers:${key}`;
const REMIX_FEED_KEY = 'cre:remixfeed';

const REMIX_FEED_CAP = 2000;
const DEFAULT_LIMIT = 36;
const MAX_LIMIT = 120;
const SCAN_CAP = 600; // how deep we read the Loom feed for aggregation/search
const TITLE_MAX = 80;
const TAG_MAX = 24;
const TAGS_MAX = 8;
const NOTE_MAX = 240;

// License terms a creator can attach. Kept as a closed vocabulary so the gallery
// can render a consistent, legible badge + remix-permission signal per item.
const LICENSES = {
	'remix-cc': { label: 'Remix freely', remixable: true, commercial: true, note: 'Anyone may remix and use commercially.' },
	'remix-nc': { label: 'Remix · non-commercial', remixable: true, commercial: false, note: 'Remix freely; no commercial use.' },
	'remix-royalty': { label: 'Remix · royalty', remixable: true, commercial: true, note: 'Remix allowed; royalties route to the original creator on mint.' },
	'all-rights': { label: 'All rights reserved', remixable: false, commercial: false, note: 'Display only, no remixing.' },
};
const DEFAULT_LICENSE = 'remix-cc';

// Style + type vocabularies power the discovery filters. Free-text tags still
// flow through search; these are the curated facets.
const STYLES = ['realistic', 'stylized', 'lowpoly', 'voxel', 'sci-fi', 'fantasy', 'cute', 'abstract'];
const TYPES = ['avatar', 'character', 'creature', 'prop', 'vehicle', 'environment', 'scene', 'object'];

// ── in-memory fallback ─────────────────────────────────────────────────────────
const mem = {
	meta: new Map(),
	children: new Map(), // parentId -> string[] childIds
	prov: new Map(), // id -> entry[]
	creators: new Map(),
	followers: new Map(), // key -> Set
	remixFeed: [], // newest-first remix events
};

function safeParse(s) {
	if (s && typeof s === 'object') return s;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// ── overlay storage abstraction ────────────────────────────────────────────────

async function getMeta(id) {
	if (!id) return null;
	const r = getRedis();
	if (!r) return mem.meta.get(id) || null;
	const raw = await r.get(META_KEY(id));
	return raw ? safeParse(raw) : null;
}

async function putMeta(meta) {
	const r = getRedis();
	if (!r) {
		mem.meta.set(meta.id, meta);
		return meta;
	}
	await r.set(META_KEY(meta.id), JSON.stringify(meta));
	return meta;
}

async function getChildren(id) {
	const r = getRedis();
	if (!r) return mem.children.get(id) || [];
	const raw = await r.lrange(CHILDREN_KEY(id), 0, 199);
	return (raw || []).filter(Boolean);
}

// Batched overlay reads. Every aggregation surface here (feed, creator,
// creators, trending) enriches a SCAN_CAP-deep slice of the Loom feed, and
// per-item getMeta + getChildren would be two Upstash REST round-trips PER
// creation: 1200 HTTP calls to render one gallery page, the exact shape of the
// quota blowout api/_lib/redis.js was written to stop. mget collapses the meta
// reads into one call and a pipeline collapses the lrange reads into another,
// so the whole slice costs two round-trips regardless of its depth.
async function getMetaMany(ids) {
	const out = new Map();
	const wanted = [...new Set(ids.filter(Boolean))];
	if (!wanted.length) return out;

	const r = getRedis();
	if (!r) {
		for (const id of wanted) out.set(id, mem.meta.get(id) || null);
		return out;
	}
	const raw = await r.mget(...wanted.map(META_KEY));
	wanted.forEach((id, i) => out.set(id, raw?.[i] ? safeParse(raw[i]) : null));
	return out;
}

async function getChildrenMany(ids) {
	const out = new Map();
	const wanted = [...new Set(ids.filter(Boolean))];
	if (!wanted.length) return out;

	const r = getRedis();
	if (!r) {
		for (const id of wanted) out.set(id, mem.children.get(id) || []);
		return out;
	}
	const pipe = r.pipeline();
	for (const id of wanted) pipe.lrange(CHILDREN_KEY(id), 0, 199);
	const results = await pipe.exec();
	wanted.forEach((id, i) => out.set(id, (results?.[i] || []).filter(Boolean)));
	return out;
}

async function addChild(parentId, childId) {
	const r = getRedis();
	if (!r) {
		const arr = mem.children.get(parentId) || [];
		if (!arr.includes(childId)) arr.unshift(childId);
		mem.children.set(parentId, arr);
		return;
	}
	await r.lpush(CHILDREN_KEY(parentId), childId);
	await r.ltrim(CHILDREN_KEY(parentId), 0, 199);
}

async function appendProvenance(id, entry) {
	const r = getRedis();
	if (!r) {
		const arr = mem.prov.get(id) || [];
		arr.push(entry);
		mem.prov.set(id, arr);
		return;
	}
	await r.rpush(PROV_KEY(id), JSON.stringify(entry));
	await r.ltrim(PROV_KEY(id), -50, -1);
}

async function getProvenance(id) {
	const r = getRedis();
	if (!r) return mem.prov.get(id) || [];
	const raw = await r.lrange(PROV_KEY(id), 0, 49);
	return (raw || []).map(safeParse).filter(Boolean);
}

async function getCreator(key) {
	const r = getRedis();
	if (!r) return mem.creators.get(key) || null;
	const raw = await r.get(CREATOR_KEY(key));
	return raw ? safeParse(raw) : null;
}

async function putCreator(rec) {
	const r = getRedis();
	if (!r) {
		mem.creators.set(rec.key, rec);
		return rec;
	}
	await r.set(CREATOR_KEY(rec.key), JSON.stringify(rec));
	return rec;
}

// Touch (create or update) a creator aggregate as creations/remixes land.
async function touchCreator({ key, displayName, agentId, creationId, earnedRemix }) {
	const existing = (await getCreator(key)) || {
		key,
		displayName: displayName || key,
		agentId: agentId || null,
		creationIds: [],
		remixesEarned: 0,
		createdAt: Date.now(),
	};
	if (displayName) existing.displayName = displayName;
	if (agentId) existing.agentId = agentId;
	if (creationId && !existing.creationIds.includes(creationId)) {
		existing.creationIds.unshift(creationId);
		if (existing.creationIds.length > 500) existing.creationIds.length = 500;
	}
	if (earnedRemix) existing.remixesEarned = (existing.remixesEarned || 0) + 1;
	existing.updatedAt = Date.now();
	await putCreator(existing);
	return existing;
}

async function followerCount(key) {
	const r = getRedis();
	if (!r) return (mem.followers.get(key) || new Set()).size;
	return (await r.scard(FOLLOWERS_KEY(key))) || 0;
}

async function isFollowing(key, followerId) {
	if (!followerId) return false;
	const r = getRedis();
	if (!r) return (mem.followers.get(key) || new Set()).has(followerId);
	return Boolean(await r.sismember(FOLLOWERS_KEY(key), followerId));
}

async function setFollow(key, followerId, follow) {
	const r = getRedis();
	if (!r) {
		const set = mem.followers.get(key) || new Set();
		if (follow) set.add(followerId);
		else set.delete(followerId);
		mem.followers.set(key, set);
		return;
	}
	if (follow) await r.sadd(FOLLOWERS_KEY(key), followerId);
	else await r.srem(FOLLOWERS_KEY(key), followerId);
}

async function pushRemixEvent(ev) {
	const r = getRedis();
	if (!r) {
		mem.remixFeed.unshift(ev);
		if (mem.remixFeed.length > REMIX_FEED_CAP) mem.remixFeed.length = REMIX_FEED_CAP;
		return;
	}
	await r.lpush(REMIX_FEED_KEY, JSON.stringify(ev));
	await r.ltrim(REMIX_FEED_KEY, 0, REMIX_FEED_CAP - 1);
}

async function readRemixEvents(limit = REMIX_FEED_CAP) {
	const r = getRedis();
	if (!r) return mem.remixFeed.slice(0, limit);
	const raw = await r.lrange(REMIX_FEED_KEY, 0, limit - 1);
	return (raw || []).map(safeParse).filter(Boolean);
}

// ── identity helpers ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slugifyAuthor(author) {
	const s = String(author || 'anon')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return s || 'anon';
}

// A creator key is either an agent UUID (when a creation is bound to an agent) or
// a slug derived from the free-text author. Resolving a creation to its creator
// prefers an explicit agent binding, then the slug.
function creatorKeyFor(creation, meta) {
	if (meta?.agentId && UUID_RE.test(meta.agentId)) return meta.agentId;
	if (meta?.creatorKey) return meta.creatorKey;
	return slugifyAuthor(creation?.author);
}

function isAgentKey(key) {
	return UUID_RE.test(String(key || ''));
}

// ── creation enrichment ─────────────────────────────────────────────────────────

// Merge a raw Loom creation with its gallery overlay + lineage counts into the
// shape the creator gallery renders. Defensive: a creation with no overlay (every
// pre-existing Loom item) still renders fully, so title falls back to the prompt,
// license to the open default, type/style inferred from tags/prompt.
// `overlay` lets a caller hand in already-batched meta/children lookups (see
// enrichAll); without it each call fetches its own, which is right for the
// single-item paths.
async function enrich(creation, { withChildren = false, overlay = null } = {}) {
	if (!creation) return null;
	const meta = overlay ? overlay.meta.get(creation.id) || null : await getMeta(creation.id);
	const childIds = overlay ? overlay.children.get(creation.id) || [] : await getChildren(creation.id);
	const creatorKey = creatorKeyFor(creation, meta);
	const inferred = inferFacets(creation, meta);
	const out = {
		id: creation.id,
		prompt: creation.prompt,
		title: meta?.title || titleFromPrompt(creation.prompt),
		glbUrl: creation.glbUrl,
		previewImageUrl: creation.previewImageUrl || null,
		author: creation.author || 'anon',
		creatorKey,
		creatorIsAgent: isAgentKey(creatorKey),
		tier: creation.tier || null,
		backend: creation.backend || null,
		type: meta?.type || inferred.type,
		style: meta?.style || inferred.style,
		tags: meta?.tags || inferred.tags,
		license: meta?.license || DEFAULT_LICENSE,
		licenseInfo: LICENSES[meta?.license || DEFAULT_LICENSE],
		parentId: meta?.parentId || null,
		royalty: meta?.royalty || null,
		createdAt: Number(creation.createdAt) || meta?.publishedAt || 0,
		remixCount: childIds.length,
		viewerUrl: `/creation/${creation.id}`,
		embedUrl: `/forge/embed?src=${encodeURIComponent(creation.glbUrl)}&title=${encodeURIComponent(meta?.title || titleFromPrompt(creation.prompt))}`,
	};
	if (withChildren) out.childIds = childIds;
	return out;
}

// Enrich a whole slice with two overlay round-trips instead of two per item.
async function enrichAll(creations, opts = {}) {
	const rows = (creations || []).filter(Boolean);
	if (!rows.length) return [];
	const ids = rows.map((c) => c.id);
	const [meta, children] = await Promise.all([getMetaMany(ids), getChildrenMany(ids)]);
	const overlay = { meta, children };
	return (await Promise.all(rows.map((c) => enrich(c, { ...opts, overlay })))).filter(Boolean);
}

function titleFromPrompt(prompt) {
	const p = String(prompt || '').trim();
	if (!p) return 'Untitled creation';
	const firstClause = p.split(/[.,;\n]/)[0].trim();
	const words = firstClause.split(/\s+/).slice(0, 7).join(' ');
	return (words || p.slice(0, 48)).replace(/^[a-z]/, (c) => c.toUpperCase());
}

// Best-effort facet inference for legacy/un-overlaid creations so filters and
// badges still have something real to show. Keyword-matched against prompt+tags.
function inferFacets(creation, meta) {
	const hay = `${creation?.prompt || ''} ${(meta?.tags || []).join(' ')}`.toLowerCase();
	const type = TYPES.find((t) => hay.includes(t)) || (hay.match(/\b(robot|knight|hero|girl|boy|man|woman|warrior)\b/) ? 'character' : 'object');
	const style = STYLES.find((s) => hay.includes(s.replace('-', ' ')) || hay.includes(s)) || null;
	const tags = Array.from(
		new Set(
			String(creation?.prompt || '')
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ')
				.split(/\s+/)
				.filter((w) => w.length >= 4)
				.slice(0, 4),
		),
	);
	return { type, style, tags };
}

// ── feed / discovery ─────────────────────────────────────────────────────────

function matchesFilters(c, { q, type, style, creator, license }) {
	if (type && c.type !== type) return false;
	if (style && c.style !== style) return false;
	if (license && c.license !== license) return false;
	if (creator && c.creatorKey !== creator && slugifyAuthor(c.author) !== creator) return false;
	if (q) {
		const hay = `${c.title} ${c.prompt} ${c.author} ${(c.tags || []).join(' ')}`.toLowerCase();
		if (!hay.includes(q.toLowerCase())) return false;
	}
	return true;
}

async function handleFeed(req, res, url) {
	const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
	const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0);
	const sort = ['new', 'trending', 'remixed'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'new';
	const filters = {
		q: (url.searchParams.get('q') || '').trim().slice(0, 80),
		type: TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : null,
		style: STYLES.includes(url.searchParams.get('style')) ? url.searchParams.get('style') : null,
		creator: sanitizeOptionalString(url.searchParams.get('creator'), 64),
		license: LICENSES[url.searchParams.get('license')] ? url.searchParams.get('license') : null,
	};

	// Pull a deep slice of the canonical Loom feed, enrich, filter, then rank.
	// SCAN_CAP bounds the work; the feed is itself capped at 2000 upstream.
	const raw = await loomReadFeed(SCAN_CAP, NaN);
	const enriched = await enrichAll(raw);
	let items = enriched.filter((c) => matchesFilters(c, filters));

	if (sort === 'new') items.sort((a, b) => b.createdAt - a.createdAt);
	else if (sort === 'remixed' || sort === 'trending') {
		// trending blends remix count with recency so a brand-new asset with one
		// remix can out-rank an old asset with two; remixed is pure count.
		if (sort === 'trending') {
			const now = Date.now();
			const score = (c) => c.remixCount * 10 + Math.max(0, 5 - (now - c.createdAt) / 86_400_000);
			items.sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt);
		} else {
			items.sort((a, b) => b.remixCount - a.remixCount || b.createdAt - a.createdAt);
		}
	}

	const total = items.length;
	const start = page * limit;
	const slice = items.slice(start, start + limit);
	const hasMore = start + limit < total;

	res.setHeader('cache-control', 'public, s-maxage=15, stale-while-revalidate=60');
	return json(res, 200, {
		creations: slice,
		page,
		limit,
		total,
		hasMore,
		facets: { styles: STYLES, types: TYPES, licenses: Object.entries(LICENSES).map(([id, v]) => ({ id, ...v })) },
	});
}

async function handleItem(req, res, url) {
	const id = url.searchParams.get('id');
	if (!id) return error(res, 400, 'bad_request', 'id is required');
	const creation = await loomReadOne(id);
	if (!creation) return error(res, 404, 'not_found', 'creation not found');

	const item = await enrich(creation, { withChildren: true });
	const provenance = await getProvenance(id);

	// Lineage: walk up to the root following parentId, and list direct children.
	const ancestors = [];
	let cursorMeta = await getMeta(id);
	let guard = 0;
	while (cursorMeta?.parentId && guard++ < 12) {
		const pc = await loomReadOne(cursorMeta.parentId);
		if (!pc) break;
		ancestors.push(await enrich(pc));
		cursorMeta = await getMeta(cursorMeta.parentId);
	}
	const childRows = await Promise.all((item.childIds || []).slice(0, 24).map((cid) => loomReadOne(cid)));
	const children = await enrichAll(childRows);

	// Creator card: aggregate + follower count + (for agents) on-chain reputation.
	const creator = await buildCreatorCard(item.creatorKey, creation);

	res.setHeader('cache-control', 'public, s-maxage=10, stale-while-revalidate=30');
	return json(res, 200, {
		creation: item,
		lineage: { ancestors: ancestors.reverse(), children, parentId: item.parentId },
		provenance,
		creator,
	});
}

async function buildCreatorCard(key, sampleCreation) {
	const rec = await getCreator(key);
	const followers = await followerCount(key);
	const displayName = rec?.displayName || sampleCreation?.author || (isAgentKey(key) ? 'Agent' : key);
	const card = {
		key,
		displayName,
		isAgent: isAgentKey(key),
		agentId: rec?.agentId || (isAgentKey(key) ? key : null),
		creationCount: rec?.creationIds?.length || null,
		remixesEarned: rec?.remixesEarned || 0,
		followers,
		profileUrl: `/creator/${encodeURIComponent(key)}`,
	};
	return card;
}

async function handleCreator(req, res, url) {
	const key = sanitizeOptionalString(url.searchParams.get('id'), 64);
	if (!key) return error(res, 400, 'bad_request', 'id is required');
	const followerId = sanitizeOptionalString(url.searchParams.get('follower'), 80);

	// Gather this creator's creations from the canonical feed (match by agent
	// binding or author slug), a bounded scan, newest-first.
	const raw = await loomReadFeed(SCAN_CAP, NaN);
	const all = await enrichAll(raw);
	const creations = all
		.filter((c) => c.creatorKey === key || slugifyAuthor(c.author) === key)
		.sort((a, b) => b.createdAt - a.createdAt);

	const remixesEarned = creations.reduce((n, c) => n + c.remixCount, 0);
	const rec = await getCreator(key);
	const followers = await followerCount(key);
	const following = await isFollowing(key, followerId);

	const creator = {
		key,
		displayName: rec?.displayName || creations[0]?.author || (isAgentKey(key) ? 'Agent' : key),
		isAgent: isAgentKey(key),
		agentId: rec?.agentId || (isAgentKey(key) ? key : null),
		creationCount: creations.length,
		remixesEarned,
		followers,
		following,
		createdAt: rec?.createdAt || creations[creations.length - 1]?.createdAt || null,
	};

	res.setHeader('cache-control', 'public, s-maxage=15, stale-while-revalidate=60');
	return json(res, 200, { creator, creations });
}

async function handleCreators(req, res, url) {
	const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '12', 10) || 12));
	const sort = ['remixed', 'prolific', 'followed'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'remixed';

	const raw = await loomReadFeed(SCAN_CAP, NaN);
	const all = await enrichAll(raw);

	// Aggregate by creator key across the scanned feed.
	const byKey = new Map();
	for (const c of all) {
		const k = c.creatorKey;
		const agg = byKey.get(k) || { key: k, displayName: c.author, isAgent: c.creatorIsAgent, creationCount: 0, remixesEarned: 0, latest: 0, sample: c };
		agg.creationCount += 1;
		agg.remixesEarned += c.remixCount;
		agg.latest = Math.max(agg.latest, c.createdAt);
		if (!agg.isAgent && c.creatorIsAgent) agg.isAgent = true;
		byKey.set(k, agg);
	}

	let creators = Array.from(byKey.values());
	// Decorate with persisted display name + follower count.
	creators = await Promise.all(
		creators.map(async (c) => {
			const rec = await getCreator(c.key);
			return {
				key: c.key,
				displayName: rec?.displayName || c.displayName || c.key,
				isAgent: c.isAgent,
				agentId: rec?.agentId || (c.isAgent ? c.key : null),
				creationCount: c.creationCount,
				remixesEarned: c.remixesEarned,
				followers: await followerCount(c.key),
				latest: c.latest,
				profileUrl: `/creator/${encodeURIComponent(c.key)}`,
				sampleGlb: c.sample?.glbUrl || null,
				samplePreview: c.sample?.previewImageUrl || null,
			};
		}),
	);

	if (sort === 'prolific') creators.sort((a, b) => b.creationCount - a.creationCount || b.remixesEarned - a.remixesEarned);
	else if (sort === 'followed') creators.sort((a, b) => b.followers - a.followers || b.remixesEarned - a.remixesEarned);
	else creators.sort((a, b) => b.remixesEarned - a.remixesEarned || b.creationCount - a.creationCount);

	res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
	return json(res, 200, { creators: creators.slice(0, limit), sort });
}

async function handleTrending(req, res, url) {
	const limit = Math.min(24, Math.max(1, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
	const raw = await loomReadFeed(SCAN_CAP, NaN);
	const all = await enrichAll(raw);
	const now = Date.now();
	const score = (c) => c.remixCount * 10 + Math.max(0, 5 - (now - c.createdAt) / 86_400_000);
	const trending = all
		.filter((c) => c.remixCount > 0)
		.sort((a, b) => score(b) - score(a))
		.slice(0, limit);
	const recentRemixes = (await readRemixEvents(20)).slice(0, 20);
	res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
	return json(res, 200, { trending, recentRemixes });
}

// ── writes ──────────────────────────────────────────────────────────────────

function sanitizeTags(raw) {
	if (!Array.isArray(raw)) return [];
	return Array.from(
		new Set(
			raw
				.map((t) => sanitizeOptionalString(t, TAG_MAX))
				.filter(Boolean)
				.map((t) => t.toLowerCase()),
		),
	).slice(0, TAGS_MAX);
}

function sanitizeRoyalty(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const bps = Math.max(0, Math.min(2000, Math.round(Number(raw.bps) || 0))); // cap at 20%
	if (!bps) return null;
	const beneficiaryKey = sanitizeOptionalString(raw.beneficiaryKey, 64);
	return { bps, beneficiaryKey: beneficiaryKey || null, settlement: 'USDC' };
}

// Publish a creation INTO the gallery. Writes the canonical Loom record (so it
// shows in the shared feed every surface reads), then attaches the gallery
// overlay (title/tags/license/type/style/creator/lineage) and a provenance entry.
// When parentId is present this is the persisted tail of a remix.
async function handlePublish(req, res, body) {
	const prompt = sanitizePrompt(body?.prompt ?? '');
	if (!prompt) return error(res, 400, 'bad_request', 'prompt is required');
	if (prompt.length > 1000) return error(res, 400, 'bad_request', 'prompt too long (max 1000)');

	const glbUrl = validateGlbUrl(body?.glbUrl);
	if (!glbUrl) return error(res, 400, 'invalid_glb_url', 'glbUrl must be an https URL on an allowed host');

	const author = sanitizeAuthor(body?.author);
	const agentId = body?.agentId && UUID_RE.test(body.agentId) ? body.agentId : null;
	const title = sanitizeOptionalString(body?.title, TITLE_MAX) || titleFromPrompt(prompt);
	const tags = sanitizeTags(body?.tags);
	const type = TYPES.includes(body?.type) ? body.type : null;
	const style = STYLES.includes(body?.style) ? body.style : null;
	const license = LICENSES[body?.license] ? body.license : DEFAULT_LICENSE;
	const royalty = sanitizeRoyalty(body?.royalty);
	const parentId = sanitizeOptionalString(body?.parentId, 64);
	const previewImageUrl = sanitizeOptionalString(body?.previewImageUrl, 600);
	const tier = sanitizeOptionalString(body?.tier, 40);
	const backend = sanitizeOptionalString(body?.backend, 40);

	// Write the canonical record to Loom (single source of truth for the feed).
	const creation = await writeCreation({
		id: randomUUID(),
		prompt,
		glbUrl,
		previewImageUrl,
		author,
		tier,
		backend,
		createdAt: Date.now(),
	});

	const creatorKey = agentId || slugifyAuthor(author);

	const meta = {
		id: creation.id,
		title,
		tags,
		type,
		style,
		license,
		royalty,
		parentId: parentId || null,
		agentId,
		creatorKey,
		author,
		publishedAt: Date.now(),
	};
	await putMeta(meta);
	await touchCreator({ key: creatorKey, displayName: author, agentId, creationId: creation.id });

	await appendProvenance(creation.id, {
		event: parentId ? 'remix' : 'origin',
		creatorKey,
		author,
		license,
		parentId: parentId || null,
		at: Date.now(),
	});

	// If this is a remix, record the lineage edge + bump the parent's creator.
	if (parentId) {
		const parent = await loomReadOne(parentId);
		if (parent) {
			await addChild(parentId, creation.id);
			const parentMeta = await getMeta(parentId);
			const parentKey = creatorKeyFor(parent, parentMeta);
			await touchCreator({ key: parentKey, displayName: parent.author, earnedRemix: true });
			await pushRemixEvent({
				parentId,
				childId: creation.id,
				parentTitle: parentMeta?.title || titleFromPrompt(parent.prompt),
				childTitle: title,
				byKey: creatorKey,
				byName: author,
				royalty,
				at: Date.now(),
			});
			await appendProvenance(parentId, {
				event: 'remixed-by',
				childId: creation.id,
				byKey: creatorKey,
				royalty,
				at: Date.now(),
			});
		}
	}

	const enriched = await enrich(creation);
	return json(res, 201, { creation: enriched, royalty });
}

// Record a lineage edge for an EXISTING child creation (e.g. one already in the
// feed) without re-publishing. Idempotent on (parentId, childId).
async function handleRemixLink(req, res, body) {
	const parentId = sanitizeOptionalString(body?.parentId, 64);
	const childId = sanitizeOptionalString(body?.childId, 64);
	if (!parentId || !childId) return error(res, 400, 'bad_request', 'parentId and childId are required');
	if (parentId === childId) return error(res, 400, 'bad_request', 'a creation cannot remix itself');

	const parent = await loomReadOne(parentId);
	const child = await loomReadOne(childId);
	if (!parent || !child) return error(res, 404, 'not_found', 'parent or child creation not found');

	const existing = await getChildren(parentId);
	if (!existing.includes(childId)) {
		await addChild(parentId, childId);
		const royalty = sanitizeRoyalty(body?.royalty);
		const childMeta = (await getMeta(childId)) || { id: childId };
		childMeta.parentId = parentId;
		if (royalty) childMeta.royalty = royalty;
		await putMeta(childMeta);

		const parentMeta = await getMeta(parentId);
		const parentKey = creatorKeyFor(parent, parentMeta);
		const childKey = creatorKeyFor(child, childMeta);
		await touchCreator({ key: parentKey, displayName: parent.author, earnedRemix: true });
		await pushRemixEvent({
			parentId,
			childId,
			parentTitle: parentMeta?.title || titleFromPrompt(parent.prompt),
			childTitle: childMeta.title || titleFromPrompt(child.prompt),
			byKey: childKey,
			byName: child.author,
			royalty,
			at: Date.now(),
		});
		await appendProvenance(childId, { event: 'remix', parentId, royalty, at: Date.now() });
		await appendProvenance(parentId, { event: 'remixed-by', childId, royalty, at: Date.now() });
	}

	const updated = await enrich(parent);
	return json(res, 200, { ok: true, parent: updated });
}

async function handleFollow(req, res, body) {
	const key = sanitizeOptionalString(body?.creatorKey, 64);
	const followerId = sanitizeOptionalString(body?.follower, 80);
	if (!key || !followerId) return error(res, 400, 'bad_request', 'creatorKey and follower are required');
	const follow = body?.follow !== false;
	await setFollow(key, followerId, follow);
	const followers = await followerCount(key);
	return json(res, 200, { ok: true, following: follow, followers });
}

// ── rate limit for writes (shared with Loom's posture: ~30/hr/ip) ──────────────
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60 * 60 * 1000;
const memWriteBuckets = new Map();

function memoryWriteLimit(ip) {
	const now = Date.now();
	const cutoff = now - WRITE_WINDOW_MS;
	const kept = (memWriteBuckets.get(ip) || []).filter((t) => t > cutoff);
	if (kept.length >= WRITE_LIMIT) {
		memWriteBuckets.set(ip, kept);
		return { success: false, limit: WRITE_LIMIT, remaining: 0, reset: kept[0] + WRITE_WINDOW_MS };
	}
	kept.push(now);
	memWriteBuckets.set(ip, kept);
	return { success: true, limit: WRITE_LIMIT, remaining: WRITE_LIMIT - kept.length, reset: now + WRITE_WINDOW_MS };
}

async function writeRateLimit(ip) {
	const r = getRedis();
	if (!r) return memoryWriteLimit(ip);
	const key = `cre:write:${ip}`;
	try {
		const count = await r.incr(key);
		if (count === 1) await r.pexpire(key, WRITE_WINDOW_MS);
		const ttl = await r.pttl(key);
		const reset = Date.now() + (ttl > 0 ? ttl : WRITE_WINDOW_MS);
		if (count > WRITE_LIMIT) return { success: false, limit: WRITE_LIMIT, remaining: 0, reset };
		return { success: true, limit: WRITE_LIMIT, remaining: WRITE_LIMIT - count, reset };
	} catch {
		return memoryWriteLimit(ip);
	}
}

// ── handler ────────────────────────────────────────────────────────────────────

export default wrap(async (req, res) => {
	if (cors(req, res)) return;

	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://localhost');
		const op = url.searchParams.get('op') || 'feed';
		switch (op) {
			case 'feed':
				return handleFeed(req, res, url);
			case 'item':
				return handleItem(req, res, url);
			case 'creator':
				return handleCreator(req, res, url);
			case 'creators':
				return handleCreators(req, res, url);
			case 'trending':
				return handleTrending(req, res, url);
			default:
				return error(res, 400, 'bad_request', `unknown op "${op}"`);
		}
	}

	if (req.method === 'POST') {
		const ip = clientIp(req);
		const rl = await writeRateLimit(ip);
		if (!rl.success) {
			setRateLimitHeaders(res, rl);
			return error(res, 429, 'rate_limited', 'too many writes, slow down', {
				retry_after: Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)),
			});
		}
		const body = await readJson(req, 12_000);
		const op = body?.op || 'publish';
		setRateLimitHeaders(res, rl);
		switch (op) {
			case 'publish':
				return handlePublish(req, res, body);
			case 'remix':
				return handleRemixLink(req, res, body);
			case 'follow':
				return handleFollow(req, res, body);
			default:
				return error(res, 400, 'bad_request', `unknown op "${op}"`);
		}
	}

	if (!method(req, res, ['GET', 'POST'])) return;
});
