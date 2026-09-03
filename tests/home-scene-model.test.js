// The layout of a real house, asserted without a GPU.
//
// Every case here runs over the recorded fixture in
// packages/home-bridge/tests/fixtures/home.json, which is a capture of a real
// Home Assistant instance (docker `stable`, demo integration) rather than a
// hand-written shape. A Home Assistant registry change therefore shows up as a
// failure in this file instead of as a broken scene in production.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildHomeGraph } from '../packages/home-bridge/src/rooms.js';
import {
	CELL,
	FLOOR_HEIGHT,
	activityOf,
	buildSceneModel,
	climateOf,
	diffScene,
	isUnavailable,
	kindOf,
	lightOf,
	packCells,
	placementOf,
	readoutsOf,
	rgbToHex,
} from '../src/home/scene-model.js';

const fixture = JSON.parse(
	readFileSync(fileURLToPath(new URL('../packages/home-bridge/tests/fixtures/home.json', import.meta.url)), 'utf8'),
);

function graph(overrides = {}) {
	return buildHomeGraph({ ...fixture, ...overrides });
}

describe('the scene model over a real house', () => {
	const model = buildSceneModel(graph());

	it('places every room on a floor and every floor at its own height', () => {
		expect(model.floors.length).toBeGreaterThan(0);
		const heights = model.floors.map((f) => f.y);
		expect(new Set(heights).size).toBe(heights.length);
		for (const [index, floor] of model.floors.entries()) expect(floor.y).toBe(index * FLOOR_HEIGHT);
		const placed = model.floors.flatMap((f) => f.roomIds);
		expect(placed.sort()).toEqual(model.rooms.map((r) => r.id).sort());
	});

	it('gives every room a footprint that fits inside its cell and never overlaps a neighbour', () => {
		for (const floor of model.floors) {
			const boxes = floor.roomIds.map((id) => model.rooms.find((r) => r.id === id));
			for (const room of boxes) {
				expect(room.w).toBeLessThanOrEqual(CELL);
				expect(room.d).toBeLessThanOrEqual(CELL);
			}
			for (let i = 0; i < boxes.length; i += 1) {
				for (let j = i + 1; j < boxes.length; j += 1) {
					const a = boxes[i];
					const b = boxes[j];
					const apart =
						Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 0.001 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2 - 0.001;
					expect(apart, `${a.name} overlaps ${b.name}`).toBe(true);
				}
			}
		}
	});

	it('orders the rooms on a floor by name, which is how the rail reads them', () => {
		for (const floor of model.floors) {
			const names = floor.roomIds.map((id) => model.rooms.find((r) => r.id === id).name);
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		}
	});

	it('carries the room rollups the renderer lights the room from', () => {
		for (const room of model.rooms) {
			expect(room.light.intensity).toBeGreaterThan(0);
			expect(room.light.hex).toMatch(/^#[0-9a-f]{6}$/);
			if (room.climate) expect(room.climate.tint).toBeGreaterThanOrEqual(-1);
			if (room.climate) expect(room.climate.tint).toBeLessThanOrEqual(1);
		}
	});

	it('never focuses the unfiled bucket while a real room exists', () => {
		const focus = model.rooms.find((r) => r.id === model.focusRoomId);
		expect(focus).toBeTruthy();
		expect(focus.synthetic).toBe(false);
	});

	it('stands the agent inside the focused room', () => {
		const room = model.rooms.find((r) => r.id === model.agent.roomId);
		expect(room.id).toBe(model.focusRoomId);
		expect(Math.abs(model.agent.x - room.x)).toBeLessThan(room.w / 2);
		expect(Math.abs(model.agent.z - room.z)).toBeLessThan(room.d / 2);
		expect(model.agent.y).toBe(room.y);
	});
});

describe('a dark room is dark', () => {
	it('drops a room with no light on to ambient, not to a dim version of lit', () => {
		const lit = lightOf({ lighting: { total: 2, on: 2, brightness: 0.8, rgb: [255, 200, 150] } });
		const dark = lightOf({ lighting: { total: 2, on: 0, brightness: 0, rgb: null } });
		expect(lit.on).toBe(true);
		expect(dark.on).toBe(false);
		expect(dark.intensity).toBeLessThan(lit.intensity / 10);
		expect(lit.hex).toBe(rgbToHex([255, 200, 150]));
	});

	it('reads brightness through to intensity monotonically', () => {
		const dim = lightOf({ lighting: { total: 1, on: 1, brightness: 0.1, rgb: null } });
		const bright = lightOf({ lighting: { total: 1, on: 1, brightness: 1, rgb: null } });
		expect(bright.intensity).toBeGreaterThan(dim.intensity);
	});
});

describe('a busy room stays legible', () => {
	it('caps what it draws and summarizes the rest rather than drawing sixty objects', () => {
		const entities = [];
		for (let i = 0; i < 60; i += 1) {
			entities.push({ entityId: `light.l${i}`, domain: 'light', name: `Light ${i}`, state: 'on', attributes: { brightness: 200 } });
			entities.push({ entityId: `sensor.s${i}`, domain: 'sensor', deviceClass: 'humidity', name: `Humidity ${i}`, state: String(40 + i), attributes: { unit_of_measurement: '%' } });
		}
		const model = buildSceneModel({
			floors: [{ id: 'f', name: 'Ground', level: 0 }],
			rooms: [{ id: 'r', name: 'Busy', floorId: 'f', entities, lighting: { total: 60, on: 60, brightness: 0.78, rgb: null }, climate: null, secured: null }],
			unassigned: [],
		});
		const room = model.rooms[0];
		expect(room.entityCount).toBe(120);
		expect(room.objects.length).toBeLessThanOrEqual(22);
		expect(room.hiddenCount).toBeGreaterThan(0);
		expect(room.readouts.length).toBeLessThanOrEqual(6);
	});

	it('cuts sensors before it cuts lights and locks', () => {
		const entities = [
			{ entityId: 'lock.front', domain: 'lock', name: 'Front door', state: 'unlocked', attributes: {} },
			{ entityId: 'light.a', domain: 'light', name: 'A light', state: 'on', attributes: {} },
		];
		for (let i = 0; i < 40; i += 1) {
			entities.push({ entityId: `switch.s${i}`, domain: 'switch', name: `Switch ${i}`, state: 'off', attributes: {} });
		}
		const model = buildSceneModel({
			floors: [],
			rooms: [{ id: 'r', name: 'Room', floorId: null, entities, lighting: { total: 1, on: 1, brightness: 1, rgb: null }, climate: null, secured: { locks: 1, unlocked: ['lock.front'], openings: 0, open: [], secure: false } }],
			unassigned: [],
		});
		const drawn = model.rooms[0].objects.map((o) => o.entityId);
		expect(drawn).toContain('lock.front');
		expect(drawn).toContain('light.a');
	});
});

describe('a house with nothing filed into a room', () => {
	const model = buildSceneModel(graph({ areas: [], floors: [] }));

	it('renders one honest room instead of a blank floor', () => {
		expect(model.needsLayout).toBe(true);
		expect(model.rooms).toHaveLength(1);
		expect(model.rooms[0].synthetic).toBe(true);
		expect(model.rooms[0].entityCount).toBeGreaterThan(0);
		expect(model.empty).toBe(false);
	});

	it('still rolls up lighting and security for that room', () => {
		const room = model.rooms[0];
		expect(room.light).toBeTruthy();
		expect(room.security).toBeTruthy();
	});
});

describe('a connected house with nothing in it', () => {
	it('is empty rather than broken', () => {
		const model = buildSceneModel({ floors: [], rooms: [], unassigned: [] });
		expect(model.empty).toBe(true);
		expect(model.needsLayout).toBe(false);
		expect(model.rooms).toHaveLength(0);
		expect(model.bounds.width).toBeGreaterThan(0);
	});

	it('survives a graph that is missing entirely', () => {
		const model = buildSceneModel(null);
		expect(model.rooms).toHaveLength(0);
		expect(model.stats.entities).toBe(0);
	});
});

describe('what an object is and what it is doing', () => {
	it('reads a lock backwards on purpose: unlocked is the state that lights up', () => {
		expect(activityOf({ domain: 'lock', state: 'unlocked', attributes: {} })).toBe(1);
		expect(activityOf({ domain: 'lock', state: 'locked', attributes: {} })).toBe(0);
	});

	it('reads a cover as a real position, not a boolean', () => {
		expect(activityOf({ domain: 'cover', state: 'open', attributes: { current_position: 40 } })).toBeCloseTo(0.4);
		expect(activityOf({ domain: 'cover', state: 'closed', attributes: { current_position: 0 } })).toBe(0);
		expect(activityOf({ domain: 'cover', state: 'open', attributes: {} })).toBe(1);
	});

	it('treats an unavailable device as inactive but keeps it drawable', () => {
		const entity = { entityId: 'light.gone', domain: 'light', name: 'Gone', state: 'unavailable', attributes: {} };
		expect(activityOf(entity)).toBe(0);
		expect(isUnavailable(entity)).toBe(true);
		expect(placementOf(entity)).toBe('ceiling');
		expect(kindOf(entity)).toBe('lamp');
	});

	it('places each domain somewhere a person would look for it', () => {
		expect(placementOf({ domain: 'light' })).toBe('ceiling');
		expect(placementOf({ domain: 'lock' })).toBe('wall');
		expect(placementOf({ domain: 'cover' })).toBe('wall');
		expect(placementOf({ domain: 'climate' })).toBe('floor');
		expect(placementOf({ domain: 'binary_sensor', deviceClass: 'door' })).toBe('wall');
		expect(placementOf({ domain: 'binary_sensor', deviceClass: 'motion' })).toBe(null);
		expect(placementOf({ domain: 'sensor', deviceClass: 'temperature' })).toBe(null);
	});

	it('summarizes numeric sensors into readouts', () => {
		const readouts = readoutsOf([
			{ entityId: 'sensor.t', domain: 'sensor', name: 'Temp', deviceClass: 'temperature', state: '21.4', attributes: { unit_of_measurement: '°C' } },
			{ entityId: 'sensor.x', domain: 'sensor', name: 'Text', deviceClass: null, state: 'idle', attributes: {} },
		]);
		expect(readouts).toHaveLength(1);
		expect(readouts[0].value).toBeCloseTo(21.4);
		expect(readouts[0].unit).toBe('°C');
	});
});

describe('climate tint', () => {
	it('is neutral in the comfort band and saturates at the extremes', () => {
		expect(climateOf({ climate: { temperature: 21, sources: 1 } }).tint).toBeCloseTo(0);
		expect(climateOf({ climate: { temperature: 30, sources: 1 } }).tint).toBe(1);
		expect(climateOf({ climate: { temperature: 10, sources: 1 } }).tint).toBe(-1);
		expect(climateOf({ climate: null })).toBe(null);
	});
});

describe('the diff the renderer retargets from', () => {
	it('reports only what actually changed', () => {
		const before = buildSceneModel(graph());
		const states = structuredClone(fixture.states);
		const lightId = Object.keys(states).find((id) => id.startsWith('light.') && states[id].state === 'off')
			|| Object.keys(states).find((id) => id.startsWith('light.'));
		states[lightId] = { ...states[lightId], state: states[lightId].state === 'on' ? 'off' : 'on' };
		const after = buildSceneModel(graph({ states }));

		const delta = diffScene(before, after);
		expect(delta.added).toHaveLength(0);
		expect(delta.removed).toHaveLength(0);
		expect(delta.changed.map((o) => o.entityId)).toContain(lightId);
		expect(delta.changed.length).toBeLessThan(3);
	});

	it('notices a device that disappeared from the house', () => {
		const before = buildSceneModel(graph());
		const states = structuredClone(fixture.states);
		const entities = fixture.entities.filter((e) => !e.entity_id.startsWith('lock.'));
		for (const id of Object.keys(states)) if (id.startsWith('lock.')) delete states[id];
		const after = buildSceneModel(graph({ states, entities }));
		expect(after.stats.entities).toBeLessThan(before.stats.entities);
		expect(diffScene(before, after).removed.length).toBeGreaterThan(0);
	});

	it('is stable when nothing moved', () => {
		const a = buildSceneModel(graph());
		const b = buildSceneModel(graph());
		const delta = diffScene(a, b);
		expect(delta.changed).toHaveLength(0);
		expect(delta.added).toHaveLength(0);
		expect(delta.removed).toHaveLength(0);
		expect(delta.roomsChanged).toHaveLength(0);
	});
});

describe('packing', () => {
	it('centres the grid on the origin and never stacks two rooms in one cell', () => {
		for (const n of [1, 2, 3, 5, 8, 13, 40]) {
			const cells = packCells(n);
			expect(cells).toHaveLength(n);
			expect(new Set(cells.map((c) => `${c.x},${c.z}`)).size).toBe(n);
			const xs = cells.map((c) => c.x);
			expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2)).toBeLessThan(0.001);
		}
	});
});

describe('an authored floorplan wins over the default packing', () => {
	it('uses the saved position and size when one exists', () => {
		const base = buildSceneModel(graph());
		const first = base.rooms[0];
		const model = buildSceneModel(graph(), { layout: { [first.id]: { x: 42, z: -13, w: 3, d: 4 } } });
		const moved = model.rooms.find((r) => r.id === first.id);
		expect(moved.x).toBe(42);
		expect(moved.z).toBe(-13);
		expect(moved.w).toBe(3);
		expect(moved.d).toBe(4);
	});
});

describe('the unit the house measures in', () => {
	it('centres the comfort band on the instance unit rather than on Celsius', () => {
		const room = { climate: { temperature: 70, sources: 1 } };
		expect(climateOf(room, '°C').tint).toBe(1);
		expect(climateOf(room, '°F').tint).toBeCloseTo(0, 5);
		expect(climateOf(room, '°F').label).toBe('70.0°F');
	});

	it('reads the unit off the graph, so the scene and the fallback cannot disagree', () => {
		const graphWithUnit = { ...graph(), temperatureUnit: '°F' };
		const model = buildSceneModel(graphWithUnit);
		const withClimate = model.rooms.find((r) => r.climate);
		expect(withClimate.climate.unit).toBe('°F');
		expect(withClimate.climate.label.endsWith('°F')).toBe(true);
	});
});
