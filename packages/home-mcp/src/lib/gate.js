// The gate decision for the stdio server, in one place.
//
// THE DECISION: over stdio, a guarded action is REFUSED. It is never executed,
// and there is no tool argument that can execute it.
//
// Why. `confirmed: true` represents a human saying yes. An MCP stdio server has
// no human in it: its only caller is a model, the transport carries no session,
// and there is no browser to raise a prompt in. Anything the server accepted as
// a confirmation here would be model output wearing a person's clothes, which is
// exactly the failure the gate exists to prevent. Home Assistant's own
// `intent__HassTurnOff` performs an unlock on a lock, so "the model said it was
// fine" is the front door standing open.
//
// The one way through is a HUMAN action taken out of band: the person who starts
// this server sets HOME_ALLOWED_ENTITIES to specific entity ids. That is a
// standing allowance, per entity and per direction, identical to
// `HomeBridge.allowList`, and no tool can widen it. There is deliberately no
// tool that adds to the allow list, because a model that can grant itself
// permission does not have a gate.
//
// Everything that moves the house toward safety (locking, closing, arming) runs
// with no prompt, on every call, always. The asymmetry is the whole point.

import { ERR } from '@three-ws/home-bridge';

/** Where a person actually confirms a guarded action. */
export const CONFIRM_AT = 'https://three.ws/smart-home';

/**
 * Turn a bridge refusal into the answer the model should read.
 *
 * The model is told plainly that it cannot confirm, what a person would have to
 * do, and that retrying is pointless. A vague refusal invites a retry loop
 * against a front door.
 *
 * @param {Error & { code?: string, pending?: object }} err
 * @returns {object|null} the refusal payload, or null when this is not a gate refusal
 */
export function refusal(err) {
	if (err?.code !== ERR.NEEDS_CONFIRMATION) return null;
	const pending = err.pending || {};
	const targets = pending.entityId
		? [pending.entityId]
		: Array.isArray(pending.targets)
			? pending.targets
			: [];
	return {
		ok: false,
		error: ERR.NEEDS_CONFIRMATION,
		refused: true,
		risk: pending.risk || 'security',
		targets,
		message: err.message,
		why: 'This action opens the house, and this server has no way for a person to say yes: an MCP client carries no session and no browser. It is refused rather than guessed at.',
		how_a_person_confirms: [
			`Connect the house at ${CONFIRM_AT} and act through the hosted three.ws MCP server instead. That surface mints a pending confirmation and the account holder redeems it in their own browser, which is a person saying yes.`,
			'Or, for a standing allowance on this exact entity, the person running THIS server adds it to HOME_ALLOWED_ENTITIES and restarts:' +
				(targets.length ? ` HOME_ALLOWED_ENTITIES=${targets.join(',')}` : ' HOME_ALLOWED_ENTITIES=lock.office_door'),
		],
		retry: 'Do not retry this call. No argument you can pass will change the answer.',
	};
}
