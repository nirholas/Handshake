// The relay protocol and its allowlist.
//
// This is the file that has to be right. The allowlist is the only thing
// standing between "three.ws can read your room graph and turn your lights on"
// and "three.ws can do anything to the machine your house runs on", so it is
// tested exhaustively and without a network: `protocol.js` is pure on purpose.
//
// The tests are organised by the question a reviewer would actually ask:
// what may go in, what may come out, what is refused, and can the two
// enforcement points (the relay in JavaScript, the integration in Python)
// disagree.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	ALLOWED_EVENT_TYPES,
	CODE,
	DENIED_SERVICES,
	DENIED_SERVICE_DOMAINS,
	FRAME,
	INBOUND_TYPES,
	LIMITS,
	MIN_AGENT_PROTOCOL,
	OUTBOUND_TYPES,
	PROTOCOL_VERSION,
	allowlistManifest,
	checkInbound,
	checkOutbound,
	decodeFrame,
	encodeFrame,
	frames,
	negotiate,
} from '../services/home-relay/src/protocol.js';
import { constantTimeEquals, mintInstallToken, newRelayId, verifyInstallToken } from '../services/home-relay/src/token.js';

const KEY = 'k'.repeat(48);

describe('what the platform may send into a house', () => {
	it('allows exactly the message types the client library emits', () => {
		// Derived from home-assistant-js-websocket and packages/home-bridge, not
		// from a wish list. If this set grows, something upstream started sending
		// something new and that is a decision, not a detail.
		expect([...OUTBOUND_TYPES].sort()).toEqual(
			[
				'call_service',
				'config/area_registry/list',
				'config/device_registry/list',
				'config/entity_registry/list',
				'config/floor_registry/list',
				'get_config',
				'get_states',
				'ping',
				'subscribe_entities',
				'subscribe_events',
				'supported_features',
				'unsubscribe_events',
			].sort(),
		);
		for (const type of OUTBOUND_TYPES) {
			if (type === 'subscribe_events' || type === 'call_service') continue;
			expect(checkOutbound({ type })).toEqual({ allowed: true });
		}
	});

	it('refuses a type that is not on the list', () => {
		for (const type of ['get_services', 'auth/current_user', 'config/auth/create', 'render_template', 'execute_script']) {
			const verdict = checkOutbound({ type });
			expect(verdict.allowed).toBe(false);
			expect(verdict.code).toBe(CODE.NOT_ALLOWED);
			expect(verdict.reason).toContain(type);
		}
	});

	it('never carries an authentication frame, because auth never crosses the relay', () => {
		expect(checkOutbound({ type: 'auth', access_token: 'x' }).allowed).toBe(false);
		expect(OUTBOUND_TYPES).not.toContain('auth');
		expect(INBOUND_TYPES).not.toContain('auth_required');
		expect(INBOUND_TYPES).not.toContain('auth_ok');
	});

	it('limits subscribe_events to the one event the state channel needs', () => {
		expect(checkOutbound({ type: 'subscribe_events', event_type: 'state_changed' })).toEqual({ allowed: true });
		// A bare subscribe_events is a firehose of everything happening in the
		// house, including other integrations' service calls.
		expect(checkOutbound({ type: 'subscribe_events' }).allowed).toBe(false);
		expect(checkOutbound({ type: 'subscribe_events', event_type: 'call_service' }).allowed).toBe(false);
		expect(ALLOWED_EVENT_TYPES).toEqual(['state_changed']);
	});

	it('allows ordinary device control, including the guarded ones', () => {
		// The relay is not the safety gate. An unlock is allowed HERE and refused
		// by packages/home-bridge/src/safety.js until a human says yes; conflating
		// the two would mean a confirmed unlock could never run.
		expect(checkOutbound({ type: 'call_service', domain: 'light', service: 'turn_on' })).toEqual({ allowed: true });
		expect(checkOutbound({ type: 'call_service', domain: 'lock', service: 'unlock' })).toEqual({ allowed: true });
		expect(checkOutbound({ type: 'call_service', domain: 'alarm_control_panel', service: 'alarm_disarm' })).toEqual({ allowed: true });
		expect(checkOutbound({ type: 'call_service', domain: 'scene', service: 'turn_on' })).toEqual({ allowed: true });
	});

	it('refuses a service call that would own the machine rather than a device', () => {
		for (const domain of DENIED_SERVICE_DOMAINS) {
			const verdict = checkOutbound({ type: 'call_service', domain, service: 'anything' });
			expect(verdict.allowed, `${domain} must be refused`).toBe(false);
			expect(verdict.code).toBe(CODE.NOT_ALLOWED);
		}
		for (const full of DENIED_SERVICES) {
			const [domain, service] = full.split('.');
			expect(checkOutbound({ type: 'call_service', domain, service }).allowed, `${full} must be refused`).toBe(false);
		}
	});

	it('refuses a call_service that is missing its target verb', () => {
		expect(checkOutbound({ type: 'call_service', domain: 'light' }).code).toBe(CODE.MALFORMED);
		expect(checkOutbound({ type: 'call_service', service: 'turn_on' }).code).toBe(CODE.MALFORMED);
		expect(checkOutbound({ type: 'call_service', domain: 'light', service: 'turn_on', return_response: 'yes' }).code).toBe(CODE.MALFORMED);
	});

	it('refuses anything that is not an object', () => {
		for (const value of [null, undefined, 'get_states', 42, ['get_states']]) {
			expect(checkOutbound(value).allowed).toBe(false);
		}
	});

	it('bounds an attacker-controlled type in the refusal message', () => {
		const verdict = checkOutbound({ type: 'x'.repeat(500) });
		expect(verdict.allowed).toBe(false);
		expect(verdict.reason.length).toBeLessThan(200);
	});
});

describe('what a house may send out', () => {
	it('allows the three reply shapes Home Assistant answers in', () => {
		expect(INBOUND_TYPES).toEqual(['result', 'event', 'pong']);
		for (const type of INBOUND_TYPES) expect(checkInbound({ type })).toEqual({ allowed: true });
	});

	it('refuses anything else, including the auth handshake', () => {
		for (const type of ['auth_required', 'auth_ok', 'auth_invalid', 'call_service']) {
			expect(checkInbound({ type }).allowed, `${type} must not leave the house`).toBe(false);
		}
	});
});

describe('framing', () => {
	it('round-trips every frame builder', () => {
		const built = [
			frames.hello('hr_x', { name: 'n', version: '1' }),
			frames.helloOk('hr_x', { version: '1' }),
			frames.helloErr(CODE.REVOKED, 'gone'),
			frames.ping(1),
			frames.pong(1),
			frames.sessionOpen('s_1'),
			frames.sessionReady('s_1', '2026.9.0'),
			frames.sessionClose('s_1', CODE.OK, 'done'),
			frames.ha('s_1', { type: 'get_states' }),
		];
		for (const frame of built) {
			const decoded = decodeFrame(encodeFrame(frame));
			expect(decoded.ok, JSON.stringify(frame)).toBe(true);
			expect(decoded.frame).toEqual(frame);
		}
	});

	it('refuses a frame from a different protocol version', () => {
		const decoded = decodeFrame(JSON.stringify({ v: 99, t: FRAME.PING }));
		expect(decoded.ok).toBe(false);
		expect(decoded.code).toBe(CODE.MALFORMED);
	});

	it('refuses an unknown frame type, malformed JSON and a non-object', () => {
		expect(decodeFrame(JSON.stringify({ v: 1, t: 'exec' })).ok).toBe(false);
		expect(decodeFrame('{oh no').ok).toBe(false);
		expect(decodeFrame(JSON.stringify([1, 2])).ok).toBe(false);
		expect(decodeFrame(JSON.stringify({ v: 1, t: FRAME.HA, sid: 's_1' })).ok).toBe(false);
	});

	it('requires a well-formed session id on every session frame', () => {
		for (const sid of ['', '../etc', 'a'.repeat(65), 42, null]) {
			expect(decodeFrame(JSON.stringify({ v: 1, t: FRAME.SESSION_OPEN, sid })).ok, String(sid)).toBe(false);
		}
		expect(decodeFrame(JSON.stringify({ v: 1, t: FRAME.SESSION_OPEN, sid: 's_abc-123_X' })).ok).toBe(true);
	});

	it('refuses a frame larger than the cap without parsing it', () => {
		const decoded = decodeFrame('x'.repeat(LIMITS.maxFrameBytes + 1));
		expect(decoded.ok).toBe(false);
		expect(decoded.message).toContain('exceeds');
	});
});

describe('version negotiation', () => {
	it('accepts the current version', () => {
		expect(negotiate(PROTOCOL_VERSION)).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
	});

	it('names the upgrade path when the integration is too old', () => {
		const verdict = negotiate(MIN_AGENT_PROTOCOL - 1);
		expect(verdict.ok).toBe(false);
		expect(verdict.code).toBe(CODE.PROTOCOL_TOO_OLD);
		expect(verdict.message).toMatch(/HACS/);
	});

	it('says the relay is behind rather than blaming the house', () => {
		const verdict = negotiate(PROTOCOL_VERSION + 1);
		expect(verdict.code).toBe(CODE.PROTOCOL_TOO_NEW);
		expect(verdict.message).toMatch(/retrying/);
	});

	it('refuses a non-integer version', () => {
		expect(negotiate('1').ok).toBe(false);
		expect(negotiate(1.5).ok).toBe(false);
	});
});

describe('install tokens', () => {
	it('round-trips the claims the relay routes on', () => {
		const relayId = newRelayId();
		const token = mintInstallToken({ relayId, userId: 'u1', homeId: 'h1' }, KEY);
		const verdict = verifyInstallToken(token, KEY);
		expect(verdict.ok).toBe(true);
		expect(verdict.claims).toMatchObject({ relayId, userId: 'u1', homeId: 'h1' });
	});

	it('refuses a tampered payload, so a token cannot be re-aimed at another house', () => {
		const mine = mintInstallToken({ relayId: 'hr_mine', userId: 'u1', homeId: 'h1' }, KEY);
		const [prefix, , mac] = mine.split('.');
		const forgedPayload = Buffer.from(JSON.stringify({ rid: 'hr_yours', uid: 'u1', hid: 'h1', iat: 1 }))
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(verifyInstallToken(`${prefix}.${forgedPayload}.${mac}`, KEY).ok).toBe(false);
	});

	it('refuses a token signed with a different key', () => {
		const token = mintInstallToken({ relayId: 'hr_x', userId: 'u', homeId: 'h' }, KEY);
		expect(verifyInstallToken(token, 'j'.repeat(48)).ok).toBe(false);
	});

	it('refuses garbage without throwing', () => {
		for (const value of ['', 'hr1.a', 'nope', null, undefined, 'hr1..']) {
			expect(verifyInstallToken(value, KEY).ok).toBe(false);
		}
	});

	it('insists on a real signing key rather than silently accepting a weak one', () => {
		expect(() => mintInstallToken({ relayId: 'a', userId: 'b', homeId: 'c' }, 'short')).toThrow(/32 characters/);
	});

	it('mints relay ids that are unique and URL safe', () => {
		const ids = new Set(Array.from({ length: 500 }, () => newRelayId()));
		expect(ids.size).toBe(500);
		for (const id of ids) expect(id).toMatch(/^hr_[A-Za-z0-9_-]{24}$/);
	});

	it('compares secrets without a length side channel', () => {
		expect(constantTimeEquals('abc', 'abc')).toBe(true);
		expect(constantTimeEquals('abc', 'abd')).toBe(false);
		expect(constantTimeEquals('abc', 'a')).toBe(false);
		expect(constantTimeEquals('', '')).toBe(true);
	});
});

describe('the two enforcement points cannot drift', () => {
	it('the generated allowlist.json still matches protocol.js', () => {
		// The Python side inside the house reads this file rather than
		// transcribing the rules. Regenerate with:
		//   node services/home-relay/scripts/gen-allowlist.mjs
		const onDisk = JSON.parse(readFileSync(new URL('../services/home-relay/allowlist.json', import.meta.url), 'utf8'));
		expect(onDisk).toEqual(allowlistManifest());
	});

	it('the copy shipped inside the Home Assistant integration is byte identical', () => {
		const service = readFileSync(new URL('../services/home-relay/allowlist.json', import.meta.url), 'utf8');
		const integration = readFileSync(
			new URL('../home-assistant-integration/custom_components/three_ws/allowlist.json', import.meta.url),
			'utf8',
		);
		expect(integration).toBe(service);
	});

	it('the integration enforces the same rules the relay does', () => {
		// A structural check rather than a running Python one: every denied domain
		// and every allowed type has to appear in the manifest the Python reads,
		// because that file IS its rule set.
		const manifest = allowlistManifest();
		expect(manifest.outboundTypes).toEqual([...OUTBOUND_TYPES]);
		expect(manifest.deniedServiceDomains).toEqual([...DENIED_SERVICE_DOMAINS]);
		expect(manifest.limits.maxFrameBytes).toBe(LIMITS.maxFrameBytes);
	});
});
