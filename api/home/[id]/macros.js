// GET /api/home/:id/macros: the scenes and scripts this house already has.
//
// For the UI, which lists them as buttons, and for the agent, which needs to
// know that "Bedtime" exists before it starts composing twelve individual
// service calls to approximate it. The user's own scene knows about the plant
// light and the fish tank; a composed sequence never will.
//
// The canonical macros (good night, leaving, arriving, morning, movie, focus)
// come back alongside, each annotated with whether this house has something that
// matches it. That is what lets a connect screen say "you have no Leaving scene,
// here is what one usually does" instead of showing an empty list and no next
// step.

import { MACROS, resolveIntent } from '@three-ws/home-bridge';

import { resolveHomeAccess } from '../../_lib/home/access.js';
import { toHomeFailure } from '../../_lib/home/errors.js';
import { withHome } from '../../_lib/home/runtime.js';
import { cors, error, json, method, rateLimited, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const access = await resolveHomeAccess(req, res, req.query?.id, 'read');
	if (!access.ok) return error(res, access.status, access.code, access.message);
	const { caller, home } = access;

	const rl = await limits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many home reads, slow down');

	try {
		const payload = await withHome(home.id, caller.userId, (bridge) => {
			const macros = bridge.macros();
			return {
				macros: macros.map((m) => ({ entity_id: m.entityId, name: m.name, kind: m.kind })),
				// Resolved against this house's real scene names, so an empty `match`
				// is a true statement about the house and not a guess.
				canonical: Object.entries(MACROS).map(([id, macro]) => {
					const match = resolveIntent(macro.triggers[0], macros);
					return {
						id,
						label: macro.label,
						example_phrase: macro.triggers[0],
						match: match ? { entity_id: match.entityId, name: match.name, kind: match.kind } : null,
					};
				}),
			};
		});
		return json(res, 200, payload);
	} catch (err) {
		const shaped = toHomeFailure(err);
		if (shaped.unexpected) throw err;
		return error(res, shaped.status, shaped.code, shaped.message, {
			code: shaped.code,
			message: shaped.message,
			...(shaped.detailCode ? { detail_code: shaped.detailCode } : {}),
		});
	}
});
