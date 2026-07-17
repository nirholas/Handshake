// /club — performance profile detection + render budgets
//
// One profile is picked at boot from real capability signals
// (`deviceMemory`, `hardwareConcurrency`, `pointer: coarse`) with the UA
// string only used to decide whether we're on a mobile device at all.
// The profile gates how expensive the scene is allowed to be — pixel
// ratio, shadows, post-FX, mirror-ball cube cam, volumetric cones, crowd
// instances. Mid-session, the animate loop downgrades one tier on
// sustained slow frames and, with strong hysteresis, upgrades one tier
// back after a much longer sustained-fast window (capped at the tier the
// device booted into, so we only ever recover lost quality, never exceed
// the device profile). Recovery matters: without it a single load-time or
// GC hitch pins the renderer's pixel ratio low for the whole session, so
// the 3D stays permanently soft on a high-DPI screen while the HTML UI
// over it renders crisp — the classic "why is it blurry" symptom.
//
// Prompts 01–04 (venue, dancers, postFX, mirror ball) read these flags
// when constructing their parts of the scene. Anything that doesn't
// exist yet is simply gated for the future; the flag set is the contract.

import { log } from './shared/log.js';
const PROFILE_TIERS = ['high', 'medium', 'low'];

/**
 * Inspect the runtime capability signals and pick the right profile tier.
 *
 *  - desktops with cores + memory      → 'high'
 *  - mobile with constrained signal    → 'low'
 *  - everything else (modern phones,
 *    chromebooks, coarse pointers)     → 'medium'
 *
 * The UA string is only used to decide `isMobile`; we do NOT branch on
 * specific vendor tokens. `deviceMemory` and `hardwareConcurrency` are
 * undefined on Safari — we default to "plenty" (8) so an iPhone with
 * a coarse pointer falls through to `medium` rather than `low`.
 *
 * @param {object} [env]
 * @param {Navigator} [env.navigator]
 * @param {Window}    [env.window]
 * @returns {'high'|'medium'|'low'}
 */
/**
 * @param {object} [env]
 * @param {Navigator} [env.navigator]
 * @param {Window}    [env.window]
 * @returns {'high'|'medium'|'low'}
 */
export function detectProfile(env = {}) {
	const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : {});
	const win = env.window ?? (typeof window !== 'undefined' ? window : {});

	const ua = String(nav.userAgent || '');
	const isMobile = /(iPhone|iPad|Android|Mobi)/i.test(ua);
	const lowMem = (nav.deviceMemory ?? 8) < 4;
	const lowCores = (nav.hardwareConcurrency ?? 8) < 4;
	const coarse = !!(win.matchMedia && win.matchMedia('(any-pointer: coarse)').matches);
	const touchPrimary = !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches);

	if (!isMobile && !lowMem && !lowCores) return 'high';
	if ((isMobile && (lowMem || lowCores)) || (touchPrimary && lowMem)) return 'low';
	if (coarse) return 'medium';
	return 'medium';
}

/**
 * Whether the current device should be treated as mobile for layout purposes.
 * Checks screen width + touch primary pointer. Exported so other modules
 * can default to single-pole VIP view on small screens.
 */
export function isMobileLayout(env = {}) {
	const win = env.window ?? (typeof window !== 'undefined' ? window : {});
	if (!win.innerWidth) return false;
	return win.innerWidth < 768;
}

/**
 * Per-tier render budgets. Keep these stable — other modules read them
 * by key, so a typo in a flag name is a silent quality regression.
 *
 *  - `pixelRatio`         — renderer.setPixelRatio cap
 *  - `shadows`            — renderer.shadowMap.enabled + spotlight castShadow
 *  - `shadowMapSize`      — square shadow map dimension (0 when shadows off)
 *  - `bloom`              — UnrealBloomPass in EffectComposer
 *  - `chromaticAberration`— ShaderPass tail of EffectComposer
 *  - `mirrorBall`         — the mirror-ball mesh is built at all
 *  - `cubeCam`            — mirror ball samples live with a CubeCamera (else
 *                           uses a static reflection texture)
 *  - `volumetricCones`    — additive cone meshes under each spotlight
 *  - `crowdInstances`     — InstancedMesh count for background crowd
 *  - `discoLights`        — number of PointLights in the swirling disco rig
 *
 * Resolution of `pixelRatio` happens at read time because
 * `window.devicePixelRatio` isn't defined in Node — guard against that
 * so the same module loads in vitest.
 */
const dpr = (cap) => {
	const d = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
	return Math.min(d, cap);
};

export const PROFILES = {
	high: {
		tier: 'high',
		pixelRatio: dpr(2),
		shadows: true,
		shadowMapSize: 1024,
		bloom: true,
		chromaticAberration: true,
		mirrorBall: true,
		cubeCam: true,
		volumetricCones: true,
		crowdInstances: 80,
		discoLights: 4,
	},
	medium: {
		tier: 'medium',
		pixelRatio: dpr(1.5),
		shadows: true,
		shadowMapSize: 512,
		bloom: true,
		chromaticAberration: false,
		mirrorBall: true,
		cubeCam: false,
		volumetricCones: true,
		crowdInstances: 40,
		discoLights: 4,
	},
	low: {
		tier: 'low',
		pixelRatio: 1.0,
		shadows: false,
		shadowMapSize: 0,
		bloom: false,
		chromaticAberration: false,
		mirrorBall: false,
		cubeCam: false,
		volumetricCones: false,
		crowdInstances: 12,
		discoLights: 2,
	},
};

/**
 * Return the next-lower profile tier (high→medium→low). `low` is the
 * floor — calling this on `low` returns `low` so callers can compare for
 * equality to detect "we can't degrade further".
 *
 * @param {'high'|'medium'|'low'} tier
 * @returns {'high'|'medium'|'low'}
 */
export function nextLowerTier(tier) {
	const i = PROFILE_TIERS.indexOf(tier);
	if (i < 0) return 'low';
	return PROFILE_TIERS[Math.min(i + 1, PROFILE_TIERS.length - 1)];
}

/**
 * Return the next-higher profile tier (low→medium→high). `high` is the
 * ceiling — calling this on `high` returns `high`. Unknown tiers return
 * `low` (the safe floor), matching `nextLowerTier`.
 *
 * @param {'high'|'medium'|'low'} tier
 * @returns {'high'|'medium'|'low'}
 */
export function nextHigherTier(tier) {
	const i = PROFILE_TIERS.indexOf(tier);
	if (i < 0) return 'low';
	return PROFILE_TIERS[Math.max(i - 1, 0)];
}

/**
 * Frame-budget watchdog. Feed it `dt` once per frame; when the EMA of
 * frame time stays above the slow-frame threshold for `holdSec`
 * consecutive seconds, fire `onDowngrade(nextTier)` and reset the
 * sustained counter so we don't fire again until another full slow
 * window passes.
 *
 * Recovery (hysteresis): once frames have been comfortably fast
 * (`frameAvg < fastSec`) for a much longer sustained window
 * (`recoverSec`, default 6s vs the 2s downgrade window), upgrade one tier
 * back via `onUpgrade(nextTier)` — but never past `maxTier` (the tier the
 * device booted into), so a capable machine that hit one load-time hitch
 * climbs back to full pixel ratio instead of staying soft forever, while
 * a genuinely weak device that can't sustain fast frames never does. The
 * long asymmetric window + a neutral dead-band between `fastSec` and
 * `slowSec` prevent tier flapping.
 *
 * @param {object}   opts
 * @param {'high'|'medium'|'low'} opts.initialTier
 * @param {number}   [opts.slowSec=1/28]    — slow threshold per frame (sec)
 * @param {number}   [opts.fastSec=1/50]    — fast threshold for recovery (sec)
 * @param {number}   [opts.holdSec=2.0]     — sustained-slow window (sec)
 * @param {number}   [opts.recoverSec=6.0]  — sustained-fast window (sec)
 * @param {'high'|'medium'|'low'} [opts.maxTier=initialTier] — recovery ceiling
 * @param {number}   [opts.emaAlpha=0.06]   — EMA decay; smaller = smoother
 * @param {(tier:'high'|'medium'|'low')=>void} opts.onDowngrade
 * @param {(tier:'high'|'medium'|'low')=>void} [opts.onUpgrade]
 */
export function createFrameWatchdog({
	initialTier,
	slowSec = 1 / 28,
	fastSec = 1 / 50,
	holdSec = 2.0,
	recoverSec = 6.0,
	maxTier = initialTier,
	emaAlpha = 0.06,
	onDowngrade,
	onUpgrade,
}) {
	let tier = initialTier;
	let frameAvg = 1 / 60;
	let slowAccum = 0;
	let fastAccum = 0;
	const maxTierIdx = PROFILE_TIERS.indexOf(maxTier);

	return {
		get tier() { return tier; },
		tick(dt) {
			if (!Number.isFinite(dt) || dt <= 0) return;
			frameAvg = frameAvg * (1 - emaAlpha) + dt * emaAlpha;

			if (frameAvg > slowSec) {
				// Slow band: accumulate toward a downgrade, cancel any recovery.
				fastAccum = 0;
				slowAccum += dt;
				if (slowAccum >= holdSec && tier !== 'low') {
					const next = nextLowerTier(tier);
					tier = next;
					slowAccum = 0;
					// Smooth out the EMA so we don't immediately retrigger
					// while the still-warm GPU recovers.
					frameAvg = slowSec * 0.9;
					try { onDowngrade?.(next); } catch (err) { log.warn('[club-perf] onDowngrade threw', err); }
				}
			} else if (onUpgrade && frameAvg < fastSec) {
				// Fast band: accumulate toward a recovery, cancel any downgrade.
				// Recovery is opt-in — a consumer that wired only `onDowngrade`
				// keeps the original monotone step-down behaviour, tier and all.
				slowAccum = 0;
				fastAccum += dt;
				// Only climb back toward the tier the device booted into.
				if (fastAccum >= recoverSec && PROFILE_TIERS.indexOf(tier) > maxTierIdx) {
					const next = nextHigherTier(tier);
					tier = next;
					fastAccum = 0;
					// Nudge the EMA up so the newly heavier tier gets a fair
					// window before we'd consider climbing again.
					frameAvg = fastSec * 1.1;
					try { onUpgrade?.(next); } catch (err) { log.warn('[club-perf] onUpgrade threw', err); }
				}
			} else {
				// Neutral dead-band: neither fast nor slow — hold steady.
				slowAccum = 0;
				fastAccum = 0;
			}
		},
		getFrameAvg() { return frameAvg; },
	};
}
