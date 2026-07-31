// Docs World wayfinder: search a doc, and the world walks you to it.
//
// A docs site normally answers "where is that page?" with a link. Here the
// answer is a place, so the answer has to be a route. This module computes a
// walkable path from wherever the visitor is standing to the pavilion that
// holds a page, draws it as a stream of chevrons flowing along the ground, and
// reports the live distance so the HUD can count it down. Arriving opens the
// page: the visitor never has to spot the right pavilion themselves.
//
// The path is a real obstacle-avoiding polyline, not a straight line. Pavilions
// are solid (player.js pushes the avatar out of a keep-out disc around each
// one), so a naive line between two neighbouring pavilions would run straight
// through the two pavilions between them and the visitor would grind along the
// collision discs following it. computePath routes around them.
//
// Everything drawn here is one InstancedMesh plus two small meshes, so an
// active route costs three draw calls no matter how long it is.

import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Color,
	CylinderGeometry,
	DynamicDrawUsage,
	InstancedMesh,
	Matrix4,
	Mesh,
	MeshBasicMaterial,
	Quaternion,
	RingGeometry,
	Vector3,
} from 'three';
import { PAVILION_TRIGGER, RING_RADIUS } from './world.js';

// Keep-out radius used when routing. player.js pushes the avatar out of a 2.4m
// disc around each pavilion, so a path that merely grazes 2.4 would leave the
// walker scraping the collision surface the whole way. The extra metre is the
// difference between "technically walkable" and a route that feels chosen.
const CLEARANCE = 3.4;

// Where the route ends: short of the pavilion centre, on the plaza-facing side,
// which is where a visitor naturally stands to read the portal. Inside
// PAVILION_TRIGGER so the proximity prompt is already armed on arrival.
const APPROACH_INSET = 3.6;

// Chevron trail. SPACING is the gap along the path; COUNT caps the pool, so a
// path longer than COUNT * SPACING (about 76m, further than the world is wide)
// would simply draw fewer markers at the tail rather than misbehave.
const CHEVRON_COUNT = 72;
const CHEVRON_SPACING = 1.05;
const FLOW_SPEED = 2.6; // metres/second the chevrons slide toward the target

// Recompute the route only after the walker has drifted this far from where it
// was last planned. Recomputing every frame makes the detour waypoints shiver
// as the geometry flips between equally-good sides of an obstacle.
const REPLAN_DISTANCE = 1.4;

const ARRIVAL_RADIUS = PAVILION_TRIGGER;

// ── Path planning (pure, {x, z} in, {x, z}[] out; unit-tested) ───────────────

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Closest point to `c` on segment `a`→`b`, plus its distance.
 * @returns {{ x: number, z: number, dist: number, t: number }}
 */
function closestOnSegment(a, b, c) {
	const abx = b.x - a.x;
	const abz = b.z - a.z;
	const lenSq = abx * abx + abz * abz;
	const t = lenSq < 1e-9 ? 0 : clamp(((c.x - a.x) * abx + (c.z - a.z) * abz) / lenSq, 0, 1);
	const x = a.x + abx * t;
	const z = a.z + abz * t;
	return { x, z, t, dist: Math.hypot(c.x - x, c.z - z) };
}

/**
 * Plan a walkable route from `from` to `to` around circular obstacles.
 *
 * Straight line first; wherever it cuts through an obstacle, insert one
 * waypoint pushed out to the obstacle's edge on the side the segment already
 * leans toward, then re-test. That converges in a couple of passes for the
 * ring-of-pavilions layout and degrades to "as direct as the obstacles allow"
 * rather than failing if it does not.
 *
 * @param {{x:number,z:number}} from
 * @param {{x:number,z:number}} to
 * @param {Array<{x:number,z:number,r:number}>} obstacles
 * @param {number} [maxPasses]
 * @returns {Array<{x:number,z:number}>} at least [from, to]
 */
export function computePath(from, to, obstacles, maxPasses = 8) {
	const pts = [
		{ x: from.x, z: from.z },
		{ x: to.x, z: to.z },
	];
	if (!obstacles || !obstacles.length) return pts;

	for (let pass = 0; pass < maxPasses; pass++) {
		let inserted = false;

		for (let i = 0; i < pts.length - 1; i++) {
			const a = pts[i];
			const b = pts[i + 1];

			// The obstacle whose intrusion starts earliest along this segment: fixing
			// the first one first keeps the waypoints in travel order.
			let worst = null;
			let worstT = Infinity;
			for (const o of obstacles) {
				const near = closestOnSegment(a, b, o);
				if (near.dist < o.r && near.t < worstT) {
					worst = { o, near };
					worstT = near.t;
				}
			}
			if (!worst) continue;

			const { o, near } = worst;
			// Push the waypoint from the obstacle centre out through the segment's
			// closest approach: that is the side the traveller was already passing on,
			// so the detour is the shorter of the two.
			let px = near.x - o.x;
			let pz = near.z - o.z;
			let plen = Math.hypot(px, pz);
			if (plen < 1e-4) {
				// Dead centre: no side is implied, so step off perpendicular to travel.
				const dx = b.x - a.x;
				const dz = b.z - a.z;
				const dlen = Math.hypot(dx, dz) || 1;
				px = -dz / dlen;
				pz = dx / dlen;
				plen = 1;
			}
			const scale = (o.r + 0.5) / plen;
			pts.splice(i + 1, 0, { x: o.x + px * scale, z: o.z + pz * scale });
			inserted = true;
			break;
		}

		if (!inserted) break;
	}

	return pts;
}

/** Cumulative arc lengths for a polyline, and its total. */
function measure(points) {
	const cum = [0];
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
		cum.push(total);
	}
	return { cum, total };
}

/**
 * Point and heading at arc length `s` along a measured polyline.
 * @returns {{x:number, z:number, yaw:number}}
 */
function sampleAt(points, cum, s) {
	const clamped = clamp(s, 0, cum[cum.length - 1]);
	let i = 1;
	while (i < cum.length - 1 && cum[i] < clamped) i++;
	const a = points[i - 1];
	const b = points[i];
	const span = cum[i] - cum[i - 1];
	const t = span < 1e-6 ? 0 : (clamped - cum[i - 1]) / span;
	return {
		x: a.x + (b.x - a.x) * t,
		z: a.z + (b.z - a.z) * t,
		yaw: Math.atan2(b.x - a.x, b.z - a.z),
	};
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * A flat chevron lying in the XZ plane, pointing toward +z, so an instance only
 * ever needs a yaw rotation. Two triangles form the arrow's notched tail.
 */
function chevronGeometry() {
	const tipZ = 0.34;
	const backZ = -0.2;
	const notchZ = -0.02;
	const halfW = 0.3;
	const innerW = 0.09;
	const verts = new Float32Array([
		// left half
		0, 0, tipZ, -halfW, 0, backZ, -innerW, 0, notchZ,
		// right half
		0, 0, tipZ, innerW, 0, notchZ, halfW, 0, backZ,
	]);
	const geo = new BufferGeometry();
	geo.setAttribute('position', new BufferAttribute(verts, 3));
	geo.computeVertexNormals();
	return geo;
}

/**
 * Build the wayfinder.
 *
 * @param {import('three').Scene} scene
 * @param {Array<{group: import('three').Group, angle: number, color: Color, section: object, index: number}>} pavilions
 * @param {{ reducedMotion?: boolean }} [opts]
 */
export function createWayfinder(scene, pavilions, { reducedMotion = false } = {}) {
	const chevrons = new InstancedMesh(
		chevronGeometry(),
		new MeshBasicMaterial({
			transparent: true,
			opacity: 0.95,
			blending: AdditiveBlending,
			depthWrite: false,
			// Both faces: the trail is read from above at every camera pitch, and a
			// single-sided arrow vanishes the moment the camera dips below its plane
			// in first person.
			side: 2,
		}),
		CHEVRON_COUNT,
	);
	chevrons.instanceMatrix.setUsage(DynamicDrawUsage);
	chevrons.frustumCulled = false;
	chevrons.visible = false;
	chevrons.renderOrder = 2;
	scene.add(chevrons);

	// Per-instance colour is how the trail fades: with additive blending, a
	// colour scaled toward black IS transparency, and it costs no extra draw call.
	const instanceColors = new Float32Array(CHEVRON_COUNT * 3);
	chevrons.instanceColor = new BufferAttribute(instanceColors, 3);
	chevrons.instanceColor.setUsage(DynamicDrawUsage);

	// Destination marker: a column of light at the target pavilion plus a ring
	// that pulses on the ground, so the goal is visible from across the world
	// even when the trail's far end is behind a pavilion.
	const beam = new Mesh(
		new CylinderGeometry(0.5, 1.25, 26, 16, 1, true),
		new MeshBasicMaterial({
			transparent: true,
			opacity: 0.15,
			blending: AdditiveBlending,
			depthWrite: false,
			side: 2,
		}),
	);
	beam.position.y = 13;
	beam.visible = false;
	beam.frustumCulled = false;
	scene.add(beam);

	const halo = new Mesh(
		new RingGeometry(2.9, 3.5, 48),
		new MeshBasicMaterial({
			transparent: true,
			opacity: 0.5,
			blending: AdditiveBlending,
			depthWrite: false,
			side: 2,
		}),
	);
	halo.rotation.x = -Math.PI / 2;
	halo.position.y = 0.05;
	halo.visible = false;
	scene.add(halo);

	const matrix = new Matrix4();
	const quat = new Quaternion();
	const axisY = new Vector3(0, 1, 0);
	const scaleVec = new Vector3(1, 1, 1);
	const tint = new Color();

	/** @type {{pavilion: object, page: object, points: Array, cum: number[], total: number} | null} */
	let route = null;
	let phase = 0;
	let plannedFrom = { x: 0, z: 0 };
	let pulse = 0;

	function obstaclesExcept(targetIndex) {
		const out = [];
		for (const p of pavilions) {
			if (p.index === targetIndex) continue;
			out.push({ x: p.group.position.x, z: p.group.position.z, r: CLEARANCE });
		}
		return out;
	}

	function approachPoint(pavilion) {
		// Plaza-facing side of the pavilion: pull its ring position in toward the
		// centre by the inset. RING_RADIUS is never 0, so this is always defined.
		const k = (RING_RADIUS - APPROACH_INSET) / RING_RADIUS;
		return { x: pavilion.group.position.x * k, z: pavilion.group.position.z * k };
	}

	function plan(from) {
		if (!route) return;
		const points = computePath(from, approachPoint(route.pavilion), obstaclesExcept(route.pavilion.index));
		const { cum, total } = measure(points);
		route.points = points;
		route.cum = cum;
		route.total = total;
		plannedFrom = { x: from.x, z: from.z };
	}

	/**
	 * Start guiding the walker to the page `page` in `pavilion`.
	 * @param {object} pavilion a member of the `pavilions` array
	 * @param {{label: string, path: string}} page
	 * @param {{x:number, z:number}} from the walker's current position
	 */
	function routeTo(pavilion, page, from) {
		route = { pavilion, page, points: [], cum: [0], total: 0 };
		plan(from);
		phase = 0;

		const c = pavilion.color;
		beam.material.color.copy(c);
		halo.material.color.copy(c);
		beam.position.set(pavilion.group.position.x, 13, pavilion.group.position.z);
		halo.position.set(pavilion.group.position.x, 0.05, pavilion.group.position.z);
		beam.visible = true;
		halo.visible = true;
		chevrons.visible = true;
	}

	function clear() {
		route = null;
		chevrons.visible = false;
		beam.visible = false;
		halo.visible = false;
	}

	/**
	 * Advance the trail and report progress.
	 *
	 * @param {number} dt seconds
	 * @param {{x:number, z:number}} walker current player position
	 * @returns {{ active: boolean, distance: number, arrived: boolean, page: object|null, section: string }}
	 */
	function update(dt, walker) {
		if (!route) return { active: false, distance: 0, arrived: false, page: null, section: '' };

		if (Math.hypot(walker.x - plannedFrom.x, walker.z - plannedFrom.z) > REPLAN_DISTANCE) {
			plan(walker);
		}

		const target = route.pavilion.group.position;
		const distance = Math.hypot(walker.x - target.x, walker.z - target.z);
		const arrived = distance <= ARRIVAL_RADIUS;

		pulse += dt;
		const beat = reducedMotion ? 0.5 : 0.5 + Math.sin(pulse * 2.4) * 0.22;
		halo.material.opacity = beat;
		const haloScale = reducedMotion ? 1 : 1 + Math.sin(pulse * 2.4) * 0.06;
		halo.scale.set(haloScale, haloScale, 1);
		beam.material.opacity = reducedMotion ? 0.14 : 0.11 + Math.sin(pulse * 1.7) * 0.05;

		if (!reducedMotion) phase = (phase + dt * FLOW_SPEED) % CHEVRON_SPACING;

		// Start the trail clear of the walker's own feet so the avatar never stands
		// inside an arrow, and stop it short of the marker ring.
		const head = 1.1;
		const tail = Math.max(head, route.total - 1.6);
		const walkerS = 0; // the path is replanned from the walker, so s=0 is at their feet
		let drawn = 0;

		for (let i = 0; i < CHEVRON_COUNT; i++) {
			const s = walkerS + head + i * CHEVRON_SPACING + phase;
			if (s > tail) break;
			const p = sampleAt(route.points, route.cum, s);
			quat.setFromAxisAngle(axisY, p.yaw);
			matrix.compose(new Vector3(p.x, 0.045, p.z), quat, scaleVec);
			chevrons.setMatrixAt(i, matrix);

			// Fade the first two in and the last three out so the trail has ends
			// rather than stopping mid-stride.
			const fromStart = s - head;
			const toEnd = tail - s;
			const alpha = Math.min(1, fromStart / 2.2) * Math.min(1, toEnd / 3.2);
			tint.copy(route.pavilion.color).multiplyScalar(Math.max(0.05, alpha));
			chevrons.setColorAt(i, tint);
			drawn++;
		}

		chevrons.count = drawn;
		chevrons.instanceMatrix.needsUpdate = true;
		if (chevrons.instanceColor) chevrons.instanceColor.needsUpdate = true;

		return {
			active: true,
			distance,
			arrived,
			page: route.page,
			section: route.pavilion.section.title,
		};
	}

	return {
		routeTo,
		clear,
		update,
		get active() {
			return !!route;
		},
		get target() {
			return route ? route.page : null;
		},
	};
}
