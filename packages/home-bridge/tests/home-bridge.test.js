// The room graph, the intent resolver, and the physical-action gate all run
// against fixtures/home.json, which is a recording of a real Home Assistant
// instance (see scripts/capture-home-fixture.mjs), not hand-written shapes. A
// registry change upstream shows up here rather than in someone's house.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	buildHomeGraph,
	classifyCall,
	classifyMcpCall,
	createAllowList,
	ERR,
	flattenEntities,
	HomeBridge,
	isPrivateHost,
	matchMacro,
	normalizeBaseUrl,
	resolveIntent,
	resolveMcpTargets,
	summarizeClimate,
	summarizeLighting,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const home = JSON.parse(readFileSync(path.join(HERE, 'fixtures/home.json'), 'utf8'));
const graph = buildHomeGraph(home);
const entities = flattenEntities(graph);
const macros = Object.values(home.states)
	.filter((s) => s.entity_id.startsWith('scene.') || s.entity_id.startsWith('script.'))
	.map((s) => ({ entityId: s.entity_id, name: s.attributes.friendly_name || s.entity_id }));

describe('normalizeBaseUrl', () => {
	it('accepts what a person actually types', () => {
		expect(normalizeBaseUrl('home.example.com').http).toBe('https://home.example.com');
		expect(normalizeBaseUrl('  https://home.example.com/  ').http).toBe('https://home.example.com');
		expect(normalizeBaseUrl('http://192.168.1.10:8123').http).toBe('http://192.168.1.10:8123');
	});

	it('derives the websocket URL, preserving a reverse-proxy path prefix', () => {
		expect(normalizeBaseUrl('https://example.com/ha/').ws).toBe('wss://example.com/ha/api/websocket');
		expect(normalizeBaseUrl('http://localhost:8123').ws).toBe('ws://localhost:8123/api/websocket');
	});

	it('rejects input that cannot work', () => {
		expect(() => normalizeBaseUrl('')).toThrow(/required/i);
		expect(() => normalizeBaseUrl('ftp://home')).toThrow(/scheme/i);
	});

	it('explains the mixed-content wall before the browser hits it', () => {
		expect(() => normalizeBaseUrl('http://192.168.1.10:8123', { requireSecure: true })).toThrow(/plain http/i);
		// Loopback is exempt: a browser treats it as a secure context.
		expect(normalizeBaseUrl('http://localhost:8123', { requireSecure: true }).loopback).toBe(true);
	});

	it('knows which hosts a cloud server can never route to', () => {
		for (const h of ['homeassistant.local', '192.168.1.10', '10.0.0.4', '172.16.9.1', '127.0.0.1', 'nas.lan']) {
			expect(isPrivateHost(h), h).toBe(true);
		}
		for (const h of ['home.example.com', 'abc123.ui.nabu.casa', '8.8.8.8']) {
			expect(isPrivateHost(h), h).toBe(false);
		}
	});
});

describe('room graph', () => {
	it('groups the real instance into its real rooms', () => {
		expect(graph.rooms.map((r) => r.name)).toEqual(['Bedroom', 'Kitchen', 'Living Room']);
		expect(graph.floors).toEqual([{ id: 'ground_floor', name: 'Ground floor', level: 0, icon: null }]);
		for (const room of graph.rooms) expect(room.floorId).toBe('ground_floor');
	});

	it('keeps YAML entities that never reach the entity registry', () => {
		// The demo integration creates most of its entities outside the registry.
		// Dropping them would silently hide half of some houses.
		const registered = new Set(home.entities.map((e) => e.entity_id));
		const unregistered = graph.unassigned.filter((e) => !registered.has(e.entityId));
		expect(unregistered.length).toBeGreaterThan(0);
	});

	it('summarizes lighting the way the 3D scene needs it', () => {
		expect(summarizeLighting([])).toEqual({ total: 0, on: 0, brightness: 0, rgb: null });
		const dim = summarizeLighting([
			{ domain: 'light', state: 'on', attributes: { brightness: 51, rgb_color: [255, 0, 0] } },
			{ domain: 'light', state: 'off', attributes: {} },
		]);
		expect(dim).toEqual({ total: 2, on: 1, brightness: 0.2, rgb: [255, 0, 0] });
	});

	it('treats a light with no brightness attribute as full', () => {
		expect(summarizeLighting([{ domain: 'light', state: 'on', attributes: {} }]).brightness).toBe(1);
	});

	it('answers "is this room buttoned up"', () => {
		const living = graph.rooms.find((r) => r.name === 'Living Room');
		expect(living.secured).not.toBeNull();
		expect(living.secured.secure).toBe(living.secured.unlocked.length === 0 && living.secured.open.length === 0);
		// A room with nothing to secure reports null rather than a false "secure".
		expect(graph.rooms.find((r) => r.name === 'Kitchen').secured).toBeNull();
	});

	it('survives an empty house without throwing', () => {
		expect(buildHomeGraph()).toEqual({ floors: [], rooms: [], unassigned: [], temperatureUnit: null });
	});

	it('converts a reading that declares its own unit into the unit the house shows', () => {
		// The case this exists for: an instance switched to US customary does not
		// rewrite a sensor pinned to Celsius, so the raw numbers are mixed. 20C is
		// 68F, and averaged with a 70F thermostat the room is 69F, not 45 of
		// nothing.
		const room = [
			{ domain: 'sensor', deviceClass: 'temperature', state: '20', attributes: { unit_of_measurement: '\u00b0C' } },
			{ domain: 'climate', deviceClass: null, state: 'heat', attributes: { current_temperature: 70 } },
		];
		expect(summarizeClimate(room, '\u00b0F')).toEqual({ temperature: 69, sources: 2, unit: '\u00b0F' });

		// A climate entity carries no unit of its own because Home Assistant has
		// already normalised it to the instance's, so it is read as-is. When an
		// integration does declare one, it is honoured: 70F averaged with the
		// 20C sensor, both shown in Celsius, is 20.6.
		const declared = [
			room[0],
			{ ...room[1], attributes: { current_temperature: 70, temperature_unit: '\u00b0F' } },
		];
		expect(summarizeClimate(declared, '\u00b0C').temperature).toBeCloseTo(20.6, 1);
	});

	it('leaves readings alone when the house never said what unit it uses', () => {
		// No unit means no safe conversion. The raw number is passed through and
		// labelled with a bare degree sign rather than converted on a guess.
		const out = summarizeClimate([{ domain: 'sensor', deviceClass: 'temperature', state: '25', attributes: {} }]);
		expect(out).toEqual({ temperature: 25, sources: 1, unit: null });
	});

	it('carries the unit the house reported, and null when it reported none', () => {
		// Null is the honest answer, not a Celsius default: the scene shows a bare
		// degree sign rather than labelling a reading with a unit nobody confirmed.
		expect(buildHomeGraph().temperatureUnit).toBeNull();
		expect(buildHomeGraph({ temperatureUnit: '\u00b0F' }).temperatureUnit).toBe('\u00b0F');
	});
});

describe('intent resolution', () => {
	it('maps spoken phrases onto the canonical macros', () => {
		expect(matchMacro('good night').key).toBe('good_night');
		expect(matchMacro('Goodnight!').key).toBe('good_night');
		expect(matchMacro("I'm leaving").key).toBe('leaving');
		expect(matchMacro('heading out').key).toBe('leaving');
		expect(matchMacro('welcome home').key).toBe('arriving');
		expect(matchMacro('what is the weather')).toBeNull();
	});

	it('finds this house\'s own scene for a macro it never named that way', () => {
		// The house has "Bedtime", not "Good night". Matching the phrase against
		// scene names alone would miss it, which is the entire point of the table.
		const hit = resolveIntent('good night', macros);
		expect(hit.entityId).toBe('scene.bedtime');
		expect(hit.macro).toBe('good_night');
		expect(hit.confidence).toBeGreaterThan(0.9);
	});

	it('routes leaving to Away Mode', () => {
		for (const phrase of ["I'm leaving", 'bye', 'heading out', 'away mode']) {
			expect(resolveIntent(phrase, macros).entityId, phrase).toBe('scene.away_mode');
		}
	});

	it('returns nothing rather than firing the wrong scene', () => {
		// This house has no movie scene. Guessing "Bedtime" would be worse than
		// admitting the miss and letting the agent compose the calls itself.
		expect(resolveIntent('movie time', macros)).toBeNull();
		expect(resolveIntent('good night', [])).toBeNull();
	});

	it('ignores candidates that are not scenes or scripts', () => {
		expect(resolveIntent('bedtime', [{ entityId: 'light.bedtime', name: 'Bedtime' }])).toBeNull();
	});
});

describe('the physical-action gate', () => {
	it('lets ordinary things through', () => {
		expect(classifyCall({ domain: 'light', service: 'turn_on', entityId: 'light.kitchen_lights' }).guarded).toBe(false);
		expect(classifyCall({ domain: 'climate', service: 'set_temperature' }).guarded).toBe(false);
		expect(classifyCall({ domain: 'media_player', service: 'turn_off' }).guarded).toBe(false);
	});

	it('is asymmetric: securing the house never prompts, opening it always does', () => {
		expect(classifyCall({ domain: 'lock', service: 'lock', entityId: 'lock.front_door' }).guarded).toBe(false);
		expect(classifyCall({ domain: 'lock', service: 'unlock', entityId: 'lock.front_door' }).guarded).toBe(true);
		expect(classifyCall({ domain: 'alarm_control_panel', service: 'alarm_arm_away' }).guarded).toBe(false);
		expect(classifyCall({ domain: 'alarm_control_panel', service: 'alarm_disarm' }).guarded).toBe(true);
	});

	it('guards a garage door but not a curtain', () => {
		const garage = { domain: 'cover', service: 'open_cover', entityId: 'cover.garage_door', attributes: { device_class: 'garage' } };
		const curtain = { domain: 'cover', service: 'open_cover', entityId: 'cover.living_room_window', attributes: { device_class: 'curtain' } };
		expect(classifyCall(garage).guarded).toBe(true);
		expect(classifyCall(garage).risk).toBe('physical');
		expect(classifyCall(curtain).guarded).toBe(false);
	});

	it('treats toggle as unsafe, because half of a toggle is an unlock', () => {
		expect(classifyCall({ domain: 'lock', service: 'toggle', entityId: 'lock.front_door' }).guarded).toBe(true);
	});

	it('scopes a standing allowance to one entity, never a domain', () => {
		const allow = createAllowList(['lock.office_door']);
		expect(allow.has('lock.office_door')).toBe(true);
		expect(allow.has('lock.front_door')).toBe(false);
	});
});

describe('the gate in front of Home Assistant\'s own MCP tools', () => {
	// Home Assistant documents intent__HassTurnOff as: "Turns off/closes a device
	// or entity. For locks, this performs an 'unlock' action." A model told to
	// turn something off can therefore unlock a front door, and the tool name
	// says nothing about it. Verified against a live instance: with the lock
	// exposed to Assist, that call really does unlock the door.
	it('catches the polymorphic unlock hiding inside HassTurnOff', () => {
		const verdict = classifyMcpCall('intent__HassTurnOff', { name: 'Front Door' }, entities);
		expect(verdict.guarded).toBe(true);
		expect(verdict.risk).toBe('security');
		expect(verdict.targets).toContain('lock.front_door');
	});

	it('does not prompt for the same tool on a light', () => {
		expect(classifyMcpCall('intent__HassTurnOff', { name: 'Ceiling Lights' }, entities).guarded).toBe(false);
	});

	it('catches an untargeted blast across a whole domain', () => {
		const verdict = classifyMcpCall('intent__HassTurnOff', { domain: 'lock' }, entities);
		expect(verdict.guarded).toBe(true);
		expect(verdict.targets.length).toBeGreaterThan(1);
	});

	it('treats HassTurnOn on a lock as the safe direction', () => {
		expect(classifyMcpCall('intent__HassTurnOn', { name: 'Front Door' }, entities).guarded).toBe(false);
	});

	it('leaves tools it does not understand alone', () => {
		expect(classifyMcpCall('todo__HassListAddItem', { name: 'Front Door' }, entities).guarded).toBe(false);
	});

	it('resolves targets the way Assist does', () => {
		const byArea = resolveMcpTargets({ area: 'Kitchen' }, entities);
		expect(byArea.length).toBeGreaterThan(0);
		expect(byArea.every((e) => e.areaName === 'Kitchen')).toBe(true);
		const byDomain = resolveMcpTargets({ domain: ['light'] }, entities);
		expect(byDomain.every((e) => e.domain === 'light')).toBe(true);
	});
});

describe('HomeBridge construction', () => {
	it('refuses to build without a token', () => {
		expect(() => new HomeBridge({ baseUrl: 'https://home.example.com' })).toThrow(/token/i);
	});

	it('refuses a URL it cannot use', () => {
		expect(() => new HomeBridge({ baseUrl: 'not a url at all', token: 'x' })).toThrow();
	});

	it('will not act before connect()', async () => {
		const bridge = new HomeBridge({ baseUrl: 'https://home.example.com', token: 'x' });
		await expect(bridge.call('light', 'turn_on', {})).rejects.toMatchObject({ code: ERR.NOT_CONNECTED });
	});
});
