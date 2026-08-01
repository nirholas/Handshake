// /asl-alphabet: the manual alphabet, on a live avatar.
//
// The reference half of the platform's signing work. /sign-language answers
// "what can this do"; this page answers "how do I make an F, and why do I keep
// confusing it with a 9". Every letter is signed on a real rig, described in
// words, paired with the letters it is mistaken for, and drillable.
//
// The 3D + animation stack is the same PoseStage the studio and /sign-language
// use, driven straight from src/fingerspelling.js so the letters here are the
// exact letters an agent signs in chat.

import { PoseStage } from './avatar-pose.js';
import { buildFingerspellingClip, normalizeWord } from './fingerspelling.js';
import { DIGITS, LETTERS, LETTER_NOTES, PRACTICE_WORDS } from './asl-alphabet-data.js';
import { buildRigPicker, loadSignPrefs, resolveRig, saveSignPrefs } from './sign-avatars.js';
import { log } from './shared/log.js';

// The rigs and the stored preferences are shared with /sign-language, including
// a custom avatar: a left-handed signer who set that once, on either page,
// should never set it again.
const SPEEDS = [
	{ label: '0.5×', rate: 0.5 },
	{ label: '0.75×', rate: 0.75 },
	{ label: '1×', rate: 1 },
];

const $ = (sel, root = document) => root.querySelector(sel);
const CHARS = [...LETTERS, ...DIGITS];

/** Scale every spelling duration so the whole word slows without losing shape. */
function scaledTiming(rate) {
	return {
		holdSeconds: 0.5 / rate,
		transitionSeconds: 0.22 / rate,
		motionSeconds: 0.9 / rate,
		leadSeconds: 0.35 / rate,
		tailSeconds: 0.4 / rate,
	};
}

async function boot() {
	const stageHost = $('#aa-stage');
	if (!stageHost) return;

	const prefs = loadSignPrefs();
	let avatar = resolveRig(prefs);
	let rate = SPEEDS.some((s) => s.rate === prefs.rate) ? prefs.rate : 1;
	let dominant = prefs.dominant === 'Left' ? 'Left' : 'Right';

	let stage = null;
	let canSign = false;
	let playToken = 0;
	let highlightTimers = [];
	let current = null;

	const statusEl = $('#aa-status');
	const setStatus = (msg) => {
		if (statusEl) statusEl.textContent = msg || '';
	};

	const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

	// ── Stage ────────────────────────────────────────────────────────────────
	const mountStage = async () => {
		stage?.dispose();
		// Portrait framing crops to the signing space: fingerspelling happens at
		// jaw height, so a full-body shot would waste most of the frame on shoes.
		stage = new PoseStage(stageHost, { glbUrl: avatar.url, framing: 'portrait' });
		try {
			const { supported } = await stage.mount();
			stage.start();
			canSign = !!supported;
			if (!supported) setStatus('This avatar has no finger bones, so it cannot form handshapes. Every description below still applies.');
			return canSign;
		} catch (err) {
			log.warn('[asl-alphabet] stage mount failed', err?.message);
			canSign = false;
			setStatus('Live preview unavailable. Every letter is still described below.');
			return false;
		}
	};
	await mountStage();

	// ── Playing letters and words ────────────────────────────────────────────
	const clearHighlights = () => {
		highlightTimers.forEach((t) => clearTimeout(t));
		highlightTimers = [];
		document.querySelectorAll('.aa-key[data-live="true"]').forEach((el) => el.removeAttribute('data-live'));
	};

	/**
	 * Spell `text` on the avatar and light each key as the hand reaches it.
	 * Marks come from the clip builder itself, so the highlight is the real
	 * cadence rather than an animation guessed alongside it.
	 */
	const play = async (text, { describe = true } = {}) => {
		const letters = normalizeWord(text);
		if (!letters) {
			setStatus('Letters and numbers only: that is all the manual alphabet can spell.');
			return null;
		}
		if (!stage?.anim || !canSign) {
			setStatus('Live preview unavailable. Every letter is still described below.');
			return null;
		}
		const token = ++playToken;
		clearHighlights();
		const marks = [];
		let clip;
		// One letter is a reference pose: it must stay up to be studied, so the
		// hand does not settle back to rest at the end. A whole word does settle,
		// the way a signer lowers their hand when the word is finished.
		const single = letters.replace(/\s+/g, '').length === 1;
		try {
			clip = buildFingerspellingClip(letters, { ...scaledTiming(rate), dominant, marks, settle: !single });
		} catch (err) {
			setStatus(err?.message || 'Could not build that spelling.');
			return null;
		}
		const name = `aa-${token}`;
		stage.anim.injectClip(name, clip, { loop: false });
		// A single letter holds its final frame so it can be studied and orbited;
		// a word hands the avatar back to its idle when the spelling is done.
		stage.anim.playOnce(name, single ? { settleTo: null } : {});

		const startedAt = performance.now();
		for (const mark of marks) {
			if (mark.letter === ' ') continue;
			highlightTimers.push(
				window.setTimeout(() => {
					if (token !== playToken) return;
					clearHighlightsOnly();
					const key = document.querySelector(`.aa-key[data-char="${mark.letter}"]`);
					key?.setAttribute('data-live', 'true');
					if (describe) showLetter(mark.letter, { quiet: true });
				}, Math.max(0, mark.start * 1000 - (performance.now() - startedAt))),
			);
		}
		highlightTimers.push(
			window.setTimeout(() => {
				if (token === playToken) clearHighlightsOnly();
			}, clip.duration * 1000),
		);
		return { clip, letters };
	};

	const clearHighlightsOnly = () => {
		document.querySelectorAll('.aa-key[data-live="true"]').forEach((el) => el.removeAttribute('data-live'));
	};

	// ── The letter detail card ───────────────────────────────────────────────
	const bigEl = $('#aa-big');
	const handEl = $('#aa-hand');
	const lookEl = $('#aa-look');
	const motionEl = $('#aa-motion');
	const shareBtn = $('#aa-share');

	const markSelected = (char) => {
		document.querySelectorAll('.aa-key').forEach((el) => {
			el.setAttribute('aria-pressed', String(el.dataset.char === char));
		});
	};

	function showLetter(char, { quiet = false } = {}) {
		const note = LETTER_NOTES[char];
		if (!note) return;
		current = char;
		if (bigEl) bigEl.textContent = char;
		if (handEl) handEl.textContent = note.hand;
		if (lookEl) lookEl.textContent = note.look || '';
		if (motionEl) motionEl.hidden = !note.motion;
		markSelected(char);
		if (shareBtn) shareBtn.hidden = false;
		if (!quiet) setStatus(`${char}: ${note.hand}`);
	}

	const signLetter = async (char) => {
		showLetter(char);
		await play(char, { describe: false });
	};

	// ── The keyboard of letters ──────────────────────────────────────────────
	const buildKeys = (hostSel, chars) => {
		const host = $(hostSel);
		if (!host) return;
		for (const char of chars) {
			const key = document.createElement('button');
			key.type = 'button';
			key.className = 'aa-key';
			key.dataset.char = char;
			key.textContent = char;
			key.setAttribute('aria-pressed', 'false');
			key.setAttribute('aria-label', `Sign the letter ${char}`);
			key.title = LETTER_NOTES[char]?.hand || '';
			key.addEventListener('click', () => signLetter(char));
			host.appendChild(key);
		}
	};
	buildKeys('#aa-letters', LETTERS);
	buildKeys('#aa-digits', DIGITS);

	// Typing a letter signs it: the fastest possible path from "what is a Q"
	// to seeing a Q, with no pointer involved.
	document.addEventListener('keydown', (e) => {
		const typing = /^(input|textarea)$/i.test(e.target?.tagName || '');
		if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
		const char = e.key.toUpperCase();
		if (!CHARS.includes(char)) return;
		e.preventDefault();
		signLetter(char);
	});

	// ── Spell a word ─────────────────────────────────────────────────────────
	const spellInput = $('#aa-spell-input');
	const spellBtn = $('#aa-spell-btn');
	const spellIt = async () => {
		const raw = spellInput?.value?.trim();
		if (!raw) {
			setStatus('Type a word and the avatar spells it, letter by letter.');
			spellInput?.focus();
			return;
		}
		const normalized = normalizeWord(raw);
		setStatus(`Spelling ${normalized.toLowerCase()}`);
		if (shareBtn) {
			shareBtn.hidden = false;
			shareBtn.dataset.share = `${location.origin}/asl-alphabet?spell=${encodeURIComponent(normalized)}`;
		}
		await play(raw);
	};
	spellBtn?.addEventListener('click', spellIt);
	spellInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			spellIt();
		}
	});

	shareBtn?.addEventListener('click', async () => {
		const url = shareBtn.dataset.share || `${location.origin}/asl-alphabet?letter=${encodeURIComponent(current || 'A')}`;
		try {
			await navigator.clipboard.writeText(url);
			shareBtn.textContent = '🔗 Link copied';
			setTimeout(() => {
				shareBtn.textContent = '🔗 Share this';
			}, 1600);
		} catch {
			setStatus(url);
		}
	});

	// ── Practice ─────────────────────────────────────────────────────────────
	// A drill, not a game: the avatar spells something, you write what you read,
	// and the answer is checked against what was actually signed.
	const practice = {
		answer: '',
		streak: 0,
		best: Number(loadSignPrefs().aslBest || 0),
		active: false,
	};
	const practiceEl = $('#aa-practice');
	const practiceInput = $('#aa-practice-input');
	const practiceFeedback = $('#aa-practice-feedback');
	const streakEl = $('#aa-streak');
	const bestEl = $('#aa-best');
	const startBtn = $('#aa-practice-start');
	const replayBtn = $('#aa-practice-replay');
	const revealBtn = $('#aa-practice-reveal');
	const modeInputs = document.querySelectorAll('input[name="aa-mode"]');

	const renderScore = () => {
		if (streakEl) streakEl.textContent = String(practice.streak);
		if (bestEl) bestEl.textContent = String(practice.best);
	};
	renderScore();

	const currentMode = () => [...modeInputs].find((i) => i.checked)?.value || 'letters';

	const nextRound = async () => {
		if (!canSign) {
			setStatus('Practice needs the live avatar, which could not load here.');
			return;
		}
		practice.active = true;
		practice.answer =
			currentMode() === 'words'
				? PRACTICE_WORDS[Math.floor(Math.random() * PRACTICE_WORDS.length)]
				: CHARS[Math.floor(Math.random() * CHARS.length)];
		if (practiceFeedback) {
			practiceFeedback.textContent = 'Watch, then type what it spelled.';
			practiceFeedback.dataset.state = 'asking';
		}
		if (practiceInput) {
			practiceInput.value = '';
			practiceInput.disabled = false;
			practiceInput.focus();
		}
		if (replayBtn) replayBtn.hidden = false;
		if (revealBtn) revealBtn.hidden = false;
		if (startBtn) startBtn.textContent = 'Skip to the next one';
		// The whole point is to read it, so the keys must not give it away.
		await play(practice.answer, { describe: false });
	};

	const checkAnswer = () => {
		if (!practice.active) return;
		const guess = normalizeWord(practiceInput?.value || '').replace(/\s+/g, '');
		if (!guess) return;
		const right = guess === practice.answer;
		practice.streak = right ? practice.streak + 1 : 0;
		if (practice.streak > practice.best) {
			practice.best = practice.streak;
			saveSignPrefs({ aslBest: practice.best });
		}
		renderScore();
		if (practiceFeedback) {
			practiceFeedback.textContent = right
				? `Correct: ${practice.answer}. Next one is coming.`
				: `That was ${practice.answer}, not ${guess}. Watch it again.`;
			practiceFeedback.dataset.state = right ? 'right' : 'wrong';
		}
		practice.active = false;
		if (right) setTimeout(nextRound, 1200);
	};

	startBtn?.addEventListener('click', nextRound);
	replayBtn?.addEventListener('click', () => play(practice.answer, { describe: false }));
	revealBtn?.addEventListener('click', () => {
		if (practiceFeedback) {
			practiceFeedback.textContent = `It spelled ${practice.answer}.`;
			practiceFeedback.dataset.state = 'shown';
		}
		practice.active = false;
	});
	practiceInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			checkAnswer();
		}
	});
	$('#aa-practice-check')?.addEventListener('click', checkAnswer);
	if (practiceEl && !canSign) practiceEl.dataset.disabled = 'true';

	// ── Settings ─────────────────────────────────────────────────────────────
	const buildOptions = (hostSel, options, pressed, onPick) => {
		const host = $(hostSel);
		if (!host) return;
		for (const option of options) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'aa-opt';
			btn.textContent = option.label;
			btn.setAttribute('aria-pressed', String(pressed(option)));
			btn.addEventListener('click', () => {
				host.querySelectorAll('.aa-opt').forEach((b) => b.setAttribute('aria-pressed', 'false'));
				btn.setAttribute('aria-pressed', 'true');
				onPick(option);
			});
			host.appendChild(btn);
		}
	};

	const persist = () => saveSignPrefs({ rate, dominant, avatar: avatar.id });

	buildOptions('#aa-speed', SPEEDS, (s) => s.rate === rate, (s) => {
		rate = s.rate;
		persist();
		if (current) play(current, { describe: false });
	});
	buildOptions(
		'#aa-hand-opts',
		[
			{ label: 'Right-handed', side: 'Right' },
			{ label: 'Left-handed', side: 'Left' },
		],
		(o) => o.side === dominant,
		(o) => {
			dominant = o.side;
			persist();
			if (current) play(current, { describe: false });
		},
	);
	// Any avatar on three.ws can form the letters, not only the two rigs that
	// ship with the platform: the handshapes are solved against whatever
	// skeleton is attached, so they land on your own avatar's fingers.
	buildRigPicker({
		host: '#aa-rig',
		optionClass: 'aa-opt',
		active: avatar,
		onStatus: setStatus,
		apply: async (picked) => {
			const previous = avatar;
			avatar = picked;
			persist();
			setStatus('Loading avatar…');
			if (await mountStage()) {
				if (current) play(current, { describe: false });
				else if (picked.custom) setStatus(`${picked.label} is forming the letters now.`);
				return true;
			}
			// No finger bones means no handshapes, and a hand that cannot move is
			// worse than the rig the visitor already had. Put that one back.
			avatar = previous;
			persist();
			const restored = await mountStage();
			setStatus(`${picked.label} has no finger bones, so it cannot form handshapes. ${previous.label} is back on stage.`);
			if (restored && current) play(current, { describe: false });
			return false;
		},
	});

	// ── Deep links ───────────────────────────────────────────────────────────
	// The stage crossfades to its idle clip asynchronously after mounting, so a
	// letter played the instant boot finishes is overwritten the moment that
	// idle lands: the shared link opened on an avatar standing at rest. Wait for
	// the idle to take before honoring the link.
	const waitForIdleClip = async () => {
		for (let i = 0; i < 60; i++) {
			if (!stage?.anim || stage.anim.currentName) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	if (canSign) await waitForIdleClip();

	const params = new URLSearchParams(location.search);
	const wanted = (params.get('letter') || '').toUpperCase().slice(0, 1);
	const wantedWord = params.get('spell') || '';
	if (wantedWord && normalizeWord(wantedWord)) {
		if (spellInput) spellInput.value = wantedWord.slice(0, 24);
		if (!reducedMotion) spellIt();
		else setStatus(`Ready to spell ${normalizeWord(wantedWord).toLowerCase()}. Press Spell it.`);
	} else if (CHARS.includes(wanted)) {
		showLetter(wanted);
		if (!reducedMotion) signLetter(wanted);
	} else {
		showLetter('A');
		if (!reducedMotion && canSign) signLetter('A');
		else setStatus('Pick a letter, or press any letter key.');
	}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
