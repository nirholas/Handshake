// Oracle ribbon — the /ibm/oracle 3D forecast line, dropped into the /play world.
//
// This is JUST the glowing price-history + Granite forecast line (no grid, no
// particle field, no HUD, no narrator). It builds as a transparent Three.js
// Group you can walk around — a floating data sculpture literally standing in
// the world. Data is real: the live trending pool's candles + IBM Granite
// TimeSeries forecast from /api/ibm/oracle.

import {
	BufferGeometry,
	CatmullRomCurve3,
	DoubleSide,
	Float32BufferAttribute,
	Group,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	SphereGeometry,
	TubeGeometry,
	Vector3,
} from 'three';
import { log } from '../shared/log.js';

const IBM = {
	blueLight: 0x78a9ff,
	up: 0x42be65,
	down: 0xfa4d56,
	flat: 0x8d8d8d,
	white: 0xf4f4f4,
};
const SPAN = 12; // local-units across the time axis (scaled down when mounted)
const HEIGHT = 5.5; // local-units across the price axis

// The line is pinned to $THREE — the one and only coin. We never surface an
// arbitrary trending token in the persistent world.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function glowTube(points, color, radius, opacity = 1) {
	const curve = new CatmullRomCurve3(points);
	const segs = Math.min(600, points.length * 4);
	const core = new Mesh(
		new TubeGeometry(curve, segs, radius, 8, false),
		new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
	);
	const halo = new Mesh(
		new TubeGeometry(curve, segs, radius * 2.6, 8, false),
		new MeshBasicMaterial({ color, transparent: true, opacity: opacity * 0.16, depthWrite: false }),
	);
	const grp = new Group();
	grp.add(core, halo);
	return grp;
}

function marker(pos, color, r = 0.13) {
	const m = new Mesh(new SphereGeometry(r, 20, 20), new MeshBasicMaterial({ color }));
	m.position.copy(pos);
	m.add(
		new Mesh(
			new SphereGeometry(r * 2.4, 20, 20),
			new MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }),
		),
	);
	return m;
}

function downsample(arr, max) {
	if (arr.length <= max) return arr;
	const step = (arr.length - 1) / (max - 1);
	const out = [];
	for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
	return out;
}

// Build the line geometry from an /api/ibm/oracle payload into `group`.
function buildSeries(group, data) {
	const history = downsample(data.history || [], 160);
	if (history.length < 2) return;
	const forecast = data.forecast || [];
	const all = [...history, ...forecast].map((p) => p.c).filter(Number.isFinite);
	const min = Math.min(...all);
	const max = Math.max(...all);
	const tMin = history[0].t;
	const tMax = forecast.length ? forecast[forecast.length - 1].t : history[history.length - 1].t;
	const span = Math.max(1, tMax - tMin);
	const xOf = (t) => ((t - tMin) / span) * SPAN - SPAN / 2;
	const yOf = (c) => (max === min ? 0 : ((c - min) / (max - min)) * HEIGHT - HEIGHT / 2);

	const histPts = history.map((p) => new Vector3(xOf(p.t), yOf(p.c), 0));
	group.add(glowTube(histPts, IBM.blueLight, 0.035));

	// "Now" seam
	const seam = histPts[histPts.length - 1];
	const seamLine = new Mesh(
		new PlaneGeometry(0.012, HEIGHT * 1.05),
		new MeshBasicMaterial({ color: IBM.white, transparent: true, opacity: 0.28, side: DoubleSide }),
	);
	seamLine.position.set(seam.x, 0, 0);
	group.add(seamLine);
	group.add(marker(seam, IBM.white, 0.11));

	if (forecast.length && data.stats) {
		const direction = data.stats.direction;
		const dirColor = direction === 'up' ? IBM.up : direction === 'down' ? IBM.down : IBM.flat;
		const fPts = [seam, ...forecast.map((p) => new Vector3(xOf(p.t), yOf(p.c), 0))];
		group.add(glowTube(fPts, dirColor, 0.045));

		// Uncertainty ribbon: half-band grows 0 → (high-low)/2 across the horizon.
		const halfMax = Math.max(0.06, (yOf(data.stats.forecastHigh) - yOf(data.stats.forecastLow)) / 2);
		const verts = [];
		for (let i = 0; i < fPts.length; i++) {
			const hb = halfMax * (i / (fPts.length - 1));
			verts.push(fPts[i].x, fPts[i].y + hb, 0, fPts[i].x, fPts[i].y - hb, 0);
		}
		const ribGeo = new BufferGeometry();
		ribGeo.setAttribute('position', new Float32BufferAttribute(verts, 3));
		const idx = [];
		for (let i = 0; i < fPts.length - 1; i++) {
			const a = i * 2;
			idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
		}
		ribGeo.setIndex(idx);
		group.add(
			new Mesh(
				ribGeo,
				new MeshBasicMaterial({
					color: dirColor,
					transparent: true,
					opacity: 0.16,
					side: DoubleSide,
					depthWrite: false,
				}),
			),
		);
		group.add(marker(fPts[fPts.length - 1], dirColor, 0.15));
	}
}

// Mount the forecast line into `scene` as a floating sculpture. Returns an
// object with update(dt) for a gentle idle bob + spin, and dispose().
export function mountOracleRibbon(scene, opts = {}) {
	const pivot = new Group();
	pivot.position.set(opts.x ?? 11, opts.y ?? 3.4, opts.z ?? -5);
	pivot.scale.setScalar(opts.scale ?? 0.6);
	scene.add(pivot);

	const series = new Group();
	pivot.add(series);

	let t = 0;
	const baseY = pivot.position.y;

	// Guarded fetch: dispose() aborts an in-flight request so a late response
	// never builds TubeGeometry into a group already removed from the scene.
	let disposed = false;
	let retryTimer = null;
	const abort = new AbortController();
	const load = async (isRetry) => {
		try {
			const r = await fetch(`/api/ibm/oracle?token=${THREE_MINT}`, { signal: abort.signal });
			if (!r.ok) throw new Error(`oracle responded ${r.status}`);
			const data = await r.json();
			if (disposed) return;
			if (data && data.history) buildSeries(series, data);
		} catch (err) {
			if (disposed || abort.signal.aborted) return;
			log.warn('[oracle-ribbon] forecast fetch failed:', err?.message);
			// One retry ~30s later covers a transient blip / rate limit; beyond that
			// the world simply renders without the line (decorative, not load-bearing).
			if (!isRetry) retryTimer = setTimeout(() => load(true), 30_000);
		}
	};
	load(false);

	return {
		group: pivot,
		update(dt) {
			t += dt;
			pivot.rotation.y += dt * 0.12;
			pivot.position.y = baseY + Math.sin(t * 0.8) * 0.12;
		},
		dispose() {
			disposed = true;
			clearTimeout(retryTimer);
			abort.abort();
			series.traverse((o) => {
				if (o.geometry) o.geometry.dispose();
				if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
			});
			scene.remove(pivot);
		},
	};
}
