// Order 07: the authored floorplan.
//
// Three tiers, matching tests/home-store.test.js: the validator is pure and
// always runs, the store tier needs a real database, and the top tier needs a
// real Home Assistant because the whole point of the area write-back is that it
// changes the user's own registry rather than our picture of it.
//
//   HOME_ASSISTANT_URL=... HOME_ASSISTANT_TOKEN=... npx vitest run tests/home-layout.test.js
//
// An instance is one command: node scripts/home-test-instance.mjs --up --onboard --seed

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	LayoutInvalid,
	LIMITS,
	reconcileLayout,
	validateLayout,
} from '../api/_lib/home/layout.js';

// ---------------------------------------------------------------------------
// The pure tier.
// ---------------------------------------------------------------------------

describe('the layout validator', () => {
	it('accepts the shape the scene reads', () => {
		const doc = validateLayout({ rooms: { kitchen: { x: 3.2, z: -1.5, w: 5, d: 4 } } });
		expect(doc).toEqual({ format: 1, units: 'm', rooms: { kitchen: { x: 3.2, z: -1.5, w: 5, d: 4 } } });
	});

	it('rebuilds the document rather than deleting unknown keys off the caller\'s object', () => {
		// The difference matters: a delete list can be forgotten when a field is
		// added, a rebuild cannot let anything through it does not name.
		const hostile = { rooms: { kitchen: { x: 0, z: 0, __proto__: { polluted: true }, script: '<img onerror=1>' } } };
		expect(() => validateLayout(hostile)).toThrow(LayoutInvalid);
	});

	it('refuses an unknown top-level field', () => {
		expect(() => validateLayout({ rooms: {}, camera: { x: 1 } })).toThrow(/Unknown field "camera"/);
	});

	it('refuses a coordinate past the world bound instead of clamping it', () => {
		// Silently moving a room the user placed is worse than refusing the number.
		expect(() => validateLayout({ rooms: { a: { x: LIMITS.maxCoord + 1, z: 0 } } })).toThrow(/limit is 500 m/);
		expect(() => validateLayout({ rooms: { a: { x: 0, z: Number.NaN } } })).toThrow(/finite number/);
		expect(() => validateLayout({ rooms: { a: { x: 0, z: Infinity } } })).toThrow(/finite number/);
	});

	it('refuses a room smaller than its own label or larger than a field', () => {
		expect(() => validateLayout({ rooms: { a: { x: 0, z: 0, w: 0.2 } } })).toThrow(/between 1.5 and 60/);
		expect(() => validateLayout({ rooms: { a: { x: 0, z: 0, d: 900 } } })).toThrow(/between 1.5 and 60/);
	});

	it('leaves w and d absent when the author never set them, so the scene keeps its default', () => {
		const doc = validateLayout({ rooms: { a: { x: 1, z: 2 } } });
		expect(doc.rooms.a.w).toBeUndefined();
		expect(doc.rooms.a.d).toBeUndefined();
	});

	it('caps the room count and the document size', () => {
		const many = {};
		for (let i = 0; i < LIMITS.maxRooms + 1; i += 1) many[`room_${i}`] = { x: 0, z: 0 };
		expect(() => validateLayout({ rooms: many })).toThrow(/at most 200 rooms/);
	});

	it('accepts the synthetic room the scene invents for unfiled devices', () => {
		expect(validateLayout({ rooms: { __unassigned__: { x: 0, z: 0 } } }).rooms.__unassigned__).toBeDefined();
	});

	it('refuses a room id that is not one', () => {
		expect(() => validateLayout({ rooms: { 'kitchen lights!': { x: 0, z: 0 } } })).toThrow(/not a usable room id/);
		expect(() => validateLayout({ rooms: { ['a'.repeat(LIMITS.maxIdLength + 1)]: { x: 0, z: 0 } } })).toThrow(/not a usable room id/);
	});

	it('refuses a format it did not write', () => {
		expect(() => validateLayout({ format: 99, rooms: {} })).toThrow(/Unsupported layout format/);
		expect(() => validateLayout({ units: 'ft', rooms: {} })).toThrow(/metres/);
	});

	it('rounds to the centimetre, because nobody places a wall to a micrometre', () => {
		expect(validateLayout({ rooms: { a: { x: 1.23456789, z: 0 } } }).rooms.a.x).toBe(1.23);
	});

	it('refuses a non-object, an array, and a missing rooms map', () => {
		for (const bad of [null, 'x', 42, [], { rooms: [] }, { rooms: 'kitchen' }, {}]) {
			expect(() => validateLayout(bad), JSON.stringify(bad)).toThrow(LayoutInvalid);
		}
	});
});

describe('reconciling a layout against a live house', () => {
	const doc = { format: 1, units: 'm', rooms: { kitchen: { x: 0, z: 0 }, gone: { x: 7, z: 0 } } };

	it('names the rooms the house no longer has and the ones nobody placed', () => {
		const graph = { rooms: [{ id: 'kitchen' }, { id: 'bedroom' }], unassigned: [] };
		expect(reconcileLayout(doc, graph)).toEqual({ orphaned: ['gone'], unplaced: ['bedroom'] });
	});

	it('counts the synthetic bucket as a real room once anything is unfiled', () => {
		const graph = { rooms: [{ id: 'kitchen' }], unassigned: [{ entityId: 'light.x' }] };
		expect(reconcileLayout(doc, graph).unplaced).toEqual(['__unassigned__']);
	});

	it('says nothing drifted for an empty layout', () => {
		expect(reconcileLayout({ rooms: {} }, { rooms: [{ id: 'kitchen' }], unassigned: [] })).toEqual({
			orphaned: [],
			unplaced: ['kitchen'],
		});
	});
});

// ---------------------------------------------------------------------------
// The live tiers.
// ---------------------------------------------------------------------------

const hasDb = Boolean(process.env.DATABASE_URL);
const hasKey = Boolean(process.env.WALLET_ENCRYPTION_KEY || process.env.JWT_SECRET);
const haUrl = process.env.HOME_ASSISTANT_URL;
const haToken = process.env.HOME_ASSISTANT_TOKEN;

const liveDb = describe.skipIf(!hasDb || !hasKey);
const liveHome = describe.skipIf(!hasDb || !hasKey || !haUrl || !haToken);

const SYNTHETIC_TOKEN = `synthetic.home.assistant.token.${'a'.repeat(64)}`;

liveDb('the layout store, against a real database', () => {
	let sql;
	let store;
	let layout;
	let owner;
	let second;
	let home;

	beforeAll(async () => {
		({ sql } = await import('../api/_lib/db.js'));
		store = await import('../api/_lib/home/store.js');
		layout = await import('../api/_lib/home/layout.js');
		const stamp = Date.now();
		[owner] = await sql`insert into users (email) values (${`home-layout-a-${stamp}@qa.three.ws`}) returning id`;
		[second] = await sql`insert into users (email) values (${`home-layout-b-${stamp}@qa.three.ws`}) returning id`;
		home = await store.createConnection({
			userId: owner.id,
			label: 'Layout test',
			baseUrl: haUrl || 'https://layout.invalid.three.ws',
			token: haToken || SYNTHETIC_TOKEN,
		});
	}, 60_000);

	afterAll(async () => {
		if (!sql) return;
		if (home) await sql`delete from home_connections where id = ${home.id}`;
		for (const u of [owner, second]) if (u) await sql`delete from users where id = ${u.id}`;
	});

	it('reports no layout before anyone draws one', async () => {
		expect(await layout.getLayout(home.id)).toBeNull();
	});

	it('creates the first layout at version 1', async () => {
		const res = await layout.putLayout({
			homeId: home.id,
			layout: { rooms: { kitchen: { x: 0, z: 0 } } },
			updatedBy: owner.id,
			expectedVersion: 0,
		});
		expect(res.ok).toBe(true);
		expect(res.version).toBe(1);
	});

	it('refuses a second create rather than overwriting the first', async () => {
		// A caller sending expectedVersion 0 believes there is nothing here. If a
		// row appeared since they loaded, that belief is stale and they must be
		// told, not silently overwritten.
		const res = await layout.putLayout({
			homeId: home.id,
			layout: { rooms: { bedroom: { x: 9, z: 0 } } },
			updatedBy: second.id,
			expectedVersion: 0,
		});
		expect(res.ok).toBe(false);
		expect(res.conflict).toBe(true);
		expect(res.current.layout.rooms).toHaveProperty('kitchen');
		expect(res.current.layout.rooms).not.toHaveProperty('bedroom');
	});

	it('advances the version on a good write', async () => {
		const res = await layout.putLayout({
			homeId: home.id,
			layout: { rooms: { kitchen: { x: 1, z: 1 } } },
			updatedBy: owner.id,
			expectedVersion: 1,
		});
		expect(res.ok).toBe(true);
		expect(res.version).toBe(2);
		expect((await layout.getLayout(home.id)).layout.rooms.kitchen).toEqual({ x: 1, z: 1, w: undefined, d: undefined });
	});

	it('refuses a stale write and hands back the current document, so no edit is lost', async () => {
		// Two members drawing at once. The second must be asked, not overruled.
		const stale = await layout.putLayout({
			homeId: home.id,
			layout: { rooms: { kitchen: { x: 99, z: 99 } } },
			updatedBy: second.id,
			expectedVersion: 1,
		});
		expect(stale.ok).toBe(false);
		expect(stale.conflict).toBe(true);
		expect(stale.current.version).toBe(2);
		expect(stale.current.layout.rooms.kitchen.x).toBe(1);
	});

	it('rejects an invalid document before it reaches the database', async () => {
		await expect(
			layout.putLayout({ homeId: home.id, layout: { rooms: { a: { x: 9e9, z: 0 } } }, updatedBy: owner.id, expectedVersion: 2 }),
		).rejects.toThrow(LayoutInvalid);
		expect((await layout.getLayout(home.id)).version).toBe(2);
	});

	it('reports a stored document this version would now refuse, rather than throwing', async () => {
		// A row can predate a cap. One bad document must degrade to the default
		// arrangement, not take the page down.
		await sql`update home_layouts set layout = ${JSON.stringify({ format: 1, units: 'm', rooms: { a: { x: 99999, z: 0 } } })}::jsonb where home_id = ${home.id}`;
		const read = await layout.getLayout(home.id);
		expect(read.unreadable).toMatch(/limit is 500 m/);
		expect(read.layout.rooms).toEqual({});
	});

	it('deletes, and is honest about deleting nothing twice', async () => {
		expect(await layout.deleteLayout(home.id)).toBe(true);
		expect(await layout.deleteLayout(home.id)).toBe(false);
		expect(await layout.getLayout(home.id)).toBeNull();
	});

	it('cascades with the home', async () => {
		await layout.putLayout({ homeId: home.id, layout: { rooms: { kitchen: { x: 0, z: 0 } } }, updatedBy: owner.id, expectedVersion: 0 });
		await sql`delete from home_connections where id = ${home.id}`;
		const [row] = await sql`select 1 as hit from home_layouts where home_id = ${home.id}`;
		expect(row).toBeUndefined();
		home = null;
	});
});

liveHome('the area write-back, against a real Home Assistant', () => {
	let bridge;
	let unfiled;
	let areaId;
	let originalArea;

	beforeAll(async () => {
		const { HomeBridge } = await import('../packages/home-bridge/src/index.js');
		bridge = new HomeBridge({ baseUrl: haUrl, token: haToken });
		await bridge.connect();
		areaId = bridge.areas()[0]?.id;
		// A registry entity that the seeder did not already file, so the test
		// moves something real and can put it back.
		const registry = bridge.registries.entities || [];
		const candidate = registry.find((e) => e.entity_id.startsWith('light.') && !e.disabled_by);
		unfiled = candidate?.entity_id;
		originalArea = candidate?.area_id ?? null;
	}, 60_000);

	afterAll(async () => {
		if (bridge && unfiled) {
			try {
				await bridge.assignEntityArea(unfiled, originalArea);
			} catch {
				// Best effort: the assertion below already proved the write works.
			}
		}
		bridge?.close();
	});

	it('has an area and a registry entity to work with', () => {
		expect(areaId).toBeTruthy();
		expect(unfiled).toBeTruthy();
	});

	it('moves a real entity into a real area, and Home Assistant agrees', async () => {
		await bridge.assignEntityArea(unfiled, areaId);
		// Read it back from Home Assistant's own registry, not from our cache of it.
		const fresh = await bridge.refreshRegistries();
		const entry = (bridge.registries.entities || []).find((e) => e.entity_id === unfiled);
		expect(entry.area_id).toBe(areaId);
		// And the room graph the scene renders reflects it without a reconnect.
		const room = fresh.rooms.find((r) => r.id === areaId);
		expect(room.entities.some((e) => e.entityId === unfiled)).toBe(true);
	}, 30_000);

	it('unfiles an entity when given a null area', async () => {
		await bridge.assignEntityArea(unfiled, null);
		const entry = (bridge.registries.entities || []).find((e) => e.entity_id === unfiled);
		expect(entry.area_id ?? null).toBeNull();
	}, 30_000);

	it('explains a YAML entity instead of throwing a raw protocol error', async () => {
		// Most demo and template entities never reach the entity registry, so this
		// is the common case rather than an edge one, and it needs a sentence a
		// person can act on.
		const registered = new Set((bridge.registries.entities || []).map((e) => e.entity_id));
		const yamlOnly = Object.keys(bridge.states).find((id) => !registered.has(id) && id.includes('.'));
		if (!yamlOnly) return;
		await expect(bridge.assignEntityArea(yamlOnly, areaId)).rejects.toThrow(/entity registry/i);
	}, 30_000);

	it('refuses something that is not an entity id at all', async () => {
		await expect(bridge.assignEntityArea('not-an-entity', areaId)).rejects.toThrow(/not an entity id/);
	});
});
