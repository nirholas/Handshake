// `call_service`: act on the house, through the gate.
//
// Safe moves run. Guarded moves are refused, never queued and never guessed at:
// see src/lib/gate.js for the decision and why an MCP client cannot confirm one.

import { z } from 'zod';

import { home } from '../lib/home.js';
import { refusal } from '../lib/gate.js';

export const def = {
	name: 'call_service',
	title: 'Call a Home Assistant service, subject to the physical-action gate',
	annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	description:
		'Run one Home Assistant service call, e.g. domain "light", service "turn_on", entity_id ' +
		'"light.kitchen". Get entity ids from `list_entities`. Extra service data (brightness_pct, ' +
		'temperature, position and so on) goes in `data`. ' +
		'THE GATE: anything that moves the house toward safety runs immediately and never prompts (lock, ' +
		'close_cover, close_valve, alarm_arm_*). Anything that OPENS the house is refused by this server and ' +
		'cannot be run from here (unlock, open_cover and open_valve on a door, gate or garage, alarm_disarm, ' +
		'and toggle on any of them), because confirming a physical action needs a person and an MCP client has ' +
		'no person in it. A refusal comes back with `refused: true` and tells you where a human confirms; do ' +
		'not retry it and do not look for an argument that overrides it, because there is none. Everything ' +
		'else (lights, climate, switches, fans, media, covers that are not an opening in the building) just ' +
		'runs.',
	inputSchema: {
		domain: z.string().min(1).describe('The service domain, e.g. "light", "climate", "lock", "cover".'),
		service: z
			.string()
			.min(1)
			.describe('The service, e.g. "turn_on", "set_temperature", "lock", "close_cover".'),
		entity_id: z
			.string()
			.min(1)
			.optional()
			.describe('The entity to act on, e.g. "light.kitchen_lights". Omit only for a service that takes no target.'),
		data: z
			.record(z.any())
			.optional()
			.describe('Extra service data, e.g. { "brightness_pct": 40 } or { "temperature": 21 }.'),
	},
	async handler(args = {}) {
		const domain = String(args.domain || '').trim();
		const service = String(args.service || '').trim();
		if (!domain || !service) {
			return { ok: false, error: 'bad_request', message: 'Both `domain` and `service` are required.' };
		}

		const data = { ...(args.data && typeof args.data === 'object' ? args.data : {}) };
		if (args.entity_id) data.entity_id = args.entity_id;

		const bridge = await home();
		try {
			// No options argument, ever. `confirmed` is a human's yes and this
			// transport has no human in it; the only way past the gate is the
			// operator's out-of-band HOME_ALLOWED_ENTITIES, which the bridge's own
			// allow list already holds.
			await bridge.call(domain, service, data);
		} catch (err) {
			const refused = refusal(err);
			if (refused) return refused;
			throw err;
		}

		return {
			ok: true,
			ran: `${domain}.${service}`,
			target: data.entity_id || null,
			note: 'Home Assistant accepted the call. Read the result with home_overview or list_entities; state settles asynchronously.',
		};
	},
};
