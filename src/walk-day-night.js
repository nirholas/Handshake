// walk-day-night.js: a real time of day for the /walk environments.
//
// Port of /play's day/night cycle (src/game/day-night.js, W01) onto the /walk
// lighting rig. Both surfaces read the same deterministic world clock
// (src/shared/world-clock.js), so /walk and /play always agree on whether it is
// night: the sun rises in the east, arcs over the park, warms and dips at dusk,
// and the sky graduates night → dawn → day → dusk. No per-client randomness,
// no server round-trip; the phase is a pure function of wall-clock time, so
// every visitor in the same world sees the exact same sky.
//
// /walk's rig differs from /play's world-env: the sky is a CSS radial gradient
// painted on the stage element (the canvas clears transparent), the lights are
// a plain ambient/hemisphere/directional trio, and IBL comes from a per-
// environment HDR whose strength lives on scene.environmentIntensity. This
// module owns the *dynamic* half of all four; the static daytime anchors come
// from the environment manifest entry, so midday still looks exactly like the
// authored world.
//
// Indoor stages (gallery, office) and the abstract void keep their fixed
// manifest lighting: setEnvironment() only arms the cycle for `kind: "outdoor"`
// entries. While AR passthrough runs, the host pauses the cycle; the real
// room's estimated lighting owns the rig there.

import { Color, MathUtils, Vector3 } from 'three';
import { worldClock, phaseLabel } from './shared/world-clock.js';

const TWO_PI = Math.PI * 2;

// Sky keyframes for the dark and dusk ends (same palette family as /play's
// cycle); the bright end is the environment's own authored sky, so noon in the
// park is still the park.
const NIGHT_SKY = { top: '#05060f', bottom: '#16223c' };
const DUSK_SKY = { top: '#1b2a52', bottom: '#e8995a' };
const DAWN_WARM = new Color('#ff7a3a');
const MOON_COOL = new Color('#9db8e8');

function smoothstep(edge0, edge1, x) {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/**
 * @param {object} deps
 * @param {import('three').AmbientLight} deps.ambientLight
 * @param {import('three').HemisphereLight} deps.hemi
 * @param {import('three').DirectionalLight} deps.sun
 * @param {import('three').Scene} deps.scene      IBL strength (environmentIntensity)
 * @param {HTMLElement} deps.stageEl              sky gradient host (#walk-stage)
 */
export function createWalkDayNight({ ambientLight, hemi, sun, scene, stageEl }) {
	let enabled = false;
	let paused = false;
	let anchors = null;

	// Scratch: update() runs every frame and must not allocate.
	const _sunC = new Color();
	const _sunDir = new Vector3();
	const _top = new Color();
	const _bot = new Color();
	const _mix = new Color();
	const _dayTop = new Color();
	const _dayBot = new Color();
	let _lastSkyP = -1;

	/**
	 * Arm (or disarm) the cycle for an environment manifest entry. Captures the
	 * entry's daytime lighting as the bright end of every range and immediately
	 * snaps the rig to the current time of day, so swapping into a world at
	 * night never flashes noon first.
	 */
	function setEnvironment(meta) {
		enabled = meta?.kind === 'outdoor' && !!meta.light && !!meta.sky;
		_lastSkyP = -1;
		if (!enabled) {
			anchors = null;
			return;
		}
		const L = meta.light;
		const d = L.sun?.direction || [4, 8, 6];
		anchors = {
			ambientI: L.ambient?.intensity ?? 0.5,
			hemiI: L.hemi?.intensity ?? 0.7,
			sunI: L.sun?.intensity ?? 1.5,
			sunColor: new Color(L.sun?.color || '#ffffff'),
			sunRadius: Math.max(6, Math.hypot(d[0], d[1], d[2])),
			azimuth: Math.atan2(d[2], d[0]),
			envIntensity: meta.envIntensity || 1,
		};
		_dayTop.set(meta.sky.top);
		_dayBot.set(meta.sky.bottom);
		update(Date.now(), true);
	}

	/**
	 * Drive the rig to the time of day for `now` (wall-clock ms). Returns the
	 * daylight amount [0..1] or null when the cycle is disarmed/paused.
	 */
	function update(now = Date.now(), force = false) {
		if (!enabled || !anchors || (paused && !force)) return null;
		const frac = worldClock(now);
		const sunAngle = (frac - 0.25) * TWO_PI; // 0.25→sunrise, 0.5→noon, 0.75→sunset
		const alt = Math.sin(sunAngle); // sun altitude, -1..1
		const horiz = Math.cos(sunAngle); // east(+) … west(−)
		const day = smoothstep(-0.1, 0.18, alt);
		// The sky crossfades over a much wider slice of the sun's arc than the
		// light levels do. Tying both to `day` made dawn and dusk flip in a
		// couple of seconds and left the world flat-lit the rest of the cycle;
		// a wider curve lets the warm dusk palette actually linger on the
		// horizon while the ground lighting still goes dark on schedule.
		const skyMix = smoothstep(-0.45, 0.45, alt);

		// --- Sun: arc along the environment's authored azimuth ------------------
		const az = anchors.azimuth;
		_sunDir
			.set(Math.cos(az) * horiz, Math.max(alt, -0.25), Math.sin(az) * horiz)
			.normalize();
		sun.position.copy(_sunDir).multiplyScalar(anchors.sunRadius);
		sun.target?.position.set(0, 0, 0);
		sun.target?.updateMatrixWorld?.();

		// Warm near the horizon, the authored colour high in the sky, and a cool
		// moonlight cast once it dips below, so the residual light at night reads
		// as moon, not as an orange sun shining from underground.
		const warmth = MathUtils.clamp(1 - alt * 1.8, 0, 1);
		_sunC.copy(anchors.sunColor).lerp(DAWN_WARM, warmth * 0.75);
		if (alt < 0) _sunC.lerp(MOON_COOL, smoothstep(0, 0.35, -alt));
		sun.color.copy(_sunC);

		// --- Light levels: authored bright end → a low, cool night --------------
		sun.intensity = MathUtils.lerp(0.07, anchors.sunI, day);
		hemi.intensity = MathUtils.lerp(0.12, anchors.hemiI, day);
		ambientLight.intensity = MathUtils.lerp(0.1, anchors.ambientI, day);
		if (scene && 'environmentIntensity' in scene) {
			scene.environmentIntensity = anchors.envIntensity * MathUtils.lerp(0.16, 1, day);
		}

		// --- Sky gradient (throttled: a CSS write only when it has shifted) -----
		if (force || Math.abs(skyMix - _lastSkyP) > 0.005) {
			_lastSkyP = skyMix;
			if (skyMix < 0.5) {
				const k = skyMix / 0.5; // night → dusk
				_top.set(NIGHT_SKY.top).lerp(_mix.set(DUSK_SKY.top), k);
				_bot.set(NIGHT_SKY.bottom).lerp(_mix.set(DUSK_SKY.bottom), k);
			} else {
				const k = (skyMix - 0.5) / 0.5; // dusk → the authored day sky
				_top.set(DUSK_SKY.top).lerp(_dayTop, k);
				_bot.set(DUSK_SKY.bottom).lerp(_dayBot, k);
			}
			paintSky(`#${_top.getHexString()}`, `#${_bot.getHexString()}`);
		}
		return day;
	}

	// Same gradient shape walk-environments.js applySky() paints, so the noon
	// sky is pixel-identical to the static one the manifest authored.
	function paintSky(top, bottom) {
		if (!stageEl) return;
		stageEl.style.background = `radial-gradient(120% 90% at 50% 18%, ${top} 0%, ${bottom} 72%) ${bottom}`;
	}

	return {
		setEnvironment,
		update,
		setPaused(v) {
			paused = !!v;
		},
		isEnabled: () => enabled,
		phase: (now = Date.now()) => worldClock(now),
		label: (now = Date.now()) => phaseLabel(worldClock(now)),
		dispose() {
			enabled = false;
			anchors = null;
		},
	};
}
