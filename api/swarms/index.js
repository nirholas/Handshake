// /api/swarms — trading-swarm directory + all mutations.
//
// GET  /api/swarms?network=&status=&limit=&offset=    public directory (aggregate track record)
// GET  /api/swarms?mine=1                              swarms the caller owns or is a member of
// POST /api/swarms { action, ... }                     create | join | contribute | exit | kill | pause | resume
//
// Every mutation that moves SOL (contribute, exit) executes a real on-chain
// transfer inside the lib, spend-guarded and audited. The treasury balance always
// ties to chain — there are no virtual balances here.
//
// Because those mutations move real funds from a custodial wallet, every POST
// carries the same two guards the rest of the platform's money writes do
// (security review L3): a CSRF token when the caller is a cookie session, so a
// third-party page can never spend on a signed-in visitor's behalf, and a
// per-user write budget so a hijacked session or runaway client can't fire an
// unbounded stream of contributes. Bearer/API-key callers are CSRF-exempt by
// construction (the token is the intent) and still metered.

import { cors, method, json, error, wrap, readJson, rateLimited } from '../_lib/http.js';
import { parseLimit, parseOffset } from '../_lib/http-params.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { limits } from '../_lib/rate-limit.js';
import {
	createSwarm, joinSwarm, contributeToSwarm, exitSwarm, killSwarm,
	setSwarmPaused, listSwarms, listSwarmsForUser, SwarmError,
} from '../_lib/swarms.js';

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function handleSwarmError(res, e) {
	if (e instanceof SwarmError) return error(res, e.status, e.code, e.message);
	throw e;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const url = new URL(req.url, 'http://x');

	if (req.method === 'GET') {
		const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';

		if (url.searchParams.get('mine') === '1') {
			const auth = await resolveAccount(req, res);
			if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
			// Includes killed/closed swarms the caller owns or joined — the only place
			// they can reach their own ended swarm dashboards.
			const data = await listSwarmsForUser(auth.userId);
			return json(res, 200, { data });
		}

		const status = url.searchParams.get('status');
		const limit = parseLimit(url.searchParams, { fallback: 30, max: 60 });
		const offset = parseOffset(url.searchParams);
		const data = await listSwarms({ network, status: status || null, limit, offset });
		return json(res, 200, { data });
	}

	// POST — all mutations require auth, CSRF (session callers), and a budget.
	const auth = await resolveAccount(req, res);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
	if (!(await requireCsrf(req, res, auth.userId))) return;
	const rl = await limits.swarmMutate(auth.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many swarm actions — slow down');
	const body = await readJson(req).catch(() => ({}));
	const action = String(body.action || '');

	const lamportsFromBody = () => {
		if (body.lamports != null) return BigInt(Math.max(0, Math.round(Number(body.lamports))));
		if (body.sol != null) return BigInt(Math.max(0, Math.round(Number(body.sol) * 1e9)));
		return 0n;
	};

	try {
		switch (action) {
			case 'create': {
				if (!isUuid(body.owner_agent_id)) return error(res, 400, 'bad_agent', 'owner_agent_id required');
				const swarm = await createSwarm({
					userId: auth.userId, ownerAgentId: body.owner_agent_id,
					name: body.name, description: body.description || null,
					network: body.network === 'devnet' ? 'devnet' : 'mainnet', policy: body.policy || {},
				});
				return json(res, 201, { data: { swarm } });
			}
			case 'join': {
				if (!isUuid(body.swarm_id)) return error(res, 400, 'bad_swarm', 'swarm_id required');
				if (!isUuid(body.agent_id)) return error(res, 400, 'bad_agent', 'agent_id required');
				const member = await joinSwarm({ userId: auth.userId, swarmId: body.swarm_id, agentId: body.agent_id });
				return json(res, 200, { data: { member } });
			}
			case 'contribute': {
				if (!isUuid(body.swarm_id)) return error(res, 400, 'bad_swarm', 'swarm_id required');
				if (!isUuid(body.agent_id)) return error(res, 400, 'bad_agent', 'agent_id required');
				const lamports = lamportsFromBody();
				if (lamports <= 0n) return error(res, 400, 'bad_amount', 'sol or lamports required');
				const result = await contributeToSwarm({ userId: auth.userId, swarmId: body.swarm_id, agentId: body.agent_id, lamports });
				return json(res, 200, { data: result });
			}
			case 'exit': {
				if (!isUuid(body.swarm_id)) return error(res, 400, 'bad_swarm', 'swarm_id required');
				if (!isUuid(body.agent_id)) return error(res, 400, 'bad_agent', 'agent_id required');
				const result = await exitSwarm({ userId: auth.userId, swarmId: body.swarm_id, agentId: body.agent_id });
				return json(res, 200, { data: result });
			}
			case 'kill': {
				if (!isUuid(body.swarm_id)) return error(res, 400, 'bad_swarm', 'swarm_id required');
				const swarm = await killSwarm({ userId: auth.userId, swarmId: body.swarm_id, reason: body.reason || null });
				return json(res, 200, { data: { swarm } });
			}
			case 'pause':
			case 'resume': {
				if (!isUuid(body.swarm_id)) return error(res, 400, 'bad_swarm', 'swarm_id required');
				const swarm = await setSwarmPaused({ userId: auth.userId, swarmId: body.swarm_id, paused: action === 'pause' });
				return json(res, 200, { data: { swarm } });
			}
			default:
				return error(res, 400, 'bad_action', 'unknown action');
		}
	} catch (e) {
		return handleSwarmError(res, e);
	}
});
