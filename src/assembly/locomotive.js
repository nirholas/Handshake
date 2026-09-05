// Machine 02: a narrow-gauge-era steam locomotive, generated from six numbers.
//
// The interesting half of a locomotive is the half that moves, so that is the
// half that is solved rather than posed. Coupled wheels share one crank angle;
// the crosshead is the exact slider-crank solution for the main rod; and the
// valve gear is a real four-bar chain, closed every frame by circle
// intersection (rig.js `circleIntersect`).
//
// One detail falls out of the maths rather than out of a reference photo: the
// return crank has to be nearly as long as the main crank and set well past a
// right angle, because the eccentric throw the valve gear needs is the vector
// sum of the two, and that sum has to be small. Change `RETURN_CRANK_ANGLE`
// and the valve motion changes the way it would on the real engine.

import * as THREE from 'three';
import {
	lathe,
	roundedBox,
	rodGeometry,
	arcSector,
	railGeometry,
	spokedWheel,
	bentPipe,
	boltRing,
	mergeGeometries,
} from './parts.js';
import { MATERIALS } from './materials.js';
import { part, joint, placeLink, slideOnLine, circleIntersect } from './rig.js';

const GAUGE = 1.435;
const RETURN_CRANK_RATIO = 0.9;
const RETURN_CRANK_ANGLE = 145;

export const spec = {
	id: 'locomotive',
	name: 'Coupled Six',
	subtitle: 'Outside-cylinder steam locomotive',
	era: '1901',
	blurb:
		'Coupled drivers, outside cylinders and a full return-crank valve gear. The linkage is closed by solving circles every frame, so every rod length you set below has to physically work.',
	facts: [
		['Gauge', '1435 mm standard'],
		['Valve gear', 'Return crank, eccentric rod, rocking lever'],
		['Motion', 'Solved four-bar chain, not baked animation'],
	],
	params: [
		{ key: 'drivers', label: 'Coupled axles', min: 2, max: 5, step: 1, value: 3, unit: '' },
		{ key: 'driverDia', label: 'Driver diameter', min: 1200, max: 2100, step: 10, value: 1680, unit: 'mm' },
		{ key: 'spacing', label: 'Axle spacing', min: 1900, max: 2900, step: 10, value: 2350, unit: 'mm' },
		{ key: 'stroke', label: 'Piston stroke', min: 460, max: 800, step: 10, value: 610, unit: 'mm' },
		{ key: 'boilerDia', label: 'Boiler diameter', min: 1200, max: 1900, step: 10, value: 1520, unit: 'mm' },
		{ key: 'spokes', label: 'Spokes per wheel', min: 10, max: 24, step: 1, value: 18, unit: '' },
	],
	camera: { position: [5.4, 2.6, 6.6], target: [0.4, 0.7, 0], radius: 8.4 },
};

export function derive(v) {
	const R = v.driverDia / 2000;
	const s = v.spacing / 1000;
	const crankR = v.stroke / 2000;
	const n = v.drivers;
	const axles = [];
	for (let j = 0; j < n; j++) axles.push((j - (n - 1) / 2) * s);
	const mainIndex = Math.min(n - 1, Math.floor(n / 2));
	const mainX = axles[mainIndex];
	const yC = R * 0.1;
	const mainRod = s * 1.28;
	const crossMax = mainX + crankR + Math.sqrt(Math.max(mainRod * mainRod - yC * yC, 0));
	const cylRear = crossMax + 0.22;
	const cylLen = crankR * 2 + 0.62;
	const boilerR = v.boilerDia / 2000;
	const yB = R * 1.08 + boilerR;
	const zMotion = GAUGE / 2 + 0.16;
	const zWheel = GAUGE / 2;
	const rE = crankR * RETURN_CRANK_RATIO;
	const psi = THREE.MathUtils.degToRad(RETURN_CRANK_ANGLE);
	// The eccentric the valve gear actually sees: the vector sum of main crank
	// and return crank, which rotates with the wheel at a constant radius.
	const rho = Math.hypot(crankR + rE * Math.cos(psi), rE * Math.sin(psi));
	const rockPivot = new THREE.Vector2(mainX + s * 0.72, yC + R * 0.62);
	const armLow = Math.max(R * 0.3, rho * 1.5);
	const armHigh = R * 0.3;
	const eccRod = Math.hypot(rockPivot.x - mainX, rockPivot.y);
	return {
		R,
		s,
		n,
		crankR,
		axles,
		mainIndex,
		mainX,
		yC,
		mainRod,
		crossMax,
		cylRear,
		cylLen,
		cylFront: cylRear + cylLen,
		boilerR,
		yB,
		zMotion,
		zWheel,
		rE,
		psi,
		rho,
		rockPivot,
		armLow,
		armHigh,
		eccRod,
		yValve: yC + R * 0.56,
		valveLink: R * 0.9,
		// The crankpin radius IS half the piston stroke. Deriving it from the
		// wheel instead would let the stroke slider lie about what it controls.
		pinR: crankR,
		rear: axles[0] - s * 0.62,
		cabBack: axles[0] - s * 0.95,
		wheelbase: axles[n - 1] - axles[0],
	};
}

export function codeFor(v) {
	const d = derive(v);
	const f = (n) => n.toFixed(3);
	return [
		{
			label: 'Driving wheel',
			code: `spokedWheel({
  radius:      ${f(d.R)},
  spokes:      ${v.spokes},
  crankRadius: ${f(d.pinR)},
  counterweight: true,
})`,
		},
		{
			label: 'Coupled axles',
			code: `const axles = [${d.axles.map((x) => f(x)).join(', ')}];
// every coupled wheel shares one crank angle, so the
// side rod stays horizontal and simply orbits
placeLink(sideRod, pin(axles[0]), pin(axles.at(-1)));`,
		},
		{
			label: 'Crosshead',
			code: `// exact slider-crank on the cylinder centreline
const pin   = crankpin(theta, ${f(d.pinR)});
const cross = slideOnLine(pin, ${f(d.yC)}, ${f(d.mainRod)});`,
		},
		{
			label: 'Valve gear',
			code: `// close the four-bar: eccentric rod meets rocking lever
const low = circleIntersect(
  eccentricPin, ${f(d.eccRod)},
  pivot,        ${f(d.armLow)}, branch);
const top = pivot.clone().sub(
  low.clone().sub(pivot).setLength(${f(d.armHigh)}));`,
		},
		{
			label: 'Rail section',
			code: `// head, web and foot as one closed profile,
// extruded along the track
railGeometry(${f(d.s * (d.n + 3))}, 1)`,
		},
	];
}

const SLEEPER_PITCH = 0.62;

function trackGroup(d) {
	const g = new THREE.Group();
	g.name = 'track';
	const length = d.s * (d.n + 3.4) + 6;
	const railY = -d.R;
	for (const z of [-GAUGE / 2, GAUGE / 2]) {
		const rail = railGeometry(length, 1);
		rail.translate(0, railY - 0.185, z);
		g.add(part(rail, MATERIALS.steel, { name: 'rail', group: 'track' }));
	}
	const sleepers = [];
	const pitch = SLEEPER_PITCH;
	const count = Math.floor(length / pitch);
	for (let i = 0; i < count; i++) {
		const x = -length / 2 + (i + 0.5) * pitch;
		const sl = roundedBox(0.26, 0.16, 2.6, 0.02, false);
		sl.translate(x, railY - 0.27, 0);
		sleepers.push(sl);
	}
	g.add(part(mergeGeometries(sleepers), MATERIALS.timber, { name: 'sleepers', group: 'track' }));
	const ballast = roundedBox(length, 0.2, 3.6, 0.04, false);
	ballast.translate(0, railY - 0.45, 0);
	g.add(part(ballast, MATERIALS.ballast, { name: 'ballast', group: 'track' }));
	return g;
}

// Bar frame: one plate per side, with the axle openings cut out of the profile
// rather than modelled as separate blocks.
function frameGeometry(d) {
	const front = d.cylFront - 0.1;
	const back = d.cabBack;
	const top = d.R * 0.34;
	const bottom = -d.R * 0.62;
	const s = new THREE.Shape();
	s.moveTo(back, bottom);
	s.lineTo(front, bottom);
	s.lineTo(front, top);
	s.lineTo(back, top);
	s.closePath();
	for (const x of d.axles) {
		const hole = new THREE.Path();
		hole.absarc(x, -d.R * 0.16, d.R * 0.2, 0, Math.PI * 2, true);
		s.holes.push(hole);
	}
	const g = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false, curveSegments: 20 });
	g.translate(0, 0, -0.025);
	g.computeVertexNormals();
	return g;
}

function boilerGroup(d, v) {
	const g = new THREE.Group();
	g.name = 'boiler';
	const grp = 'boiler';
	const r = d.boilerR;
	const smokeboxFront = d.cylFront - 0.08;
	const fireboxBack = d.axles[0] - d.s * 0.34;
	// One turned profile from the smokebox door to the firebox throat.
	const barrel = lathe(
		[
			[0, fireboxBack], [r * 1.02, fireboxBack], [r * 1.02, fireboxBack + 0.12],
			[r * 0.98, fireboxBack + 0.14], [r * 0.98, smokeboxFront - 1.05],
			[r * 1.04, smokeboxFront - 1.02], [r * 1.04, smokeboxFront - 0.08],
			[r * 0.96, smokeboxFront - 0.01], [r * 0.6, smokeboxFront + 0.03],
			[0, smokeboxFront + 0.05],
		],
		56,
	);
	barrel.rotateZ(-Math.PI / 2);
	barrel.translate(0, d.yB, 0);
	g.add(part(barrel, MATERIALS.paintDark, { name: 'boiler barrel', group: grp, explode: new THREE.Vector3(0, 1.5, 0) }));

	// Bands, dome, safety valves and chimney: all revolves on the same axis.
	const bands = [];
	for (let i = 0; i < 4; i++) {
		const x = fireboxBack + 0.5 + i * ((smokeboxFront - 1.6 - fireboxBack) / 3);
		const b = new THREE.CylinderGeometry(r * 1.005, r * 1.005, 0.05, 48);
		b.rotateZ(Math.PI / 2);
		b.translate(x, d.yB, 0);
		bands.push(b);
	}
	g.add(part(mergeGeometries(bands), MATERIALS.brass, { name: 'boiler bands', group: grp, explode: new THREE.Vector3(0, 1.9, 0) }));

	// These three stand upright on the boiler, and `lathe` already revolves about
	// +Y, so they need no reorientation at all.
	const domeX = fireboxBack + (smokeboxFront - fireboxBack) * 0.42;
	const dome = lathe(
		[
			[0, 0], [r * 0.34, 0], [r * 0.36, 0.16], [r * 0.33, 0.32],
			[r * 0.24, 0.4], [r * 0.1, 0.42], [0, 0.42],
		],
		36,
	);
	dome.translate(domeX, d.yB + r * 0.93, 0);
	g.add(part(dome, MATERIALS.brass, { name: 'steam dome', group: grp, explode: new THREE.Vector3(0, 2.4, 0) }));

	const stack = lathe(
		[
			[0, 0], [r * 0.28, 0], [r * 0.26, 0.06], [r * 0.2, 0.2],
			[r * 0.2, 0.44], [r * 0.3, 0.5], [r * 0.31, 0.58], [r * 0.22, 0.58],
			[r * 0.13, 0.5], [0, 0.5],
		],
		36,
	);
	stack.translate(smokeboxFront - 0.55, d.yB + r * 0.9, 0);
	g.add(part(stack, MATERIALS.graphite, { name: 'chimney', group: grp, explode: new THREE.Vector3(0, 2.7, 0) }));

	const safety = [];
	for (const z of [-0.16, 0.16]) {
		const sv = lathe([[0, 0], [0.06, 0], [0.058, 0.14], [0.075, 0.16], [0.03, 0.2], [0, 0.2]], 20);
		sv.translate(fireboxBack + 0.45, d.yB + r * 0.94, z);
		safety.push(sv);
	}
	g.add(part(mergeGeometries(safety), MATERIALS.brass, { name: 'safety valves', group: grp, explode: new THREE.Vector3(0, 2.5, 0) }));

	// Handrails: bent pipe, not a stretched cylinder.
	for (const z of [-1, 1]) {
		const pts = [
			new THREE.Vector3(smokeboxFront - 0.02, d.yB + r * 0.52, z * r * 0.86),
			new THREE.Vector3(smokeboxFront - 0.5, d.yB + r * 0.72, z * r * 1.0),
			new THREE.Vector3(fireboxBack + 0.9, d.yB + r * 0.72, z * r * 1.0),
			new THREE.Vector3(fireboxBack + 0.25, d.yB + r * 0.66, z * r * 0.98),
		];
		g.add(
			part(bentPipe(pts, 0.022, { radialSegments: 8, tubularSegments: 32 }), MATERIALS.brass, {
				name: 'handrail',
				group: grp,
				explode: new THREE.Vector3(0, 2.1, z * 0.4),
			}),
		);
	}

	const door = boltRing({ count: 14, radius: r * 0.7, head: 0.03, height: 0.05 });
	door.rotateY(Math.PI / 2);
	door.translate(smokeboxFront + 0.04, d.yB, 0);
	g.add(part(door, MATERIALS.steel, { name: 'smokebox dogs', group: grp, explode: new THREE.Vector3(1.4, 0.4, 0) }));
	return g;
}

function cabGroup(d, v) {
	const g = new THREE.Group();
	g.name = 'cab';
	const grp = 'cab';
	const r = d.boilerR;
	const fireboxBack = d.axles[0] - d.s * 0.34;
	const cabFront = fireboxBack - 0.06;
	const cabBack = d.cabBack;
	const halfW = Math.max(1.06, r * 1.28);
	const floorY = d.R * 0.42;
	const roofY = floorY + 2.15;

	// Firebox: the wide box the boiler sits on top of, ahead of the cab.
	const fb = roundedBox(1.35, r * 1.62, halfW * 1.62, 0.05);
	fb.translate(fireboxBack + 0.62, d.yB - r * 0.1, 0);
	g.add(part(fb, MATERIALS.paintDark, { name: 'firebox', group: grp, explode: new THREE.Vector3(0, 1.3, 0) }));

	// Side sheets, with the window cut out of the profile.
	for (const z of [-1, 1]) {
		const s = new THREE.Shape();
		s.moveTo(cabBack, floorY);
		s.lineTo(cabFront, floorY);
		s.lineTo(cabFront, roofY - 0.2);
		s.lineTo(cabBack, roofY - 0.2);
		s.closePath();
		const win = new THREE.Path();
		const wx = cabBack + 0.36;
		const wy = floorY + 1.06;
		const ww = cabFront - cabBack - 0.72;
		const wh = 0.72;
		win.moveTo(wx, wy);
		win.lineTo(wx + ww, wy);
		win.lineTo(wx + ww, wy + wh);
		win.lineTo(wx, wy + wh);
		win.closePath();
		s.holes.push(win);
		const geo = new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false });
		geo.translate(0, 0, z * halfW - z * 0.025);
		geo.computeVertexNormals();
		g.add(
			part(geo, MATERIALS.paintRed, {
				name: 'cab side',
				group: grp,
				explode: new THREE.Vector3(-0.6, 0.5, z * 1.5),
			}),
		);
	}

	const back = roundedBox(halfW * 2, roofY - 0.2 - floorY, 0.06, 0.03);
	back.rotateY(Math.PI / 2);
	back.translate(cabBack + 0.03, (roofY - 0.2 + floorY) / 2, 0);
	g.add(part(back, MATERIALS.paintRed, { name: 'cab back', group: grp, explode: new THREE.Vector3(-1.8, 0.3, 0) }));

	const floor = roundedBox(cabFront - cabBack, 0.08, halfW * 2, 0.02, false);
	floor.translate((cabFront + cabBack) / 2, floorY, 0);
	g.add(part(floor, MATERIALS.timber, { name: 'cab floor', group: grp, explode: new THREE.Vector3(-0.4, -0.3, 0) }));

	// Arched roof: an annular sector, extruded along the cab.
	const roof = arcSector({
		rInner: halfW * 2.5,
		rOuter: halfW * 2.5 + 0.06,
		from: Math.PI / 2 - 0.24,
		to: Math.PI / 2 + 0.24,
		thickness: cabFront - cabBack + 0.3,
		segments: 24,
	});
	// The sector is drawn in XY and extruded in Z; the cab needs it arching
	// across the track, so swap those two axes.
	roof.rotateY(Math.PI / 2);
	roof.translate((cabFront + cabBack) / 2, roofY - halfW * 2.5 - 0.2, 0);
	g.add(part(roof, MATERIALS.paintDark, { name: 'cab roof', group: grp, explode: new THREE.Vector3(0, 1.4, 0) }));
	return g;
}

function chassisGroup(d, v) {
	const g = new THREE.Group();
	g.name = 'chassis';
	const grp = 'frame';
	for (const z of [-1, 1]) {
		g.add(
			part(frameGeometry(d), MATERIALS.graphite, {
				name: 'frame plate',
				group: grp,
				position: new THREE.Vector3(0, 0, z * 0.5),
				explode: new THREE.Vector3(0, 0, z * 0.85),
			}),
		);
	}
	const halfW = Math.max(1.06, d.boilerR * 1.28);
	for (const z of [-1, 1]) {
		const board = roundedBox(d.cylFront - d.cabBack - 0.2, 0.06, 0.34, 0.02, false);
		board.translate((d.cylFront + d.cabBack) / 2, d.R * 0.98, z * (halfW - 0.1));
		g.add(
			part(board, MATERIALS.graphite, {
				name: 'running board',
				group: grp,
				explode: new THREE.Vector3(0, 0.7, z * 0.7),
			}),
		);
	}
	// Pilot: angled bars, the one part of the machine that is pure repetition.
	const bars = [];
	for (let i = -3; i <= 3; i++) {
		const bar = roundedBox(0.06, 1.05, 0.06, 0.02, false);
		bar.rotateZ(-0.34);
		bar.translate(d.cylFront + 0.42 + Math.abs(i) * 0.03, -d.R * 0.42, i * 0.18);
		bars.push(bar);
	}
	g.add(
		part(mergeGeometries(bars), MATERIALS.graphite, {
			name: 'pilot',
			group: grp,
			explode: new THREE.Vector3(2.1, 0, 0),
		}),
	);
	const beam = roundedBox(0.18, 0.3, 2.1, 0.03);
	beam.translate(d.cylFront + 0.3, -d.R * 0.02, 0);
	g.add(part(beam, MATERIALS.paintRed, { name: 'buffer beam', group: grp, explode: new THREE.Vector3(2.4, 0, 0) }));
	return g;
}

// One side's wheels, rods, crosshead and valve gear. Built twice, mirrored,
// with the quartering phase that stops a two-cylinder engine dead-centring.
function sideGroup(d, v, side, phase) {
	const z = side * d.zMotion;
	const zw = side * d.zWheel;
	const g = new THREE.Group();
	g.name = side > 0 ? 'right motion' : 'left motion';
	const wheels = [];
	for (let j = 0; j < d.n; j++) {
		const geo = spokedWheel({
			radius: d.R,
			tyreWidth: 0.14,
			hubRadius: d.R * 0.19,
			hubWidth: 0.3,
			spokes: v.spokes,
			spokeWidth: d.R * 0.055,
			crankRadius: d.pinR,
			pinSide: side,
		});
		const mesh = part(geo, MATERIALS.castIron, {
			name: `driver ${j + 1}`,
			group: 'wheels',
			position: new THREE.Vector3(d.axles[j], 0, zw * 1),
			explode: new THREE.Vector3(0, 0, side * 0.9),
		});
		g.add(mesh);
		wheels.push(mesh);
	}

	const sideRodLen = d.axles[d.n - 1] - d.axles[0];
	const sideRod = part(
		rodGeometry({
			length: sideRodLen,
			bigEndR: d.R * 0.1,
			smallEndR: d.R * 0.1,
			waist: d.R * 0.055,
			thickness: 0.06,
		}),
		MATERIALS.steel,
		{ name: 'coupling rod', group: 'motion', explode: new THREE.Vector3(0, 0, side * 1.35) },
	);
	g.add(sideRod);

	const mainRodMesh = part(
		rodGeometry({
			length: d.mainRod,
			bigEndR: d.R * 0.11,
			smallEndR: d.R * 0.075,
			waist: d.R * 0.05,
			thickness: 0.07,
		}),
		MATERIALS.steel,
		{ name: 'main rod', group: 'motion', explode: new THREE.Vector3(0, 0, side * 1.6) },
	);
	g.add(mainRodMesh);

	const crosshead = part(roundedBox(0.34, d.R * 0.26, 0.22, 0.02), MATERIALS.steel, {
		name: 'crosshead',
		group: 'motion',
		explode: new THREE.Vector3(0, 0, side * 1.6),
	});
	g.add(crosshead);

	const pistonRod = part(
		(() => {
			const c = new THREE.CylinderGeometry(0.05, 0.05, 1, 16);
			c.rotateZ(-Math.PI / 2);
			return c;
		})(),
		MATERIALS.steel,
		{ name: 'piston rod', group: 'motion', explode: new THREE.Vector3(0, 0, side * 1.6) },
	);
	g.add(pistonRod);

	// Guide bars are fixed: two flats the crosshead slides between.
	for (const dy of [-1, 1]) {
		const bar = roundedBox(d.crankR * 2 + 0.5, 0.05, 0.16, 0.015, false);
		bar.translate(d.cylRear - (d.crankR * 2 + 0.5) / 2 - 0.03, d.yC + dy * d.R * 0.16, 0);
		g.add(
			part(bar, MATERIALS.graphite, {
				name: 'guide bar',
				group: 'motion',
				position: new THREE.Vector3(0, 0, z),
				explode: new THREE.Vector3(0, dy * 0.35, side * 1.2),
			}),
		);
	}

	// Cylinder and valve chest.
	const cyl = lathe(
		[
			[0, 0], [d.R * 0.36, 0], [d.R * 0.36, 0.06], [d.R * 0.3, 0.08],
			[d.R * 0.3, d.cylLen - 0.08], [d.R * 0.36, d.cylLen - 0.06],
			[d.R * 0.36, d.cylLen], [0, d.cylLen],
		],
		36,
	);
	cyl.rotateZ(-Math.PI / 2);
	cyl.translate(d.cylRear, d.yC, 0);
	g.add(
		part(cyl, MATERIALS.castIron, {
			name: 'cylinder',
			group: 'cylinders',
			position: new THREE.Vector3(0, 0, z),
			explode: new THREE.Vector3(1.1, 0, side * 1.1),
		}),
	);
	const chest = lathe(
		[
			[0, 0], [d.R * 0.19, 0], [d.R * 0.19, d.cylLen * 0.92], [0, d.cylLen * 0.92],
		],
		28,
	);
	chest.rotateZ(-Math.PI / 2);
	chest.translate(d.cylRear + 0.04, d.yValve, 0);
	g.add(
		part(chest, MATERIALS.castIron, {
			name: 'valve chest',
			group: 'cylinders',
			position: new THREE.Vector3(0, 0, z),
			explode: new THREE.Vector3(1.1, 0.6, side * 1.1),
		}),
	);
	const cover = roundedBox(0.12, d.R * 0.82, d.R * 0.82, 0.03);
	cover.translate(d.cylFront + 0.02, d.yC, 0);
	g.add(
		part(cover, MATERIALS.castIron, {
			name: 'cylinder cover',
			group: 'cylinders',
			position: new THREE.Vector3(0, 0, z),
			explode: new THREE.Vector3(1.9, 0, side * 1.1),
		}),
	);

	const piston = part(
		(() => {
			const p = new THREE.CylinderGeometry(d.R * 0.29, d.R * 0.29, 0.16, 28);
			p.rotateZ(Math.PI / 2);
			return p;
		})(),
		MATERIALS.brass,
		{ name: 'piston', group: 'motion', explode: new THREE.Vector3(0, 0, side * 2.1) },
	);
	g.add(piston);

	// Valve gear links.
	const returnCrank = part(
		rodGeometry({ length: d.rE, bigEndR: 0.075, smallEndR: 0.055, thickness: 0.05 }),
		MATERIALS.steel,
		{ name: 'return crank', group: 'valve gear', explode: new THREE.Vector3(0, 0, side * 1.9) },
	);
	g.add(returnCrank);

	const eccRodMesh = part(
		rodGeometry({ length: d.eccRod, bigEndR: 0.06, smallEndR: 0.05, waist: 0.032, thickness: 0.045 }),
		MATERIALS.steel,
		{ name: 'eccentric rod', group: 'valve gear', explode: new THREE.Vector3(0, 0.2, side * 1.9) },
	);
	g.add(eccRodMesh);

	const lever = part(
		rodGeometry({
			length: d.armLow + d.armHigh,
			bigEndR: 0.065,
			smallEndR: 0.06,
			waist: 0.04,
			thickness: 0.05,
		}),
		MATERIALS.steel,
		{ name: 'rocking lever', group: 'valve gear', explode: new THREE.Vector3(0, 0.5, side * 1.9) },
	);
	g.add(lever);

	const valveLinkMesh = part(
		rodGeometry({ length: d.valveLink, bigEndR: 0.05, smallEndR: 0.045, waist: 0.03, thickness: 0.04 }),
		MATERIALS.steel,
		{ name: 'valve link', group: 'valve gear', explode: new THREE.Vector3(0.3, 0.5, side * 1.9) },
	);
	g.add(valveLinkMesh);

	const valveRod = part(
		(() => {
			const c = new THREE.CylinderGeometry(0.035, 0.035, 1, 14);
			c.rotateZ(-Math.PI / 2);
			return c;
		})(),
		MATERIALS.steel,
		{ name: 'valve spindle', group: 'valve gear', explode: new THREE.Vector3(0, 0.55, side * 1.9) },
	);
	g.add(valveRod);

	const bracket = joint('lever bracket', {
		group: 'valve gear',
		position: new THREE.Vector3(d.rockPivot.x, d.rockPivot.y, z),
	});
	const brGeo = roundedBox(0.12, d.R * 0.5, 0.1, 0.02, false);
	brGeo.translate(0, -d.R * 0.25, 0);
	bracket.add(part(brGeo, MATERIALS.graphite, { name: 'bracket', group: 'valve gear' }));
	g.add(bracket);

	return {
		group: g,
		side,
		phase,
		z,
		wheels,
		sideRod,
		mainRodMesh,
		crosshead,
		pistonRod,
		piston,
		returnCrank,
		eccRodMesh,
		lever,
		valveLinkMesh,
		valveRod,
		branch: 0,
	};
}

export function build(v) {
	const d = derive(v);
	const root = new THREE.Group();
	root.name = 'coupled-six';

	const track = trackGroup(d);
	root.add(track);
	root.add(chassisGroup(d, v));
	root.add(boilerGroup(d, v));
	root.add(cabGroup(d, v));

	const sides = [sideGroup(d, v, 1, 0), sideGroup(d, v, -1, Math.PI / 2)];
	for (const s of sides) root.add(s.group);

	const pin = new THREE.Vector2();
	const ecc = new THREE.Vector2();
	const lastPin = new THREE.Vector2(d.rockPivot.x, d.rockPivot.y - d.armLow);

	// Pick the solution branch once, at build time: the one that hangs the
	// lever's lower end below its pivot. Locking it here is what keeps the
	// linkage from snapping through itself at a dead centre.
	{
		const a = 0;
		ecc.set(
			d.mainX + d.pinR * Math.cos(a) + d.rE * Math.cos(a + d.psi),
			d.pinR * Math.sin(a) + d.rE * Math.sin(a + d.psi),
		);
		for (const s of sides) {
			const up = circleIntersect(ecc, d.eccRod, d.rockPivot, d.armLow, 1);
			const down = circleIntersect(ecc, d.eccRod, d.rockPivot, d.armLow, -1);
			if (up && down) s.branch = up.y < down.y ? 1 : -1;
			else s.branch = up ? 1 : -1;
		}
	}

	const p2 = new THREE.Vector2();
	const q2 = new THREE.Vector2();
	// Distance from the crosshead pin to the piston face, fixed by the rod.
	const pistonOffset = d.cylRear + d.cylLen * 0.5 - (d.crossMax - d.crankR);

	function update(theta) {
		// The engine stays put and the track runs under it. Wrapping the offset
		// at one sleeper pitch makes that loop seamless, because the track is
		// periodic at exactly that interval.
		const travelled = theta * d.R;
		track.position.x = -(((travelled % SLEEPER_PITCH) + SLEEPER_PITCH) % SLEEPER_PITCH);
		for (const s of sides) {
			// Rolling forward turns the wheel clockwise in this view.
			const a = -theta + s.phase;
			for (let j = 0; j < d.n; j++) s.wheels[j].rotation.z = a;

			const cos = Math.cos(a);
			const sin = Math.sin(a);
			const pinY = d.pinR * sin;
			p2.set(d.axles[0] + d.pinR * cos, pinY);
			q2.set(d.axles[d.n - 1] + d.pinR * cos, pinY);
			placeLink(s.sideRod, p2, q2, s.z + 0.02 * s.side);

			pin.set(d.mainX + d.pinR * cos, pinY);
			const cross = slideOnLine(pin, d.yC, d.mainRod, 1);
			if (cross) {
				placeLink(s.mainRodMesh, pin, cross, s.z + 0.09 * s.side);
				s.crosshead.position.set(cross.x + 0.12, d.yC, s.z + 0.09 * s.side);
				s.crosshead.userData.rest.copy(s.crosshead.position);
				const rodBack = cross.x + 0.2;
				const rodFront = d.cylRear + 0.12;
				s.pistonRod.position.set((rodBack + rodFront) / 2, d.yC, s.z);
				s.pistonRod.userData.rest.copy(s.pistonRod.position);
				s.pistonRod.scale.x = Math.max(rodFront - rodBack, 0.02);
				// The piston is on the far end of the same rod, so it inherits the
				// crosshead's motion exactly, offset into the bore.
				s.piston.position.set(cross.x + pistonOffset, d.yC, s.z);
				s.piston.userData.rest.copy(s.piston.position);
			}

			ecc.set(
				d.mainX + d.pinR * cos + d.rE * Math.cos(a + d.psi),
				pinY + d.rE * Math.sin(a + d.psi),
			);
			placeLink(s.returnCrank, pin, ecc, s.z + 0.15 * s.side);

			const low = circleIntersect(ecc, d.eccRod, d.rockPivot, d.armLow, s.branch) || lastPin;
			lastPin.copy(low);
			placeLink(s.eccRodMesh, ecc, low, s.z + 0.15 * s.side);

			const dir = low.clone().sub(d.rockPivot).normalize();
			const top = d.rockPivot.clone().addScaledVector(dir, -d.armHigh);
			placeLink(s.lever, low, top, s.z + 0.2 * s.side);

			const valvePin = slideOnLine(top, d.yValve, d.valveLink, 1);
			if (valvePin) {
				placeLink(s.valveLinkMesh, top, valvePin, s.z + 0.24 * s.side);
				const back = valvePin.x;
				const front = d.cylRear + d.cylLen * 0.55;
				s.valveRod.position.set((back + front) / 2, d.yValve, s.z);
				s.valveRod.userData.rest.copy(s.valveRod.position);
				s.valveRod.scale.x = Math.max(front - back, 0.02);
			}
		}
	}

	update(0);

	const readout = [
		['Coupled wheelbase', `${d.wheelbase.toFixed(2)} m`],
		['Driver diameter', `${v.driverDia} mm`],
		['Piston stroke', `${v.stroke} mm`],
		['Eccentric throw', `${(d.rho * 1000).toFixed(0)} mm`],
	];

	return { root, update, readout, cyclesPerTurn: 1, rollingRadius: d.R };
}
