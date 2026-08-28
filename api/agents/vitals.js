// GET /api/agents/vitals: capability attestation for the autonomous trading fleet.
//
// Answers "can each armed agent actually act right now, and if not, what is the
// ONE thing to fix" rather than "is the process up". Every reading is live: the
// strategies table, the position ledger, a Solana RPC, the launch feed, the
// model chain, and the build time of the image the worker is really running.
//
// Root causes are reported, not symptoms. An arm blocked by a dead model chain
// that is itself caused by a stale deployment returns the deployment, once,
// with the command that fixes it. See packages/agent-vitals for the engine and
// docs/agent-vitals.md for the model.
//
// Auth is authorizeOps, the same gate as /api/ops/health: the response names
// wallet addresses, funding deficits and deploy commands, which is an operator
// view rather than a public one. It is deliberately never CRON_SECRET, so a
// leaked ops password cannot be escalated into triggering a job that moves funds.
//
// Read-only. It signs, funds and deploys nothing.
//
// Query:
//   network=mainnet|devnet   (default mainnet)
//   llm=1                    also probe the model chain (OFF by default here)
//
// The model probe sends a real completion, so it is opt-in over HTTP: this is a
// board an operator leaves polling, and a token spend per poll is a bill nobody
// asked for. The CLI defaults the other way, because a human runs it once. With
// the probe off, an arm that needs a model reports `cognition: unknown`, which
// keeps its capability `unknown` rather than inventing a pass.
//
// Response: { ok, network, at, shared, summary, arms: [{ name, can, root_causes, ... }] }

import { cors, error, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { authorizeOps } from '../_lib/ops-auth.js';
import { attestFleet, summarizeFleet } from '../_lib/agent-vitals/sniper-probe.js';

const NETWORKS = new Set(['mainnet', 'devnet']);

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// `authedReadIp` (300/5m), the same polled-read bucket the ops health board
	// uses, not the strict credential bucket: an operator watching this must never
	// spend the budget that gates their own sign-in from that IP.
	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// Hardened ops gate: admin session or a dedicated OPS_SECRET, fail-closed in
	// production, never CRON_SECRET.
	const auth = await authorizeOps(req);
	if (!auth.ok) return error(res, 401, 'unauthorized', 'admin session or x-ops-secret required');

	const url = new URL(req.url, 'http://localhost');
	const network = url.searchParams.get('network') || 'mainnet';
	if (!NETWORKS.has(network)) {
		return error(res, 400, 'invalid_network', `network must be one of: ${[...NETWORKS].join(', ')}`);
	}
	const includeCognition = url.searchParams.get('llm') === '1';

	const fleet = await attestFleet({ network, includeCognition });
	const summary = summarizeFleet(fleet.arms);

	return json(res, 200, {
		ok: true,
		network: fleet.network,
		at: fleet.at,
		shared: fleet.shared,
		summary: {
			total: summary.total,
			can_enter: summary.ready,
			cannot_enter: summary.unable,
			unreadable: summary.unknown,
			can_exit: summary.canExit,
			// Capable and still silent: nothing is broken, so the entry filters are
			// the answer. Naming that stops an operator hunting healthy infrastructure.
			capable_but_silent: summary.stalledButCapable,
			// A verdict the position ledger disproves. Surfaced rather than hidden:
			// a health model that cannot notice it is wrong gets trusted until it matters.
			contradictions: summary.contradictions,
			work_queue: summary.rootCauses,
		},
		arms: fleet.arms.map((arm) => ({
			agent_id: arm.agentId,
			name: arm.name,
			label: arm.label,
			wallet: arm.wallet,
			stalled: arm.stalled,
			activity: arm.activity,
			contradiction: arm.contradiction,
			can: arm.verdict.can,
			explain: arm.verdict.explain(),
			root_causes: arm.verdict.rootCauses.map((r) => ({
				id: r.id,
				status: r.status,
				detail: r.detail,
				remedy: r.remedy,
			})),
			vitals: arm.verdict.vitals.map((v) => ({
				id: v.id,
				status: v.status,
				detail: v.detail,
				blocked_by: v.blockedBy,
			})),
		})),
	});
});
