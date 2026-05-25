// narrator.js — page-section narrator for the Walk Avatar extension.
// Activated when narrationEnabled setting is on. Uses IntersectionObserver to
// detect which section is in view, calls /api/tts/speak with the section text,
// and streams the audio while posting a 'walk:narrate' message to the avatar iframe.

const THREEWS = 'https://three.ws';
const SECTION_DEBOUNCE_MS = 600;
const MAX_CHARS = 380;

export class Narrator {
	constructor({ getIframe, getSession, getSettings }) {
		this.getIframe = getIframe;
		this.getSession = getSession;
		this.getSettings = getSettings;
		this._muted = false;
		this._observer = null;
		this._currentSection = null;
		this._debounceTimer = null;
		this._audio = null;
		this._activeController = null;
	}

	start() {
		this._collectSections();
	}

	stop() {
		this._observer?.disconnect();
		this._observer = null;
		this._cancelAudio();
	}

	mute() { this._muted = true; this._cancelAudio(); }
	unmute() { this._muted = false; }

	// ── Section discovery ─────────────────────────────────────────────────
	_collectSections() {
		if (this._observer) this._observer.disconnect();

		// Prefer explicitly marked elements, fall back to semantic headings + paragraphs
		const marked = Array.from(document.querySelectorAll('[data-walk-narrate]'))
			.filter(el => el.dataset.walkNarrate !== 'skip');

		let sections;
		if (marked.length > 0) {
			sections = marked;
		} else {
			// Find heading + following paragraph pairs
			const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
			sections = headings.filter((h) => {
				const next = h.nextElementSibling;
				return next && (next.tagName === 'P' || next.tagName === 'SECTION');
			});
			// Fallback: article paragraphs
			if (sections.length === 0) {
				sections = Array.from(document.querySelectorAll('article p, main p, .content p'))
					.filter((p) => p.textContent.trim().length > 80);
			}
		}

		if (sections.length === 0) return;

		this._observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
					this._onSectionVisible(entry.target);
					break;
				}
			}
		}, { threshold: 0.6 });

		sections.forEach((el) => this._observer.observe(el));
	}

	_onSectionVisible(el) {
		if (el === this._currentSection) return;
		clearTimeout(this._debounceTimer);
		this._debounceTimer = setTimeout(() => {
			this._currentSection = el;
			if (!this._muted) this._narrate(el);
		}, SECTION_DEBOUNCE_MS);
	}

	// ── Narration ─────────────────────────────────────────────────────────
	_extractText(el) {
		// Use custom script if provided via data attribute
		if (el.dataset.walkScript) return el.dataset.walkScript.trim();
		// Otherwise extract visible text, strip extra whitespace
		const raw = el.innerText || el.textContent || '';
		return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
	}

	async _narrate(el) {
		const text = this._extractText(el);
		if (!text) return;

		this._cancelAudio();

		const settings = this.getSettings();
		const session = this.getSession();
		const voice = settings?.voice || 'nova';

		// Tell the avatar to play talking gesture + show bubble
		const iframe = this.getIframe();
		iframe?.contentWindow?.postMessage({
			type: 'walk:narrate',
			text,
			voice,
		}, THREEWS);

		try {
			const controller = new AbortController();
			this._activeController = controller;

			const headers = { 'Content-Type': 'application/json' };
			if (session) headers['Authorization'] = `Bearer ${session}`;

			const res = await fetch(`${THREEWS}/api/tts/speak`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ text, voice, format: 'mp3' }),
				signal: controller.signal,
			});

			if (!res.ok) return;

			const blob = await res.blob();
			if (this._muted) return;

			const url = URL.createObjectURL(blob);
			this._audio = new Audio(url);
			this._audio.onended = () => {
				URL.revokeObjectURL(url);
				iframe?.contentWindow?.postMessage({ type: 'walk:narrateEnd' }, THREEWS);
			};
			this._audio.onerror = () => URL.revokeObjectURL(url);
			await this._audio.play().catch(() => {});
		} catch (err) {
			if (err.name !== 'AbortError') {
				console.warn('[walk-narrator]', err);
			}
		}
	}

	_cancelAudio() {
		this._activeController?.abort();
		this._activeController = null;
		if (this._audio) {
			this._audio.pause();
			this._audio.src = '';
			this._audio = null;
		}
	}
}
