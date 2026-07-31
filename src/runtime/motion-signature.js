// Motion signatures: what a baked clip actually does, measured from its keyframes.
//
// Every clip in public/animations/clips/*.json is a THREE.AnimationClip with
// named bone tracks on the canonical skeleton (src/glb-canonicalize.js maps any
// rig onto it). That means the motion is not opaque: the rotation of every bone
// over time is right there, and questions people keep answering by eye can be
// answered by arithmetic instead.
//
//   • Where does this clip move? (head, arms, torso, legs, root)
//   • How energetic is it, and does it have a beat?
//   • Does it travel across the floor, or stay on the spot?
//   • Does its last frame meet its first, i.e. can it loop without a snap?
//   • Can it overlay a walk cycle, or does it need the whole body?
//
// Those answers drive real behaviour, not decoration: the /walk gesture layer
// table is checked against measured overlay-safety in tests/motion-signature
// .test.js, and the /gestures override picker refuses to quietly hand a slot a
// clip that cannot do the job that slot is for.
//
// Dependency-free on purpose (no Three.js, no DOM, no fs) for the same reason
// animation-slots.js is: the build script, the tests and the browser all import
// this one file, so they can never disagree about what a signature means.

/** Bumped when a field changes meaning. The build script stamps it into the index. */
export const SIGNATURE_VERSION = 1;

/** Body regions, in head-to-toe order (the order the UI renders them in). */
export const REGIONS = ['head', 'arms', 'torso', 'root', 'legs'];

/** Human labels for the regions, so every surface names them identically. */
export const REGION_LABELS = {
	head: 'Head',
	arms: 'Arms',
	torso: 'Torso',
	root: 'Hips',
	legs: 'Legs',
};

/**
 * Fewer frames than this is a pose, not an animation. Single-frame clips do
 * exist in the library (they were exported from a static pose) and they must be
 * flagged rather than silently scored as "perfectly calm".
 */
const MIN_ANIMATED_FRAMES = 2;

/** Below this mean angular speed (rad/s) nothing visible is happening. */
const STATIC_SPEED = 0.005;

/** Saturation constant for the 0..1 energy scale. A brisk walk lands near 0.7. */
const ENERGY_SCALE = 1.2;

/** Autocorrelation search window for a beat, in seconds. */
const MIN_BEAT_PERIOD = 0.3;
const MAX_BEAT_PERIOD = 2.5;

/** A peak below this is noise, not a beat. */
const BEAT_FLOOR = 0.25;

/** Loop-seam thresholds: mean bone angle (rad) and root offset (metres). */
const SEAM_ANGLE_LIMIT = 0.2;
const SEAM_ROOT_LIMIT = 0.06;

/**
 * Share of motion that must survive an upper-body strip for a clip to still
 * read as itself when played as an overlay. AnimationManager._buildOverlayClip
 * drops every hips/leg/foot track before making the clip additive, so a clip
 * whose motion is mostly in the legs becomes a near no-op on the `upper` layer.
 */
const OVERLAY_UPPER_SHARE = 0.6;

/**
 * Net root displacement (metres) past which a one-shot visibly relocates the
 * avatar. Agent slots play full-body through AnimationManager.play(), root
 * track included, so a clip that ends 30 cm from where it started slides the
 * avatar sideways and snaps back when it crossfades out.
 */
const ANCHOR_TRAVEL = 0.08;

/** Resample grid rate. Every clip in the library is baked at 30fps. */
const GRID_FPS = 30;
const MAX_GRID = 4096;

/**
 * Map a canonical bone name to a region, or null for bones that are excluded.
 *
 * Finger bones are deliberately excluded. Only some clips carry finger tracks
 * (51 vs 156 tracks across the library), so counting them would make two clips
 * with identical body motion score differently purely on export settings.
 *
 * @param {string} bone
 * @returns {string|null}
 */
export function regionOf(bone) {
	if (bone === 'Hips') return 'root';
	if (bone === 'Neck' || bone === 'Head') return 'head';
	if (/^Spine\d*$/.test(bone)) return 'torso';
	if (/^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/.test(bone)) return 'arms';
	if (/^(Left|Right)(UpLeg|Leg|Foot|ToeBase)$/.test(bone)) return 'legs';
	return null;
}

/** Which side of the body a bone is on, for the balance measure. */
function sideOf(bone) {
	if (bone.startsWith('Left')) return 'left';
	if (bone.startsWith('Right')) return 'right';
	return null;
}

/**
 * Visual mass of a bone: roughly how much of the silhouette its own rotation
 * moves. A shoulder rotation swings the whole arm; a wrist rotation swings a
 * hand. Without this, region shares answer "how many joints rotated" instead of
 * "where did the body move", and a wave reads as head-led because the two neck
 * bones out-average the one arm that is doing the work.
 *
 * Every clip in the library carries the full canonical bone set, so these
 * weights are comparable across clips without further normalisation.
 */
const BONE_MASS = {
	Hips: 3,
	Spine: 1.6,
	Spine1: 1.3,
	Spine2: 1,
	Neck: 0.5,
	Head: 1,
	Shoulder: 0.8,
	Arm: 1.2,
	ForeArm: 0.8,
	Hand: 0.4,
	UpLeg: 1.4,
	Leg: 1,
	Foot: 0.5,
	ToeBase: 0.2,
};

/** Mass of a canonical bone, side prefix stripped. */
function massOf(bone) {
	return BONE_MASS[bone.replace(/^(Left|Right)/, '')] ?? 1;
}

const round = (n, dp = 3) => {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
};

/** Shortest-arc angle between two unit quaternions, in radians. */
function quatAngle(v, a, b) {
	const dot = v[a] * v[b] + v[a + 1] * v[b + 1] + v[a + 2] * v[b + 2] + v[a + 3] * v[b + 3];
	return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

/**
 * Spread a segment's rotation angle across a uniform time grid.
 * Segments are proportioned by overlap, so a clip sampled off-grid still lands
 * its energy in the right bins instead of being snapped to the nearest one.
 */
function accumulate(grid, gridDt, t0, t1, angle) {
	const span = t1 - t0;
	if (!(span > 0)) return;
	const first = Math.max(0, Math.floor(t0 / gridDt));
	const last = Math.min(grid.length - 1, Math.floor((t1 - 1e-9) / gridDt));
	for (let i = first; i <= last; i++) {
		const lo = Math.max(t0, i * gridDt);
		const hi = Math.min(t1, (i + 1) * gridDt);
		if (hi > lo) grid[i] += angle * ((hi - lo) / span);
	}
}

/** Three-tap moving average. Frame-to-frame jitter autocorrelates; a beat does not need it. */
function smooth(signal) {
	const n = signal.length;
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = signal[Math.max(0, i - 1)];
		const b = signal[i];
		const c = signal[Math.min(n - 1, i + 1)];
		out[i] = (a + 2 * b + c) / 4;
	}
	return out;
}

/**
 * Find the clip's beat by autocorrelating its motion-energy envelope.
 *
 * Only local maxima count. Autocorrelation decays with lag, so taking the
 * largest value in the window always returns the shortest lag searched, which
 * is how a nod ends up reported at 257 BPM. A real periodic motion puts a peak
 * at its period with troughs either side; that is what this looks for.
 *
 * @returns {{period:number|null, strength:number}} period in seconds
 */
function findBeat(signal, dt, duration) {
	const n = signal.length;
	const maxLagS = Math.min(MAX_BEAT_PERIOD, duration / 2);
	if (n < 12 || maxLagS <= MIN_BEAT_PERIOD) return { period: null, strength: 0 };

	const env = smooth(signal);
	let mean = 0;
	for (let i = 0; i < n; i++) mean += env[i];
	mean /= n;

	const dev = new Float64Array(n);
	let energy = 0;
	for (let i = 0; i < n; i++) {
		dev[i] = env[i] - mean;
		energy += dev[i] * dev[i];
	}
	if (energy <= 0) return { period: null, strength: 0 };

	const minLag = Math.max(2, Math.round(MIN_BEAT_PERIOD / dt));
	const maxLag = Math.min(n - 2, Math.round(maxLagS / dt));
	if (maxLag <= minLag + 1) return { period: null, strength: 0 };

	// Normalised autocorrelation across the whole window, then peak-pick on it.
	const acf = new Float64Array(maxLag + 2);
	for (let lag = minLag - 1; lag <= maxLag + 1 && lag < n - 1; lag++) {
		let sum = 0;
		for (let i = 0; i + lag < n; i++) sum += dev[i] * dev[i + lag];
		acf[lag] = (sum / (n - lag)) / (energy / n);
	}

	let bestLag = 0;
	let best = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		if (acf[lag] <= acf[lag - 1] || acf[lag] < acf[lag + 1]) continue;
		if (acf[lag] > best) {
			best = acf[lag];
			bestLag = lag;
		}
	}
	if (bestLag === 0 || best < BEAT_FLOOR) {
		return { period: null, strength: round(Math.max(0, best)) };
	}
	return { period: bestLag * dt, strength: round(Math.min(1, best)) };
}

/**
 * Measure one baked clip.
 *
 * @param {{name:string, duration:number, tracks:Array}} clip — the parsed
 *   contents of public/animations/clips/<name>.json
 * @returns {object} signature (see the README table in docs/animations.md)
 */
export function analyzeClip(clip) {
	const name = String(clip?.name || '');
	const duration = Number(clip?.duration) || 0;
	const tracks = Array.isArray(clip?.tracks) ? clip.tracks : [];

	const gridN = Math.min(MAX_GRID, Math.max(2, Math.round(duration * GRID_FPS)));
	const gridDt = duration > 0 ? duration / gridN : 1;
	const grid = new Float64Array(gridN);

	const regionSum = { head: 0, arms: 0, torso: 0, root: 0, legs: 0 };
	const sideSum = { left: 0, right: 0 };
	let seamAngle = 0;
	let seamBones = 0;
	let totalAngle = 0;
	let boneCount = 0;
	let frames = 0;

	for (const track of tracks) {
		const [bone, prop] = String(track?.name || '').split('.');
		if (prop !== 'quaternion') continue;
		const region = regionOf(bone);
		if (!region) continue;
		const times = track.times;
		const values = track.values;
		if (!times?.length || !values?.length) continue;
		frames = Math.max(frames, times.length);

		let sum = 0;
		for (let i = 0; i < times.length - 1; i++) {
			const angle = quatAngle(values, i * 4, (i + 1) * 4);
			sum += angle;
			accumulate(grid, gridDt, times[i], times[i + 1], angle);
		}

		const perSecond = duration > 0 ? sum / duration : 0;
		const mass = massOf(bone);
		regionSum[region] += mass * perSecond;
		totalAngle += sum;
		boneCount += 1;

		const side = sideOf(bone);
		if (side) sideSum[side] += mass * perSecond;

		seamAngle += quatAngle(values, 0, (times.length - 1) * 4);
		seamBones += 1;
	}

	const meanSpeed = boneCount > 0 && duration > 0 ? totalAngle / boneCount / duration : 0;

	// Mass-weighted shares: what fraction of the body's visible movement each
	// region accounts for.
	let regionTotal = 0;
	for (const r of REGIONS) regionTotal += regionSum[r];
	const regions = {};
	for (const r of REGIONS) regions[r] = round(regionTotal > 0 ? regionSum[r] / regionTotal : 0);

	// Root translation. Hips.position is in metres on the canonical rig.
	let travel = 0;
	let path = 0;
	let rise = 0;
	const hips = tracks.find((t) => t?.name === 'Hips.position');
	if (hips?.values?.length >= 3) {
		const v = hips.values;
		const n = Math.floor(v.length / 3);
		let yMin = Infinity;
		let yMax = -Infinity;
		for (let i = 0; i < n; i++) {
			const y = v[i * 3 + 1];
			if (y < yMin) yMin = y;
			if (y > yMax) yMax = y;
			if (i > 0) path += Math.hypot(v[i * 3] - v[(i - 1) * 3], v[i * 3 + 2] - v[(i - 1) * 3 + 2]);
		}
		travel = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]);
		rise = yMax - yMin;
	}

	const speedSignal = new Float64Array(gridN);
	for (let i = 0; i < gridN; i++) speedSignal[i] = grid[i] / gridDt;
	const beat = findBeat(speedSignal, gridDt, duration);

	const seam = seamBones > 0 ? seamAngle / seamBones : 0;
	const seamRoot = hips?.values?.length >= 3
		? (() => {
				const v = hips.values;
				const n = Math.floor(v.length / 3);
				return Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 1] - v[1], v[(n - 1) * 3 + 2] - v[2]);
			})()
		: 0;

	const balance = sideSum.left + sideSum.right > 0
		? 1 - Math.abs(sideSum.left - sideSum.right) / (sideSum.left + sideSum.right)
		: 1;

	const isStatic = frames < MIN_ANIMATED_FRAMES || meanSpeed < STATIC_SPEED;
	const upperShare = round(regions.head + regions.arms + regions.torso);

	return {
		clip: name,
		duration: round(duration, 2),
		frames,
		energy: round(1 - Math.exp(-meanSpeed / ENERGY_SCALE)),
		speed: round(meanSpeed),
		regions,
		lead: leadRegion(regions),
		upperShare,
		balance: round(balance),
		travel: round(travel),
		path: round(path),
		rise: round(rise),
		tempo: beat.period ? Math.round(60 / beat.period) : 0,
		beat: beat.strength,
		seam: round(seam),
		seamRoot: round(seamRoot),
		loopClean: !isStatic && seam < SEAM_ANGLE_LIMIT && seamRoot < SEAM_ROOT_LIMIT,
		anchored: travel < ANCHOR_TRAVEL,
		overlay: !isStatic && upperShare >= OVERLAY_UPPER_SHARE,
		static: isStatic,
	};
}

/** The region carrying the most motion. */
export function leadRegion(regions) {
	let best = REGIONS[0];
	for (const r of REGIONS) if ((regions[r] || 0) > (regions[best] || 0)) best = r;
	return best;
}

/**
 * Distance between two signatures in the descriptor space, 0 (identical) to 1.
 * Region shares dominate because "where the motion is" is what people mean by
 * "a clip like this one"; energy and tempo refine the ordering inside a family.
 */
export function distance(a, b) {
	if (!a || !b) return 1;
	let regionDelta = 0;
	for (const r of REGIONS) regionDelta += Math.abs((a.regions?.[r] || 0) - (b.regions?.[r] || 0));
	// Region shares each sum to 1, so the L1 delta is at most 2.
	const regionTerm = regionDelta / 2;
	const energyTerm = Math.abs((a.energy || 0) - (b.energy || 0));
	const tempoTerm = a.tempo && b.tempo
		? Math.min(1, Math.abs(a.tempo - b.tempo) / 120)
		: (a.tempo || b.tempo ? 0.5 : 0);
	const travelTerm = Math.min(1, Math.abs((a.path || 0) - (b.path || 0)) / 2);
	return round(Math.min(1, 0.55 * regionTerm + 0.25 * energyTerm + 0.12 * tempoTerm + 0.08 * travelTerm));
}

/** Rank an index of signatures by closeness to one clip. */
export function similarTo(clipName, index, limit = 6) {
	const target = index?.[clipName];
	if (!target) return [];
	return Object.values(index)
		.filter((s) => s.clip !== clipName)
		.map((s) => ({ clip: s.clip, distance: distance(target, s), signature: s }))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, limit);
}

/** Plain-language energy band, so the UI and the docs use the same words. */
export function energyBand(sig) {
	if (!sig || sig.static) return 'still';
	if (sig.energy < 0.15) return 'calm';
	if (sig.energy < 0.4) return 'gentle';
	if (sig.energy < 0.65) return 'lively';
	return 'explosive';
}

/**
 * One sentence describing a signature, for card subtitles and screen readers.
 * @param {object} sig
 * @returns {string}
 */
export function describe(sig) {
	if (!sig) return '';
	if (sig.static) return 'A single held pose. Nothing moves.';
	const parts = [`${energyBand(sig)} motion led by the ${REGION_LABELS[sig.lead].toLowerCase()}`];
	if (sig.tempo) parts.push(`on a ${sig.tempo} BPM beat`);
	if (!sig.anchored) parts.push(`ending ${sig.travel.toFixed(2)} m from where it started`);
	else parts.push('anchored on the spot');
	if (sig.overlay) parts.push('readable as an upper-body overlay');
	if (!sig.loopClean) parts.push('with a visible seam if looped');
	return `${parts.join(', ')}.`;
}

/**
 * Slots the walk state machine plays on its `upper` layer, where
 * AnimationManager._buildOverlayClip strips every hips/leg/foot track before
 * blending. tests/motion-signature.test.js holds this list to the real GESTURES
 * table in src/animation-state-machine.js.
 */
export const DEFAULT_OVERLAY_SLOTS = ['wave', 'nod', 'shake', 'point', 'shrug', 'sign'];

/** Slots that run as a continuous loop rather than a one-shot. */
export const DEFAULT_LOOP_SLOTS = ['idle', 'fidget', 'patience'];

/**
 * Whether a clip can actually do the job a slot is for.
 *
 * Three failure modes, each measured rather than guessed:
 *
 *   1. A held pose in an animated slot freezes the avatar (four clips in the
 *      library are single-frame exports).
 *   2. A leg-led clip in an overlay slot nearly vanishes, because the overlay
 *      path strips the lower body before blending.
 *   3. A clip whose root ends away from where it began slides the avatar across
 *      the floor and snaps it back on crossfade out. Agent slots play full-body
 *      through AnimationManager.play(), root track included, so this is visible
 *      on every agent page.
 *
 * @param {string} slot
 * @param {object} sig
 * @param {{overlaySlots?: string[], loopSlots?: string[]}} [rules]
 * @returns {{level:'ok'|'warn', message:string}|null} null when nothing to say
 */
export function slotFit(slot, sig, rules = {}) {
	if (!sig) return null;
	const overlaySlots = rules.overlaySlots || DEFAULT_OVERLAY_SLOTS;
	const loopSlots = rules.loopSlots || DEFAULT_LOOP_SLOTS;

	if (sig.static) {
		return {
			level: 'warn',
			message: 'This clip is a single held pose, so the slot would freeze instead of animating.',
		};
	}
	if (overlaySlots.includes(slot) && !sig.overlay) {
		return {
			level: 'warn',
			message: `On /walk, ${slot} plays as an upper-body overlay with the hips and legs stripped out, and ${Math.round((1 - sig.upperShare) * 100)}% of this clip's motion is below the waist. Most of it would not survive the strip.`,
		};
	}
	if (loopSlots.includes(slot) && !sig.loopClean) {
		return {
			level: 'warn',
			message: `${slot} loops continuously, and this clip's last frame does not meet its first. Expect a visible snap every cycle.`,
		};
	}
	if (!sig.anchored) {
		return {
			level: 'warn',
			message: `This clip ends ${sig.travel.toFixed(2)} m from where it started, so the avatar slides that far and snaps back when the gesture finishes.`,
		};
	}
	return { level: 'ok', message: describe(sig) };
}
