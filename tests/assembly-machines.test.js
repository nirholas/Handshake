/**
 * Machine Atlas (/assembly) — geometry and kinematics.
 *
 * These machines have no model files behind them, so the only thing standing
 * between a slider and a broken frame is the maths. Two classes of failure are
 * worth a test: geometry that comes out non-finite (a NaN in one vertex kills
 * the whole draw call), and a linkage that cannot physically close at some
 * parameter combination, which would freeze the motion silently.
 */

import { describe, it, expect } from 'vitest';
import { Vector2 } from 'three';
import * as radial from '../src/assembly/radial-engine.js';
import * as locomotive from '../src/assembly/locomotive.js';
import { slider, circleIntersect, slideOnLine } from '../src/assembly/rig.js';
import { finnedBarrel, loftedBlade, spokedWheel } from '../src/assembly/parts.js';

const MACHINES = [radial, locomotive];

function defaults(machine) {
	const v = {};
	for (const p of machine.spec.params) v[p.key] = p.value;
	return v;
}

// Every combination of each parameter's low, default and high value is too many
// builds; the corners plus the defaults catch the cases that actually break.
function extremes(machine) {
	const base = defaults(machine);
	const sets = [base];
	for (const p of machine.spec.params) {
		sets.push({ ...base, [p.key]: p.min }, { ...base, [p.key]: p.max });
	}
	sets.push(Object.fromEntries(machine.spec.params.map((p) => [p.key, p.min])));
	sets.push(Object.fromEntries(machine.spec.params.map((p) => [p.key, p.max])));
	return sets;
}

function everyVertexFinite(root) {
	let checked = 0;
	root.traverse((o) => {
		if (!o.isMesh) return;
		const pos = o.geometry.getAttribute('position');
		for (let i = 0; i < pos.count; i++) {
			if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) {
				throw new Error(`non-finite vertex ${i} in ${o.name}`);
			}
		}
		checked++;
	});
	return checked;
}

describe('machine specs', () => {
	it('give every parameter a default inside its own range and on its step grid', () => {
		for (const m of MACHINES) {
			for (const p of m.spec.params) {
				expect(p.value, `${m.spec.id}.${p.key}`).toBeGreaterThanOrEqual(p.min);
				expect(p.value, `${m.spec.id}.${p.key}`).toBeLessThanOrEqual(p.max);
				const steps = (p.value - p.min) / p.step;
				expect(Math.abs(steps - Math.round(steps)), `${m.spec.id}.${p.key}`).toBeLessThan(1e-6);
			}
		}
	});

	it('uses unique machine ids and non-empty copy', () => {
		const ids = MACHINES.map((m) => m.spec.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const m of MACHINES) {
			expect(m.spec.name.length).toBeGreaterThan(0);
			expect(m.spec.blurb.length).toBeGreaterThan(20);
			expect(m.spec.facts.length).toBeGreaterThan(0);
		}
	});

	it('generates code samples from the live values, so they track the geometry', () => {
		const v = defaults(radial);
		const before = radial.codeFor(v).map((s) => s.code).join('\n');
		const after = radial.codeFor({ ...v, bore: v.bore + 10 }).map((s) => s.code).join('\n');
		expect(before).not.toBe(after);
		for (const m of MACHINES) {
			for (const sample of m.codeFor(defaults(m))) {
				expect(sample.code).not.toMatch(/NaN|undefined/);
			}
		}
	});
});

describe('geometry generation', () => {
	it('builds both machines with finite geometry across the parameter extremes', () => {
		for (const m of MACHINES) {
			for (const values of extremes(m)) {
				const built = m.build(values);
				expect(everyVertexFinite(built.root)).toBeGreaterThan(4);
			}
		}
	});

	it('adds a fin to the barrel for every fin asked for', () => {
		const a = finnedBarrel({ bore: 0.15, length: 0.3, fins: 10, segments: 8 });
		const b = finnedBarrel({ bore: 0.15, length: 0.3, fins: 30, segments: 8 });
		expect(b.getAttribute('position').count).toBeGreaterThan(a.getAttribute('position').count);
	});

	it('lofts a blade whose sections taper and twist', () => {
		const g = loftedBlade({ span: 1, chordRoot: 0.2, chordTip: 0.1, twistRoot: 30, twistTip: 5 });
		const pos = g.getAttribute('position');
		let rootWidth = 0;
		let tipWidth = 0;
		for (let i = 0; i < pos.count; i++) {
			const z = pos.getZ(i);
			if (z < 0.02) rootWidth = Math.max(rootWidth, Math.abs(pos.getX(i)));
			if (z > 0.9) tipWidth = Math.max(tipWidth, Math.abs(pos.getX(i)));
		}
		expect(rootWidth).toBeGreaterThan(tipWidth);
		expect(g.getAttribute('normal')).toBeTruthy();
	});

	it('leaves the wheel face open so the spokes are visible', () => {
		const g = spokedWheel({ radius: 0.8, spokes: 16, crankRadius: 0.35 });
		const pos = g.getAttribute('position');
		let found = false;
		for (let i = 0; i < pos.count && !found; i++) {
			// A spoke sits between hub and rim; a solid disc would have no
			// geometry at mid radius other than the closing faces.
			const r = Math.hypot(pos.getX(i), pos.getY(i));
			if (r > 0.35 && r < 0.6 && Math.abs(pos.getZ(i)) < 0.05) found = true;
		}
		expect(found).toBe(true);
	});
});

describe('radial engine kinematics', () => {
	it('solves the slider-crank exactly at top and bottom dead centre', () => {
		const rod = 0.35;
		const throwR = 0.0875;
		const axis = new Vector2(1, 0);
		const tdc = slider(new Vector2(throwR, 0), axis, rod);
		const bdc = slider(new Vector2(-throwR, 0), axis, rod);
		expect(tdc).toBeCloseTo(throwR + rod, 10);
		expect(bdc).toBeCloseTo(rod - throwR, 10);
		expect(tdc - bdc).toBeCloseTo(throwR * 2, 10);
	});

	it('keeps every piston inside its bore for a full revolution', () => {
		const v = defaults(radial);
		const d = radial.derive(v);
		const built = radial.build(v);
		const pistons = [];
		built.root.traverse((o) => {
			if (o.isMesh && o.name.startsWith('piston')) pistons.push(o);
		});
		expect(pistons.length).toBe(v.cylinders);
		for (let i = 0; i < 72; i++) {
			built.update((i / 72) * Math.PI * 2);
			for (const p of pistons) {
				const radius = Math.hypot(p.position.x, p.position.y);
				expect(radius + d.crown).toBeLessThanOrEqual(d.deck + 1e-9);
				expect(radius).toBeGreaterThan(d.baseR - d.bore * 0.34);
			}
		}
	});

	it('gives a longer rod a longer dwell near top dead centre', () => {
		const axis = new Vector2(1, 0);
		const throwR = 0.09;
		const dwell = (rod) => {
			const top = throwR + rod;
			let count = 0;
			for (let i = 0; i < 720; i++) {
				const a = (i / 720) * Math.PI * 2;
				const pin = new Vector2(Math.cos(a) * throwR, Math.sin(a) * throwR);
				if (top - slider(pin, axis, rod) < throwR * 0.05) count++;
			}
			return count;
		};
		expect(dwell(0.36)).toBeGreaterThan(dwell(0.16));
	});
});

describe('locomotive valve gear', () => {
	it('sizes the rocking lever so the eccentric can always reach it', () => {
		for (const values of extremes(locomotive)) {
			const d = locomotive.derive(values);
			expect(d.armLow, JSON.stringify(values)).toBeGreaterThanOrEqual(d.rho);
		}
	});

	it('closes the four-bar chain at every crank angle, for every parameter set', () => {
		for (const values of extremes(locomotive)) {
			const d = locomotive.derive(values);
			for (let i = 0; i < 90; i++) {
				const a = (i / 90) * Math.PI * 2;
				const ecc = new Vector2(
					d.mainX + d.pinR * Math.cos(a) + d.rE * Math.cos(a + d.psi),
					d.pinR * Math.sin(a) + d.rE * Math.sin(a + d.psi),
				);
				const low = circleIntersect(ecc, d.eccRod, d.rockPivot, d.armLow, 1);
				expect(low, `${JSON.stringify(values)} at ${i}`).not.toBeNull();
			}
		}
	});

	it('keeps the crosshead on its centreline and inside the guide bars', () => {
		const values = defaults(locomotive);
		const d = locomotive.derive(values);
		let min = Infinity;
		let max = -Infinity;
		for (let i = 0; i < 180; i++) {
			const a = (i / 180) * Math.PI * 2;
			const pin = new Vector2(d.mainX + d.pinR * Math.cos(a), d.pinR * Math.sin(a));
			const cross = slideOnLine(pin, d.yC, d.mainRod, 1);
			expect(cross).not.toBeNull();
			expect(cross.y).toBeCloseTo(d.yC, 12);
			min = Math.min(min, cross.x);
			max = Math.max(max, cross.x);
		}
		// Crosshead travel is the piston stroke the slider names. The cylinder
		// centreline sits slightly above the axle, so the travel comes out a
		// fraction longer than twice the crank radius, exactly as it does on a
		// real engine with inclined cylinders. It must never come out shorter.
		const travel = max - min;
		expect(travel).toBeGreaterThanOrEqual(d.pinR * 2);
		expect(travel).toBeLessThan(d.pinR * 2 * 1.02);
		expect(max).toBeLessThanOrEqual(d.cylRear);
	});

	it('couples every driver to the same crank angle', () => {
		const values = defaults(locomotive);
		const built = locomotive.build(values);
		const drivers = [];
		built.root.traverse((o) => {
			if (o.isMesh && o.name.startsWith('driver')) drivers.push(o);
		});
		expect(drivers.length).toBe(values.drivers * 2);
		built.update(1.1);
		const angles = new Set(drivers.map((o) => o.rotation.z.toFixed(6)));
		// Two sides, quartered ninety degrees apart, so exactly two angles.
		expect(angles.size).toBe(2);
	});
});
