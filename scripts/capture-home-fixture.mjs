#!/usr/bin/env node
// Records a real Home Assistant instance into the @three-ws/home-bridge test
// fixture. The room-graph tests run against a recording of a live instance
// rather than hand-written shapes, so a Home Assistant registry change shows up
// as a test failure instead of a production surprise.
//
//   HOME_ASSISTANT_URL=http://localhost:8123 \
//   HOME_ASSISTANT_TOKEN=<long-lived token> \
//   node scripts/capture-home-fixture.mjs
//
// A throwaway instance is one command:
//   docker run -d --name ha -p 8123:8123 ghcr.io/home-assistant/home-assistant:stable
// then add `demo:` to its configuration.yaml for a house full of real entities.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HA = (process.env.HOME_ASSISTANT_URL || 'http://localhost:8123').replace(/\/+$/, '');
const TOKEN = process.env.HOME_ASSISTANT_TOKEN;
const OUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'packages/home-bridge/tests/fixtures/home.json',
);

if (!TOKEN) {
	console.error('HOME_ASSISTANT_TOKEN is required (Profile, Security, Long-lived access tokens).');
	process.exit(1);
}

// Entity domains the room graph renders, plus the scene and script entities the
// intent resolver matches against. Everything else is noise in a fixture.
const KEEP =
	/^(light|lock|cover|climate|switch|fan|binary_sensor|media_player|alarm_control_panel|valve|scene|script|sensor\.outside_temperature)/;

const registries = await readRegistries();
const raw = await fetchJson('/api/states');

const states = {};
for (const s of raw) {
	if (KEEP.test(s.entity_id)) states[s.entity_id] = { entity_id: s.entity_id, state: s.state, attributes: s.attributes };
}
const keep = new Set(Object.keys(states));

const fixture = {
	_source:
		'Recorded from a real Home Assistant instance (docker ghcr.io/home-assistant/home-assistant:stable) running the demo integration, with three areas, one floor, and two user scenes. Not hand-written: regenerate by pointing scripts/capture-home-fixture.mjs at any instance.',
	floors: registries.floors.map((f) => ({ floor_id: f.floor_id, name: f.name, level: f.level, icon: f.icon ?? null })),
	areas: registries.areas.map((a) => ({ area_id: a.area_id, name: a.name, icon: a.icon ?? null, floor_id: a.floor_id ?? null, aliases: a.aliases || [] })),
	devices: registries.devices.map((d) => ({ id: d.id, area_id: d.area_id ?? null, name: d.name_by_user || d.name })),
	entities: registries.entities
		.filter((e) => keep.has(e.entity_id))
		.map((e) => ({
			entity_id: e.entity_id,
			device_id: e.device_id ?? null,
			area_id: e.area_id ?? null,
			name: e.name ?? null,
			original_name: e.original_name ?? null,
			original_device_class: e.original_device_class ?? null,
			disabled_by: e.disabled_by ?? null,
			hidden_by: e.hidden_by ?? null,
		})),
	states,
};

fs.writeFileSync(OUT, `${JSON.stringify(fixture, null, '\t')}\n`);
console.log(
	`wrote ${path.relative(process.cwd(), OUT)}: ${fixture.areas.length} areas, ${fixture.floors.length} floors, ${fixture.entities.length} registry entities, ${Object.keys(states).length} states`,
);

async function fetchJson(pathname) {
	const res = await fetch(HA + pathname, { headers: { authorization: `Bearer ${TOKEN}` } });
	if (!res.ok) throw new Error(`${pathname} returned ${res.status}`);
	return res.json();
}

async function readRegistries() {
	const wsUrl = `${HA.replace(/^http/, 'ws')}/api/websocket`;
	const socket = new WebSocket(wsUrl);
	let nextId = 1;
	const pending = new Map();

	await new Promise((ready, fail) => {
		socket.onerror = () => fail(new Error(`Could not open ${wsUrl}`));
		socket.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === 'auth_required') return socket.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
			if (msg.type === 'auth_ok') return ready();
			if (msg.type === 'auth_invalid') return fail(new Error('Home Assistant rejected the token.'));
			if (msg.type === 'result') {
				const entry = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.success) entry.resolve(msg.result);
				else entry.reject(new Error(JSON.stringify(msg.error)));
			}
		};
	});

	const call = (type) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, type }));
		}).catch(() => []);

	const [floors, areas, devices, entities] = await Promise.all([
		call('config/floor_registry/list'),
		call('config/area_registry/list'),
		call('config/device_registry/list'),
		call('config/entity_registry/list'),
	]);
	socket.close();
	return { floors, areas, devices, entities };
}
