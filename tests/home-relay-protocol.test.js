// The relay's allowlist is enforced twice: here in JavaScript, and again in
// Python inside the house. Two enforcement points that drift apart are worse
// than one, so the Python side reads `services/home-relay/allowlist.json`
// rather than transcribing the rules, and that file is generated from
// `src/protocol.js` by `scripts/gen-allowlist.mjs`.
//
// This suite is the guard on that arrangement. A rule changed in protocol.js
// without regenerating the manifest fails here, loudly, instead of leaving the
// relay refusing one thing and the integration refusing another.
//
//   npx vitest run tests/home-relay-protocol.test.js

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	allowlistManifest,
	checkInbound,
	checkOutbound,
} from '../services/home-relay/src/protocol.js';

const checkedIn = JSON.parse(
	readFileSync(new URL('../services/home-relay/allowlist.json', import.meta.url), 'utf8'),
);

describe('the generated allowlist manifest', () => {
	it('matches the checked-in file the Home Assistant integration reads', () => {
		// If this fails: node services/home-relay/scripts/gen-allowlist.mjs
		expect(checkedIn).toEqual(allowlistManifest());
	});

	it('carries the shape the Python side destructures', () => {
		for (const key of [
			'protocolVersion',
			'minAgentProtocol',
			'frameTypes',
			'outboundTypes',
			'inboundTypes',
			'allowedEventTypes',
			'deniedServiceDomains',
			'deniedServices',
			'limits',
		]) {
			expect(checkedIn, `allowlist.json is missing ${key}`).toHaveProperty(key);
		}
	});
});

describe('what the relay carries into a house', () => {
	it('allows the reads the room graph is built from', () => {
		for (const type of [
			'get_states',
			'get_config',
			'config/floor_registry/list',
			'config/area_registry/list',
			'config/device_registry/list',
			'config/entity_registry/list',
			'subscribe_entities',
		]) {
			expect(checkOutbound({ type }).allowed, `${type} should be carried`).toBe(true);
		}
	});

	it('refuses a message type that is not on the list', () => {
		const verdict = checkOutbound({ type: 'config/auth_provider/homeassistant/create' });
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toMatch(/not a message type this relay carries into a home/);
	});

	it('limits subscribe_events to the one event type the room graph needs', () => {
		expect(checkOutbound({ type: 'subscribe_events', event_type: 'state_changed' }).allowed).toBe(true);
		const verdict = checkOutbound({ type: 'subscribe_events', event_type: 'call_service' });
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toMatch(/more of the house than the room graph needs/);
	});

	it('refuses every service domain that can execute code or take the instance down', () => {
		for (const domain of checkedIn.deniedServiceDomains) {
			const verdict = checkOutbound({ type: 'call_service', domain, service: 'anything' });
			expect(verdict.allowed, `${domain}.anything must be refused`).toBe(false);
		}
	});

	it('refuses the named services that survive a permitted domain', () => {
		for (const named of checkedIn.deniedServices) {
			const [domain, service] = named.split('.');
			const verdict = checkOutbound({ type: 'call_service', domain, service });
			expect(verdict.allowed, `${named} must be refused`).toBe(false);
		}
	});

	it('still carries an ordinary service call, including the one that locks up', () => {
		expect(
			checkOutbound({ type: 'call_service', domain: 'light', service: 'turn_on' }).allowed,
		).toBe(true);
		expect(checkOutbound({ type: 'call_service', domain: 'lock', service: 'lock' }).allowed).toBe(true);
	});

	it('refuses anything that is not an object', () => {
		for (const junk of [null, undefined, 'get_states', 42, ['get_states']]) {
			expect(checkOutbound(junk).allowed, `${JSON.stringify(junk)} must be refused`).toBe(false);
		}
	});
});

describe('what the relay carries out of a house', () => {
	it('allows only results, events and pongs', () => {
		for (const type of checkedIn.inboundTypes) {
			expect(checkInbound({ type }).allowed, `${type} should be carried`).toBe(true);
		}
		const verdict = checkInbound({ type: 'auth_required' });
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason).toMatch(/not a message type this relay carries out of a home/);
	});

	it('refuses anything that is not an object', () => {
		for (const junk of [null, undefined, 'result', 7, []]) {
			expect(checkInbound(junk).allowed, `${JSON.stringify(junk)} must be refused`).toBe(false);
		}
	});
});
