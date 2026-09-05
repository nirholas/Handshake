// Parametric part vocabulary for the Machine Atlas (/assembly).
//
// Nothing here loads a file. Every export turns a handful of dimensions into
// real BufferGeometry: profiles get revolved, cross-sections get extruded,
// airfoil stations get lofted. The machines in this folder are assembled
// entirely out of these calls, which is why changing a slider rebuilds actual
// geometry instead of scaling a mesh.
//
// Conventions:
//   - Units are metres. A driving wheel really is 1.6 m across.
//   - Wheels, rods and any planar linkage live in the XY plane and spin about
//     +Z, so the kinematics in the machine modules stay 2D and exact.
//   - Every builder returns geometry with normals computed and nothing shared,
//     so a rebuild can dispose the old tree without touching the new one.

import * as THREE from 'three';

/* ── profiles and revolves ──────────────────────────────────────────── */

// A profile is an array of [radius, axial] pairs. Revolving it about +Y is the
// cheapest way to describe a turned part: shafts, domes, stacks, bosses.
export function profilePoints(pairs) {
	return pairs.map(([r, y]) => new THREE.Vector2(r, y));
}

export function lathe(pairs, segments = 48) {
	const g = new THREE.LatheGeometry(profilePoints(pairs), segments);
	g.computeVertexNormals();
	return g;
}

// A finned air-cooled barrel: one revolve of a sawtooth profile, so the fins
// are part of the same surface a real casting would have, not stacked rings.
export function finnedBarrel({
	bore,
	wall = 0.008,
	finRoot,
	finTip,
	length,
	fins,
	finThickness = 0.004,
	segments = 40,
}) {
	const rBore = bore / 2;
	const rRoot = finRoot ?? rBore + wall;
	const rTip = finTip ?? rRoot + 0.035;
	const pairs = [[rBore, 0], [rRoot, 0]];
	const pitch = fins > 1 ? (length - finThickness) / (fins - 1) : 0;
	for (let i = 0; i < fins; i++) {
		const y = i * pitch;
		pairs.push([rRoot, y], [rTip, y], [rTip, y + finThickness], [rRoot, y + finThickness]);
	}
	pairs.push([rRoot, length], [rBore, length], [rBore, 0]);
	return lathe(pairs, segments);
}

/* ── extruded cross-sections ────────────────────────────────────────── */

function roundedRectShape(w, h, r) {
	const x = -w / 2;
	const y = -h / 2;
	const k = Math.min(r, w / 2, h / 2);
	const s = new THREE.Shape();
	s.moveTo(x + k, y);
	s.lineTo(x + w - k, y);
	s.quadraticCurveTo(x + w, y, x + w, y + k);
	s.lineTo(x + w, y + h - k);
	s.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
	s.lineTo(x + k, y + h);
	s.quadraticCurveTo(x, y + h, x, y + h - k);
	s.lineTo(x, y + k);
	s.quadraticCurveTo(x, y, x + k, y);
	return s;
}

// A box with softened edges. Every hard-edged casting on the atlas uses this
// instead of BoxGeometry so highlights read as metal rather than as a cube.
export function roundedBox(w, h, d, r = 0.01, bevel = true) {
	const bs = bevel ? Math.min(r * 0.6, d / 4) : 0;
	const g = new THREE.ExtrudeGeometry(roundedRectShape(w, h, r), {
		depth: d - bs * 2,
		bevelEnabled: bevel,
		bevelThickness: bs,
		bevelSize: bs,
		bevelSegments: 2,
		curveSegments: 6,
	});
	g.translate(0, 0, -(d - bs * 2) / 2 - bs);
	g.computeVertexNormals();
	return g;
}

// A connecting or coupling rod: a waisted stadium running +X from a big end at
// the origin to a small end at `length`, extruded through its thickness in Z.
export function rodGeometry({ length, bigEndR, smallEndR, waist, thickness, boss = 0 }) {
	const w = waist ?? Math.min(bigEndR, smallEndR) * 0.62;
	const s = new THREE.Shape();
	s.moveTo(0, bigEndR);
	s.quadraticCurveTo(length * 0.5, w, length, smallEndR);
	s.absarc(length, 0, smallEndR, Math.PI / 2, -Math.PI / 2, true);
	s.quadraticCurveTo(length * 0.5, -w, 0, -bigEndR);
	s.absarc(0, 0, bigEndR, -Math.PI / 2, -Math.PI * 1.5, true);
	const g = new THREE.ExtrudeGeometry(s, {
		depth: thickness,
		bevelEnabled: true,
		bevelThickness: thickness * 0.12,
		bevelSize: thickness * 0.12,
		bevelSegments: 1,
		curveSegments: 18,
	});
	g.translate(0, 0, -thickness / 2);
	if (boss > 0) {
		const bosses = [];
		for (const [x, r] of [[0, bigEndR], [length, smallEndR]]) {
			const b = new THREE.CylinderGeometry(r * 0.98, r * 0.98, thickness + boss * 2, 24);
			b.rotateX(Math.PI / 2);
			b.translate(x, 0, 0);
			bosses.push(b);
		}
		return mergeGeometries([g, ...bosses]);
	}
	g.computeVertexNormals();
	return g;
}

// An annular sector extruded in Z: counterweights, brackets, expansion links.
export function arcSector({ rInner, rOuter, from, to, thickness, segments = 28 }) {
	const s = new THREE.Shape();
	s.absarc(0, 0, rOuter, from, to, false);
	s.absarc(0, 0, rInner, to, from, true);
	const g = new THREE.ExtrudeGeometry(s, {
		depth: thickness,
		bevelEnabled: false,
		curveSegments: segments,
	});
	g.translate(0, 0, -thickness / 2);
	g.computeVertexNormals();
	return g;
}

// Flat-bottom rail section (head, web, foot), extruded along +Z as the track
// direction. The web taper is what makes a rail read as a rail at a glance.
export function railShape(scale = 1) {
	const s = new THREE.Shape();
	const p = (x, y) => [x * scale, y * scale];
	const pts = [
		p(-0.076, 0), p(0.076, 0), p(0.076, 0.014), p(0.020, 0.036),
		p(0.016, 0.116), p(0.037, 0.130), p(0.037, 0.166), p(0.020, 0.185),
		p(-0.020, 0.185), p(-0.037, 0.166), p(-0.037, 0.130), p(-0.016, 0.116),
		p(-0.020, 0.036), p(-0.076, 0.014),
	];
	s.moveTo(pts[0][0], pts[0][1]);
	for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
	s.closePath();
	return s;
}

export function railGeometry(length, scale = 1) {
	const g = new THREE.ExtrudeGeometry(railShape(scale), {
		depth: length,
		bevelEnabled: false,
	});
	g.translate(0, 0, -length / 2);
	g.rotateY(Math.PI / 2);
	g.computeVertexNormals();
	return g;
}

/* ── swept and lofted surfaces ──────────────────────────────────────── */

// A pipe bent through a list of points. Used for induction pipes and handrails,
// where a straight cylinder would look like a placeholder.
export function bentPipe(points, radius, { radialSegments = 12, tubularSegments = 48 } = {}) {
	const curve = new THREE.CatmullRomCurve3(points.map((p) => p.clone()), false, 'catmullrom', 0.35);
	const g = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
	g.computeVertexNormals();
	return g;
}

// NACA 4-digit section, closed loop, chord along +X, thickness in +Y.
function nacaSection(code, n) {
	const m = Number(code[0]) / 100;
	const p = Number(code[1]) / 10;
	const t = Number(code.slice(2)) / 100;
	const upper = [];
	const lower = [];
	for (let i = 0; i <= n; i++) {
		// Cosine spacing packs points into the leading edge, where curvature is.
		const x = 0.5 * (1 - Math.cos((Math.PI * i) / n));
		const yt =
			5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
		let yc = 0;
		let dyc = 0;
		if (m > 0 && p > 0) {
			if (x < p) {
				yc = (m / (p * p)) * (2 * p * x - x * x);
				dyc = ((2 * m) / (p * p)) * (p - x);
			} else {
				yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x);
				dyc = ((2 * m) / ((1 - p) ** 2)) * (p - x);
			}
		}
		const th = Math.atan(dyc);
		upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
		lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
	}
	lower.reverse();
	return upper.concat(lower.slice(1, -1));
}

// Loft a twisting, tapering airfoil along +Z: a propeller or turbine blade
// described by root chord, tip chord and the twist between them.
export function loftedBlade({
	span,
	chordRoot,
	chordTip,
	twistRoot,
	twistTip,
	code = '2412',
	stations = 14,
	resolution = 18,
	rake = 0,
}) {
	const section = nacaSection(code, resolution);
	const ring = section.length;
	const pos = [];
	const idx = [];
	for (let s = 0; s < stations; s++) {
		const u = s / (stations - 1);
		const chord = chordRoot + (chordTip - chordRoot) * u;
		const twist = THREE.MathUtils.degToRad(twistRoot + (twistTip - twistRoot) * u);
		const z = u * span;
		const x0 = rake * u * u;
		const cos = Math.cos(twist);
		const sin = Math.sin(twist);
		// Taper toward a rounded tip so the last station is not a flat cut.
		const shrink = u > 0.94 ? Math.sqrt(Math.max(0, 1 - ((u - 0.94) / 0.06) ** 2)) : 1;
		for (const [sx, sy] of section) {
			const cx = (sx - 0.28) * chord * shrink;
			const cy = sy * chord * shrink;
			pos.push(cx * cos - cy * sin + x0, cx * sin + cy * cos, z);
		}
	}
	for (let s = 0; s < stations - 1; s++) {
		for (let i = 0; i < ring; i++) {
			const a = s * ring + i;
			const b = s * ring + ((i + 1) % ring);
			const c = a + ring;
			const d = b + ring;
			idx.push(a, c, b, b, c, d);
		}
	}
	// Fan-cap the root; the tip closes on itself through `shrink`.
	const rootCentre = pos.length / 3;
	pos.push(0, 0, 0);
	for (let i = 0; i < ring; i++) idx.push(rootCentre, (i + 1) % ring, i);
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setIndex(idx);
	g.computeVertexNormals();
	return g;
}

/* ── assemblies ─────────────────────────────────────────────────────── */

// A spoked driving wheel in the XY plane, axle along Z: tyre, flange, spokes,
// crescent counterweight and a crankpin boss at `crankRadius`.
export function spokedWheel({
	radius,
	tyreWidth = 0.14,
	flange = 0.028,
	hubRadius = 0.16,
	hubWidth = 0.26,
	spokes = 18,
	spokeWidth = 0.05,
	crankRadius = 0,
	counterweight = true,
	pinSide = 1,
}) {
	const parts = [];
	const rimInner = radius - 0.09;
	const w = tyreWidth / 2;
	// Tyre and flange as one revolved section, the way a tyre is actually
	// turned. A pair of cones would close the wheel face and bury the spokes.
	const tyre = lathe(
		[
			[rimInner, -w], [radius + flange, -w], [radius + flange, -w + 0.022],
			[radius, -w + 0.034], [radius, w], [rimInner, w], [rimInner, -w],
		],
		64,
	);
	tyre.rotateX(Math.PI / 2);
	parts.push(tyre);
	const hub = new THREE.CylinderGeometry(hubRadius, hubRadius, hubWidth, 32);
	hub.rotateX(Math.PI / 2);
	parts.push(hub);

	const spokeLen = rimInner - hubRadius * 0.7;
	for (let i = 0; i < spokes; i++) {
		const a = (i / spokes) * Math.PI * 2;
		// Spokes are tapered plates, thicker at the hub, like a cast wheel centre.
		const s = new THREE.CylinderGeometry(spokeWidth * 0.72, spokeWidth, spokeLen, 10);
		s.translate(0, spokeLen / 2 + hubRadius * 0.7, 0);
		s.rotateZ(a);
		s.scale(1, 1, 0.55);
		parts.push(s);
	}
	if (counterweight) {
		const cw = arcSector({
			rInner: hubRadius + 0.06,
			rOuter: rimInner - 0.01,
			from: Math.PI * 0.72,
			to: Math.PI * 1.28,
			thickness: tyreWidth * 0.58,
			segments: 24,
		});
		parts.push(cw);
	}
	if (crankRadius > 0) {
		// The pin sits outboard, so which way that is depends on the side of the
		// locomotive. Mirroring the mesh instead would invert its normals.
		const pin = new THREE.CylinderGeometry(0.052, 0.052, tyreWidth * 1.5, 20);
		pin.rotateX(Math.PI / 2);
		pin.translate(crankRadius, 0, pinSide * tyreWidth * 0.62);
		parts.push(pin);
		const boss = new THREE.CylinderGeometry(0.086, 0.086, tyreWidth * 0.5, 20);
		boss.rotateX(Math.PI / 2);
		boss.translate(crankRadius, 0, pinSide * tyreWidth * 0.28);
		parts.push(boss);
	}
	return mergeGeometries(parts);
}

// A ring of identical fasteners around +Z, baked into one geometry.
export function boltRing({ count, radius, head = 0.014, height = 0.012, z = 0 }) {
	const parts = [];
	for (let i = 0; i < count; i++) {
		const a = (i / count) * Math.PI * 2;
		const b = new THREE.CylinderGeometry(head, head, height, 6);
		b.rotateX(Math.PI / 2);
		b.translate(Math.cos(a) * radius, Math.sin(a) * radius, z);
		parts.push(b);
	}
	return mergeGeometries(parts);
}

/* ── merging ────────────────────────────────────────────────────────── */

// Minimal non-indexed merge. three's BufferGeometryUtils needs every input to
// carry identical attribute sets; these builders mix indexed and non-indexed
// primitives, so normalising to raw position/normal/uv triangles here is both
// simpler and cheaper than reconciling them.
export function mergeGeometries(geometries) {
	const pos = [];
	const nor = [];
	const uv = [];
	for (const g of geometries) {
		const src = g.index ? g.toNonIndexed() : g;
		const p = src.getAttribute('position');
		const n = src.getAttribute('normal') || null;
		const t = src.getAttribute('uv') || null;
		for (let i = 0; i < p.count; i++) {
			pos.push(p.getX(i), p.getY(i), p.getZ(i));
			if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i));
			uv.push(t ? t.getX(i) : 0, t ? t.getY(i) : 0);
		}
		if (src !== g) src.dispose();
		g.dispose();
	}
	const out = new THREE.BufferGeometry();
	out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	if (nor.length === pos.length) {
		out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
	} else {
		out.computeVertexNormals();
	}
	return out;
}

// Triangles actually being drawn: a hidden subassembly costs nothing, and the
// stat panel should say so.
export function triangleCount(object) {
	let n = 0;
	object.traverse((o) => {
		if (!o.isMesh || !o.geometry || !o.visible) return;
		const g = o.geometry;
		const count = g.index ? g.index.count : g.getAttribute('position').count;
		n += (count / 3) * (o.isInstancedMesh ? o.count : 1);
	});
	return n;
}
