// Day/night cycle — a real time-of-day that drives the sun, sky, fog and the
// city's lights (W01: open-world foundation).
//
// world-env.js gives each biome a single, fixed sun. This module replaces that
// frozen noon with a moving day: the sun rises in the east, arcs overhead and
// sets in the west, the sky graduates night → dawn → day → dusk, fog closes in
// after dark, and the district's windows and streetlamps come up at dusk. It is
// driven by an authoritative world time the server broadcasts, so every client
// in a world sees the EXACT same sky — two players always agree on whether it's
// night.
//
// It owns no scene objects of its own: it reads the biome's daytime values as
// the bright end of every range and writes through the handles world-env and the
// district expose. `setTime(t)` takes a day fraction in [0, 1): 0 = midnight,
// 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.

import { Color, MathUtils } from 'three';

const TWO_PI = Math.PI * 2;

// Sky keyframes for the dark and dusk ends; the bright end is the biome's own
// `sky` palette, so midday still looks like the coin's world.
const NIGHT_SKY = ['#05060f', '#0a0f24', '#16223c'];
const DUSK_SKY = ['#1b2a52', '#6a4a72', '#e8995a'];
const DAWN_WARM = new Color('#ff7a3a');

function smoothstep(edge0, edge1, x) {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

// Scratch target for the string-hex branch, so a sky crossfade allocates nothing
// per frame (this runs three times per update, every update, for the whole
// session). Callers pass pre-built Colors where they can; biome palettes still
// arrive as hex strings, and those parse into this one reused instance.
const _lerpScratch = new Color();
function lerpHex(a, b, t, out) {
	return out.set(a).lerp(typeof b === 'string' ? _lerpScratch.set(b) : b, t);
}

/**
 * @param {object} env       world-env handle exposing { biome, lights, setSky, setBaseSun, setBaseFog }
 * @param {object} [district] district handle exposing setNight(k) (optional)
 */
export function createDayNightCycle(env, district = null) {
	const biome = env.biome;
	const { sunLight, sun, hemi, ambient } = env.lights;

	// Bright-end (daytime) anchors, straight from the biome.
	const dayHemi = biome.hemi[2];
	const dayAmbient = biome.ambient;
	const dayFogNear = biome.fogNear;
	const dayFogFar = biome.fogFar;
	const daySunI = biome.sun.intensity;
	const biomeSunColor = new Color(biome.sun.color);
	const azR = MathUtils.degToRad(biome.sun.azimuth);

	// Scratch colours so setTime allocates nothing per frame.
	const _sunC = new Color();
	const _top = new Color(), _mid = new Color(), _hor = new Color();
	const _fog = new Color();
	let _lastSkyP = -1;

	function setTime(t) {
		const frac = ((t % 1) + 1) % 1; // wrap into [0,1)
		const sunAngle = (frac - 0.25) * TWO_PI; // 0.25→sunrise, 0.5→noon, 0.75→sunset
		const alt = Math.sin(sunAngle);   // sun altitude, -1..1
		const horiz = Math.cos(sunAngle); // east(+) … west(−)
		const day = smoothstep(-0.10, 0.18, alt); // 0 night … 1 full day
		const night = 1 - day;

		// --- Sun position + colour ---------------------------------------------
		sun.set(Math.cos(azR) * horiz, Math.max(alt, -0.25), Math.sin(azR) * horiz).normalize();
		sunLight.position.copy(sun).multiplyScalar(120);
		sunLight.target.position.set(0, 0, 0);
		// Warm and dim near the horizon, neutral-bright high in the sky.
		const warmth = Math.max(0, Math.min(1, 1 - alt * 1.8));
		_sunC.copy(biomeSunColor).lerp(DAWN_WARM, warmth * 0.75);
		sunLight.color.copy(_sunC);

		// --- Light levels (biome bright end → a low, cool night) ----------------
		env.setBaseSun(daySunI * day);
		hemi.intensity = MathUtils.lerp(0.1, dayHemi, day);
		ambient.intensity = MathUtils.lerp(0.05, dayAmbient, day);

		// --- Fog: closes in and darkens after dark -----------------------------
		env.setBaseFog(
			MathUtils.lerp(dayFogNear * 0.55, dayFogNear, day),
			MathUtils.lerp(dayFogFar * 0.6, dayFogFar, day),
		);

		// --- Sky gradient (throttled — only rebuild when it has shifted) --------
		if (Math.abs(day - _lastSkyP) > 0.01) {
			_lastSkyP = day;
			if (day < 0.5) {
				const k = day / 0.5; // night → dusk
				lerpHex(NIGHT_SKY[0], DUSK_SKY[0], k, _top);
				lerpHex(NIGHT_SKY[1], DUSK_SKY[1], k, _mid);
				lerpHex(NIGHT_SKY[2], DUSK_SKY[2], k, _hor);
			} else {
				const k = (day - 0.5) / 0.5; // dusk → day (biome palette)
				lerpHex(DUSK_SKY[0], biome.sky[0], k, _top);
				lerpHex(DUSK_SKY[1], biome.sky[1], k, _mid);
				lerpHex(DUSK_SKY[2], biome.sky[2], k, _hor);
			}
			_fog.copy(_hor);
			env.setSky(
				`#${_top.getHexString()}`,
				`#${_mid.getHexString()}`,
				`#${_hor.getHexString()}`,
				`#${_fog.getHexString()}`,
			);
		}

		// --- City lights -------------------------------------------------------
		district?.setNight(night);

		return { day, alt, night };
	}

	return {
		setTime,
		dispose() { /* owns no scene objects; handles belong to env/district */ },
	};
}
