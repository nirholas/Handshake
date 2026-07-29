// P3.1 — locally-driven world objects.
//
// When there is no authoritative room, /play renders the coin world's persisted
// build from the durable store itself. These entries have to behave like real
// objects (raycastable, deletable, snapshot-able back into the doc) AND get out
// of the way the instant the room's own copy of the same id arrives, or the
// player sees every prop twice.

import { describe, it, expect, beforeEach } from 'vitest';
import { Scene } from 'three';
import { WorldObjects, registerUploadedProp, isUploadType, propDef } from '../src/game/world-objects.js';

// A CommunityNet stand-in: only `on(event, fn)` is touched by the manager.
function fakeNet() {
	const handlers = new Map();
	return {
		handlers,
		on(event, fn) { handlers.set(event, fn); return () => handlers.delete(event); },
		emit(event, ...args) { handlers.get(event)?.(...args); },
	};
}

function serverObject(id, over = {}) {
	return { id, type: 'crate', kind: 'prop', ownerId: 'server-owner', x: 5, y: 0, z: 5, yaw: 0, scale: 1, ...over };
}

describe('WorldObjects local entries (P3.1)', () => {
	let scene; let net; let objs;
	beforeEach(() => {
		scene = new Scene();
		net = fakeNet();
		objs = new WorldObjects(scene, net, { isMine: (o) => o.ownerId === 'me' });
	});

	it('renders a restored prop and reports it as local', () => {
		objs.addLocal({ id: 'p1', type: 'crate', x: 3, y: 0, z: 4, yaw: 1, scale: 2 }, { mine: true });
		expect(objs.count).toBe(1);
		expect(objs.localCount()).toBe(1);
		expect(objs.isLocal('p1')).toBe(true);
		const node = scene.getObjectByName('wo:p1');
		expect(node).toBeTruthy();
		expect(node.position.x).toBeCloseTo(3, 5);
		expect(node.position.z).toBeCloseTo(4, 5);
		expect(node.rotation.y).toBeCloseTo(1, 5);
		expect(node.scale.x).toBeCloseTo(2, 5);
	});

	it('refuses a malformed record instead of adding a ghost entry', () => {
		expect(objs.addLocal(null)).toBeNull();
		expect(objs.addLocal({ x: 1, y: 0, z: 1 })).toBeNull();
		expect(objs.count).toBe(0);
	});

	it('snapshots local entries back into world-doc shape', () => {
		objs.addLocal({ id: 'p1', type: 'lamp', kind: 'block', ownerId: 'me', x: 1, y: 0, z: 2, yaw: 0.5, scale: 1.5 });
		objs.addLocal({ id: 'p2', type: 'u:abc', ownerId: 'me', x: 3, y: 0, z: 4, url: 'https://pub-test.r2.dev/a.glb' });
		const rows = objs.localObjects();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ id: 'p1', type: 'lamp', kind: 'block', ownerId: 'me', x: 1, y: 0, z: 2, yaw: 0.5, scale: 1.5 });
		expect(rows[1].url).toBe('https://pub-test.r2.dev/a.glb');
	});

	it('leaves the url key off catalog props so the saved doc stays compact', () => {
		objs.addLocal({ id: 'p1', type: 'crate', x: 1, y: 0, z: 1 });
		expect(Object.keys(objs.localObjects()[0])).not.toContain('url');
	});

	it('lets the authoritative room supersede a local entry with the same id', () => {
		objs.addLocal({ id: 'p1', type: 'crate', ownerId: 'me', x: 1, y: 0, z: 1 }, { mine: true });
		expect(objs.localCount()).toBe(1);
		net.emit('objectAdd', serverObject('p1', { x: 9, y: 0, z: 9 }), 'p1');
		// One object, not two, and it is the server's copy now.
		expect(objs.count).toBe(1);
		expect(objs.localCount()).toBe(0);
		expect(objs.isLocal('p1')).toBe(false);
		expect(objs.entries.get('p1').tx).toBe(9);
	});

	it('drops every local entry when the room finishes syncing, leaving server ones alone', () => {
		objs.addLocal({ id: 'p1', type: 'crate', x: 1, y: 0, z: 1 });
		objs.addLocal({ id: 'p2', type: 'crate', x: 2, y: 0, z: 2 });
		net.emit('objectAdd', serverObject('s1'), 's1');
		expect(objs.count).toBe(3);
		expect(objs.dropLocal()).toBe(2);
		expect(objs.count).toBe(1);
		expect(objs.entries.has('s1')).toBe(true);
		expect(scene.getObjectByName('wo:p1')).toBeUndefined();
	});

	it('removes a local entry on request and refuses to touch a server one', () => {
		objs.addLocal({ id: 'p1', type: 'crate', x: 1, y: 0, z: 1 });
		net.emit('objectAdd', serverObject('s1'), 's1');
		expect(objs.removeLocal('p1')).toBe(true);
		expect(objs.removeLocal('s1')).toBe(false);
		expect(objs.removeLocal('nope')).toBe(false);
		expect(objs.entries.has('s1')).toBe(true);
	});

	it('offers only owned entries to delete-own, local ones included', () => {
		objs.addLocal({ id: 'mine', type: 'crate', ownerId: 'me', x: 1, y: 0, z: 1 }, { mine: true });
		objs.addLocal({ id: 'theirs', type: 'crate', ownerId: 'someone', x: 2, y: 0, z: 2 }, { mine: false });
		expect(objs.ownedNodes().map((n) => n.name)).toEqual(['wo:mine']);
	});

	it('keeps a local entry parked at its pose (no server is interpolating it)', () => {
		objs.addLocal({ id: 'p1', type: 'crate', x: 7, y: 0, z: 8 });
		objs.update();
		objs.update();
		const node = scene.getObjectByName('wo:p1');
		expect(node.position.x).toBeCloseTo(7, 5);
		expect(node.position.z).toBeCloseTo(8, 5);
	});
});

describe('uploaded prop registry (P3.3)', () => {
	it('maps a url to a stable, short, catalog-resolvable type', () => {
		const url = 'https://pub-test.r2.dev/u/anon/avatar/8f14e45f.glb';
		const def = registerUploadedProp(url, { name: 'Statue' });
		expect(isUploadType(def.id)).toBe(true);
		expect(def.id.length).toBeLessThanOrEqual(48);
		expect(def.upload).toBe(true);
		expect(def.glb).toBe(url);
		// Same url, same id — a re-upload must not stack duplicate palette entries.
		expect(registerUploadedProp(url).id).toBe(def.id);
		// And it resolves through the shared catalog lookup the ghost/factory use.
		expect(propDef(def.id)).toBe(def);
	});

	it('gives different models different ids', () => {
		const a = registerUploadedProp('https://pub-test.r2.dev/a.glb');
		const b = registerUploadedProp('https://pub-test.r2.dev/b.glb');
		expect(a.id).not.toBe(b.id);
	});

	it('keeps its natural height (fitH null) so an upload is not stretched to a preset', () => {
		expect(registerUploadedProp('https://pub-test.r2.dev/c.glb').fitH).toBeNull();
	});
});
