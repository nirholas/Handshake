/**
 * The physical-action gate.
 *
 * A voice channel that can unlock a front door on a misheard phoneme is not a
 * feature. This module decides which calls the agent may make on its own and
 * which ones need the user to say yes, using the same shape as the on-chain
 * spend gate: reads are free, and the irreversible or security-relevant writes
 * stop and ask.
 *
 * The rule is deliberately asymmetric. Locking up, closing the garage, and
 * arming the alarm move the house toward safety and never prompt. Unlocking,
 * opening, and disarming move it away from safety and always do, until the user
 * grants a standing allowance for that specific entity.
 */

/** Domains where the unsafe direction needs confirmation every time. */
export const GUARDED_DOMAINS = new Set(['lock', 'alarm_control_panel', 'valve']);

/** Cover device classes that are an opening in the building envelope. */
export const GUARDED_COVER_CLASSES = new Set(['garage', 'gate', 'door']);

/** Services that move a guarded entity toward "open", "unlocked", or "off guard". */
const UNSAFE_SERVICES = new Set([
	'unlock',
	'open',
	'open_cover',
	'open_valve',
	'set_cover_position',
	'set_valve_position',
	'alarm_disarm',
	'toggle',
]);

/** Everything a read-only agent may do without ever prompting. */
export const READ_ONLY_SERVICES = new Set(['get_states', 'get_config', 'get_services']);

/**
 * @param {object} call
 * @param {string} call.domain e.g. "lock"
 * @param {string} call.service e.g. "unlock"
 * @param {string} [call.entityId]
 * @param {object} [call.attributes] the entity's current attributes, for device_class
 * @returns {{ guarded: boolean, risk: ('security'|'physical'|null), reason: string }}
 */
export function classifyCall({ domain, service, entityId, attributes = {} } = {}) {
	const d = String(domain || '').toLowerCase();
	const s = String(service || '').toLowerCase();
	const deviceClass = String(attributes.device_class || '').toLowerCase();
	const label = entityId || d;

	if (d === 'cover' && GUARDED_COVER_CLASSES.has(deviceClass)) {
		if (UNSAFE_SERVICES.has(s)) {
			return { guarded: true, risk: 'physical', reason: `Opening ${label} is a physical opening in the building.` };
		}
		return { guarded: false, risk: null, reason: '' };
	}

	if (d === 'alarm_control_panel') {
		if (s === 'alarm_disarm') {
			return { guarded: true, risk: 'security', reason: `Disarming ${label} turns the alarm system off.` };
		}
		return { guarded: false, risk: null, reason: '' };
	}

	if (GUARDED_DOMAINS.has(d) && UNSAFE_SERVICES.has(s)) {
		return { guarded: true, risk: d === 'lock' ? 'security' : 'physical', reason: `"${s}" on ${label} cannot be safely undone remotely.` };
	}

	return { guarded: false, risk: null, reason: '' };
}

/**
 * A standing allowance is per entity and per direction, never per domain: a user
 * who lets the agent open the office door has not let it open the front door.
 *
 * @param {Iterable<string>} entityIds entity ids the user has pre-approved
 */
export function createAllowList(entityIds = []) {
	const allowed = new Set(entityIds);
	return {
		has: (entityId) => allowed.has(entityId),
		add: (entityId) => allowed.add(entityId),
		remove: (entityId) => allowed.delete(entityId),
		list: () => [...allowed],
	};
}
