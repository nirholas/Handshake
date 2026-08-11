// Launch Copilot — market-maker policy control surface.
//
//   GET    /api/launch/mm?mint=&network=            → policy (public view) + presets
//   GET    /api/launch/mm/:mint?state=1             → live state: policy + budget + recent actions
//   GET    /api/launch/mm/:mint?stream=1            → SSE: live action feed
//   GET    /api/launch/mm?owner=1                   → the caller's policies
//   POST   /api/launch/mm                           → create/update a policy (owner + CSRF)
//   POST   /api/launch/mm?action=pause|resume|kill|withdraw   → lifecycle controls (owner + CSRF)
//   DELETE /api/launch/mm?mint=&network=            → remove the policy (owner + CSRF)
//
// A policy can only be attached to a coin launched THROUGH three.ws (a row in
// pump_agent_mints) by its owner. The MM trades from that launch's own agent
// wallet through the shared firewall + spend-guard + custody pipeline — this
// endpoint never moves funds; it owns policy state + the kill switch, and routes
// the owner to the agent wallet's audited withdraw flow for funds.

import { cors, json, method, error, readJson, rateLimited, wrap } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { requireCsrf } from '../_lib/csrf.js';
import { sql } from '../_lib/db.js';
import {
	PRESETS, GUARDS, GRADUATION_ACTIONS, PolicyError,
	normalizePolicyPatch, upsertPolicy, getPolicyByMint, listOwnerPolicies,
	resolveOwnedLaunch, listActions, getDeployedLamports24h, getDefenseLamports24h,
	getEngineLiveness, toPublicPolicy, toPublicAction, SOL,
} from '../_lib/market-maker.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SSE_PING_MS = 15_000;
const SSE_POLL_MS = 3_000;
const SSE_MAX_MS = 10 * 60_000;

function netOf(url) {
	return url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
}

// Resolve the mint from the path (/api/launch/mm/:mint), query, or body.
function mintFrom(url, bodyMint) {
	const m = url.pathname.match(/\/api\/launch\/mm\/([^/?]+)/);
	if (m && m[1]) return m[1];
	return url.searchParams.get('mint') || bodyMint || null;
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, session: true };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId, session: false };
	return null;
}

async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);

	if (req.method === 'GET') {
		if (url.searchParams.get('stream') === '1') return handleStream(req, res, url);
		if (url.searchParams.get('owner') === '1') return handleListOwner(req, res);
		return handleGet(req, res, url);
	}
	if (req.method === 'POST') return handlePost(req, res, url);
	if (req.method === 'DELETE') return handleDelete(req, res, url);
	return method(req, res, ['GET', 'POST', 'DELETE']) ? error(res, 405, 'method_not_allowed', 'use GET, POST, or DELETE') : undefined;
}

// ── GET policy (+ optional live state) ────────────────────────────────────────
async function handleGet(req, res, url) {
	const mint = mintFrom(url, null);
	const network = netOf(url);
	if (!mint || !MINT_RE.test(mint)) return error(res, 400, 'invalid_mint', 'a valid mint is required');

	const auth = await resolveAuth(req);
	const policy = await getPolicyByMint(mint, network);

	// Ownership: the policy/state controls are owner-only. The disclosed policy +
	// public action log are readable by anyone (transparency is the point).
	let owned = false;
	if (auth) {
		const launch = await resolveOwnedLaunch({ userId: auth.userId, mint, network });
		owned = !!launch || (policy && policy.user_id === auth.userId);
	}

	if (!policy) {
		return json(res, 200, { data: { policy: null, owned, presets: presetCatalog(), guards: guardInfo() } });
	}

	const pub = toPublicPolicy(policy);
	const wantState = url.searchParams.get('state') === '1';
	if (!wantState) {
		return json(res, 200, { data: { policy: pub, owned, presets: presetCatalog(), guards: guardInfo() } });
	}

	const [actions, deployed, defense, engine] = await Promise.all([
		listActions(policy.id, { limit: 40, includeSkips: true }),
		getDeployedLamports24h(policy.id),
		getDefenseLamports24h(policy.id),
		// An armed policy with no worker sweeping it will never fire. Say so here
		// rather than letting the dashboard imply a maker that is working.
		getEngineLiveness(),
	]);
	const dailyBudget = BigInt(policy.daily_budget_lamports || 0);
	const dipBudget = BigInt(policy.dip_buy_budget_lamports || 0);
	const state = {
		daily_remaining_sol: dailyBudget > 0n ? Math.max(0, Number(dailyBudget - deployed) / SOL) : null,
		daily_spent_sol: Number(deployed) / SOL,
		dip_remaining_sol: dipBudget > 0n ? Math.max(0, Number(dipBudget - defense) / SOL) : null,
		dip_spent_sol: Number(defense) / SOL,
	};
	return json(res, 200, {
		data: {
			policy: pub, owned, presets: presetCatalog(), guards: guardInfo(),
			budget: state,
			engine,
			actions: actions.map(toPublicAction),
		},
	});
}

async function handleListOwner(req, res) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to list your market-makers');
	const rl = await limits.walletRead(auth.userId);
	if (!rl.success) return rateLimited(res, rl);
	const rows = await listOwnerPolicies(auth.userId);
	return json(res, 200, { data: { policies: rows.map(toPublicPolicy) } });
}

// ── POST create/update + lifecycle ────────────────────────────────────────────
async function handlePost(req, res, url) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to manage a market-maker');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let body;
	try { body = await readJson(req); } catch (e) { return error(res, 400, 'bad_request', e?.message || 'invalid body'); }

	const mint = mintFrom(url, body?.mint);
	const network = body?.network === 'devnet' ? 'devnet' : netOf(url);
	if (!mint || !MINT_RE.test(mint)) return error(res, 400, 'invalid_mint', 'a valid mint is required');

	// Owner-only: the coin must be one this user launched through three.ws.
	const launch = await resolveOwnedLaunch({ userId: auth.userId, mint, network });
	const existing = await getPolicyByMint(mint, network);
	if (!launch && !(existing && existing.user_id === auth.userId)) {
		return error(res, 403, 'forbidden', 'only the owner of a coin launched on three.ws can attach a market-maker to it');
	}
	if (auth.session && !(await requireCsrf(req, res, auth.userId))) return;

	const agentId = launch?.agent_id || existing?.agent_id;
	if (!agentId) return error(res, 409, 'no_agent', 'this launch has no agent wallet to run the market-maker from');

	const action = url.searchParams.get('action');
	try {
		if (action === 'pause') {
			const row = await upsertPolicy({ mint, network, agentId, userId: auth.userId, patch: { enabled: false } });
			return json(res, 200, { data: { policy: toPublicPolicy(row) } });
		}
		if (action === 'resume') {
			const row = await upsertPolicy({ mint, network, agentId, userId: auth.userId, patch: { enabled: true, kill_switch: false } });
			return json(res, 200, { data: { policy: toPublicPolicy(row) } });
		}
		if (action === 'kill') {
			const row = await upsertPolicy({ mint, network, agentId, userId: auth.userId, patch: { enabled: false, kill_switch: true } });
			return json(res, 200, { data: { policy: toPublicPolicy(row), withdraw_url: `/agent/${agentId}/wallet#withdraw` } });
		}
		if (action === 'withdraw') {
			// The MM never holds custody — funds live in the agent wallet. Halt the
			// maker, then route the owner to the wallet's audited withdraw flow.
			const row = await upsertPolicy({ mint, network, agentId, userId: auth.userId, patch: { enabled: false, kill_switch: true } });
			return json(res, 200, {
				data: {
					policy: toPublicPolicy(row),
					withdraw_url: `/agent/${agentId}/wallet#withdraw`,
					message: 'Market-maker halted. Withdraw the remaining inventory + SOL from the agent wallet.',
				},
			});
		}

		// Create or update from the supplied fields/preset.
		const patch = normalizePolicyPatch(body, { isCreate: !existing });
		const row = await upsertPolicy({ mint, network, agentId, userId: auth.userId, patch });
		return json(res, existing ? 200 : 201, { data: { policy: toPublicPolicy(row) } });
	} catch (e) {
		if (e instanceof PolicyError) return error(res, e.status, e.code, e.message, e.detail && Object.keys(e.detail).length ? { detail: e.detail } : {});
		console.error('[launch/mm] post failed', e?.message);
		return error(res, 500, 'internal_error', 'could not save the market-maker policy');
	}
}

async function handleDelete(req, res, url) {
	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to remove a market-maker');
	const mint = mintFrom(url, null);
	const network = netOf(url);
	if (!mint || !MINT_RE.test(mint)) return error(res, 400, 'invalid_mint', 'a valid mint is required');
	const existing = await getPolicyByMint(mint, network);
	if (!existing) return json(res, 200, { data: { removed: false } });
	if (existing.user_id !== auth.userId) return error(res, 403, 'forbidden', 'only the owner can remove this market-maker');
	if (auth.session && !(await requireCsrf(req, res, auth.userId))) return;
	await sql`DELETE FROM market_maker_policies WHERE id = ${existing.id}`;
	return json(res, 200, { data: { removed: true, withdraw_url: `/agent/${existing.agent_id}/wallet#withdraw` } });
}

// ── SSE live action feed ──────────────────────────────────────────────────────
async function handleStream(req, res, url) {
	const mint = mintFrom(url, null);
	const network = netOf(url);
	if (!mint || !MINT_RE.test(mint)) return error(res, 400, 'invalid_mint', 'a valid mint is required');
	const policy = await getPolicyByMint(mint, network);
	if (!policy) return error(res, 404, 'not_found', 'no market-maker is attached to this coin');

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Seed with the latest actions, then poll for new ones by id.
	let lastId = 0;
	try {
		const seed = await listActions(policy.id, { limit: 20, includeSkips: true });
		const ordered = seed.slice().reverse();
		for (const a of ordered) { lastId = Math.max(lastId, Number(a.id)); }
		send('open', { policy_id: policy.id, mint, network, actions: ordered.map(toPublicAction) });
	} catch {
		send('open', { policy_id: policy.id, mint, network, actions: [] });
	}

	const poll = setInterval(async () => {
		if (!active) return;
		try {
			const rows = await listActions(policy.id, { sinceId: lastId, limit: 50, includeSkips: true });
			for (const a of rows) {
				lastId = Math.max(lastId, Number(a.id));
				send('action', toPublicAction(a));
			}
			// Refresh policy aggregates so the UI's PnL/inventory stays live.
			const fresh = await getPolicyByMint(mint, network);
			if (fresh) send('state', toPublicPolicy(fresh));
		} catch { /* transient — next tick */ }
	}, SSE_POLL_MS);

	const ping = setInterval(() => send('ping', { t: Date.now() }), SSE_PING_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(poll);
		clearInterval(ping);
		clearTimeout(durationTimer);
		try { res.end(); } catch {}
	};
	const durationTimer = setTimeout(() => { send('close', { reason: 'duration_limit' }); teardown(); }, SSE_MAX_MS);
	req.on('close', teardown);
}

// ── catalog helpers (presets + disclosed guard caps for the UI) ──────────────
function presetCatalog() {
	return Object.entries(PRESETS).map(([key, v]) => ({ key, ...v }));
}
function guardInfo() {
	return {
		min_action_interval_seconds: GUARDS.MIN_ACTION_INTERVAL_SECONDS,
		side_flip_multiple: GUARDS.SIDE_FLIP_INTERVAL_MULTIPLE,
		max_volume_pct_ceiling: GUARDS.MAX_VOLUME_PCT_CEILING,
		max_recycle_pct: GUARDS.MAX_RECYCLE_PCT,
		graduation_actions: GRADUATION_ACTIONS,
		statement:
			'This market-maker is rules-based and non-manipulative: it cannot wash-trade, cannot dominate volume, ' +
			'discloses its full policy, and runs from the launch’s own audited wallet. The owner can pause, kill, or withdraw at any time.',
	};
}

export default wrap(handler);
