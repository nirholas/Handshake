// /sign-language: the dedicated home for three.ws's signing avatars.
//
// A live avatar that signs on arrival, an input that spells or signs anything
// you type, a webcam demo that transcribes your own fingerspelling, and a plain
// explanation of what works today. This is the front door for the feature that
// otherwise lives inside the Animation Studio panel and the chat toggles.
//
// The 3D + animation stack is the same PoseStage the studio uses; SignSpeaker
// (src/sign-speech.js) drives it exactly like a text-to-speech engine.

import { PoseStage } from './avatar-pose.js';
import { CHAT_TIMING, SignSpeaker } from './sign-speech.js';
import { normalizeWord } from './fingerspelling.js';
import { SIGNS, signGloss, signLookup } from './sign-dictionary.js';
import { log } from './shared/log.js';

// Two hero rigs, because signing has two halves and no one avatar shows both
// best. The classic rig is light enough to animate smoothly everywhere,
// including on software renderers, but carries no face blendshapes. The
// expressive rig ships the full ARKit shape set, so the non-manual markers a
// signed question needs (raised brows, furrowed brows, a headshake's set jaw)
// are actually visible on it. See docs/sign-language.md.
const AVATARS = [
	{ id: 'classic', label: 'Classic', url: '/avatars/cz.glb' },
	{ id: 'expressive', label: 'Expressive face', url: '/avatars/default.glb' },
];

// Speed, hand, and rig survive a reload: a left-handed signer should not have
// to re-declare themselves on every visit.
const PREFS_KEY = 'threews:sign-prefs';
function loadPrefs() {
	try {
		return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
	} catch {
		return {};
	}
}
function savePrefs(prefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
	} catch {
		/* private mode: settings just don't persist */
	}
}

// Signing speed. Learners and many Deaf viewers want it slower, and signing is
// content, so it cannot simply be reduced away like decorative motion.
const SPEEDS = [
	{ label: '0.5×', rate: 0.5 },
	{ label: '0.75×', rate: 0.75 },
	{ label: '1×', rate: 1 },
];

// Phrases the hero cycles through so a first-time visitor immediately sees the
// avatar signing real content, not a static pose. Each mixes lexical signs with
// fingerspelling, which is what the feature actually does.
const DEMO_PHRASES = ['HELLO', 'HAPPY TO MEET YOU', 'WELCOME TO THREE WS', 'THANK YOU YALL'];

const $ = (sel, root = document) => root.querySelector(sel);

/** Stretch every duration in the chat timing so the whole utterance slows. */
function scaleTiming(rate) {
	const out = {};
	for (const [key, value] of Object.entries(CHAT_TIMING)) out[key] = value / rate;
	return out;
}

async function boot() {
	const stageHost = $('#sl-stage');
	if (!stageHost) return;

	const prefs = loadPrefs();
	let avatar = AVATARS.find((a) => a.id === prefs.avatar) || AVATARS[0];
	let stage = null;
	let speaker = null;
	let heroTimer = 0;
	let heroIndex = 0;
	let heroActive = true;

	const status = $('#sl-status');
	const setStatus = (msg) => {
		if (status) status.textContent = msg || '';
	};

	// Speed and dominant hand are baked into the compiled clips, so changing
	// either rebuilds the speaker (cheap: the vocabulary is compiled lazily and
	// cached per setting).
	let rate = SPEEDS.some((s) => s.rate === prefs.rate) ? prefs.rate : 1;
	let dominant = prefs.dominant === 'Left' ? 'Left' : 'Right';
	/** The last thing signed, so a settings change can show itself immediately. */
	let lastPhrase = null;
	const rebuildSpeaker = () => {
		if (!stage?.anim) return;
		speaker?.cancel();
		speaker = new SignSpeaker({
			manager: stage.anim,
			dominant,
			signs: signLookup({ dominant, rate }),
			timing: rate === 1 ? null : scaleTiming(rate),
		});
	};
	const replay = async () => {
		if (!speaker || !lastPhrase) return;
		try {
			const result = await speaker.speak(lastPhrase);
			if (!result.superseded) setStatus(describeResult(result));
		} catch {
			/* a superseded replay is not an error worth surfacing */
		}
	};
	const applySetting = (fn) => {
		fn();
		savePrefs({ rate, dominant, avatar: avatar.id });
		rebuildSpeaker();
		replay();
	};
	const setRate = (value) => applySetting(() => { rate = value; });
	const setDominant = (value) => applySetting(() => { dominant = value; });

	// Tell the visitor which words were SIGNED and which were spelled: the
	// distinction is the whole point of having a dictionary.
	const describeResult = ({ signed, spelled }) => {
		const parts = [];
		if (signed?.length) parts.push(`signed ${signed.map((w) => w.toLowerCase()).join(', ')}`);
		if (spelled?.length) parts.push(`spelled ${spelled.map((w) => w.toLowerCase()).join(', ')}`);
		return parts.length ? parts.join(' · ') : 'Type anything and watch the avatar sign it.';
	};

	/** Mount (or remount) the hero on the current rig. Returns whether it signs. */
	const mountStage = async () => {
		clearTimeout(heroTimer);
		speaker?.cancel();
		speaker = null;
		stage?.dispose();
		// Full-body framing: the whole avatar stays in frame, and the orbit
		// controls let anyone zoom into the signing space when they want detail.
		stage = new PoseStage(stageHost, { glbUrl: avatar.url });
		try {
			const { supported } = await stage.mount();
			stage.start();
			if (!supported) {
				setStatus('This avatar can’t sign, but the tools below still work.');
				return false;
			}
			rebuildSpeaker();
			return true;
		} catch (err) {
			log.warn('[sign-language] stage mount failed', err?.message);
			setStatus('Live preview unavailable: the spelling tools below still work.');
			return false;
		}
	};
	await mountStage();

	// ── Hero auto-signing loop ────────────────────────────────────────────────
	// Signing is content, so it is never disabled: but auto-PLAYING on arrival
	// is motion the visitor did not ask for. Under prefers-reduced-motion the
	// hero waits for an explicit action (typing, a chip, a vocab word) instead
	// of looping on its own.
	const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
	async function heroTick() {
		if (!heroActive || !speaker) return;
		const phrase = DEMO_PHRASES[heroIndex % DEMO_PHRASES.length];
		heroIndex++;
		setStatus(`Signing: “${phrase.toLowerCase()}”`);
		try {
			const { clip } = await speaker.speak(phrase);
			heroTimer = window.setTimeout(heroTick, clip.duration * 1000 + 1400);
		} catch {
			heroTimer = window.setTimeout(heroTick, 3000);
		}
	}
	const stopHero = () => {
		heroActive = false;
		clearTimeout(heroTimer);
		speaker?.cancel();
	};
	if (speaker && !reducedMotion) heroTick();
	else if (speaker) setStatus('Type anything and watch the avatar sign it.');

	// ── Spell-anything input ──────────────────────────────────────────────────
	const spellInput = $('#sl-spell-input');
	const spellBtn = $('#sl-spell-btn');

	const spellIt = async () => {
		if (!speaker) return;
		const raw = spellInput.value.trim();
		const norm = normalizeWord(raw);
		if (!norm) {
			setStatus('Type letters or numbers to sign.');
			return;
		}
		stopHero();
		heroActive = false;
		lastPhrase = raw;
		setStatus(`Signing: “${norm.toLowerCase()}”`);
		try {
			const result = await speaker.speak(raw);
			if (!result.superseded) setStatus(describeResult(result));
		} catch (e) {
			setStatus(e?.message || 'Could not sign that.');
		}
	};
	spellBtn?.addEventListener('click', spellIt);
	spellInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			spellIt();
		}
	});
	// Quick-phrase chips.
	document.querySelectorAll('[data-sl-phrase]').forEach((chip) => {
		chip.addEventListener('click', () => {
			if (spellInput) spellInput.value = chip.dataset.slPhrase;
			spellIt();
		});
	});

	// ── Signing speed, dominant hand, and hero rig ────────────────────────────
	/** A pill group: one button per option, exactly one pressed at a time. */
	const buildOptions = (hostSel, options, pressed, onPick) => {
		const host = $(hostSel);
		if (!host) return;
		options.forEach((option) => {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'sl-opt';
			btn.textContent = option.label;
			btn.setAttribute('aria-pressed', String(pressed(option)));
			btn.addEventListener('click', () => {
				host.querySelectorAll('.sl-opt').forEach((b) => b.setAttribute('aria-pressed', 'false'));
				btn.setAttribute('aria-pressed', 'true');
				onPick(option);
			});
			host.appendChild(btn);
		});
	};

	buildOptions('#sl-speed', SPEEDS, (s) => s.rate === rate, (s) => setRate(s.rate));
	buildOptions(
		'#sl-hand',
		[
			{ label: 'Right-handed', side: 'Right' },
			{ label: 'Left-handed', side: 'Left' },
		],
		(o) => o.side === dominant,
		(o) => setDominant(o.side),
	);
	// Switching rigs replaces the whole stage: the clips are rig-independent
	// (they retarget on attach), so the speaker just rebuilds against the new
	// skeleton and whatever was signing resumes on the new avatar.
	let switchingRig = false;
	buildOptions('#sl-rig', AVATARS, (a) => a.id === avatar.id, async (picked) => {
		if (switchingRig || picked.id === avatar.id) return;
		switchingRig = true;
		avatar = picked;
		savePrefs({ rate, dominant, avatar: avatar.id });
		setStatus('Loading avatar…');
		const ok = await mountStage();
		switchingRig = false;
		if (!ok) return;
		if (picked.id === 'expressive') {
			setStatus('This avatar has a face: questions raise the brows, negation furrows them.');
		}
		if (heroActive && !reducedMotion) heroTick();
		else replay();
	});

	// ── Vocabulary: every word with a real sign, playable ─────────────────────
	const vocabHost = $('#sl-vocab-chips');
	if (vocabHost) {
		const words = Object.keys(SIGNS).sort();
		let active = null;
		for (const word of words) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'sl-vocab-chip';
			chip.setAttribute('role', 'listitem');
			chip.setAttribute('aria-pressed', 'false');
			chip.textContent = word.toLowerCase();
			const gloss = signGloss(word);
			if (gloss) chip.title = gloss;
			chip.addEventListener('click', async () => {
				if (!speaker) return;
				stopHero();
				heroActive = false;
				active?.setAttribute('aria-pressed', 'false');
				active = chip;
				chip.setAttribute('aria-pressed', 'true');
				lastPhrase = word;
				setStatus(gloss ? `${word.toLowerCase()}: ${gloss}` : `Signing “${word.toLowerCase()}”`);
				try {
					const result = await speaker.speak(word);
					if (!result.superseded) chip.setAttribute('aria-pressed', 'false');
				} catch {
					chip.setAttribute('aria-pressed', 'false');
					setStatus('Could not sign that.');
				}
			});
			vocabHost.appendChild(chip);
		}
	}

	// ── Webcam sign-in demo ───────────────────────────────────────────────────
	wireWebcamDemo(setStatus);

	// ── ?say= deep link ───────────────────────────────────────────────────────
	// A shareable signing link, mirroring the studio's ?spell=: /sign-language
	// ?say=hello+world signs the phrase on arrival (dictionary + spelling).
	const say = new URLSearchParams(location.search).get('say');
	if (say && speaker && normalizeWord(say)) {
		stopHero();
		heroActive = false;
		if (spellInput) spellInput.value = say.slice(0, 48);
		lastPhrase = say;
		speaker
			.speak(say)
			.then((result) => {
				if (!result.superseded) setStatus(describeResult(result));
			})
			.catch((e) => setStatus(e?.message || 'Could not sign that.'));
	}
}

function wireWebcamDemo(setStatus) {
	const btn = $('#sl-cam-btn');
	const previewWrap = $('#sl-cam-preview');
	const resultEl = $('#sl-cam-result');
	if (!btn) return;

	let input = null;
	let active = false;

	btn.addEventListener('click', async () => {
		if (active) {
			btn.disabled = true;
			btn.textContent = 'Reading…';
			try {
				const { text, confidence } = await input.stop();
				if (text) {
					resultEl.textContent = text;
					resultEl.dataset.state = confidence != null && confidence < 0.4 ? 'low' : 'ok';
				} else {
					resultEl.textContent = 'No fingerspelling read: try again, a little slower.';
					resultEl.dataset.state = 'low';
				}
			} catch (e) {
				resultEl.textContent = e?.message || 'Transcription failed.';
				resultEl.dataset.state = 'low';
			}
			active = false;
			btn.disabled = false;
			btn.textContent = '🎥 Start signing';
			btn.classList.remove('is-live');
			previewWrap.hidden = true;
			previewWrap.innerHTML = '';
			return;
		}
		try {
			if (!input) {
				const { SignInput } = await import('./sign-input.js');
				input = new SignInput({
					onState: (s, d) => {
						if (s === 'capturing') setStatus(`Reading your signing… ${d?.frames ?? 0} frames`);
						else if (s === 'transcribing') setStatus('Transcribing…');
						else setStatus('');
					},
				});
			}
			await input.start();
			previewWrap.innerHTML = '';
			const v = input.videoElement;
			v.className = 'sl-cam-video';
			previewWrap.appendChild(v);
			previewWrap.hidden = false;
			active = true;
			btn.textContent = '⏹ Stop & read';
			btn.classList.add('is-live');
			resultEl.textContent = '';
			resultEl.removeAttribute('data-state');
		} catch (e) {
			resultEl.textContent = e?.message || 'Camera unavailable: check browser permissions.';
			resultEl.dataset.state = 'low';
			input?.cancel();
		}
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot);
} else {
	boot();
}
