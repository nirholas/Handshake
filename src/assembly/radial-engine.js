// Machine 01: an air-cooled radial aero engine, generated from nine numbers.
//
// There is no model file behind this. Bore and stroke set the crank throw, the
// crank throw sets the crankcase diameter, the crankcase diameter sets where
// the cylinders bolt on, and the cylinder count divides the circle. Move the
// bore slider and every downstream dimension is recomputed and re-lofted.
//
// The motion is solved, not keyframed: pistons come from the exact planar
// slider-crank (rig.js `slider`), so a long rod really does dwell at top dead
// centre longer than a short one.

import * as THREE from 'three';
import {
	finnedBarrel,
	lathe,
	roundedBox,
	rodGeometry,
	loftedBlade,
	boltRing,
	mergeGeometries,
} from './parts.js';
import { MATERIALS } from './materials.js';
import { part, joint, alignSegment, slider } from './rig.js';

export const spec = {
	id: 'radial',
	name: 'Radial Nine',
	subtitle: 'Air-cooled radial aero engine',
	era: '1932',
	blurb:
		'A single row of air-cooled cylinders around one crank throw. Every fin, pushrod and blade section below is computed at load time from the parameters on the right.',
	facts: [
		['Layout', 'Single-row radial, four-stroke'],
		['Cooling', 'Direct air, integral head and barrel fins'],
		['Valve gear', 'Cam ring, pushrod, overhead rocker'],
	],
	params: [
		{ key: 'cylinders', label: 'Cylinders', min: 5, max: 11, step: 2, value: 9, unit: '' },
		{ key: 'bore', label: 'Bore', min: 110, max: 175, step: 1, value: 155, unit: 'mm' },
		{ key: 'stroke', label: 'Stroke', min: 120, max: 200, step: 1, value: 175, unit: 'mm' },
		{ key: 'rodRatio', label: 'Rod / stroke', min: 1.6, max: 2.6, step: 0.05, value: 2, unit: ':1' },
		{ key: 'fins', label: 'Barrel fins', min: 8, max: 40, step: 1, value: 30, unit: '' },
		{ key: 'blades', label: 'Prop blades', min: 2, max: 5, step: 1, value: 3, unit: '' },
		{ key: 'propDia', label: 'Prop diameter', min: 1.8, max: 3.2, step: 0.05, value: 2.2, unit: 'm' },
	],
	camera: { position: [2.7, 1.15, 1.55], target: [0, 0, 0.15], radius: 2.1 },
};

// Every dimension the builder needs, derived from the seven the user controls.
// Keeping this pure makes the readout, the code panel and the geometry agree
// by construction rather than by remembering to update three places.
export function derive(v) {
	const bore = v.bore / 1000;
	const stroke = v.stroke / 1000;
	const throwR = stroke / 2;
	const rod = stroke * v.rodRatio;
	const caseR = throwR + bore * 0.62;
	const baseR = caseR + 0.012;
	// The deck has to clear the piston crown at top dead centre, which sits at
	// (throw + rod) from the engine axis plus the crown height. Deriving it
	// rather than guessing is why a long-rod setting lengthens the barrel.
	const crown = bore * 0.34;
	const deck = throwR + rod + crown + bore * 0.1;
	const displacement = (Math.PI / 4) * bore * bore * stroke * v.cylinders * 1000;
	return {
		bore,
		stroke,
		throwR,
		rod,
		caseR,
		baseR,
		deck,
		crown,
		barrelLen: deck - baseR,
		headH: bore * 0.42,
		finTip: bore * 0.5 + 0.028,
		finRoot: bore * 0.5 + 0.009,
		displacement,
		propR: v.propDia / 2,
	};
}

// The code panel is generated from the live values, so it cannot drift away
// from the geometry the way a pasted snippet would.
export function codeFor(v) {
	const d = derive(v);
	const mm = (n) => n.toFixed(3);
	return [
		{
			label: 'Cylinder barrel',
			code: `finnedBarrel({
  bore:     ${mm(d.bore)},
  finRoot:  ${mm(d.finRoot)},
  finTip:   ${mm(d.finTip)},
  length:   ${mm(d.barrelLen)},
  fins:     ${v.fins},
})`,
		},
		{
			label: 'Cylinder placement',
			code: `for (let i = 0; i < ${v.cylinders}; i++) {
  const theta = (i / ${v.cylinders}) * Math.PI * 2;
  cylinder.position.set(
    Math.cos(theta) * ${mm(d.baseR)},
    Math.sin(theta) * ${mm(d.baseR)}, 0);
  cylinder.rotation.z = theta - Math.PI / 2;
}`,
		},
		{
			label: 'Piston motion',
			code: `// exact planar slider-crank, no keyframes
const pin  = crankpin(phi, ${mm(d.throwR)});
const c    = slider(pin, axis, ${mm(d.rod)});
piston.position.copy(axis).multiplyScalar(c);`,
		},
		{
			label: 'Propeller blade',
			code: `loftedBlade({
  span:      ${mm(d.propR - 0.11)},
  chordRoot: ${mm(d.propR * 0.17)},
  chordTip:  ${mm(d.propR * 0.09)},
  twistRoot: 34, twistTip: 8,
  code: '2412',   // NACA 4-digit sections
})`,
		},
	];
}

function crankcase(d) {
	// Rear accessory case, main case, front nose case: one turned profile.
	const rear = lathe(
		[
			[0, -0.16], [d.caseR * 0.44, -0.16], [d.caseR * 0.5, -0.14],
			[d.caseR * 0.72, -0.115], [d.caseR * 0.78, -0.075], [d.caseR, -0.045],
			[d.caseR, 0], [0, 0],
		],
		56,
	);
	const front = lathe(
		[
			[0, 0], [d.caseR, 0], [d.caseR, 0.05], [d.caseR * 0.82, 0.085],
			[d.caseR * 0.5, 0.1], [d.caseR * 0.34, 0.13], [d.caseR * 0.3, 0.2],
			[d.caseR * 0.22, 0.215], [0, 0.215],
		],
		56,
	);
	// The crankshaft runs along +Z and the profiles are revolved about +Y, so a
	// quarter turn about X puts the nose case forward and the accessory case aft.
	for (const g of [rear, front]) g.rotateX(Math.PI / 2);
	return { rear, front };
}

function cylinderAssembly(d, v, index) {
	const g = new THREE.Group();
	g.name = `cylinder-${index + 1}`;
	const grp = 'cylinders';

	const barrel = finnedBarrel({
		bore: d.bore,
		finRoot: d.finRoot,
		finTip: d.finTip,
		length: d.barrelLen,
		fins: v.fins,
		finThickness: Math.min(0.005, (d.barrelLen / v.fins) * 0.42),
		segments: 36,
	});
	g.add(part(barrel, MATERIALS.castIron, { name: 'barrel', group: grp }));

	// Head: finned casting plus the rocker box that carries the valve gear.
	const headY = d.barrelLen + d.headH / 2;
	const headGeoms = [];
	const headBody = roundedBox(d.bore * 1.24, d.headH, d.bore * 1.34, 0.016);
	headBody.rotateX(Math.PI / 2);
	headBody.translate(0, headY, 0);
	headGeoms.push(headBody);
	const headFins = 5;
	for (let i = 0; i < headFins; i++) {
		const y = d.barrelLen + 0.008 + (i * (d.headH - 0.016)) / headFins;
		const f = roundedBox(d.bore * 1.4, 0.005, d.bore * 1.5, 0.01, false);
		f.rotateX(Math.PI / 2);
		f.translate(0, y, 0);
		headGeoms.push(f);
	}
	const rockerBox = roundedBox(d.bore * 0.66, d.bore * 0.34, d.bore * 1.1, 0.014);
	rockerBox.rotateX(Math.PI / 2);
	rockerBox.translate(0, headY + d.headH / 2 + d.bore * 0.15, 0);
	headGeoms.push(rockerBox);
	g.add(
		part(mergeGeometries(headGeoms), MATERIALS.castAlloy, {
			name: 'head',
			group: grp,
			explode: new THREE.Vector3(0, 0.16, 0),
		}),
	);

	// Two rockers, front and rear, pivoting about the tangential axis.
	const rockers = [];
	for (const side of [-1, 1]) {
		const pivot = joint(`rocker-${side < 0 ? 'in' : 'ex'}`, {
			group: grp,
			position: new THREE.Vector3(0, headY + d.headH / 2 + d.bore * 0.14, side * d.bore * 0.3),
		});
		const arm = roundedBox(d.bore * 0.13, d.bore * 0.1, d.bore * 0.5, 0.008);
		arm.rotateX(Math.PI / 2);
		pivot.add(part(arm, MATERIALS.steel, { name: 'rocker arm', group: grp }));
		g.add(pivot);
		rockers.push({ pivot, side });
	}

	// Pushrod tubes running from the cam ring up the side of the barrel.
	const rods = [];
	for (const side of [-1, 1]) {
		const tube = new THREE.CylinderGeometry(0.017, 0.017, 1, 12);
		const mesh = part(tube, MATERIALS.steel, {
			name: 'pushrod tube',
			group: grp,
			explode: new THREE.Vector3(0, 0.05, side * 0.08),
		});
		const a = new THREE.Vector3(d.bore * 0.34 * (side < 0 ? -1 : 1), -0.02, side * d.bore * 0.24);
		const b = new THREE.Vector3(0, headY + d.headH / 2 + d.bore * 0.1, side * d.bore * 0.3);
		alignSegment(mesh, a, b);
		g.add(mesh);
		rods.push(mesh);
	}

	// Induction pipe: a bent tube, because a straight cylinder reads as a stub.
	g.add(
		part(bentInduction(d), MATERIALS.steel, {
			name: 'induction pipe',
			group: grp,
			explode: new THREE.Vector3(0, 0.1, -0.12),
		}),
	);

	return { group: g, rockers };
}

function bentInduction(d) {
	const headY = d.barrelLen + d.headH / 2;
	const pts = [
		new THREE.Vector3(0, 0.02, -d.bore * 0.62),
		new THREE.Vector3(0, d.barrelLen * 0.35, -d.bore * 0.9),
		new THREE.Vector3(0, d.barrelLen * 0.78, -d.bore * 0.86),
		new THREE.Vector3(0, headY - 0.01, -d.bore * 0.66),
	];
	const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
	const g = new THREE.TubeGeometry(curve, 28, d.bore * 0.13, 14, false);
	g.computeVertexNormals();
	return g;
}

function propeller(d, v) {
	const g = new THREE.Group();
	g.name = 'propeller';
	const grp = 'propeller';
	const hub = lathe(
		[
			[0, 0], [d.propR * 0.13, 0], [d.propR * 0.15, 0.05],
			[d.propR * 0.12, 0.09], [d.propR * 0.07, 0.1], [0, 0.1],
		],
		40,
	);
	hub.rotateX(Math.PI / 2);
	g.add(part(hub, MATERIALS.steel, { name: 'hub', group: grp }));

	const spinner = lathe(
		[
			[0, 0], [d.propR * 0.115, 0], [d.propR * 0.108, 0.09],
			[d.propR * 0.075, 0.15], [d.propR * 0.03, 0.185], [0, 0.19],
		],
		40,
	);
	spinner.rotateX(Math.PI / 2);
	g.add(
		part(spinner, MATERIALS.paintRed, {
			name: 'spinner',
			group: grp,
			position: new THREE.Vector3(0, 0, 0.06),
			explode: new THREE.Vector3(0, 0, 0.42),
		}),
	);

	for (let i = 0; i < v.blades; i++) {
		const a = (i / v.blades) * Math.PI * 2;
		const blade = loftedBlade({
			span: d.propR - 0.11,
			chordRoot: d.propR * 0.17,
			chordTip: d.propR * 0.09,
			twistRoot: 34,
			twistTip: 8,
			rake: d.propR * 0.02,
			stations: 16,
			resolution: 16,
		});
		blade.rotateX(-Math.PI / 2);
		blade.translate(0, 0.11, 0);
		blade.rotateZ(a);
		g.add(
			part(blade, MATERIALS.graphite, {
				name: `blade ${i + 1}`,
				group: grp,
				explode: new THREE.Vector3(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0.2),
			}),
		);
	}
	const collar = boltRing({ count: v.blades * 3, radius: d.propR * 0.1, head: 0.011, height: 0.02, z: 0.02 });
	g.add(part(collar, MATERIALS.steel, { name: 'hub bolts', group: grp }));
	return g;
}

// Raised-cosine valve lift over a 240 degree cam window, the classic four-stroke
// profile. Returns 0 to 1.
function lift(phase) {
	const x = ((phase % 1) + 1) % 1;
	const window = 0.34;
	if (x > window) return 0;
	return 0.5 - 0.5 * Math.cos((x / window) * Math.PI * 2);
}

export function build(v) {
	const d = derive(v);
	const root = new THREE.Group();
	root.name = 'radial-nine';

	const cc = crankcase(d);
	root.add(
		part(cc.rear, MATERIALS.castAlloy, {
			name: 'rear case',
			group: 'crankcase',
			explode: new THREE.Vector3(0, 0, -0.55),
		}),
	);
	root.add(
		part(cc.front, MATERIALS.castAlloy, {
			name: 'front case',
			group: 'crankcase',
			explode: new THREE.Vector3(0, 0, 0.3),
		}),
	);
	const caseBolts = boltRing({ count: v.cylinders * 2, radius: d.caseR * 0.86, head: 0.013, height: 0.03, z: 0.05 });
	root.add(
		part(caseBolts, MATERIALS.steel, {
			name: 'case bolts',
			group: 'crankcase',
			explode: new THREE.Vector3(0, 0, 0.42),
		}),
	);

	// Crankshaft: two cheeks either side of one crankpin, on the engine axis.
	const crank = new THREE.Group();
	crank.name = 'crankshaft';
	crank.userData = { group: 'crankshaft', rest: crank.position.clone(), explode: new THREE.Vector3() };
	const journal = new THREE.CylinderGeometry(d.bore * 0.2, d.bore * 0.2, 0.42, 24);
	journal.rotateX(Math.PI / 2);
	crank.add(part(journal, MATERIALS.steel, { name: 'main journal', group: 'crankshaft' }));
	for (const z of [-0.075, 0.075]) {
		const cheek = new THREE.CylinderGeometry(d.throwR + d.bore * 0.2, d.throwR + d.bore * 0.2, 0.05, 28);
		cheek.rotateX(Math.PI / 2);
		cheek.translate(0, 0, z);
		crank.add(part(cheek, MATERIALS.steel, { name: 'crank cheek', group: 'crankshaft' }));
	}
	const crankpinGeo = new THREE.CylinderGeometry(d.bore * 0.21, d.bore * 0.21, 0.16, 24);
	crankpinGeo.rotateX(Math.PI / 2);
	crankpinGeo.translate(d.throwR, 0, 0);
	crank.add(part(crankpinGeo, MATERIALS.brass, { name: 'crankpin', group: 'crankshaft' }));
	root.add(crank);

	// Cylinders, pistons and rods.
	const cylinders = [];
	for (let i = 0; i < v.cylinders; i++) {
		const theta = (i / v.cylinders) * Math.PI * 2 + Math.PI / 2;
		const axis = new THREE.Vector2(Math.cos(theta), Math.sin(theta));
		const { group, rockers } = cylinderAssembly(d, v, i);
		group.position.set(axis.x * d.baseR, axis.y * d.baseR, 0);
		group.rotation.z = theta - Math.PI / 2;
		group.userData = {
			group: 'cylinders',
			rest: group.position.clone(),
			explode: new THREE.Vector3(axis.x * 0.34, axis.y * 0.34, 0),
		};
		root.add(group);

		// Skirt below the gudgeon pin, crown above it, so the pin sits inside the
		// piston where it belongs rather than under its base.
		const pistonGeo = lathe(
			[
				[0, -d.bore * 0.34], [d.bore * 0.47, -d.bore * 0.34], [d.bore * 0.49, -d.bore * 0.26],
				[d.bore * 0.49, d.crown - 0.012], [d.bore * 0.44, d.crown - 0.004],
				[d.bore * 0.2, d.crown], [0, d.crown],
			],
			32,
		);
		pistonGeo.rotateZ(-Math.PI / 2);
		const piston = part(pistonGeo, MATERIALS.castAlloy, {
			name: `piston ${i + 1}`,
			group: 'pistons',
			explode: new THREE.Vector3(axis.x * 0.62, axis.y * 0.62, 0),
		});
		piston.rotation.z = theta;
		root.add(piston);

		const rodGeo = rodGeometry({
			length: d.rod,
			bigEndR: d.bore * 0.24,
			smallEndR: d.bore * 0.12,
			thickness: d.bore * 0.16,
		});
		const rod = part(rodGeo, MATERIALS.steel, {
			name: `rod ${i + 1}`,
			group: 'pistons',
			explode: new THREE.Vector3(axis.x * 0.48, axis.y * 0.48, 0),
		});
		root.add(rod);

		cylinders.push({ theta, axis, piston, rod, rockers, index: i });
	}

	const prop = propeller(d, v);
	prop.position.z = 0.3;
	prop.userData = {
		group: 'propeller',
		rest: prop.position.clone(),
		explode: new THREE.Vector3(0, 0, 0.75),
	};
	root.add(prop);

	const pin = new THREE.Vector2();
	const geared = 0.5; // reduction gear: the prop turns at half crank speed

	function update(angle) {
		crank.rotation.z = angle;
		pin.set(Math.cos(angle) * d.throwR, Math.sin(angle) * d.throwR);
		prop.rotation.z = angle * geared;
		for (const c of cylinders) {
			const dist = slider(pin, c.axis, d.rod);
			c.piston.position.set(c.axis.x * dist, c.axis.y * dist, 0);
			c.piston.userData.rest.copy(c.piston.position);
			const px = c.axis.x * dist;
			const py = c.axis.y * dist;
			c.rod.position.set(pin.x, pin.y, 0);
			c.rod.userData.rest.copy(c.rod.position);
			c.rod.rotation.z = Math.atan2(py - pin.y, px - pin.x);
			// Cam ring phasing. An odd-cylinder radial fires alternate cylinders,
			// so physical cylinder i sits (i * (n + 1) / 2) mod n intervals into a
			// cycle, and one four-stroke cycle takes two crank revolutions.
			const order = ((c.index * (v.cylinders + 1)) / 2) % v.cylinders;
			const cycle = angle / (Math.PI * 4) - order / v.cylinders;
			for (let k = 0; k < c.rockers.length; k++) {
				const r = c.rockers[k];
				r.pivot.rotation.x = r.side * lift(cycle + k * 0.5) * 0.32;
			}
		}
	}

	update(0);

	const readout = [
		['Displacement', `${d.displacement.toFixed(1)} L`],
		['Bore x stroke', `${v.bore} x ${v.stroke} mm`],
		['Rod length', `${(d.rod * 1000).toFixed(0)} mm`],
		['Frontal diameter', `${((d.deck + d.headH + 0.03) * 2).toFixed(2)} m`],
	];

	return { root, update, readout, cyclesPerTurn: 1 };
}
