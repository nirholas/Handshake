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

/**
 * Services that move a guarded entity toward locked, closed, or armed.
 *
 * This is the exact mirror of UNSAFE_SERVICES, and it is a separate set rather
 * than "everything not unsafe" on purpose: `light.turn_on` is not unsafe and it
 * is not a safety action either. Only the moves in here are the ones a quota,
 * a plan limit, or any other commercial gate is forbidden to block.
 */
const SAFE_SERVICES = new Set([
	'lock',
	'close',
	'close_cover',
	'close_valve',
	'alarm_arm_away',
	'alarm_arm_home',
	'alarm_arm_night',
	'alarm_arm_vacation',
	'alarm_arm_custom_bypass',
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

/**
 * The same gate, in front of the Model Context Protocol channel.
 *
 * This is not belt and braces, it is load bearing. Home Assistant's own Assist
 * tools are deliberately polymorphic, and its published description of
 * `intent__HassTurnOff` reads: "Turns off/closes a device or entity. For locks,
 * this performs an 'unlock' action." So a model that has been told to turn
 * something off can unlock a front door, and nothing in the tool name says so.
 *
 * We resolve the tool call's targets against the live entity list, translate
 * each one into the service it would really perform, and run the same
 * classification the WebSocket path uses.
 *
 * @param {string} toolName the MCP tool name, e.g. "intent__HassTurnOff"
 * @param {object} args the arguments the model produced
 * @param {Array<{entityId: string, name: string, domain: string, deviceClass: string|null, areaId: string|null, attributes: object}>} entities
 * @returns {{ guarded: boolean, risk: string|null, reason: string, targets: string[] }}
 */
export function classifyMcpCall(toolName, args = {}, entities = []) {
	const intent = String(toolName || '').split('__').pop();
	const direction = MCP_INTENT_DIRECTION[intent];
	if (!direction) return { guarded: false, risk: null, reason: '', targets: [] };

	const targets = resolveMcpTargets(args, entities);
	const hits = [];
	for (const entity of targets) {
		const service = serviceForDirection(entity.domain, direction);
		if (!service) continue;
		const verdict = classifyCall({ domain: entity.domain, service, entityId: entity.entityId, attributes: entity.attributes });
		if (verdict.guarded) hits.push({ entity, verdict });
	}
	if (!hits.length) return { guarded: false, risk: null, reason: '', targets: targets.map((e) => e.entityId) };

	const names = hits.map((h) => h.entity.name).join(', ');
	return {
		guarded: true,
		risk: hits[0].verdict.risk,
		reason: `"${toolName}" would ${direction === 'off' ? 'unlock or open' : 'open'} ${names}.`,
		targets: hits.map((h) => h.entity.entityId),
	};
}

/** Which way each Assist intent pushes an entity. */
const MCP_INTENT_DIRECTION = {
	HassTurnOn: 'on',
	HassTurnOff: 'off',
	HassSetPosition: 'position',
};

function serviceForDirection(domain, direction) {
	if (domain === 'lock') return direction === 'off' ? 'unlock' : 'lock';
	if (domain === 'cover') {
		if (direction === 'position') return 'set_cover_position';
		return direction === 'on' ? 'open_cover' : 'close_cover';
	}
	if (domain === 'valve') {
		if (direction === 'position') return 'set_valve_position';
		return direction === 'on' ? 'open_valve' : 'close_valve';
	}
	if (domain === 'alarm_control_panel') return direction === 'off' ? 'alarm_disarm' : 'alarm_arm_away';
	return null;
}

/**
 * Assist targets are a name, or a domain, or an area, or a device class, or any
 * combination. Reproduce that resolution so the gate sees the same entities the
 * intent will.
 */
export function resolveMcpTargets(args = {}, entities = []) {
	const name = normalizeTarget(args.name);
	const domains = toArray(args.domain).map(normalizeTarget).filter(Boolean);
	const deviceClasses = toArray(args.device_class).map(normalizeTarget).filter(Boolean);
	const area = normalizeTarget(args.area);

	// No target at all means "everything the intent applies to", which is the
	// broadest and therefore the most dangerous case, not the safest.
	const filtered = entities.filter((e) => {
		if (name && normalizeTarget(e.name) !== name && normalizeTarget(e.entityId) !== name) return false;
		if (domains.length && !domains.includes(e.domain)) return false;
		if (deviceClasses.length && !deviceClasses.includes(normalizeTarget(e.deviceClass))) return false;
		if (area && normalizeTarget(e.areaId) !== area && normalizeTarget(e.areaName) !== area) return false;
		return true;
	});
	return filtered;
}

function normalizeTarget(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/[\s_-]+/g, ' ')
		.trim();
}

function toArray(value) {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

/**
 * Does this call move the house toward safety?
 *
 * `classifyCall` answers the question the gate asks ("does this open the
 * house"). This answers the opposite one, and the two are deliberately not
 * complements: `light.turn_on` is neither. Locking a door, closing a garage,
 * closing a water valve and arming an alarm are the four moves in the set, and
 * they are the moves that must work when everything else about an account has
 * been cut off.
 *
 * Why it lives here, beside the gate, rather than in the billing code: the list
 * of things a lock can do is a fact about Home Assistant, not a fact about a
 * price list. Anything that needs to know "may I refuse this" imports this
 * function; nothing gets to keep its own copy of the list and drift from it.
 *
 * @param {object} call
 * @param {string} call.domain
 * @param {string} call.service
 * @returns {boolean}
 */
export function isSafetyAction({ domain, service } = {}) {
	const d = String(domain || '').toLowerCase();
	const s = String(service || '').toLowerCase();

	// Deliberately NOT filtered by device_class, unlike classifyCall. The gate has
	// to know whether a cover is a garage door before it will refuse opening it,
	// because opening a blind is nothing and opening a garage is an opening in the
	// building. Closing has no such asymmetry: there is no cover whose CLOSING is
	// dangerous, and no valve whose closing is dangerous.
	//
	// That is not a shortcut, it is the property that makes the exemption usable.
	// Reading device_class requires a live socket to the house, and the moment a
	// safety exemption depends on the connection being healthy it stops being an
	// exemption: the states where a user most needs to lock up (a paused home, a
	// degraded instance, an account over quota) are exactly the states where the
	// attributes are not in hand.
	if (d === 'cover' || d === 'valve') return SAFE_SERVICES.has(s);
	if (d === 'alarm_control_panel') return s.startsWith('alarm_arm') && SAFE_SERVICES.has(s);
	if (GUARDED_DOMAINS.has(d)) return SAFE_SERVICES.has(s);
	return false;
}

/**
 * The same question, in front of the MCP channel.
 *
 * `HassTurnOn` on a lock is a lock, and `HassTurnOff` on a garage door is a
 * close: the polymorphism that makes the gate necessary also means the safe
 * direction arrives under a tool name that says nothing about doors. Resolve the
 * targets the same way the gate does and ask `isSafetyAction` about each one.
 *
 * True only when the call touches at least one guarded entity and EVERY guarded
 * entity it touches moves toward safety. A mixed call is not a safety action,
 * because refusing it would still have refused a safety move, and allowing it
 * would have allowed something else through on a safety exemption.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {Array<object>} entities
 * @returns {boolean}
 */
export function isSafetyMcpCall(toolName, args = {}, entities = []) {
	const intent = String(toolName || '').split('__').pop();
	const direction = MCP_INTENT_DIRECTION[intent];
	if (!direction || direction === 'position') return false;

	let sawSafety = false;
	for (const entity of resolveMcpTargets(args, entities)) {
		const service = serviceForDirection(entity.domain, direction);
		if (!service) continue;
		const call = { domain: entity.domain, service, entityId: entity.entityId, attributes: entity.attributes };
		if (isSafetyAction(call)) {
			sawSafety = true;
			continue;
		}
		if (classifyCall(call).guarded) return false;
	}
	return sawSafety;
}
