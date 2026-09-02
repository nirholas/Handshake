/**
 * Turns Home Assistant's four flat registries (floors, areas, devices,
 * entities) plus the current state map into the room graph the 3D scene
 * renders and the agent reasons over.
 *
 * Everything here is a pure function of data the bridge already fetched, so the
 * scene can rebuild on every state push without another round trip.
 */

/** Domains the 3D scene draws as something you can see or walk up to. */
const RENDERABLE_DOMAINS = new Set([
	'light',
	'switch',
	'cover',
	'lock',
	'climate',
	'media_player',
	'fan',
	'sensor',
	'binary_sensor',
	'camera',
	'vacuum',
	'alarm_control_panel',
]);

export function domainOf(entityId) {
	const i = String(entityId || '').indexOf('.');
	return i === -1 ? '' : entityId.slice(0, i);
}

/**
 * @param {object} input
 * @param {Array} input.floors    config/floor_registry/list
 * @param {Array} input.areas     config/area_registry/list
 * @param {Array} input.devices   config/device_registry/list
 * @param {Array} input.entities  config/entity_registry/list
 * @param {Record<string, object>} input.states  entity_id to state object
 */
export function buildHomeGraph({ floors = [], areas = [], devices = [], entities = [], states = {} } = {}) {
	const deviceArea = new Map(devices.map((d) => [d.id, d.area_id || null]));

	const rooms = new Map(
		areas.map((a) => [
			a.area_id,
			{
				id: a.area_id,
				name: a.name,
				icon: a.icon || null,
				floorId: a.floor_id || null,
				aliases: a.aliases || [],
				entities: [],
			},
		]),
	);

	const unassigned = [];
	const seen = new Set();

	for (const entry of entities) {
		if (entry.disabled_by || entry.hidden_by) continue;
		const entityId = entry.entity_id;
		seen.add(entityId);
		const areaId = entry.area_id || deviceArea.get(entry.device_id) || null;
		const item = describeEntity(entityId, entry, states[entityId]);
		if (!item) continue;
		const room = areaId && rooms.get(areaId);
		if (room) room.entities.push(item);
		else unassigned.push(item);
	}

	// Entities created in YAML never reach the entity registry, and the demo and
	// template integrations are full of them. Dropping them would silently hide
	// half of some houses, so pick them up from the state map directly.
	for (const [entityId, state] of Object.entries(states)) {
		if (seen.has(entityId)) continue;
		const item = describeEntity(entityId, null, state);
		if (item) unassigned.push(item);
	}

	const list = [...rooms.values()].map((room) => ({
		...room,
		entities: room.entities.sort(byName),
		lighting: summarizeLighting(room.entities),
		climate: summarizeClimate(room.entities),
		secured: summarizeSecurity(room.entities),
	}));

	return {
		floors: floors.map((f) => ({ id: f.floor_id, name: f.name, level: f.level ?? 0, icon: f.icon || null })).sort((a, b) => a.level - b.level),
		rooms: list.sort(byName),
		unassigned: unassigned.sort(byName),
	};
}

function describeEntity(entityId, registryEntry, state) {
	const domain = domainOf(entityId);
	if (!RENDERABLE_DOMAINS.has(domain)) return null;
	const attributes = state?.attributes || {};
	return {
		entityId,
		domain,
		name: registryEntry?.name || attributes.friendly_name || registryEntry?.original_name || entityId,
		deviceClass: attributes.device_class || registryEntry?.device_class || registryEntry?.original_device_class || null,
		state: state?.state ?? 'unavailable',
		attributes,
	};
}

function byName(a, b) {
	return String(a.name).localeCompare(String(b.name));
}

/**
 * The numbers the 3D scene needs to light a room the way the real room is lit:
 * how many lights are on, the mean brightness as 0..1, and the mean colour of
 * the lights that report one.
 */
export function summarizeLighting(entities) {
	const lights = entities.filter((e) => e.domain === 'light');
	const on = lights.filter((e) => e.state === 'on');
	let brightness = 0;
	const rgb = [0, 0, 0];
	let coloured = 0;
	for (const light of on) {
		brightness += (Number(light.attributes.brightness) || 255) / 255;
		const c = light.attributes.rgb_color;
		if (Array.isArray(c) && c.length === 3) {
			rgb[0] += c[0];
			rgb[1] += c[1];
			rgb[2] += c[2];
			coloured += 1;
		}
	}
	return {
		total: lights.length,
		on: on.length,
		brightness: on.length ? Number((brightness / on.length).toFixed(3)) : 0,
		rgb: coloured ? rgb.map((v) => Math.round(v / coloured)) : null,
	};
}

export function summarizeClimate(entities) {
	const readings = entities
		.filter((e) => e.domain === 'climate' || (e.domain === 'sensor' && e.deviceClass === 'temperature'))
		.map((e) => (e.domain === 'climate' ? Number(e.attributes.current_temperature) : Number(e.state)))
		.filter((n) => Number.isFinite(n));
	if (!readings.length) return null;
	const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
	return { temperature: Number(mean.toFixed(1)), sources: readings.length };
}

/**
 * "Is this room buttoned up?" in one object, so the scene can tint a door red
 * and the agent can answer "did I lock everything" without a second pass.
 */
export function summarizeSecurity(entities) {
	const locks = entities.filter((e) => e.domain === 'lock');
	const openings = entities.filter(
		(e) => e.domain === 'cover' || (e.domain === 'binary_sensor' && (e.deviceClass === 'door' || e.deviceClass === 'window' || e.deviceClass === 'garage_door')),
	);
	const unlocked = locks.filter((e) => e.state === 'unlocked').map((e) => e.entityId);
	const open = openings.filter((e) => e.state === 'open' || e.state === 'on').map((e) => e.entityId);
	if (!locks.length && !openings.length) return null;
	return { locks: locks.length, unlocked, openings: openings.length, open, secure: unlocked.length === 0 && open.length === 0 };
}
