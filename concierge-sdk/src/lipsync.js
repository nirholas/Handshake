/**
 * Lipsync driver — @three-ws/concierge (shared lineage: page-agent-sdk/src/lipsync.js)
 * =====================================
 *
 * Text → viseme heuristic. No audio analysis, no microphone, no network. We
 * tokenize the spoken text into a timed viseme sequence and lerp the matching
 * morph targets each frame, so the mouth shapes track the words the speech
 * engine is saying. This is the same approach three.ws ships in production
 * (src/runtime/lipsync.js); it is reproduced here so the package stays
 * dependency-free apart from `three`.
 *
 * Three mouth drivers, chosen from the discovered morph targets:
 *   - 'arkit': full Oculus/ARKit viseme set (best).
 *   - 'jaw':   only jawOpen/mouthOpen — amplitude-style open/close.
 *   - none:    no morphs → returns a no-op timeline; the stage carries the
 *              talk visually through body animation instead.
 */

const ARKIT_VISEMES = [
	'viseme_aa', 'viseme_CH', 'viseme_DD', 'viseme_E', 'viseme_FF',
	'viseme_I', 'viseme_kk', 'viseme_nn', 'viseme_O', 'viseme_PP',
	'viseme_RR', 'viseme_sil', 'viseme_SS', 'viseme_TH', 'viseme_U',
];
const JAW_FALLBACKS = ['jawOpen', 'mouthOpen'];

const CHAR_TO_VISEME = {
	a: 'viseme_aa', e: 'viseme_E', i: 'viseme_I', o: 'viseme_O', u: 'viseme_U',
	b: 'viseme_PP', m: 'viseme_PP', p: 'viseme_PP',
	f: 'viseme_FF', v: 'viseme_FF',
	d: 'viseme_DD', t: 'viseme_DD', n: 'viseme_DD', l: 'viseme_DD',
	k: 'viseme_kk', g: 'viseme_kk', c: 'viseme_kk', q: 'viseme_kk',
	s: 'viseme_SS', z: 'viseme_SS', x: 'viseme_SS',
	r: 'viseme_RR', w: 'viseme_U', y: 'viseme_I', h: 'viseme_E', j: 'viseme_CH',
};
const DIGRAPH_TO_VISEME = { th: 'viseme_TH', ch: 'viseme_CH', sh: 'viseme_CH' };

const MS_PER_PHONEME = 80;
const WORD_GAP_MS = 120;
const PUNCT_GAP_MS = 200;
const LERP = 0.35;

/**
 * Build a map of morph-target name → [{ mesh, index }] for the avatar root.
 * @param {import('three').Object3D} root
 * @returns {{ mode: 'arkit'|'jaw', map: Map<string, {mesh:any,index:number}[]> }|null}
 */
export function buildMorphMap(root) {
	const arkit = new Map();
	const jaw = new Map();
	root?.traverse?.((node) => {
		if (!node.isMesh || !node.morphTargetDictionary || !node.morphTargetInfluences) return;
		const dict = node.morphTargetDictionary;
		for (const name of ARKIT_VISEMES) {
			if (dict[name] === undefined) continue;
			if (!arkit.has(name)) arkit.set(name, []);
			arkit.get(name).push({ mesh: node, index: dict[name] });
		}
		for (const name of JAW_FALLBACKS) {
			if (dict[name] === undefined) continue;
			if (!jaw.has(name)) jaw.set(name, []);
			jaw.get(name).push({ mesh: node, index: dict[name] });
		}
	});
	if (arkit.size) return { mode: 'arkit', map: arkit };
	if (jaw.size) return { mode: 'jaw', map: jaw };
	return null;
}

function tokenize(text) {
	const seq = [];
	const lower = String(text || '').toLowerCase();
	let t = 0;
	for (let i = 0; i < lower.length; ) {
		const pair = i + 1 < lower.length ? lower[i] + lower[i + 1] : '';
		if (DIGRAPH_TO_VISEME[pair]) {
			seq.push({ viseme: DIGRAPH_TO_VISEME[pair], startMs: t, endMs: t + MS_PER_PHONEME * 2 });
			t += MS_PER_PHONEME * 2;
			i += 2;
			continue;
		}
		const ch = lower[i];
		if (CHAR_TO_VISEME[ch]) {
			seq.push({ viseme: CHAR_TO_VISEME[ch], startMs: t, endMs: t + MS_PER_PHONEME });
			t += MS_PER_PHONEME;
		} else if (/\s/.test(ch)) {
			t += WORD_GAP_MS;
		} else if (/[.,!?;:]/.test(ch)) {
			t += PUNCT_GAP_MS;
		}
		i++;
	}
	return seq;
}

/** Rough natural duration of `text` in ms, used to pace the no-morph case. */
export function estimateDurationMs(text) {
	const seq = tokenize(text);
	return seq.length ? seq[seq.length - 1].endMs : 0;
}

/**
 * Start a lipsync timeline. The returned object exposes:
 *   - tick(nowMs): call every frame; advances + lerps morph influences.
 *   - stop():      reset all influences to 0 and mark done.
 *   - done:        true once the sequence has fully played.
 *
 * The caller owns the clock so the timeline can be synced to the speech engine
 * (we start it on utterance `start`, advance on the render loop, stop on `end`).
 *
 * @param {string} text
 * @param {ReturnType<typeof buildMorphMap>|null} morph
 * @param {{ rate?: number }} [opts]  rate>1 speeds the mouth to match faster TTS
 */
export function createLipsync(text, morph, opts = {}) {
	const rate = opts.rate && opts.rate > 0 ? opts.rate : 1;
	const seq = morph ? tokenize(text) : [];
	const totalMs = seq.length ? seq[seq.length - 1].endMs : 0;
	let startMs = -1;
	let done = false;

	// Per-morph smoothed influence so we can lerp toward targets each frame.
	const current = morph ? new Map([...morph.map.keys()].map((k) => [k, 0])) : new Map();

	function apply(name, value) {
		const entries = morph?.map.get(name);
		if (!entries) return;
		for (const { mesh, index } of entries) mesh.morphTargetInfluences[index] = value;
	}

	function tick(nowMs) {
		if (!morph || done) return;
		if (startMs < 0) startMs = nowMs;
		const elapsed = (nowMs - startMs) * rate;

		// Determine the active viseme target for this instant.
		let active = null;
		if (elapsed <= totalMs) {
			for (const ph of seq) {
				if (elapsed >= ph.startMs && elapsed < ph.endMs) { active = ph.viseme; break; }
			}
		}

		// In jaw mode there's no per-viseme shape — any active phoneme opens the
		// jaw on an envelope; silence closes it.
		for (const name of current.keys()) {
			let target = 0;
			if (morph.mode === 'arkit') {
				target = name === active ? 0.92 : 0;
			} else {
				// jaw: open while speaking, with a gentle per-phoneme pulse
				target = active ? 0.45 + 0.25 * Math.abs(Math.sin(elapsed / 70)) : 0;
			}
			const next = current.get(name) + (target - current.get(name)) * LERP;
			current.set(name, next);
			apply(name, next);
		}

		if (elapsed > totalMs + 120) done = true;
	}

	function stop() {
		done = true;
		for (const name of current.keys()) {
			current.set(name, 0);
			apply(name, 0);
		}
	}

	return { tick, stop, get done() { return done; }, get totalMs() { return totalMs; } };
}
