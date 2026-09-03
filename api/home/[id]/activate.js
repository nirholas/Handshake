// POST /api/home/:id/activate, a phrase to a scene the user already built.
//
// Body: { phrase, dryRun, confirmed }
//
// "Good night" is not a feature we invent. It is a scene the user already built,
// in an editor they already know, and this route's whole job is to find it. The
// user's own Bedtime scene knows about the plant light and the fish tank, and no
// amount of reasoning over an entity list will.
//
// `dryRun: true` resolves the phrase and returns the match WITHOUT running it.
// That is not a debugging affordance, it is the voice loop's read-back step: an
// agent that heard "good night" through a microphone should be able to say "I'll
// run your Bedtime scene" and be told which scene that is before anything in the
// house moves.
//
// A phrase that matches nothing is a 200 with `ran: false` and `match: null`,
// never a 404. The house simply has no scene by that name, which is an ordinary
// answer the client renders as a suggestion, not a failure to report.

import { requireCsrf } from '../../_lib/csrf.js';
import { resolveHomeAccess } from '../../_lib/home/access.js';
import { can } from '../../_lib/home/members.js';
import { homeError, homeFailure, HOME_ERR, toHomeFailure } from '../../_lib/home/errors.js';
import { acquire } from '../../_lib/home/runtime.js';
import { listAllowedEntities, logHomeAction } from '../../_lib/home/store.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

/** Long enough for any spoken sentence, short enough not to be a payload. */
const PHRASE_MAX = 200;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	// Running a scene moves things in the world, so it needs `act`. A viewer is
	// refused here; a guest is admitted and then held to their scope below.
	const access = await resolveHomeAccess(req, res, req.query?.id, 'act');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	if (!(await requireCsrf(req, res, caller.userId))) return;

	const body = await readJson(req, 8_000).catch(() => null);
	const phrase = typeof body?.phrase === 'string' ? body.phrase.trim().slice(0, PHRASE_MAX) : '';
	if (!phrase) {
		return homeError(res, homeFailure(HOME_ERR.VALIDATION, 'Send a phrase, for example "good night".'));
	}
	const dryRun = body.dryRun === true || body.dry_run === true;
	// Strict `=== true`: see the note in call.js. A truthy string must never be
	// able to stand in for a person saying yes.
	const confirmed = body.confirmed === true;

	// The same role check call.js makes, for the same reason. A scene is a bundle
	// of service calls the user assembled themselves, and "good night" in a house
	// with a smart lock locks the door. Whether that bundle may be waved through a
	// guarded step is a question about the person, not about the phrase.
	if (confirmed && !can(access.role, 'confirm')) {
		return error(res, 403, 'role_forbidden', `A ${access.role} cannot confirm a guarded action in this home.`);
	}

	// A scoped member gets scenes, not the house. A scene reaches whatever its
	// author put in it, which for "good night" is usually every room, so running
	// one from a role that was given the kitchen is not something to narrow down
	// to the kitchen: it is something to refuse. Refusing is also the honest
	// answer, because a half-run scene is worse than no scene.
	if (access.scoped) {
		return error(res, 403, 'out_of_scope', 'Scenes run across the whole house, so they are not available on a scoped role.');
	}

	// A dry run moves nothing, so it is metered as a read. Charging it to the act
	// bucket would make the voice loop's read-back step compete with the actions
	// it is reading back, and the honest ceiling for "resolve a phrase" is the
	// same as for any other lookup.
	const rl = dryRun ? await limits.homeRead(caller.userId) : await limits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, dryRun ? 'too many home reads, slow down' : 'too many home actions, slow down');

	let checkout;
	try {
		checkout = await acquire(home.id, caller.userId);
	} catch (err) {
		const shaped = toHomeFailure(err);
		if (shaped.unexpected) throw err;
		return homeError(res, err);
	}

	const { bridge, release } = checkout;
	try {
		if (!dryRun) await syncAllowList(bridge, home.id);

		const outcome = await bridge.activate(phrase, { confirmed, dryRun });

		if (!outcome.match) {
			// Nothing ran and nothing was refused, so nothing is logged: the action
			// log records what the platform DID in a house, and a phrase that matched
			// no scene did nothing at all.
			return json(res, 200, {
				ran: false,
				match: null,
				phrase,
				macros: bridge.macros().map(macroShape),
			});
		}

		if (!dryRun) {
			logHomeAction({
				homeId: home.id,
				userId: caller.userId,
				actor: actorFor(caller),
				channel: 'websocket',
				action: `${outcome.match.kind}.turn_on`,
				entityIds: [outcome.match.entityId],
				guarded: false,
				risk: null,
				outcome: 'ok',
				detail: { phrase, macro: outcome.match.macro ?? null, score: outcome.match.score ?? null },
			});
		}

		return json(res, 200, {
			ran: outcome.ran,
			dry_run: dryRun,
			phrase,
			match: macroShape(outcome.match),
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
			action: shaped.pending?.domain && shaped.pending?.service ? `${shaped.pending.domain}.${shaped.pending.service}` : 'scene.turn_on',
			entityIds: shaped.pending?.entityId ? [shaped.pending.entityId] : [],
			guarded: refused,
			risk: shaped.pending?.risk ?? null,
			outcome: refused ? 'refused' : 'failed',
			detail: { phrase, code: shaped.code, reason: shaped.message.slice(0, 300) },
		});

		return homeError(res, err);
	} finally {
		release();
	}
});

/** Identical to call.js on purpose: withdrawal must propagate as fast as grant. */
async function syncAllowList(bridge, homeId) {
	const allowList = bridge?.allowList;
	if (!allowList) return;
	const live = new Set(await listAllowedEntities(homeId).catch(() => []));
	for (const existing of allowList.list()) if (!live.has(existing)) allowList.remove(existing);
	for (const id of live) allowList.add(id);
}

function macroShape(match) {
	return {
		entity_id: match.entityId,
		name: match.name,
		kind: match.kind,
		macro: match.macro ?? null,
		score: match.score ?? null,
	};
}

function actorFor(caller) {
	return caller.via === 'bearer' ? 'agent' : 'user';
}
