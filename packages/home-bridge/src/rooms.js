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
export function buildHomeGraph({ floors = [], areas = [], devices = [], entities = [], states = {}, temperatureUnit = null } = {}) {
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
		const item = describeEntity(entityId, entry, states[entityId], areaId);
		if (!item) continue;
		const room = areaId && rooms.get(areaId);
		if (room) {
			item.areaName = room.name;
			room.entities.push(item);
		} else {
			unassigned.push(item);
		}
	}

	// Entities created in YAML never reach the entity registry, and the demo and
	// template integrations are full of them. Dropping them would silently hide
	// half of some houses, so pick them up from the state map directly.
	for (const [entityId, state] of Object.entries(states)) {
		if (seen.has(entityId)) continue;
		const item = describeEntity(entityId, null, state, null);
		if (item) unassigned.push(item);
	}

	const list = [...rooms.values()].map((room) => ({
		...room,
		entities: room.entities.sort(byName),
		lighting: summarizeLighting(room.entities),
		climate: summarizeClimate(room.entities, temperatureUnit),
		secured: summarizeSecurity(room.entities),
	}));

	return {
		floors: floors.map((f) => ({ id: f.floor_id, name: f.name, level: f.level ?? 0, icon: f.icon || null })).sort((a, b) => a.level - b.level),
		rooms: list.sort(byName),
		unassigned: unassigned.sort(byName),
		// Carried on the graph rather than read at render time: the scene, the 2D
		// fallback and the agent's answers all have to say the same unit, and this
		// is the one object all three of them already read.
		temperatureUnit,
	};
}

function describeEntity(entityId, registryEntry, state, areaId) {
	const domain = domainOf(entityId);
	if (!RENDERABLE_DOMAINS.has(domain)) return null;
	const attributes = state?.attributes || {};
	return {
		entityId,
		domain,
		areaId: areaId || null,
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

const CELSIUS = '\u00b0C';
const FAHRENHEIT = '\u00b0F';

/**
 * Convert one reading between the two units Home Assistant measures temperature
 * in. An unknown pair is returned untouched rather than mangled: a wrong number
 * is worse than an unconverted one, because it looks right.
 */
function convertTemperature(value, from, to) {
	if (!Number.isFinite(value) || !from || !to || from === to) return value;
	if (from === CELSIUS && to === FAHRENHEIT) return (value * 9) / 5 + 32;
	if (from === FAHRENHEIT && to === CELSIUS) return ((value - 32) * 5) / 9;
	return value;
}

/**
 * The room's temperature, in the unit the house displays.
 *
 * A house is not all one unit. Switching an instance to US customary does not
 * rewrite a sensor that declares its own `unit_of_measurement`, so a real house
 * can hold a Celsius sensor and a Fahrenheit thermostat at once, and averaging
 * their raw numbers produces a reading that belongs to neither. Every reading
 * is converted to `unit` first, using the unit that reading itself declares: a
 * sensor states it outright, and a climate entity is already normalised to the
 * instance's own unit, which is what `unit` is.
 */
export function summarizeClimate(entities, unit = null) {
	const readings = [];
	for (const entity of entities) {
		const isClimate = entity.domain === 'climate';
		if (!isClimate && !(entity.domain === 'sensor' && entity.deviceClass === 'temperature')) continue;
		const attributes = entity.attributes || {};
		const raw = isClimate ? Number(attributes.current_temperature) : Number(entity.state);
		if (!Number.isFinite(raw)) continue;
		const own = (isClimate ? attributes.temperature_unit : attributes.unit_of_measurement) || unit;
		readings.push(convertTemperature(raw, own, unit || own));
	}
	if (!readings.length) return null;
	const mean = readings.reduce((a, b) => a + b, 0) / readings.length;
	return { temperature: Number(mean.toFixed(1)), sources: readings.length, unit: unit || null };
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

/** Every renderable entity in the house as one flat list, area id included. */
export function flattenEntities(graph) {
	const out = [];
	for (const room of graph?.rooms || []) out.push(...room.entities);
	out.push(...(graph?.unassigned || []));
	return out;
}
