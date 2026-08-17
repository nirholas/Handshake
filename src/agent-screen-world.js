// Ambient world stage for /agent-screen (Brief 22) — mounts the real src/game/
// world engine into the screen canvas and runs it as a calm, always-on channel.
//
// This is the "place, not a dashboard" half of the Ambient World DJ. It reuses
// the exact world the /play product renders — the seeded biome from world-env.js,
// the deterministic crowd + traffic from ambient-life.js, and the moving sun from
// day-night.js — and drives the time of day from the deterministic world clock so
// every viewer of the same agent sees the same sky. The DJ (agent-screen-dj.js)
// reads getState() to narrate it; the page (agent-screen.js) owns the audio.
//
// Nothing here is faked: same engine, same shaders, same NPCs. The only thing
// added on top is the cinematic host camera that slowly orbits the plaza and a
// per-agent clock offset so two agents aren't locked to the same hour.

import { PerspectiveCamera, Scene, WebGLRenderer, Vector3 } from 'three';
import { createWorldEnvironment, seedFromString, biomeForSeed } from './game/world-env.js';
import { NavGraph } from './game/npc/nav-graph.js';
import { AmbientLife } from './game/npc/ambient-life.js';
import { createDayNightCycle } from './game/day-night.js';
import {
	worldClock, phaseLabel, daylightAmount, DEFAULT_CYCLE_MS,
} from './shared/world-clock.js';
import { applyCinematicDefaults, detectQualityTier } from './shared/cinematic-render.js';

export { worldClock, phaseLabel, daylightAmount, DEFAULT_CYCLE_MS };

const PLAY_RADIUS = 58;   // matches the world-env plaza the biome is built around
const NAV_RADIUS = 54;    // NPCs roam just inside the plaza edge
const ORBIT_PERIOD_S = 190; // one slow camera revolution — unhurried, watchable
const CROWD_RADIUS = 30;   // peds nearer than this read as "around the plaza"

// A biome-appropriate name for the spot the host camera frames, used in narration.
function landmarkFor(biome) {
	if (biome?.town === 'frontier') return 'the square';
	switch (biome?.flora) {
		case 'palm': return 'the shore';
		case 'crystal': return 'the expanse';
		case 'cactus': return 'the dunes';
		case 'snowpine': return 'the frostfields';
		case 'deadtree': return 'the caldera';
		default: return 'the plaza';
	}
}

/**
 * Mount the ambient world into a container element.
 *
 * @param {object} opts
 * @param {string} [opts.agentId]       agent id — seeds the world when no explicit seed
 * @param {string|number} [opts.seed]   explicit seed (coin mint or id); falls back to agentId
 * @param {HTMLElement} opts.container  element the canvas is appended into (sized by CSS)
 * @param {number} [opts.cycleMs]       real ms per in-world day
 * @param {number} [opts.timeScale]     day-speed multiplier (1 = real, >1 accelerates demos)
 * @param {boolean} [opts.reducedMotion] hold the clock at midday and stop the orbit
 * @returns {{ start, stop, dispose, setTimeScale, getState, canvas, biome }}
 */
export function createAmbientWorld({ agentId, seed, container, cycleMs = DEFAULT_CYCLE_MS, timeScale = 1, reducedMotion = false }) {
	if (!container) throw new Error('createAmbientWorld: container is required');

	const seedStr = seed != null && seed !== '' ? String(seed) : String(agentId || 'three-ws');
	const numericSeed = seedFromString(seedStr);
	// Per-agent clock offset keeps each world on its own hour while staying a pure
	// function of wall time — every viewer of THIS agent still agrees on the sky.
	const clockOffset = numericSeed % (cycleMs > 0 ? cycleMs : DEFAULT_CYCLE_MS);

	// Paint the container with the biome's horizon tint immediately so the first
	// frames build over a sky gradient, never a blank black canvas (loading state).
	const biomePreview = biomeForSeed(numericSeed);
	container.style.background = `linear-gradient(180deg, ${biomePreview.sky[0]} 0%, ${biomePreview.sky[1]} 55%, ${biomePreview.sky[2]} 100%)`;

	const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	// ACES + sRGB + soft shadows only (src/shared/cinematic-render.js). No HDRI
	// preset and no ground-contact shadow catcher here: this world already has
	// its own real environment (createWorldEnvironment's biome sky + the
	// deterministic day-night cycle) and its own ground plane with real NPCs
	// casting real shadows on it (AmbientLife) — a static studio HDRI would
	// fight the dynamic sky instead of complementing it.
	applyCinematicDefaults(renderer, { tier: detectQualityTier() });
	const canvas = renderer.domElement;
	canvas.style.cssText = 'width:100%;height:100%;display:block;';
	container.appendChild(canvas);

	const scene = new Scene();
	const camera = new PerspectiveCamera(50, 16 / 9, 0.5, 1400);

	const env = createWorldEnvironment(scene, renderer, PLAY_RADIUS, { seed: numericSeed });
	const nav = new NavGraph({ radius: NAV_RADIUS, seed: numericSeed });
	const ambient = new AmbientLife({ scene, nav });
	const cycle = createDayNightCycle(env);
	const landmark = landmarkFor(env.biome);

	const _target = new Vector3(0, 2.2, 0);
	let raf = null;
	let running = false;
	let lastT = 0;
	let elapsed = 0;        // real seconds since start (drives the orbit)
	let simMs = 0;          // accumulated in-world ms (drives the day, scalable)
	let scale = Math.max(0, timeScale);
	let phase = reducedMotion ? 0.5 : 0.5;

	function size() {
		const w = container.clientWidth || 640;
		const h = container.clientHeight || 360;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}

	// Place a ped's speech bubble (a body-appended DOM node) over its head in
	// screen space, so ambient chatter reads in-world instead of stacking at the
	// page origin. Hidden when the point is behind the camera.
	const _v = new Vector3();
	function project(node, x, y, z) {
		const rect = canvas.getBoundingClientRect();
		_v.set(x, y, z).project(camera);
		if (_v.z > 1 || _v.z < -1) { node.style.display = 'none'; return; }
		node.style.display = '';
		const px = rect.left + (_v.x * 0.5 + 0.5) * rect.width;
		const py = rect.top + (-_v.y * 0.5 + 0.5) * rect.height;
		node.style.transform = `translate(-50%, -100%) translate(${px}px, ${py}px)`;
	}

	function aimCamera() {
		// Slow orbit around the plaza at a cinematic height; held still under
		// reduced-motion so the stage never drifts for a motion-sensitive viewer.
		const ang = reducedMotion ? Math.PI * 0.25 : (elapsed / ORBIT_PERIOD_S) * Math.PI * 2;
		const r = 50;
		camera.position.set(Math.cos(ang) * r, 16, Math.sin(ang) * r);
		camera.lookAt(_target);
	}

	function frame(t) {
		raf = requestAnimationFrame(frame);
		const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
		lastT = t;
		elapsed += dt;
		simMs += dt * 1000 * scale;

		// Deterministic day across viewers: real wall time + this agent's offset,
		// scaled only when a demo asks to accelerate. At timeScale 1 this tracks
		// Date.now() so two viewers agree on the hour.
		phase = reducedMotion ? 0.5 : worldClock(Date.now() + simMs - elapsed * 1000, cycleMs, clockOffset);
		cycle.setTime(phase);

		env.update(dt);
		ambient.update(dt, { player: null, project });
		aimCamera();
		renderer.render(scene, camera);
	}

	function start() {
		if (running) return;
		running = true;
		size();
		window.addEventListener('resize', size);
		lastT = 0;
		raf = requestAnimationFrame(frame);
	}

	function stop() {
		if (!running) return;
		running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = null;
		window.removeEventListener('resize', size);
	}

	// Count detailed peds near the plaza centre → a 0..1 "how busy is it" reading
	// the DJ turns into crowd lines. Honest: it reads the real ambient crowd's
	// live positions, not a number we invented.
	function crowd() {
		const peds = ambient.peds || [];
		if (!peds.length) return 0;
		let near = 0;
		for (const p of peds) {
			const pos = p.rig?.position;
			if (pos && Math.hypot(pos.x, pos.z) <= CROWD_RADIUS) near++;
		}
		return Math.min(1, near / peds.length);
	}

	return {
		canvas,
		biome: env.biome,
		start,
		stop,
		setTimeScale(n) { scale = Math.max(0, Number(n) || 0); },
		getState() {
			return {
				phase,
				label: phaseLabel(phase),
				daylight: daylightAmount(phase),
				biomeLabel: env.biome.label,
				landmark,
				pedCount: (ambient.peds || []).length,
				crowd: crowd(),
			};
		},
		dispose() {
			stop();
			try { ambient.dispose(); } catch { /* already torn down */ }
			try { cycle.dispose?.(); } catch { /* no-op owner */ }
			try { env.dispose(); } catch { /* already torn down */ }
			renderer.dispose();
			canvas.remove();
			container.style.background = '';
		},
	};
}
