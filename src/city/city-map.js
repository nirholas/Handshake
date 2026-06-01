import * as THREE from 'three';

// City grid constants (metres)
export const BLOCK = 56;       // building footprint area per block
export const ROAD = 14;        // road width (kerb to kerb + sidewalk)
export const CELL = BLOCK + ROAD; // 70 — one grid cell
export const GRID = 8;         // 8×8 blocks
export const CITY_HALF = (GRID * CELL + ROAD) / 2; // 287 — half-extent from origin

// NYC-inspired architectural palette: brick, concrete, glass, stone
const PALETTE = [
	0xc0794a, // terracotta brick
	0xb8a888, // limestone
	0x4a6e9a, // glass blue
	0x9a9898, // concrete gray
	0xd4c890, // sandstone cream
	0x607878, // weathered dark concrete
	0xa06048, // dark brick red
	0x7898b8, // steel glass
	0xd8ccb8, // light stone
	0x506070, // dark glass tower
	0xb89870, // warm sandstone
	0x88a070, // industrial green-gray
];

// Deterministic seeded RNG (mulberry32-style)
function makeRng(seed) {
	let s = seed ^ 0xdeadbeef;
	return () => {
		s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
		s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
		s ^= s >>> 16;
		return (s >>> 0) / 0xffffffff;
	};
}

// Build the entire city geometry into `scene`.
// Returns { buildingBoxes } — flat AABB list used for collision.
export function buildCity(scene) {
	const r = makeRng(42);
	const buildingBoxes = [];

	// ── Ground (grass/dirt base beneath everything) ───────────────────────────
	const groundSize = CITY_HALF * 2 + 600;
	const groundMesh = new THREE.Mesh(
		new THREE.PlaneGeometry(groundSize, groundSize),
		new THREE.MeshStandardMaterial({ color: 0x2a3a28, roughness: 1.0 }),
	);
	groundMesh.rotation.x = -Math.PI / 2;
	groundMesh.receiveShadow = true;
	scene.add(groundMesh);

	// ── Road surface (one large dark plane) ──────────────────────────────────
	const roadMesh = new THREE.Mesh(
		new THREE.PlaneGeometry(CITY_HALF * 2, CITY_HALF * 2),
		new THREE.MeshStandardMaterial({ color: 0x282830, roughness: 0.92, metalness: 0.05 }),
	);
	roadMesh.rotation.x = -Math.PI / 2;
	roadMesh.position.y = 0.01;
	roadMesh.receiveShadow = true;
	scene.add(roadMesh);

	// ── Sidewalk pads (one per block, slightly raised) ────────────────────────
	const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x38383e, roughness: 0.9 });
	const sidewalkGeo = new THREE.PlaneGeometry(BLOCK + 2, BLOCK + 2);
	for (let bx = 0; bx < GRID; bx++) {
		for (let bz = 0; bz < GRID; bz++) {
			const cx = blockCenter(bx);
			const cz = blockCenter(bz);
			const pad = new THREE.Mesh(sidewalkGeo, sidewalkMat);
			pad.rotation.x = -Math.PI / 2;
			pad.position.set(cx, 0.02, cz);
			pad.receiveShadow = true;
			scene.add(pad);
		}
	}

	// ── Road centre-line dashes ───────────────────────────────────────────────
	buildRoadMarkings(scene);

	// ── Collect building instance data grouped by colour ─────────────────────
	const byColor = new Map(); // paletteIdx → [{cx, cz, w, h, d}]
	for (let bx = 0; bx < GRID; bx++) {
		for (let bz = 0; bz < GRID; bz++) {
			placeBlockBuildings(blockCenter(bx), blockCenter(bz), r, byColor, buildingBoxes);
		}
	}

	// ── Window texture (shared emissive canvas — lit offices) ────────────────
	const WIN_TEX = buildWindowTex();
	WIN_TEX.wrapS = WIN_TEX.wrapT = THREE.RepeatWrapping;
	// Repeat of 0.3 ≈ one window every ~3 building units at typical building sizes
	WIN_TEX.repeat.set(0.3, 0.3);

	// ── Emit one InstancedMesh per colour ─────────────────────────────────────
	const unitBox = new THREE.BoxGeometry(1, 1, 1);
	const tm = new THREE.Matrix4();
	const q = new THREE.Quaternion();

	for (const [palIdx, list] of byColor) {
		const mat = new THREE.MeshStandardMaterial({
			color: PALETTE[palIdx],
			roughness: 0.85,
			metalness: 0.0,
			emissiveMap: WIN_TEX,
			emissive: new THREE.Color(0xfff0c0),
			emissiveIntensity: 0.55,
		});
		const mesh = new THREE.InstancedMesh(unitBox, mat, list.length);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		list.forEach(({ cx, cz, w, h, d }, i) => {
			tm.compose(new THREE.Vector3(cx, h / 2, cz), q, new THREE.Vector3(w, h, d));
			mesh.setMatrixAt(i, tm);
		});
		mesh.instanceMatrix.needsUpdate = true;
		scene.add(mesh);
	}

	// ── Rooftop caps (single grey, all buildings) ─────────────────────────────
	const allBuildings = [...byColor.values()].flat();
	if (allBuildings.length > 0) {
		const roofMat = new THREE.MeshStandardMaterial({ color: 0x505058, roughness: 0.6, metalness: 0.15 });
		const roofMesh = new THREE.InstancedMesh(unitBox, roofMat, allBuildings.length);
		allBuildings.forEach(({ cx, cz, w, h, d }, i) => {
			tm.compose(new THREE.Vector3(cx, h + 0.25, cz), q, new THREE.Vector3(w + 0.4, 0.5, d + 0.4));
			roofMesh.setMatrixAt(i, tm);
		});
		roofMesh.instanceMatrix.needsUpdate = true;
		scene.add(roofMesh);
	}

	// ── Street lights ─────────────────────────────────────────────────────────
	buildStreetlights(scene);

	return { buildingBoxes };
}

// Centre coordinate of grid column/row index
function blockCenter(idx) {
	return -CITY_HALF + ROAD + BLOCK / 2 + idx * CELL;
}

// Fill a block with buildings, push instances to byColor, boxes to buildingBoxes
function placeBlockBuildings(bCX, bCZ, r, byColor, buildingBoxes) {
	const margin = 4;
	const inner = BLOCK - margin * 2;  // 48m inner area
	const cols = 2 + Math.floor(r() * 2); // 2 or 3
	const rows = 2 + Math.floor(r() * 2);
	const cellW = inner / cols;
	const cellD = inner / rows;

	for (let ci = 0; ci < cols; ci++) {
		for (let ri = 0; ri < rows; ri++) {
			if (r() < 0.12) continue; // occasionally leave a gap

			// Centre of this slot with slight jitter
			const cx = bCX - inner / 2 + cellW * (ci + 0.5) + (r() - 0.5) * cellW * 0.14;
			const cz = bCZ - inner / 2 + cellD * (ri + 0.5) + (r() - 0.5) * cellD * 0.14;

			const w = cellW * (0.60 + r() * 0.32);
			const d = cellD * (0.60 + r() * 0.32);
			// Height biased toward shorter buildings (urban density mix)
			const h = Math.pow(r(), 1.7) * 52 + 4;

			const palIdx = Math.floor(r() * PALETTE.length);

			if (!byColor.has(palIdx)) byColor.set(palIdx, []);
			byColor.get(palIdx).push({ cx, cz, w, h, d });

			buildingBoxes.push({
				minX: cx - w / 2, maxX: cx + w / 2,
				minZ: cz - d / 2, maxZ: cz + d / 2,
				h,
			});
		}
	}
}

// Yellow dashed centre lines along every road
function buildRoadMarkings(scene) {
	const dashMat = new THREE.MeshStandardMaterial({
		color: 0xeecc00,
		emissive: 0x443300,
		emissiveIntensity: 0.15,
		roughness: 0.9,
	});
	// Vertical roads (parallel to Z)
	for (let i = 0; i <= GRID; i++) {
		const rx = -CITY_HALF + ROAD / 2 + i * CELL;
		addDashes(scene, dashMat, rx, true);
	}
	// Horizontal roads (parallel to X)
	for (let i = 0; i <= GRID; i++) {
		const rz = -CITY_HALF + ROAD / 2 + i * CELL;
		addDashes(scene, dashMat, rz, false);
	}
}

function addDashes(scene, mat, axisVal, alongZ) {
	const length = CITY_HALF * 2;
	const dashLen = 5;
	const dashGap = 5;
	const count = Math.floor(length / (dashLen + dashGap));
	// PlaneGeometry is in the XY plane; rotate -90° around X to lay flat on ground
	const geo = alongZ
		? new THREE.PlaneGeometry(0.28, dashLen)   // width × length along Z
		: new THREE.PlaneGeometry(dashLen, 0.28);   // length along X × width
	const mesh = new THREE.InstancedMesh(geo, mat, count);
	// Rotation matrix: -90° around X lays the plane flat (normal faces +Y)
	const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
	const trans = new THREE.Matrix4();
	const m = new THREE.Matrix4();
	for (let k = 0; k < count; k++) {
		const along = -CITY_HALF + k * (dashLen + dashGap) + dashLen / 2;
		const px = alongZ ? axisVal : along;
		const pz = alongZ ? along : axisVal;
		trans.makeTranslation(px, 0.035, pz);
		m.multiplyMatrices(trans, rot);
		mesh.setMatrixAt(k, m);
	}
	mesh.instanceMatrix.needsUpdate = true;
	scene.add(mesh);
}

// Street lights at every road intersection
function buildStreetlights(scene) {
	const poleMat = new THREE.MeshStandardMaterial({ color: 0x484854, roughness: 0.6, metalness: 0.5 });
	const glowMat = new THREE.MeshStandardMaterial({ color: 0xfff0b8, emissive: 0xfff0b8, emissiveIntensity: 2.5 });

	const intersections = (GRID + 1) * (GRID + 1);
	const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.09, 6.5, 6), poleMat, intersections);
	const glowMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 6, 6), glowMat, intersections);
	poleMesh.castShadow = true;

	const m = new THREE.Matrix4();
	let idx = 0;
	for (let bx = 0; bx <= GRID; bx++) {
		for (let bz = 0; bz <= GRID; bz++) {
			const x = -CITY_HALF + ROAD / 2 + bx * CELL - 3;
			const z = -CITY_HALF + ROAD / 2 + bz * CELL - 3;
			m.makeTranslation(x, 3.25, z);
			poleMesh.setMatrixAt(idx, m);
			m.makeTranslation(x, 6.7, z);
			glowMesh.setMatrixAt(idx, m);
			idx++;
		}
	}
	poleMesh.instanceMatrix.needsUpdate = true;
	glowMesh.instanceMatrix.needsUpdate = true;
	scene.add(poleMesh);
	scene.add(glowMesh);
}

// Pre-render a static overhead minimap canvas for the city layout.
// Returns an HTMLCanvasElement you can drawImage() from every frame.
export function buildMinimapStatic(buildingBoxes) {
	const SCALE = 1.8; // pixels per metre
	const SIZE = Math.ceil(CITY_HALF * 2 * SCALE);
	const c = document.createElement('canvas');
	c.width = SIZE; c.height = SIZE;
	const ctx = c.getContext('2d');

	// Road base
	ctx.fillStyle = '#18181e';
	ctx.fillRect(0, 0, SIZE, SIZE);

	// Sidewalk pads
	ctx.fillStyle = '#2a2a32';
	for (let bx = 0; bx < GRID; bx++) {
		for (let bz = 0; bz < GRID; bz++) {
			const cx = blockCenter(bx);
			const cz = blockCenter(bz);
			const sx = (cx - BLOCK / 2 + CITY_HALF) * SCALE;
			const sz = (cz - BLOCK / 2 + CITY_HALF) * SCALE;
			ctx.fillRect(sx, sz, BLOCK * SCALE, BLOCK * SCALE);
		}
	}

	// Buildings (taller = slightly lighter)
	for (const b of buildingBoxes) {
		const brightness = Math.min(1, 0.3 + b.h / 60);
		ctx.fillStyle = `rgba(${Math.round(80 + brightness * 70)},${Math.round(85 + brightness * 65)},${Math.round(100 + brightness * 60)},0.9)`;
		const sx = (b.minX + CITY_HALF) * SCALE;
		const sz = (b.minZ + CITY_HALF) * SCALE;
		const sw = (b.maxX - b.minX) * SCALE;
		const sd = (b.maxZ - b.minZ) * SCALE;
		ctx.fillRect(sx, sz, Math.max(1, sw), Math.max(1, sd));
	}

	return { canvas: c, scale: SCALE };
}

// Canvas texture simulating lit/unlit office windows.
// Tiled via repeat on the building emissive map — warm glow on every face.
function buildWindowTex() {
	const COLS = 6, ROWS = 10;
	const W = 128, H = 200;
	const c = document.createElement('canvas');
	c.width = W; c.height = H;
	const ctx = c.getContext('2d');

	// Dark building face base
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, W, H);

	const cw = W / COLS, rh = H / ROWS;
	const pw = cw * 0.56, ph = rh * 0.52;
	const ox = (cw - pw) / 2, oy = (rh - ph) / 2;

	// Deterministic random for consistent look every load
	let s = 0xc0ffee;
	const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };

	for (let col = 0; col < COLS; col++) {
		for (let row = 0; row < ROWS; row++) {
			if (rand() > 0.45) { // ~55% of windows lit
				// Vary between warm (office) and cool (fluorescent) light
				const warm = rand() > 0.4;
				ctx.fillStyle = warm ? `rgba(255,225,150,${0.6 + rand() * 0.4})` : `rgba(180,220,255,${0.5 + rand() * 0.4})`;
				ctx.fillRect(col * cw + ox, row * rh + oy, pw, ph);
			}
		}
	}

	return new THREE.CanvasTexture(c);
}
