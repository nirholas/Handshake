// POST /api/home/:id/call, one Home Assistant service call, through the gate.
//
// Body: { domain, service, data, confirmed }
//
// This is the endpoint that can unlock a front door, so the shape of its refusal
// matters more than the shape of its success.
//
// A guarded action with no explicit yes comes back as 409 with the resolved
// action in `pending`. Not 403, which every HTTP client on earth treats as
// terminal and would turn "ask the user" into "give up". Not 200 with an error
// field, which a language model reads as SUCCESS and which is precisely how an
// agent talks itself into believing it locked a door it actually opened. 409 is
// a conflict with the current authorization state, and it is retryable with the
// same body plus a human's yes, which is exactly what this is.
//
// `confirmed: true` represents a person saying yes. It arrives from a client
// where a human pressed something. It is never set from model output, never
// inferred from phrasing, and never defaulted on, which is why it is read as a
// strict `=== true` below rather than as anything truthy: the string "false",
// which is what a form field or a sloppy serializer produces, is truthy in
// JavaScript and would open a door.
//
// Every outcome, including every refusal, writes a home_action_log row. A
// refused unlock is the single most important row in that table: it is the
// evidence that the gate held.

import { classifyCall, flattenEntities } from '@three-ws/home-bridge';

import { requireCsrf } from '../../_lib/csrf.js';
import { outOfScopeEntities, resolveHomeAccess } from '../../_lib/home/access.js';
import { can } from '../../_lib/home/members.js';
import { assertHomeActionAllowed, HomePausedError } from '../../_lib/home/entitlements.js';
import { homeError, homeFailure, HOME_ERR, toHomeFailure } from '../../_lib/home/errors.js';
import { acquire } from '../../_lib/home/runtime.js';
import { listAllowedEntities, logHomeAction } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

/** A Home Assistant domain or service name: lower snake case, nothing else. */
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// `act` admits the caller to the endpoint. Whether they may say yes to a
	// GUARDED action is a second question, asked below, and the two are different
	// on purpose: a guest may turn a light on and may never authorise an unlock.
	const access = await resolveHomeAccess(req, res, req.query?.id, 'act');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await limits.homeAct(caller.userId);
	if (!rl.success) {
		logHomeAction({
			homeId: home.id, userId: caller.userId, actor: actorFor(caller), channel: 'websocket',
			action: 'rate_limited', outcome: 'refused', detail: { reason: 'act bucket exhausted' },
		});
		return rateLimited(res, rl, 'too many home actions, slow down');
	}

	const body = await readJson(req, 32_000).catch(() => null);
	if (!body || typeof body !== 'object') {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'Send a JSON body with domain, service and data.'));
	}

	const domain = String(body.domain || '').toLowerCase();
	const service = String(body.service || '').toLowerCase();
	if (!NAME_RE.test(domain) || !NAME_RE.test(service)) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'domain and service must each be a Home Assistant name, for example "light" and "turn_on".'));
	}
	const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
	// Strict equality, on purpose. See the header: anything looser lets a string
	// through, and the string on the other side of this check is a lock.
	const confirmed = body.confirmed === true;

	const action = `${domain}.${service}`;
	const targets = entityIdsOf(data);

	// The role check on the confirmation, and the reason order 12 exists.
	//
	// `confirmed: true` is a human saying yes to something that opens a building.
	// A guest is admitted to this endpoint because a house sitter should be able
	// to turn the lights on, and a guest saying yes to an unlock is exactly what
	// a house sitter must not be able to do. So the refusal happens HERE, before
	// the socket is even acquired, and it is a refusal naming their role rather
	// than a confirmation prompt they could answer: a role that cannot confirm
	// must never be shown a door it could open.
	if (confirmed && !can(access.role, 'confirm')) {
		logHomeAction({
			homeId: home.id, userId: caller.userId, actor: actorFor(caller), channel: 'websocket',
			action, entityIds: targets, guarded: true, outcome: 'refused',
			detail: { reason: 'role_forbidden', role: access.role },
		});
		return error(res, 403, 'role_forbidden', `A ${access.role} cannot confirm a guarded action in this home.`);
	}

	// The plan check, and the ONE line in this file that is about money.
	//
	// It sits here, before the socket is acquired, and it checks the safety
	// exemption FIRST: locking a door, closing a garage or a valve and arming an
	// alarm are never refused by a commercial limit, on any plan, in any state,
	// including on a home this account's plan has paused. The classification
	// needs only the domain and the service, so the exemption does not depend on
	// the connection being healthy, which matters because the degraded states are
	// exactly the ones where somebody needs to lock up.
	//
	// A refusal is logged like every other refusal. A home_action_log row that
	// says "we would not do this because of a plan" is evidence the gate held for
	// a different reason, and the owner is entitled to see it.
	try {
		assertHomeActionAllowed({ home, call: { domain, service } });
	} catch (err) {
		if (!(err instanceof HomePausedError)) throw err;
		logHomeAction({
			homeId: home.id, userId: caller.userId, actor: actorFor(caller), channel: 'websocket',
			action, entityIds: targets, outcome: 'refused', detail: { reason: err.code },
		});
		return json(res, err.status, {
			error: err.code,
			error_description: err.message,
			code: err.code,
			message: err.message,
			upgrade: err.upgradePath,
		});
	}

	let checkout;
	try {
		checkout = await acquire(home.id, caller.userId);
	} catch (err) {
		const shaped = toHomeFailure(err);
		if (shaped.unexpected) throw err;
		logHomeAction({
			homeId: home.id, userId: caller.userId, actor: actorFor(caller), channel: 'websocket',
			action, entityIds: targets, outcome: 'failed', detail: { code: shaped.code },
		});
		return homeError(res, err);
	}

	const { bridge, release } = checkout;
	try {
		// The standing allowances are read fresh from the store on every call, not
		// once when the socket opened. A grant made thirty seconds ago has to be
		// live now, and a grant WITHDRAWN thirty seconds ago has to be gone now:
		// a pooled socket outliving a revoked allowance is a door that opens after
		// the user took the key back.
		await syncAllowList(bridge, home.id);

		// Scope, enforced on the way out as well as on the way in.
		//
		// A scoped member's room graph is filtered before it reaches them, so they
		// cannot SEE an out-of-scope entity. That is not a reason to skip checking
		// what they ASK for: the filtered graph is what an honest client renders,
		// and this endpoint takes an entity id straight from a request body. The
		// area is resolved from the live graph rather than trusted from the body,
		// because an area a caller names is an argument and an area an entity is
		// actually in is a fact.
		if (access.scoped) {
			const areaOf = new Map(flattenEntities(bridge.graph).map((e) => [e.entityId, e.areaId]));
			const refused = outOfScopeEntities(
				access.scope,
				targets.map((id) => ({ entityId: id, areaId: areaOf.get(id) ?? null })),
			);
			if (refused.length) {
				logHomeAction({
					homeId: home.id, userId: caller.userId, actor: actorFor(caller), channel: 'websocket',
					action, entityIds: refused, outcome: 'refused',
					detail: { reason: 'out_of_scope', role: access.role },
				});
				return error(res, 403, 'out_of_scope', 'That is not one of the things you were given access to in this home.');
			}
		}

		// Classified for the LOG, not for the decision. The decision is made once,
		// inside bridge.call, so there is exactly one gate and this cannot drift
		// away from it.
		const verdict = classifyCall({
			domain,
			service,
			entityId: targets[0],
			attributes: targets[0] ? bridge.states?.[targets[0]]?.attributes : undefined,
		});

		// Our own leg of the call, which is what the latency SLO is written against
		// (docs/ops/home-operations.md). It deliberately includes the house's
		// service call, because there is no point at which we can separate the two
		// from here; what it excludes is everything before the gate: auth, the
		// store read and the pool open. A p95 measured on a number nobody records
		// is a number nobody has, so this is stamped on every action rather than
		// sampled.
		const startedAt = Date.now();
		const result = await bridge.call(domain, service, data, { confirmed });
		const latencyMs = Date.now() - startedAt;

		logHomeAction({
			homeId: home.id,
			userId: caller.userId,
			actor: actorFor(caller),
			channel: 'websocket',
			action,
			entityIds: targets,
			guarded: verdict.guarded,
			confirmedBy: verdict.guarded && confirmed ? caller.userId : null,
			risk: verdict.risk,
			outcome: 'ok',
			detail: { via: caller.via, allowed_by_grant: verdict.guarded && !confirmed, latencyMs },
		});

		return json(res, 200, {
			ok: true,
			action,
			entity_ids: targets,
			guarded: verdict.guarded,
			risk: verdict.risk,
			confirmed: verdict.guarded ? confirmed : false,
			result: result ?? null,
		});
	} catch (err) {
		const shaped = toHomeFailure(err);
		if (shaped.unexpected) throw err;

		const refused = shaped.code === HOME_ERR.NEEDS_CONFIRMATION;
		logHomeAction({
			homeId: home.id,
			userId: caller.userId,
			actor: actorFor(caller),
			channel: 'websocket',
			action,
			// On a refusal the resolved target is the one the gate matched, which is
			// the entity a person is about to be asked about. Log THAT, not the raw
			// argument, so the audit trail and the confirmation prompt agree.
			entityIds: shaped.pending?.entityId ? [shaped.pending.entityId] : targets,
			guarded: refused,
			risk: shaped.pending?.risk ?? null,
			outcome: refused ? 'refused' : 'failed',
			detail: { code: shaped.code, reason: shaped.message.slice(0, 300) },
		});

		return homeError(res, err);
	} finally {
		release();
	}
});

/**
 * Apply this home's live standing allowances to the pooled bridge.
 *
 * The bridge holds an allow list built when its socket opened. Grants change
 * under it, so the set is replaced (not merely added to) from the store on every
 * action: withdrawal has to propagate as fast as grant does.
 */
async function syncAllowList(bridge, homeId) {
	const allowList = bridge?.allowList;
	if (!allowList) return;
	const live = new Set(await listAllowedEntities(homeId).catch(() => []));
	for (const existing of allowList.list()) if (!live.has(existing)) allowList.remove(existing);
	for (const id of live) allowList.add(id);
}

/** entity_id is a string or an array of them; the log wants the array either way. */
function entityIdsOf(data) {
	const id = data?.entity_id;
	if (Array.isArray(id)) return id.filter((v) => typeof v === 'string');
	return typeof id === 'string' ? [id] : [];
}

/** A bearer caller is an agent principal; a cookie session is a person at a screen. */
function actorFor(caller) {
	return caller.via === 'bearer' ? 'agent' : 'user';
}
