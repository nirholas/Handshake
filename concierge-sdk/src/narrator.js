/**
 * SpeechNarrator — @three-ws/concierge (shared lineage: page-agent-sdk/src/narrator.js)
 * =====================================
 *
 * Speaks queued text aloud with the Web Speech API and keeps the avatar's mouth
 * in sync. There is no backend, no API key, no audio file: TTS is synthesized
 * in the browser, and the lipsync timeline is advanced on the stage's render
 * loop so visemes track the spoken words.
 *
 * Graceful by design:
 *   - No speechSynthesis (or muted): we still run the lipsync timeline for the
 *     text's estimated duration so the avatar visibly "talks" and captions
 *     show — the page narration never silently stalls.
 *   - Voice list loads async on some platforms; we wait for `voiceschanged`.
 */

import { createLipsync, estimateDurationMs } from './lipsync.js';

const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

export class SpeechNarrator {
	/**
	 * @param {import('./stage.js').AvatarStage} stage
	 * @param {{ muted?: boolean, onState?: (s:'idle'|'speaking')=>void,
	 *          onCaption?: (text:string|null)=>void, onError?: (e:Error)=>void }} [opts]
	 */
	constructor(stage, opts = {}) {
		this.stage = stage;
		this.muted = !!opts.muted;
		this.onState = opts.onState || (() => {});
		this.onCaption = opts.onCaption || (() => {});
		this.onError = opts.onError || (() => {});

		this.agent = null; // current RiggedAgent (for voice selection)
		this._queue = [];
		this._active = null; // { lipsync, utter, fallbackTimer, resolve }
		this._frameUnsub = stage.onFrame((dt, nowMs) => this._tick(nowMs));
		this._voices = [];

		if (hasTTS) {
			this._onVoices = this._loadVoices.bind(this);
			this._loadVoices();
			window.speechSynthesis.addEventListener?.('voiceschanged', this._onVoices);
		}
	}

	/** Switch the active agent so future utterances use its voice profile. */
	setAgent(agent) {
		this.agent = agent;
	}

	setMuted(muted) {
		this.muted = !!muted;
		if (muted && hasTTS) window.speechSynthesis.cancel();
	}

	/**
	 * Queue text to speak. Returns a promise that resolves when this line ends
	 * (or is skipped/cancelled). Multiple calls play in order.
	 * @param {string} text
	 * @param {{ interrupt?: boolean }} [opts]
	 * @returns {Promise<void>}
	 */
	speak(text, opts = {}) {
		const clean = String(text || '').trim();
		if (!clean) return Promise.resolve();
		if (opts.interrupt) this.cancel();
		return new Promise((resolve) => {
			this._queue.push({ text: clean, resolve });
			if (!this._active) this._next();
		});
	}

	/** Stop everything and clear the queue. */
	cancel() {
		if (hasTTS) window.speechSynthesis.cancel();
		this._finishActive(true);
		for (const item of this._queue.splice(0)) item.resolve();
		this.onCaption(null);
		this.stage.setSpeaking(false);
		this.onState('idle');
	}

	get speaking() {
		return !!this._active;
	}

	_next() {
		const item = this._queue.shift();
		if (!item) { this.onState('idle'); this.onCaption(null); this.stage.setSpeaking(false); return; }

		const rate = this.agent?.voice?.rate || 1;
		const lipsync = createLipsync(item.text, this.stage.morph, { rate });
		const active = { text: item.text, lipsync, resolve: item.resolve, utter: null, fallbackTimer: 0 };
		this._active = active;

		this.stage.setSpeaking(true);
		this.onState('speaking');
		this.onCaption(item.text);

		if (hasTTS && !this.muted) {
			const utter = new SpeechSynthesisUtterance(item.text);
			const v = this._pickVoice();
			if (v) utter.voice = v;
			utter.lang = this.agent?.voice?.lang || v?.lang || 'en-US';
			utter.pitch = clamp(this.agent?.voice?.pitch ?? 1, 0, 2);
			utter.rate = clamp(this.agent?.voice?.rate ?? 1, 0.1, 3);
			utter.onend = () => this._finishActive(false);
			utter.onerror = (e) => {
				// Some engines fire 'interrupted'/'canceled' as errors on cancel —
				// only surface genuine synthesis failures, then fall back visually.
				if (e?.error && !/interrupt|cancel/i.test(e.error)) {
					this.onError(new Error('speech-synthesis: ' + e.error));
					this._runVisualFallback(active);
				} else {
					this._finishActive(false);
				}
			};
			active.utter = utter;
			// Safety net: if neither onend nor onerror fires (known flaky on some
			// mobile engines), close out after the estimated duration + slack.
			const guardMs = estimateDurationMs(item.text) * (1 / (utter.rate || 1)) + 1500;
			active.fallbackTimer = window.setTimeout(() => this._finishActive(false), Math.max(2500, guardMs));
			try {
				window.speechSynthesis.speak(utter);
			} catch (err) {
				this.onError(err instanceof Error ? err : new Error(String(err)));
				this._runVisualFallback(active);
			}
		} else {
			this._runVisualFallback(active);
		}
	}

	/** No audio (muted / unsupported): play the lipsync visually then advance. */
	_runVisualFallback(active) {
		if (active !== this._active) return;
		// Estimate from the morph timeline when present, else from raw text so
		// no-morph (animation-lipsync) agents still hold the caption long enough.
		const ms = active.lipsync.totalMs
			? active.lipsync.totalMs + 350
			: Math.max(1200, estimateDurationMs(active.text) + 350);
		active.fallbackTimer = window.setTimeout(() => this._finishActive(false), ms);
	}

	_tick(nowMs) {
		this._active?.lipsync?.tick(nowMs);
	}

	_finishActive(silent) {
		const active = this._active;
		if (!active) return;
		this._active = null;
		if (active.fallbackTimer) clearTimeout(active.fallbackTimer);
		active.lipsync?.stop();
		try { active.resolve(); } catch { /* consumer callback */ }
		if (!silent) this._next();
	}

	_loadVoices() {
		if (!hasTTS) return;
		this._voices = window.speechSynthesis.getVoices() || [];
	}

	_pickVoice() {
		if (!this._voices.length) this._loadVoices();
		const prof = this.agent?.voice || {};
		const voices = this._voices;
		if (!voices.length) return null;
		// 1) explicit name matches, in priority order
		for (const needle of prof.match || []) {
			const v = voices.find((x) => x.name?.toLowerCase().includes(needle.toLowerCase()));
			if (v) return v;
		}
		// 2) language match
		if (prof.lang) {
			const v = voices.find((x) => x.lang?.toLowerCase().startsWith(prof.lang.toLowerCase().slice(0, 2)));
			if (v) return v;
		}
		// 3) first local voice, else first available
		return voices.find((x) => x.localService) || voices[0];
	}

	dispose() {
		this.cancel();
		this._frameUnsub?.();
		if (hasTTS) window.speechSynthesis.removeEventListener?.('voiceschanged', this._onVoices);
	}
}

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, Number(n)));
}
