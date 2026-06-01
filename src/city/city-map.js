import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Manhattan — Times Square area centre
const CENTER_LAT = 40.7580;
const CENTER_LON = -73.9855;
const RADIUS_METERS = 700; // ~10 city blocks

// OSM localStorage cache (24h TTL)
const CACHE_KEY = 'city-osm-manhattan-v2';
const CACHE_TTL_MS = 86_400_000;

export const CITY_HALF = RADIUS_METERS;

// Web Mercator projection — returns metres from city centre in XZ world space
function project(lat, lon) {
	const R = 6_371_000;
	const cosC = Math.cos(CENTER_LAT * Math.PI / 180);
	return {
		x: (lon - CENTER_LON) * (Math.PI / 180) * R * cosC,
		z: -(lat - CENTER_LAT) * (Math.PI / 180) * R,
	};
}

// Fetch building footprints from OpenStreetMap Overpass API (free, no key)
export async function fetchOSMData(onProgress) {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (raw) {
			const { ts, data } = JSON.parse(raw);
			if (Date.now() - ts < CACHE_TTL_MS) {
				onProgress?.(0.5, 'Using cached city data…');
				return data;
			}
		}
	} catch { /* ignore bad cache */ }

	const lat1 = CENTER_LAT - RADIUS_METERS / 111_000;
	const lat2 = CENTER_LAT + RADIUS_METERS / 111_000;
	const cosC = Math.cos(CENTER_LAT * Math.PI / 180);
	const lon1 = CENTER_LON - RADIUS_METERS / (111_000 * cosC);
	const lon2 = CENTER_LON + RADIUS_METERS / (111_000 * cosC);

	// Query buildings + roads in bounding box
	const query =
		`[out:json][timeout:30];` +
		`(way["building"](${lat1},${lon1},${lat2},${lon2});` +
		`way["highway"]["highway"~"^(primary|secondary|tertiary|residential|unclassified)$"](${lat1},${lon1},${lat2},${lon2});` +
		`);out body;>;out skel qt;`;

	onProgress?.(0.1, 'Fetching Manhattan map data…');
	const res = await fetch(
		`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
	);
	if (!res.ok) throw new Error(`Overpass API ${res.status}`);

	onProgress?.(0.4, 'Parsing city geometry…');
	const data = await res.json();

	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
	} catch { /* quota exceeded */ }

	return data;
}

// Build the city scene from parsed OSM data.
// Returns { buildingBoxes } for collision in city-player.js.
export function buildCity(scene, osmData) {
	const buildingBoxes = [];

	// ── Parse OSM elements ────────────────────────────────────────────────────
	const nodeMap = new Map();
	const buildingWays = [];
	const roadWays = [];

	for (const el of osmData.elements) {
		if (el.type === 'node') nodeMap.set(el.id, project(el.lat, el.lon));
	}
	for (const el of osmData.elements) {
		if (el.type !== 'way') continue;
		if (el.tags?.building) buildingWays.push(el);
		else if (el.tags?.highway) roadWays.push(el);
	}

	// ── Ground ────────────────────────────────────────────────────────────────
	const groundSize = RADIUS_METERS * 2 + 600;
	const groundMesh = new THREE.Mesh(
		new THREE.PlaneGeometry(groundSize, groundSize),
		new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.95, metalness: 0 }),
	);
	groundMesh.rotation.x = -Math.PI / 2;
	groundMesh.receiveShadow = true;
	scene.add(groundMesh);

	// ── Road planes from OSM highway ways ────────────────────────────────────
	buildRoads(scene, roadWays, nodeMap);

	// ── Buildings ─────────────────────────────────────────────────────────────
	const WIN_TEX = buildWindowTex();
	WIN_TEX.wrapS = WIN_TEX.wrapT = THREE.RepeatWrapping;

	// Bucket geometries by facade material tier
	const buckets = { glass: [], concrete: [], brick: [], stone: [] };

	for (const way of buildingWays) {
		const nodes = way.nodes.map(id => nodeMap.get(id)).filter(Boolean);
		if (nodes.length < 3) continue;

		// Discard if entirely outside city radius
		const inside = nodes.some(n => Math.abs(n.x) < RADIUS_METERS && Math.abs(n.z) < RADIUS_METERS);
		if (!inside) continue;

		const height = inferHeight(way.tags, way.id);
		const tier = height > 60 ? 'glass' : height > 25 ? 'concrete' : height > 10 ? 'brick' : 'stone';

		const geo = buildingPolygon(nodes, height);
		if (!geo) continue;

		buckets[tier].push(geo);

		// AABB for collision
		let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
			minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
		}
		buildingBoxes.push({ minX, maxX, minZ, maxZ, h: height });
	}

	// Per-tier materials with window emissive
	const tierDefs = {
		glass:    { color: 0x4a6e9a, roughness: 0.08, metalness: 0.82 },
		concrete: { color: 0x7c7c80, roughness: 0.90, metalness: 0.04 },
		brick:    { color: 0xa06048, roughness: 0.94, metalness: 0.00 },
		stone:    { color: 0xb8a888, roughness: 0.92, metalness: 0.00 },
	};

	for (const [tier, geos] of Object.entries(buckets)) {
		if (geos.length === 0) continue;
		const merged = mergeGeometries(geos, false);
		const { color, roughness, metalness } = tierDefs[tier];

		const winTexClone = WIN_TEX.clone();
		winTexClone.wrapS = winTexClone.wrapT = THREE.RepeatWrapping;
		const rpt = tier === 'glass' ? 0.12 : tier === 'concrete' ? 0.10 : 0.08;
		winTexClone.repeat.set(rpt, rpt);
		winTexClone.needsUpdate = true;

		const mat = new THREE.MeshStandardMaterial({
			color,
			roughness,
			metalness,
			emissiveMap: winTexClone,
			emissive: new THREE.Color(0xfff2d0),
			emissiveIntensity: tier === 'glass' ? 0.50 : 0.35,
		});

		const mesh = new THREE.Mesh(merged, mat);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		scene.add(mesh);
	}

	// ── Street lights ─────────────────────────────────────────────────────────
	buildStreetlights(scene, buildingBoxes);

	return { buildingBoxes };
}

// Infer building height from OSM tags
function inferHeight(tags, wayId) {
	if (tags.height) {
		const h = parseFloat(tags.height);
		if (h > 0) return Math.min(h, 420);
	}
	if (tags['building:levels']) {
		const lvl = parseFloat(tags['building:levels']);
		if (lvl > 0) return Math.min(lvl * 3.5, 420);
	}
	// Deterministic pseudo-random from way ID — consistent across reloads
	const seed = Math.imul(wayId ^ (wayId >>> 16), 0x45d9f3b);
	const t = ((seed >>> 0) % 1000) / 1000;
	return 3 + Math.pow(t, 2.2) * 55;
}

// Build ExtrudeGeometry from OSM polygon already in world XZ coords.
// Shape is defined in shape-XY (x→X, -z→Y) then rotateX(-PI/2) lays it flat.
function buildingPolygon(nodes, height) {
	try {
		const shape = new THREE.Shape();
		shape.moveTo(nodes[0].x, -nodes[0].z);
		for (let i = 1; i < nodes.length; i++) shape.lineTo(nodes[i].x, -nodes[i].z);
		shape.closePath();

		const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
		geo.rotateX(-Math.PI / 2); // extrusion now goes up (world +Y)
		return geo;
	} catch {
		return null;
	}
}

// Render road surface planes along OSM highway ways
function buildRoads(scene, roadWays, nodeMap) {
	if (roadWays.length === 0) return;

	const roadMat = new THREE.MeshStandardMaterial({ color: 0x252530, roughness: 0.95, metalness: 0 });
	const dashMat = new THREE.MeshStandardMaterial({
		color: 0xddbb00,
		emissive: 0x332a00,
		emissiveIntensity: 0.2,
		roughness: 0.9,
	});

	const roadGeos = [];
	const dashGeos = [];

	for (const way of roadWays) {
		const pts = way.nodes.map(id => nodeMap.get(id)).filter(Boolean);
		if (pts.length < 2) continue;

		const hw = way.tags.highway;
		const halfW = hw === 'primary' ? 8 : hw === 'secondary' ? 6 : 4.5;

		for (let i = 0; i < pts.length - 1; i++) {
			const a = pts[i], b = pts[i + 1];
			const dx = b.x - a.x, dz = b.z - a.z;
			const len = Math.sqrt(dx * dx + dz * dz);
			if (len < 0.5) continue;
			const angle = Math.atan2(dx, dz);

			const rGeo = new THREE.PlaneGeometry(halfW * 2, len);
			rGeo.rotateX(-Math.PI / 2);
			rGeo.rotateY(angle);
			rGeo.translate((a.x + b.x) / 2, 0.02, (a.z + b.z) / 2);
			roadGeos.push(rGeo);

			// Centre-line dashes
			const dashLen = 4, dashGap = 4;
			const numDash = Math.floor(len / (dashLen + dashGap));
			for (let k = 0; k < numDash; k++) {
				const t = (k * (dashLen + dashGap) + dashLen / 2) / len;
				const dGeo = new THREE.PlaneGeometry(0.28, dashLen);
				dGeo.rotateX(-Math.PI / 2);
				dGeo.rotateY(angle);
				dGeo.translate(a.x + dx * t, 0.035, a.z + dz * t);
				dashGeos.push(dGeo);
			}
		}
	}

	if (roadGeos.length > 0) scene.add(new THREE.Mesh(mergeGeometries(roadGeos, false), roadMat));
	if (dashGeos.length > 0) scene.add(new THREE.Mesh(mergeGeometries(dashGeos, false), dashMat));
}

// Street lights on road-like areas (not inside buildings)
function buildStreetlights(scene, boxes) {
	const poleMat = new THREE.MeshStandardMaterial({ color: 0x383844, roughness: 0.6, metalness: 0.55 });
	const glowMat = new THREE.MeshStandardMaterial({ color: 0xfff0b8, emissive: 0xfff0b8, emissiveIntensity: 2.8 });

	const step = 55;
	const positions = [];
	for (let x = -RADIUS_METERS; x < RADIUS_METERS; x += step) {
		for (let z = -RADIUS_METERS; z < RADIUS_METERS; z += step) {
			const inBuilding = boxes.some(b => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);
			if (!inBuilding) positions.push({ x, z });
		}
	}
	if (positions.length === 0) return;

	const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 6, 5), poleMat, positions.length);
	const glowMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 5, 5), glowMat, positions.length);
	poleMesh.castShadow = true;

	const m = new THREE.Matrix4();
	positions.forEach(({ x, z }, i) => {
		m.makeTranslation(x, 3, z);
		poleMesh.setMatrixAt(i, m);
		m.makeTranslation(x, 6.5, z);
		glowMesh.setMatrixAt(i, m);
	});
	poleMesh.instanceMatrix.needsUpdate = true;
	glowMesh.instanceMatrix.needsUpdate = true;
	scene.add(poleMesh);
	scene.add(glowMesh);
}

// Pre-render static overhead minimap canvas
export function buildMinimapStatic(buildingBoxes) {
	const SCALE = 0.46; // px per metre (700m * 2 * 0.46 ≈ 644px canvas)
	const SIZE = Math.ceil(CITY_HALF * 2 * SCALE);
	const c = document.createElement('canvas');
	c.width = SIZE; c.height = SIZE;
	const ctx = c.getContext('2d');

	ctx.fillStyle = '#14141a';
	ctx.fillRect(0, 0, SIZE, SIZE);

	for (const b of buildingBoxes) {
		const brightness = Math.min(1, 0.3 + b.h / 80);
		ctx.fillStyle = `rgba(${Math.round(60 + brightness * 90)},${Math.round(65 + brightness * 80)},${Math.round(80 + brightness * 90)},0.88)`;
		const sx = (b.minX + CITY_HALF) * SCALE;
		const sz = (b.minZ + CITY_HALF) * SCALE;
		ctx.fillRect(sx, sz, Math.max(1, (b.maxX - b.minX) * SCALE), Math.max(1, (b.maxZ - b.minZ) * SCALE));
	}

	return { canvas: c, scale: SCALE };
}

// Office window emissive canvas — warm/cool glow, deterministic per load
function buildWindowTex() {
	const COLS = 6, ROWS = 10;
	const W = 128, H = 200;
	const c = document.createElement('canvas');
	c.width = W; c.height = H;
	const ctx = c.getContext('2d');

	ctx.fillStyle = '#060608';
	ctx.fillRect(0, 0, W, H);

	const cw = W / COLS, rh = H / ROWS;
	const pw = cw * 0.54, ph = rh * 0.50;
	const ox = (cw - pw) / 2, oy = (rh - ph) / 2;

	let s = 0xc0ffee;
	const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };

	for (let col = 0; col < COLS; col++) {
		for (let row = 0; row < ROWS; row++) {
			if (rand() > 0.44) {
				const warm = rand() > 0.38;
				const a = (0.55 + rand() * 0.45).toFixed(2);
				ctx.fillStyle = warm ? `rgba(255,228,155,${a})` : `rgba(175,215,255,${a})`;
				ctx.fillRect(col * cw + ox, row * rh + oy, pw, ph);
			}
		}
	}

	return new THREE.CanvasTexture(c);
}
