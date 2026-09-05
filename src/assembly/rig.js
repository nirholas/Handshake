// The small runtime every machine in the atlas is built on.
//
// A machine is a tree of `part()` meshes. Each part records where it rests when
// assembled and which way it flies when the assembly is exploded, so explode /
// reassemble is one lerp over the tree rather than a hand-keyed animation.

import * as THREE from 'three';

// Create a named, explodable mesh. `explode` is a metre offset applied at
// factor 1; `group` names the subassembly it belongs to in the parts list.
export function part(geometry, material, { name, group, explode, position, rotation, scale } = {}) {
	const mesh = new THREE.Mesh(geometry, material);
	mesh.name = name || 'part';
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	if (position) mesh.position.copy(position);
	if (rotation) mesh.rotation.copy(rotation);
	if (scale) mesh.scale.copy(scale);
	mesh.userData.group = group || 'frame';
	mesh.userData.rest = mesh.position.clone();
	mesh.userData.explode = explode ? explode.clone() : new THREE.Vector3();
	return mesh;
}

// A pivot that participates in explode without carrying geometry itself.
export function joint(name, { group, explode, position } = {}) {
	const g = new THREE.Group();
	g.name = name;
	if (position) g.position.copy(position);
	g.userData.group = group || 'frame';
	g.userData.rest = g.position.clone();
	g.userData.explode = explode ? explode.clone() : new THREE.Vector3();
	return g;
}

const _v = new THREE.Vector3();

// Walk the tree once and place everything between rest and exploded. Called
// every frame while the factor is moving and never after it settles.
export function applyExplode(root, factor) {
	root.traverse((o) => {
		const rest = o.userData && o.userData.rest;
		if (!rest) return;
		const e = o.userData.explode;
		o.position.copy(rest).add(_v.copy(e).multiplyScalar(factor));
	});
}

// Group ids present in a machine, in the order they first appear, so the parts
// list reads top-down through the assembly instead of alphabetically.
export function groupsOf(root) {
	const seen = [];
	root.traverse((o) => {
		const g = o.userData && o.userData.group;
		if (g && !seen.includes(g)) seen.push(g);
	});
	return seen;
}

export function setGroupVisible(root, group, visible) {
	root.traverse((o) => {
		if (o.userData && o.userData.group === group) o.visible = visible;
	});
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

// Point a unit-length +Y primitive (a cylinder, a tube, a guide bar) at the
// segment a to b and stretch it to fit. Geometry stays unit length so the same
// buffer serves a link whose length changes every frame.
export function alignSegment(mesh, a, b) {
	_a.copy(a);
	_b.copy(b).sub(_a);
	const len = _b.length();
	mesh.position.copy(_a).addScaledVector(_b, 0.5);
	if (mesh.userData) mesh.userData.rest = mesh.position.clone();
	if (len > 1e-6) {
		_q.setFromUnitVectors(_up, _b.divideScalar(len));
		mesh.quaternion.copy(_q);
		mesh.scale.y = len;
	}
	return len;
}

// Slider-crank solved in the plane: given a crankpin at `pin` and a rod of
// length `rod` whose far end is constrained to the line through the origin in
// direction `axis`, return the distance from the origin to that far end.
// This is the exact solution, not an approximation, so a long rod and a short
// one give visibly different piston motion the way real engines do.
export function slider(pin, axis, rod) {
	const proj = pin.x * axis.x + pin.y * axis.y;
	const disc = rod * rod - (pin.x * pin.x + pin.y * pin.y) + proj * proj;
	return proj + Math.sqrt(Math.max(disc, 0));
}

// Where two circles meet. `sign` picks which of the two intersections to take,
// which is how a linkage stays on one branch of its solution instead of
// snapping through itself halfway round a revolution. Returns null when the
// links cannot reach, so a bad parameter set degrades to "hold the last pose"
// rather than to NaN geometry.
export function circleIntersect(c1, r1, c2, r2, sign = 1) {
	const dx = c2.x - c1.x;
	const dy = c2.y - c1.y;
	const dist = Math.hypot(dx, dy);
	if (dist < 1e-9 || dist > r1 + r2 || dist < Math.abs(r1 - r2)) return null;
	const a = (r1 * r1 - r2 * r2 + dist * dist) / (2 * dist);
	const h2 = r1 * r1 - a * a;
	if (h2 < 0) return null;
	const h = Math.sqrt(h2);
	const mx = c1.x + (a * dx) / dist;
	const my = c1.y + (a * dy) / dist;
	return new THREE.Vector2(mx + (sign * h * dy) / dist, my - (sign * h * dx) / dist);
}

// A pin on a horizontal line, reached from `centre` by a link of length `len`.
// The crosshead and the valve spindle both ride lines like this.
export function slideOnLine(centre, y, len, sign = 1) {
	const dy = y - centre.y;
	const disc = len * len - dy * dy;
	if (disc < 0) return null;
	return new THREE.Vector2(centre.x + sign * Math.sqrt(disc), y);
}

// Place a planar link mesh built by `rodGeometry` (big end at the origin,
// running +X) so its ends land on a and b.
export function placeLink(mesh, a, b, z = 0) {
	mesh.position.set(a.x, a.y, z);
	if (mesh.userData) mesh.userData.rest.copy(mesh.position);
	mesh.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
}
