// api/spotlight/[action]: Agent Spotlight, the community showcase.
//
//   GET  /api/spotlight/list?sort=trending|new|top&category=&tag=&q=&limit=&offset=&featured=1
//   GET  /api/spotlight/get?id=<uuid>
//   GET  /api/spotlight/categories     (per-category counts + headline totals)
//   GET  /api/spotlight/eligible            (auth: the caller's showcasable agents)
//   POST /api/spotlight/submit  { agentId, title, tagline, story?, demoUrl?, category, tags[] }
//   POST /api/spotlight/vote    { id }      (toggle)
//   POST /api/spotlight/remove  { id }      (submitter or agent owner)
//
// Reads are public and CDN-cached; writes need a session plus CSRF. The ranking
// and every query live in api/_lib/spotlight-store.js; this file is the HTTP
// boundary and nothing else.

import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { getSessionUser } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';
import {
	CATEGORIES,
	SORTS,
	agentIsPublic,
	bumpViews,
	categoryCounts,
	countEntries,
	eligibleAgents,
	entryExists,
	getEntry,
	isCategory,
	listEntries,
	ownsAgent,
	showcaseConfigured,
	showcaseTotals,
	softDeleteEntry,
	toggleVote,
	upsertEntry,
} from '../_lib/spotlight-store.js';

const MAX_LIMIT = 48;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (!showcaseConfigured()) {
		return error(res, 503, 'not_configured', 'the showcase needs a database; none is configured here');
	}

	switch (actionOf(req)) {
		case 'list':
			return await handleList(req, res);
		case 'get':
			return await handleGet(req, res);
		case 'categories':
			return await handleCategories(req, res);
		case 'eligible':
			return await handleEligible(req, res);
		case 'submit':
			return await handleSubmit(req, res);
		case 'vote':
			return await handleVote(req, res);
		case 'remove':
			return await handleRemove(req, res);
		default:
			return error(res, 404, 'not_found', `unknown spotlight action "${actionOf(req)}"`);
	}
});

function actionOf(req) {
	const fromQuery = req.query?.action;
	if (fromQuery && fromQuery !== '[action]') return String(fromQuery).toLowerCase();
	return (new URL(req.url, 'http://x').pathname.split('/').pop() || '').toLowerCase();
}

function queryOf(req) {
	return new URL(req.url, 'http://x').searchParams;
}

// A viewer is optional on every read: signed in, their own votes come back
// marked; signed out, the page still renders in full. A broken session cookie
// must therefore never turn a public read into a 401.
async function viewer(req) {
	try {
		const user = await getSessionUser(req);
		return user?.id || null;
	} catch {
		return null;
	}
}

/* ── reads ────────────────────────────────────────────────────────────────── */

async function handleList(req, res) {
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const p = queryOf(req);
	const sort = SORTS.has(p.get('sort')) ? p.get('sort') : 'trending';
	const rawCategory = (p.get('category') || '').toLowerCase();
	const category = isCategory(rawCategory) ? rawCategory : null;
	const tag = (p.get('tag') || '').trim().toLowerCase().slice(0, 40) || null;
	const q = (p.get('q') || '').trim().slice(0, 100) || null;
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number(p.get('limit') || 24) | 0));
	const offset = Math.max(0, Math.min(5000, Number(p.get('offset') || 0) | 0));
	const featuredOnly = p.get('featured') === '1';

	const viewerId = await viewer(req);
	const [entries, total] = await Promise.all([
		listEntries({ sort, category, tag, q, limit, offset, viewerId, featuredOnly }),
		countEntries({ category, tag, q }),
	]);

	// A signed-in read is personalised (voted_by_me), so it must never land in a
	// shared cache. Anonymous reads are identical for everyone and cache freely.
	const cache = viewerId
		? { 'Cache-Control': 'private, no-store' }
		: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' };

	return json(
		res,
		200,
		{
			entries,
			count: entries.length,
			total,
			has_more: offset + entries.length < total,
			next_offset: offset + entries.length < total ? offset + entries.length : null,
			sort,
			category,
			generated_at: new Date().toISOString(),
		},
		cache,
	);
}

async function handleGet(req, res) {
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const id = queryOf(req).get('id') || '';
	if (!isUuid(id)) return error(res, 400, 'bad_request', 'id must be a uuid');

	const viewerId = await viewer(req);
	const entry = await getEntry(id, { viewerId });
	if (!entry) return error(res, 404, 'not_found', 'no such showcase entry');

	void bumpViews(id);
	return json(res, 200, { entry }, { 'Cache-Control': 'private, no-store' });
}

async function handleCategories(req, res) {
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [categories, totals] = await Promise.all([categoryCounts(), showcaseTotals()]);
	return json(
		res,
		200,
		{ categories, totals },
		{ 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' },
	);
}

async function handleEligible(req, res) {
	if (!method(req, res, ['GET'])) return;
	const user = await sessionOr401(req, res, 'sign in to see which of your agents you can showcase');
	if (!user) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const agents = await eligibleAgents(user.id);
	return json(res, 200, { agents, categories: CATEGORIES }, { 'Cache-Control': 'private, no-store' });
}

/* ── writes ───────────────────────────────────────────────────────────────── */

async function handleSubmit(req, res) {
	if (!method(req, res, ['POST'])) return;
	const user = await sessionOr401(req, res, 'sign in to submit an agent to the showcase');
	if (!user) return;
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.showcaseWrite(user.id);
	if (!rl.success) return rateLimited(res, rl, 'too many showcase submissions; slow down');

	const body = await readJson(req, 32_000);
	const agentId = String(body?.agentId || '').trim();
	if (!isUuid(agentId)) return error(res, 400, 'bad_request', 'agentId must be a uuid');

	if (!(await ownsAgent(agentId, user.id))) {
		return error(res, 403, 'forbidden', 'you can only showcase an agent you own');
	}
	if ((await agentIsPublic(agentId)) !== true) {
		return error(
			res,
			409,
			'agent_not_public',
			'make the agent public before showcasing it: the showcase only lists agents visitors can open',
		);
	}

	const title = trimmed(body?.title);
	const tagline = trimmed(body?.tagline);
	const story = trimmed(body?.story) || null;
	const category = String(body?.category || '').toLowerCase();
	const demoUrl = normalizeDemoUrl(body?.demoUrl);
	if (demoUrl === false) {
		return error(res, 400, 'bad_request', 'demoUrl must be an http(s) link');
	}

	if (!title || title.length < 3 || title.length > 90) {
		return error(res, 400, 'bad_request', 'title must be 3 to 90 characters');
	}
	if (!tagline || tagline.length < 10 || tagline.length > 160) {
		return error(res, 400, 'bad_request', 'tagline must be 10 to 160 characters');
	}
	if (story && story.length > 4000) {
		return error(res, 400, 'bad_request', 'story must be 4000 characters or fewer');
	}
	if (!isCategory(category)) {
		return error(res, 400, 'bad_request', `category must be one of: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
	}

	const tags = normalizeTags(body?.tags);
	if (tags === false) return error(res, 400, 'bad_request', 'tags must be up to 6 short labels');

	const id = await upsertEntry({
		agentId,
		userId: user.id,
		title,
		tagline,
		story,
		demoUrl: demoUrl || null,
		category,
		tags,
	});
	if (!id) return error(res, 500, 'write_failed', 'the entry could not be saved');

	const entry = await getEntry(id, { viewerId: user.id });
	return json(res, 200, { entry }, { 'Cache-Control': 'private, no-store' });
}

async function handleVote(req, res) {
	if (!method(req, res, ['POST'])) return;
	const user = await sessionOr401(req, res, 'sign in to upvote an agent');
	if (!user) return;
	if (!(await requireCsrf(req, res, user.id))) return;

	const rl = await limits.showcaseVote(user.id);
	if (!rl.success) return rateLimited(res, rl, 'too many votes; slow down');

	const body = await readJson(req, 2_000);
	const id = String(body?.id || '').trim();
	if (!isUuid(id)) return error(res, 400, 'bad_request', 'id must be a uuid');
	if (!(await entryExists(id))) return error(res, 404, 'not_found', 'no such showcase entry');

	const result = await toggleVote(id, user.id);
	return json(res, 200, result, { 'Cache-Control': 'private, no-store' });
}

async function handleRemove(req, res) {
	if (!method(req, res, ['POST'])) return;
	const user = await sessionOr401(req, res, 'sign in to remove a showcase entry');
	if (!user) return;
	if (!(await requireCsrf(req, res, user.id))) return;

	const body = await readJson(req, 2_000);
	const id = String(body?.id || '').trim();
	if (!isUuid(id)) return error(res, 400, 'bad_request', 'id must be a uuid');

	const removed = await softDeleteEntry(id, user.id);
	if (!removed) {
		return error(res, 403, 'forbidden', 'only the submitter or the agent owner can remove an entry');
	}
	return json(res, 200, { removed: true }, { 'Cache-Control': 'private, no-store' });
}

/* ── input helpers ────────────────────────────────────────────────────────── */

async function sessionOr401(req, res, message) {
	let user = null;
	try {
		user = await getSessionUser(req);
	} catch {
		user = null;
	}
	if (!user) {
		error(res, 401, 'unauthorized', message);
		return null;
	}
	return user;
}

function trimmed(v) {
	return typeof v === 'string' ? v.trim() : '';
}

// Returns a normalized URL string, '' for "not supplied", or false for invalid.
// Only http(s) is accepted: the value is rendered as a link on a public page, so
// javascript:, data: and friends have to be rejected at the boundary, not
// escaped at the sink.
function normalizeDemoUrl(raw) {
	const value = trimmed(raw);
	if (!value) return '';
	if (value.length > 500) return false;
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	return url.toString();
}

// Up to 6 lowercase, hyphenatable labels. Returns false on anything that cannot
// be coerced into that shape rather than silently dropping the caller's input.
function normalizeTags(raw) {
	if (raw == null) return [];
	if (!Array.isArray(raw)) return false;
	if (raw.length > 6) return false;
	const out = [];
	for (const t of raw) {
		if (typeof t !== 'string') return false;
		const tag = t.trim().toLowerCase().replace(/\s+/g, '-');
		if (!tag) continue;
		if (tag.length > 24 || !/^[a-z0-9][a-z0-9-]*$/.test(tag)) return false;
		if (!out.includes(tag)) out.push(tag);
	}
	return out;
}
