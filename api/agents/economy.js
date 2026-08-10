// GET  /api/agents/economy?view=offers          — marketplace catalog + live stats
// GET  /api/agents/economy?view=offer&slug=…     — one offer + provider + stats
// GET  /api/agents/economy?view=hires&agentId=…  — an agent's hire history (accounting)
// GET  /api/agents/economy?view=summary&agentId=… — income/outlay + provider reputation
// POST /api/agents/economy  { action:'rate', hireId, rating } — rate a completed hire
//
// The single read surface behind the agent-to-agent economy UI. Every number it
// returns is a real aggregate over real hires (api/_lib/agent-economy.js) — there
// is no path here that fabricates a completion count, rating, or earning. Reads
// are public (the same data the public money pulse already exposes); the only
// write is an owner-gated rating.

import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap } from '../_lib/http.js';
import { requireCsrf } from '../_lib/csrf.js';
import { isUuid } from '../_lib/validate.js';
import {
	agentEconomySummary,
	getHireById,
	getOfferBySlug,
	listHiresForAgent,
	listOffersWithStats,
	providerStats,
	rateHire,
} from '../_lib/agent-economy.js';

// Every id below lands in a `WHERE col = $1` against a uuid column. Without this
// gate a malformed id reaches Postgres and comes back as error 22P02, which the
// wrap boundary can only render as a 500. A caller typo has to be a 400 instead.
function badId(res, field, value) {
	if (value == null || isUuid(value)) return false;
	error(res, 400, 'validation_error', `${field} must be a uuid`);
	return true;
}

async function handleGet(req, res) {
	const url = new URL(req.url, 'http://x');
	const view = url.searchParams.get('view') || 'offers';

	if (view === 'offers') {
		const limit = Number(url.searchParams.get('limit')) || 60;
		const providerAgentId = url.searchParams.get('agentId') || null;
		if (badId(res, 'agentId', providerAgentId)) return;
		const offers = await listOffersWithStats({ limit, providerAgentId });
		return json(res, 200, { data: { offers } }, { 'cache-control': 'public, max-age=15' });
	}

	if (view === 'offer') {
		const slug = url.searchParams.get('slug');
		if (!slug) return error(res, 400, 'validation_error', 'slug is required');
		const offer = await getOfferBySlug(slug);
		if (!offer) return error(res, 404, 'not_found', 'offer not found');
		return json(res, 200, { data: { offer } });
	}

	if (view === 'hires') {
		const agentId = url.searchParams.get('agentId');
		if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');
		if (badId(res, 'agentId', agentId)) return;
		const role = url.searchParams.get('role') || 'all';
		const limit = Number(url.searchParams.get('limit')) || 40;
		const beforeId = url.searchParams.get('beforeId') || null;
		if (badId(res, 'beforeId', beforeId)) return;
		const hires = await listHiresForAgent(agentId, { role, limit, beforeId });
		const next_cursor = hires.length === limit ? hires[hires.length - 1].id : null;
		return json(res, 200, { data: { hires, next_cursor } });
	}

	if (view === 'summary') {
		const agentId = url.searchParams.get('agentId');
		if (!agentId) return error(res, 400, 'validation_error', 'agentId is required');
		if (badId(res, 'agentId', agentId)) return;
		const [summary, reputation] = await Promise.all([
			agentEconomySummary(agentId),
			providerStats(agentId),
		]);
		return json(res, 200, { data: { agent_id: agentId, summary, reputation } });
	}

	return error(res, 400, 'bad_view', `unknown view '${view}'`);
}

async function handlePost(req, res) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer?.userId;
	if (session && !(await requireCsrf(req, res, userId))) return;

	const body = (await readJson(req)) || {};
	if (body.action !== 'rate') return error(res, 400, 'bad_action', "only action 'rate' is supported");

	const { hireId, rating } = body;
	if (!hireId) return error(res, 400, 'validation_error', 'hireId is required');
	if (badId(res, 'hireId', hireId)) return;

	const hire = await getHireById(hireId);
	if (!hire) return error(res, 404, 'not_found', 'hire not found');
	if (hire.hirer_user_id !== userId) return error(res, 403, 'forbidden', 'only the hirer can rate this hire');
	if (hire.status !== 'completed') return error(res, 409, 'not_rateable', 'only a completed hire can be rated');

	try {
		const updated = await rateHire(hireId, userId, rating);
		if (!updated) return error(res, 409, 'rate_failed', 'could not record the rating');
		return json(res, 200, { ok: true, hire_id: hireId, rating: updated.rating });
	} catch (err) {
		if (err?.code === 'invalid_rating') return error(res, 400, 'invalid_rating', err.message);
		throw err;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	if (req.method === 'POST') return handlePost(req, res);
	return handleGet(req, res);
});
