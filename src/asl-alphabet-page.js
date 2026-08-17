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

	// A shared link names the letter the visitor came for, so it is read before
	// anything is built. Seeding the card from it is the difference between a
	// /asl-alphabet?letter=W link showing W's description immediately and showing
	// A's description for the whole length of the rig download.
	const params = new URLSearchParams(location.search);
	const linkedLetter = (params.get('letter') || '').toUpperCase().slice(0, 1);
	const rawWord = (params.get('spell') || '').slice(0, 24);
	const linkedWord = normalizeWord(rawWord) ? rawWord : '';
	const linkedFirst = normalizeWord(linkedWord).replace(/\s+/g, '').slice(0, 1);

	const prefs = loadSignPrefs();
	let avatar = resolveRig(prefs);
	let rate = SPEEDS.some((s) => s.rate === prefs.rate) ? prefs.rate : 1;
	let dominant = prefs.dominant === 'Left' ? 'Left' : 'Right';

	let stage = null;
	let canSign = false;
	// The rig is fetched after the page is interactive, so a key pressed during
	// the download is answered with "still loading" rather than "unavailable".
	let stageState = 'loading';
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
		stage = new PoseStage(stageHost, {
			glbUrl: avatar.url,
			framing: 'portrait',
			label: 'A 3D avatar forming the selected letter of the American manual alphabet',
		});
		try {
			const { supported } = await stage.mount();
			stage.start();
			canSign = !!supported;
			stageState = canSign ? 'ready' : 'unavailable';
			if (!supported) setStatus('This avatar has no finger bones, so it cannot form handshapes. Every description below still applies.');
		} catch (err) {
			log.warn('[asl-alphabet] stage mount failed', err?.message);
			canSign = false;
			stageState = 'unavailable';
			setStatus('The avatar could not load. Reload the page to try again: every letter is still described in words below.');
		}
		// Every path through the mount decides whether the drill can run, including
		// the remounts a rig switch triggers, so the panel is settled in one place.
		applyPracticeAvailability();
		return canSign;
	};

	// Why the avatar cannot sign right now, phrased for whichever panel is asking.
	// Both the stage status and the spell panel need it, and a visitor scrolled
	// down to the spell box never sees a message left on the stage.
	const stageProblem = () =>
		stageState === 'loading'
			? 'The avatar is still loading: the description is ready now, the handshape follows.'
			: 'The avatar could not load. Reload the page to try again: every letter is still described in words.';

	// ── Playing letters and words ────────────────────────────────────────────
	const clearHighlights = () => {
		highlightTimers.forEach((t) => clearTimeout(t));
		highlightTimers = [];
		clearHighlightsOnly();
	};

	/**
	 * Spell `text` on the avatar and light each key as the hand reaches it.
	 * Marks come from the clip builder itself, so the highlight is the real
	 * cadence rather than an animation guessed alongside it.
	 */
	const play = async (text, { describe = true, trail = false } = {}) => {
		const letters = normalizeWord(text);
		if (!letters) {
			setStatus('Letters and numbers only: that is all the manual alphabet can spell.');
			return null;
		}
		if (!stage?.anim || !canSign) {
			setStatus(stageProblem());
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

		// The trail is built from `marks` rather than from the word, so its cells
		// line up with the clip one-for-one even when a letter repeats.
		const trailCells = trail ? renderTrail(marks) : [];

		const startedAt = performance.now();
		marks.forEach((mark, i) => {
			if (mark.letter === ' ') return;
			highlightTimers.push(
				window.setTimeout(() => {
					if (token !== playToken) return;
					clearHighlightsOnly();
					const key = document.querySelector(`.aa-key[data-char="${mark.letter}"]`);
					key?.setAttribute('data-live', 'true');
					trailCells[i]?.setAttribute('data-live', 'true');
					// The card follows the spelling, but the share link keeps
					// pointing at the whole word rather than whichever letter
					// the hand happened to be on when Share was clicked.
					if (describe) showLetter(mark.letter, { quiet: true, share: false });
				}, Math.max(0, mark.start * 1000 - (performance.now() - startedAt))),
			);
		});
		highlightTimers.push(
			window.setTimeout(() => {
				if (token === playToken) clearHighlightsOnly();
			}, clip.duration * 1000),
		);
		return { clip, letters };
	};

	const clearHighlightsOnly = () => {
		document.querySelectorAll('.aa-key[data-live="true"]').forEach((el) => el.removeAttribute('data-live'));
		document.querySelectorAll('.aa-trail-ch[data-live="true"]').forEach((el) => el.removeAttribute('data-live'));
	};

	// ── The letter detail card ───────────────────────────────────────────────
	const bigEl = $('#aa-big');
	const handEl = $('#aa-hand');
	const lookEl = $('#aa-look');
	const motionEl = $('#aa-motion');
	const shareBtn = $('#aa-share');
	// What Share hands out: whatever the visitor last asked for, a letter or a
	// spelled word. Derived at click time so it can never lag the card.
	let shareTarget = { param: 'letter', value: 'A' };
	let userPicked = null;

	const markSelected = (char) => {
		document.querySelectorAll('.aa-key').forEach((el) => {
			el.setAttribute('aria-pressed', String(el.dataset.char === char));
		});
	};

	function showLetter(char, { quiet = false, share = true } = {}) {
		const note = LETTER_NOTES[char];
		if (!note) return;
		current = char;
		if (bigEl) bigEl.textContent = char;
		if (handEl) handEl.textContent = note.hand;
		if (lookEl) lookEl.textContent = note.look || '';
		if (motionEl) motionEl.hidden = !note.motion;
		markSelected(char);
		if (share) shareTarget = { param: 'letter', value: char };
		if (shareBtn) shareBtn.hidden = false;
		if (!quiet) setStatus(`${char}: ${note.hand}`);
	}

	const signLetter = async (char) => {
		userPicked = char;
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
	// Populate the card before the rig is fetched: the look-alike note, the
	// pressed key and the share link are all readable while the GLB downloads.
	// A deep link decides which letter that is, so a link never opens on the
	// wrong description and corrects itself minutes later on a slow connection.
	const seeded = [linkedLetter, linkedFirst].find((c) => CHARS.includes(c)) || 'A';
	showLetter(seeded, { quiet: true });

	// Typing a letter signs it: the fastest possible path from "what is a Q"
	// to seeing a Q, with no pointer involved.
	document.addEventListener('keydown', (e) => {
		const typing = /^(input|textarea|select)$/i.test(e.target?.tagName || '') || e.target?.isContentEditable;
		// An open modal (the avatar picker) owns the keyboard. Signing behind it
		// both swallows the dialog's own key handling and animates a letter the
		// visitor cannot see.
		const modal = document.querySelector('[aria-modal="true"], dialog[open]');
		if (typing || modal || e.metaKey || e.ctrlKey || e.altKey) return;
		const char = e.key.toUpperCase();
		if (!CHARS.includes(char)) return;
		e.preventDefault();
		signLetter(char);
	});

	// ── Spell a word ─────────────────────────────────────────────────────────
	// The panel answers in its own line rather than only on the stage overlay.
	// The overlay sits beside the avatar, a viewport above this box on a phone,
	// so a rejected word used to change nothing the visitor could see.
	const spellInput = $('#aa-spell-input');
	const spellBtn = $('#aa-spell-btn');
	const spellFeedback = $('#aa-spell-feedback');

	const saySpell = (text, state) => {
		if (!spellFeedback) return;
		spellFeedback.textContent = text;
		spellFeedback.dataset.state = state;
	};

	/** Lay the spelling out as cells and hand them back in clip order. */
	function renderTrail(marks) {
		if (!spellFeedback) return [];
		spellFeedback.textContent = '';
		spellFeedback.dataset.state = 'shown';
		const row = document.createElement('span');
		row.className = 'aa-trail';
		const cells = marks.map((mark) => {
			const cell = document.createElement('span');
			cell.className = 'aa-trail-ch';
			const space = mark.letter === ' ';
			cell.textContent = space ? ' ' : mark.letter;
			if (space) cell.setAttribute('data-space', 'true');
			row.appendChild(cell);
			return cell;
		});
		spellFeedback.appendChild(row);
		return cells;
	}

	const spellIt = async () => {
		const raw = spellInput?.value?.trim();
		if (!raw) {
			saySpell('Type a word first: a name, a city, anything with no sign of its own.', 'wrong');
			spellInput?.focus();
			return;
		}
		const normalized = normalizeWord(raw);
		if (!normalized) {
			saySpell('Letters and numbers only: that is all the manual alphabet can spell.', 'wrong');
			spellInput?.focus();
			return;
		}
		setStatus(`Spelling ${normalized.toLowerCase()}`);
		shareTarget = { param: 'spell', value: normalized };
		if (shareBtn) shareBtn.hidden = false;
		if (!(await play(normalized, { trail: true }))) saySpell(stageProblem(), 'wrong');
	};
	spellBtn?.addEventListener('click', spellIt);
	spellInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			spellIt();
		}
	});
	// A shared spelling arrives in the box straight away, so the link reads as
	// itself while the rig is still downloading.
	if (linkedWord) {
		if (spellInput) spellInput.value = linkedWord;
		shareTarget = { param: 'spell', value: normalizeWord(linkedWord) };
	}

	shareBtn?.addEventListener('click', async () => {
		const { param, value } = shareTarget;
		const url = `${location.origin}/asl-alphabet?${param}=${encodeURIComponent(value)}`;
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

	// The drill speaks in one place, and the start button's label names the phase
	// the drill is actually in, so the feedback line can point at it by name.
	const say = (text, state) => {
		if (!practiceFeedback) return;
		practiceFeedback.textContent = text;
		practiceFeedback.dataset.state = state;
	};

	const setStartLabel = () => {
		if (!startBtn) return;
		startBtn.textContent = !practice.answer ? 'Start practising' : practice.active ? 'Skip to the next one' : 'Next one';
	};

	const currentMode = () => [...modeInputs].find((i) => i.checked)?.value || 'letters';

	const nextRound = async () => {
		if (!canSign) {
			const msg =
				stageState === 'loading'
					? 'The avatar is still loading: the drill starts as soon as it is on stage.'
					: 'This drill needs the live avatar, which could not load. Reload the page to try again.';
			setStatus(msg);
			say(msg, 'shown');
			return;
		}
		practice.active = true;
		practice.answer =
			currentMode() === 'words'
				? PRACTICE_WORDS[Math.floor(Math.random() * PRACTICE_WORDS.length)]
				: CHARS[Math.floor(Math.random() * CHARS.length)];
		say('Watch, then type what it spelled.', 'asking');
		if (practiceInput) {
			practiceInput.value = '';
			practiceInput.disabled = false;
			practiceInput.focus();
		}
		if (replayBtn) replayBtn.hidden = false;
		if (revealBtn) revealBtn.hidden = false;
		setStartLabel();
		// The whole point is to read it, so the keys must not give it away.
		await play(practice.answer, { describe: false });
	};

	// Check is live from first paint, so it answers every press: with no round to
	// grade it says how to start one, with an empty box it says what to put there.
	// A press that changes nothing on screen reads as a broken button.
	const checkAnswer = () => {
		if (!practice.active) {
			say(
				practice.answer
					? 'That round is finished. Press "Next one" to keep reading.'
					: 'Press start and the avatar will spell something to read.',
				'shown',
			);
			return;
		}
		const guess = normalizeWord(practiceInput?.value || '').replace(/\s+/g, '');
		if (!guess) {
			say('Type what you read, then press Check. "Show it again" replays it.', 'asking');
			practiceInput?.focus();
			return;
		}
		const right = guess === practice.answer;
		practice.streak = right ? practice.streak + 1 : 0;
		if (practice.streak > practice.best) {
			practice.best = practice.streak;
			saveSignPrefs({ aslBest: practice.best });
		}
		renderScore();
		say(
			right
				? `Correct: ${practice.answer}. Next one is coming.`
				: `That was ${practice.answer}, not ${guess}. Show it again to see the shape, then take the next one.`,
			right ? 'right' : 'wrong',
		);
		practice.active = false;
		setStartLabel();
		if (right) setTimeout(nextRound, 1200);
	};

	startBtn?.addEventListener('click', nextRound);
	replayBtn?.addEventListener('click', () => play(practice.answer, { describe: false }));
	revealBtn?.addEventListener('click', () => {
		say(`It spelled ${practice.answer}.`, 'shown');
		practice.active = false;
		setStartLabel();
	});
	practiceInput?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			checkAnswer();
		}
	});
	const checkBtn = $('#aa-practice-check');
	checkBtn?.addEventListener('click', checkAnswer);

	// Reading what the avatar spells is the whole drill, so it needs the avatar.
	// When the rig cannot sign, the panel says so in its own feedback line and
	// stops offering controls that can only answer in a status bar elsewhere on
	// the page. The explanation itself stays at full contrast.
	const applyPracticeAvailability = () => {
		if (!practiceEl) return;
		practiceEl.dataset.disabled = String(!canSign);
		for (const el of [startBtn, replayBtn, revealBtn, checkBtn, practiceInput, ...modeInputs]) {
			if (el) el.disabled = !canSign;
		}
		if (!canSign) say('This drill needs the live avatar, which could not load. Reload the page to try again.', 'shown');
	};

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
				// Say the swap landed. Replaying the letter is silent, so without
				// this the stage sat under "Loading avatar…" for the rest of the
				// visit, and a screen reader was never told the load had finished.
				setStatus(`${picked.label} is forming the letters now.`);
				if (current) play(current, { describe: false });
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

	// ── The avatar ───────────────────────────────────────────────────────────
	// Mounted LAST, on purpose. The keys, the descriptions, the look-alike notes
	// and the drill are all built above, before a byte of the rig is fetched, so
	// a visitor on a slow connection is reading and clicking the alphabet while
	// the GLB downloads instead of waiting at an empty box.
	setStatus('Loading the avatar…');
	await mountStage();

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

	// The card was seeded from these at build time; what is left is the playback,
	// which is the only part that had to wait for a rig.
	if (linkedWord) {
		if (!reducedMotion) spellIt();
		else setStatus(`Ready to spell ${normalizeWord(linkedWord).toLowerCase()}. Press Spell it.`);
	} else if (CHARS.includes(linkedLetter)) {
		if (!reducedMotion) signLetter(linkedLetter);
		else showLetter(linkedLetter);
	} else if (userPicked) {
		// Someone who pressed a key while the rig was still downloading has
		// already chosen: sign what they asked for rather than resetting to A.
		if (!reducedMotion && canSign) signLetter(userPicked);
		else showLetter(userPicked);
	} else if (canSign) {
		showLetter('A');
		if (!reducedMotion) signLetter('A');
		else setStatus('Pick a letter, or press any letter key.');
	} else {
		// The mount already said why there is no avatar. Leave that explanation
		// on screen rather than replacing it with a handshape description.
		showLetter('A', { quiet: true });
	}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
