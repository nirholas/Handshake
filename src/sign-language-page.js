// /sign-language — the dedicated home for three.ws's signing avatars.
//
// A live avatar that signs on arrival, an input that spells or signs anything
// you type, a webcam demo that transcribes your own fingerspelling, and a plain
// explanation of what works today. This is the front door for the feature that
// otherwise lives inside the Animation Studio panel and the chat toggles.
//
// The 3D + animation stack is the same PoseStage the studio uses; SignSpeaker
// (src/sign-speech.js) drives it exactly like a text-to-speech engine.

import { PoseStage } from './avatar-pose.js';
import { SignSpeaker } from './sign-speech.js';
import { normalizeWord } from './fingerspelling.js';
import { log } from './shared/log.js';

const HERO_AVATAR = '/avatars/cz.glb';

// Phrases the hero cycles through so a first-time visitor immediately sees the
// avatar signing real content, not a static pose.
const DEMO_PHRASES = ['HELLO', 'WELCOME TO THREE WS', 'ASK ME ANYTHING', 'NICE TO MEET YOU'];

const $ = (sel, root = document) => root.querySelector(sel);

async function boot() {
	const stageHost = $('#sl-stage');
	if (!stageHost) return;

	const stage = new PoseStage(stageHost, { glbUrl: HERO_AVATAR, framing: 'portrait' });
	let speaker = null;
	let heroTimer = 0;
	let heroIndex = 0;
	let heroActive = true;

	const status = $('#sl-status');
	const setStatus = (msg) => {
		if (status) status.textContent = msg || '';
	};

	try {
		const { supported } = await stage.mount();
		stage.start();
		if (!supported) {
			setStatus('This avatar can’t sign, but the tools below still work.');
			return;
		}
		speaker = new SignSpeaker({ manager: stage.anim });
	} catch (err) {
		log.warn('[sign-language] stage mount failed', err?.message);
		setStatus('Live preview unavailable — the spelling tools below still work.');
	}

	// ── Hero auto-signing loop ────────────────────────────────────────────────
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
	if (speaker) heroTick();

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
		setStatus(`Signing: “${norm.toLowerCase()}”`);
		try {
			await speaker.speak(raw);
			setStatus('Type anything and watch the avatar sign it.');
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

	// ── Webcam sign-in demo ───────────────────────────────────────────────────
	wireWebcamDemo(setStatus);
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
					resultEl.textContent = 'No fingerspelling read — try again, a little slower.';
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
			resultEl.textContent = e?.message || 'Camera unavailable — check browser permissions.';
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
