// Section narration for the corner companion (Task 34).
// ======================================================
// As the visitor scrolls three.ws, the companion avatar "reads" the page section
// currently nearest it: a tasteful caption bubble rises beside the avatar, and —
// only when the visitor opts in — the same copy is spoken aloud through the real
// /api/tts/speak endpoint. This is the in-site sibling of the Chrome extension's
// content-narrator.js (task 09); it reuses that module's section model
// (author-marked → heading fallback, per-section debounce, custom scripts) but
// renders the bubble directly over the SDK companion instead of postMessaging an
// iframe.
//
// WHY a dedicated bubble (not the SDK's greeting bubble):
// The SDK's own `.walk-companion-bubble` is owned by the greeting/invite flow —
// reusing it would let a greeting timeout wipe a narration mid-read and vice
// versa. We mount our own caption element into the host, styled to match the
// SDK bubble but stacked above it, and drive it independently. It carries
// aria-live="polite" so assistive tech announces each section as the avatar
// reaches it — captions are the accessible, always-on channel; audio is opt-in.
//
// SECTION DETECTION (mirrors content-narrator.js):
//   1. Author-marked sections: every [data-walk-narrate] whose value isn't
//      "skip". Authors mark exactly what should be read. An optional
//      [data-walk-script] supplies hand-written copy (better than innerText).
//   2. Fallback for unmarked pages: headings + substantial blocks under the
//      page's main/article region, with nav/header/footer chrome excluded.
// An IntersectionObserver tracks which section is most in view; a 600ms debounce
// (matching the extension) ensures each section narrates once as it settles into
// view, not on every scroll tick.
//
// SETTING: a three-state toggle persisted under the companion's own key
// convention (`${prefix}:companion:narrate`): "off" → silent, "caption" →
// captions only (default), "voice" → captions + spoken audio. Surfaced as a
// small round control slotted into the companion chrome alongside the
// trails/click-to-walk toggles, cycled on click. Default is caption-only so the
// avatar never speaks audio without an explicit opt-in — and even when "voice"
// is selected, the first audible clip is only attempted after a real user
// gesture (the toggle click that enabled it, or any subsequent interaction),
// honouring browser autoplay policy.
//
// MOTION: under prefers-reduced-motion the caption appears without slide/fade
// transitions (it still appears — the information is not motion). Audio is
// independent of the motion preference; it's gated solely by the voice opt-in.
//
// This module is owned by src/walk-companion.js, which calls installNarrator()
// once on load. Side-effect free on import.

import { prefersReducedMotion } from '../walk-sdk/src/internal/storage.js';

// ── Tunables (aligned with the extension's content-narrator.js) ────────────────
const SECTION_DEBOUNCE_MS = 600; // settle time before a newly-visible section reads
const MAX_CHARS = 400; // cap spoken/captioned copy so a clip is short & cheap
const MIN_SECTION_CHARS = 24; // ignore trivially short blocks in the fallback scan
const VISIBILITY_RATIO = 0.55; // a section must be this in-view to become active
const CAPTION_HOLD_MS = 5600; // how long a caption lingers when there's no audio
const RESCAN_DEBOUNCE_MS = 400; // coalesce DOM-mutation/route-change rescans
const TTS_VOICE = 'nova'; // default OpenAI/NVIDIA voice id the endpoint accepts

// The three narration modes, in cycle order. "caption" is the safe default:
// always-on text, never any audio. "voice" layers spoken audio on top. "off"
// silences everything.
const MODES = ['caption', 'voice', 'off'];
const MODE_LABELS = {
	off: 'Narration: off',
	caption: 'Narration: captions',
	voice: 'Narration: captions + voice',
};
const MODE_GLYPH = { off: '💬', caption: '💬', voice: '🔊' };

// ── Persistence (mirrors the companion's `${prefix}:companion:*` convention) ───
let PREF_KEY = 'walk:companion:narrate';

function readMode() {
	try {
		const v = localStorage.getItem(PREF_KEY);
		if (v && MODES.includes(v)) return v;
	} catch {
		/* private mode / disabled storage — fall through to default */
	}
	return 'caption'; // captions on, audio off, until the visitor opts in
}
function writeMode(mode) {
	try {
		localStorage.setItem(PREF_KEY, mode);
	} catch {
		/* private mode / disabled storage — in-memory only */
	}
}

// ── Section discovery ──────────────────────────────────────────────────────────
// Chrome we never narrate: site nav/header/footer and explicitly-hidden nodes.
const CHROME_SELECTOR = 'nav, header, footer, aside, [role="navigation"], [aria-hidden="true"], .walk-companion';

function textOf(el) {
	return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

function isChrome(el) {
	if (el.closest(CHROME_SELECTOR)) return true;
	try {
		const cs = getComputedStyle(el);
		if (cs.display === 'none' || cs.visibility === 'hidden') return true;
	} catch {
		/* detached node — treat as chrome */
		return true;
	}
	return false;
}

// Resolve the readable sections for the current page.
//   · If the author marked sections with [data-walk-narrate], honour exactly
//     those (skipping value "skip" and chrome). Marked sections may be short —
//     authors opted them in deliberately — so no min-length filter applies.
//   · Otherwise fall back to headings + substantial blocks in the main region.
function findSections() {
	const marked = Array.from(document.querySelectorAll('[data-walk-narrate]')).filter(
		(el) => el.getAttribute('data-walk-narrate') !== 'skip' && !isChrome(el) && extractText(el),
	);
	if (marked.length > 0) return marked;

	const root = document.querySelector('main, article, [role="main"]') || document.body;
	const candidates = Array.from(root.querySelectorAll('h1, h2, h3, p, li, blockquote'));
	return candidates.filter((el) => !isChrome(el) && textOf(el).length >= MIN_SECTION_CHARS);
}

// The copy read for a section: a hand-written [data-walk-script] when present
// (better than raw text), else the section's own text, capped to MAX_CHARS.
function extractText(el) {
	const script = el.getAttribute && el.getAttribute('data-walk-script');
	if (script && script.trim()) return script.trim().slice(0, MAX_CHARS);
	return textOf(el).slice(0, MAX_CHARS);
}

// ── Caption bubble ─────────────────────────────────────────────────────────────
// A live-region caption mounted into the companion host, stacked above the SDK's
// own greeting bubble so the two never overwrite each other. Styled to match the
// SDK bubble (same surface/typography) using design tokens where they apply.
// Width is clamped border-box: the bubble is centered over a host whose center
// sits 116px from the right viewport edge (host right:16px, width 200px), so any
// total width above 2 x (116 - 8) = 216px would escape the viewport. The mobile
// host (right:10px, width 148px) puts the center 84px in, hence the 156px cap.
const CAPTION_STYLE_ID = 'walk-companion-narrate-style';
function ensureCaptionStyles() {
	if (document.getElementById(CAPTION_STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = CAPTION_STYLE_ID;
	s.textContent = `
.walk-companion-caption{position:absolute;left:50%;bottom:calc(100% - 30px);z-index:4;transform:translateX(-50%) translateY(8px);box-sizing:border-box;max-width:min(216px,calc(100vw - 16px));width:max-content;background:var(--surface-glass,rgba(18,20,28,.95));backdrop-filter:blur(var(--blur-sm,8px));-webkit-backdrop-filter:blur(var(--blur-sm,8px));color:var(--ink-bright,#f2f4f8);font:var(--weight-medium,500) var(--text-sm,12.5px)/var(--leading-tight,1.4) var(--font-body,system-ui,-apple-system,'Segoe UI',sans-serif);padding:8px 11px;border-radius:var(--radius-md,12px);border:1px solid var(--stroke-strong,rgba(255,255,255,.14));box-shadow:var(--shadow-2,0 10px 28px rgba(0,0,0,.35));pointer-events:none;opacity:0;transition:opacity .3s ease,transform .3s ease;text-align:left}
.walk-companion-caption.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.walk-companion-caption::after{content:'';position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:var(--surface-glass,rgba(18,20,28,.95))}
.walk-companion-caption .wcn-speaker{display:inline-block;margin-right:5px;opacity:.7;font-size:11px}
@media (max-width:520px){.walk-companion-caption{font-size:11.5px;max-width:min(156px,calc(100vw - 12px))}}
@media (prefers-reduced-motion:reduce){.walk-companion-caption{transition:none}}
.walk-companion-narrate{position:absolute;top:2px;right:106px;z-index:3;width:22px;height:22px;border:none;border-radius:50%;background:rgba(12,14,20,.55);color:#fff;font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;opacity:0;transition:opacity .2s ease,background .2s ease;display:grid;place-items:center;padding:0}
.walk-companion:hover .walk-companion-narrate,.walk-companion:focus-within .walk-companion-narrate{opacity:1}
.walk-companion-narrate:hover{background:rgba(122,162,255,.85)}
.walk-companion-narrate:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;opacity:1}
@media (pointer:coarse){.walk-companion-narrate{opacity:1;right:114px}}
`;
	document.head.appendChild(s);
}

function createCaption(getHost) {
	let el = null;
	let hideTimer = 0;

	function mount() {
		const host = getHost();
		if (!host) return null;
		if (el && el.isConnected && el.parentNode === host) return el;
		// Host changed (avatar swap / playground round-trip) — remint the caption.
		el = document.createElement('div');
		el.className = 'walk-companion-caption';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		el.setAttribute('aria-atomic', 'true');
		el.hidden = true;
		host.appendChild(el);
		return el;
	}

	function show(text, { speaker = false, hold = CAPTION_HOLD_MS } = {}) {
		const node = mount();
		if (!node || !text) return;
		clearTimeout(hideTimer);
		// A small speaker glyph signals when audio accompanies the caption.
		node.textContent = '';
		if (speaker) {
			const icon = document.createElement('span');
			icon.className = 'wcn-speaker';
			icon.setAttribute('aria-hidden', 'true');
			icon.textContent = '🔊';
			node.appendChild(icon);
		}
		node.appendChild(document.createTextNode(text));
		node.hidden = false;
		// Force reflow so the entry transition fires when toggling .is-in.
		void node.offsetWidth;
		node.classList.add('is-in');
		if (hold > 0) {
			hideTimer = window.setTimeout(() => hide(), hold);
		}
	}

	function hide() {
		clearTimeout(hideTimer);
		if (!el) return;
		el.classList.remove('is-in');
		const node = el;
		window.setTimeout(() => {
			if (node && !node.classList.contains('is-in')) node.hidden = true;
		}, prefersReducedMotion() ? 0 : 300);
	}

	function dispose() {
		clearTimeout(hideTimer);
		el?.remove();
		el = null;
	}

	return { show, hide, dispose };
}

// ── Spoken audio (real TTS, opt-in, autoplay-policy aware) ──────────────────────
// Fetches a full clip from POST /api/tts/speak and plays it. Never autoplays
// before a user gesture: the install flips a "gesture seen" flag on the first
// pointer/key interaction, and the very act of choosing "voice" is itself a
// gesture. If playback is rejected by autoplay policy we degrade silently to the
// caption (which is already on screen) — no fake audio, no error noise.
function createSpeaker() {
	let audio = null;
	let controller = null;
	let objectUrl = null;

	function cancel() {
		if (controller) {
			controller.abort();
			controller = null;
		}
		if (audio) {
			audio.pause();
			audio.onended = null;
			audio.onerror = null;
			audio.src = '';
			audio = null;
		}
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
	}

	// Returns true if a clip began playing, false if it was unavailable/blocked.
	async function speak(text, { onEnd } = {}) {
		cancel();
		controller = new AbortController();
		let blob;
		try {
			const res = await fetch('/api/tts/speak', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ text, voice: TTS_VOICE, format: 'mp3' }),
				signal: controller.signal,
			});
			if (!res.ok) {
				onEnd?.();
				return false;
			}
			blob = await res.blob();
		} catch {
			// Network failure or aborted by a newer section — treat as no audio.
			onEnd?.();
			return false;
		}
		if (!blob || blob.size === 0) {
			onEnd?.();
			return false;
		}
		objectUrl = URL.createObjectURL(blob);
		audio = new Audio(objectUrl);
		audio.onended = () => {
			cancel();
			onEnd?.();
		};
		audio.onerror = () => {
			cancel();
			onEnd?.();
		};
		try {
			await audio.play();
			return true;
		} catch {
			// Autoplay blocked (no gesture yet) — the caption already conveys it.
			cancel();
			onEnd?.();
			return false;
		}
	}

	return { speak, cancel };
}

// ── Settings toggle (slotted into the companion chrome) ────────────────────────
// Matches the trails/click-to-walk sibling buttons: a small round control in the
// host's top-right cluster, revealed on hover/focus, cycling off → caption →
// voice on click. aria-pressed reflects whether narration is active (not off).
function syncToggleVisual(btn, mode) {
	btn.title = MODE_LABELS[mode];
	btn.setAttribute('aria-label', MODE_LABELS[mode]);
	btn.setAttribute('aria-pressed', mode === 'off' ? 'false' : 'true');
	btn.textContent = MODE_GLYPH[mode];
	const active = mode !== 'off';
	btn.style.background = active ? 'rgba(122,162,255,.45)' : 'rgba(12,14,20,.55)';
	btn.style.color = active ? '#fff' : 'rgba(255,255,255,.5)';
}

function ensureToggle(host, getMode, onCycle) {
	if (!host || host.querySelector('.walk-companion-narrate')) return;
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'walk-companion-narrate';
	syncToggleVisual(btn, getMode());
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		const next = onCycle();
		syncToggleVisual(btn, next);
	});
	host.appendChild(btn);
}

// ── Public install ─────────────────────────────────────────────────────────────
/**
 * Wire section narration to the companion.
 * @param {object} opts
 * @param {() => (object|null)} opts.getInstance returns the live WalkCompanion
 *        instance (with .host, .mounted).
 * @param {() => (HTMLElement|null)} [opts.getHostEl] returns the companion host
 *        for mounting the caption + settings toggle (defaults to getInstance().host).
 * @param {string} [opts.storageKey] localStorage key for the narration mode.
 * @returns {() => void} uninstall function.
 */
export function installNarrator({ getInstance, getHostEl, storageKey } = {}) {
	if (typeof document === 'undefined') return () => {};
	if (storageKey) PREF_KEY = storageKey;
	const resolveInst = typeof getInstance === 'function' ? getInstance : () => null;
	const resolveHost = () => {
		try {
			return (typeof getHostEl === 'function' ? getHostEl() : resolveInst()?.host) || null;
		} catch {
			return null;
		}
	};

	ensureCaptionStyles();

	let mode = readMode();
	const caption = createCaption(resolveHost);
	const speaker = createSpeaker();

	// Autoplay-policy gate: audio is only attempted after a real user gesture.
	// Choosing "voice" is itself a gesture, and we also flip this on the first
	// pointer/key interaction so a page that loads with "voice" already saved
	// waits for the visitor to touch the page before the avatar speaks.
	let userGestureSeen = false;
	const markGesture = () => {
		userGestureSeen = true;
	};
	document.addEventListener('pointerdown', markGesture, { capture: true, once: true });
	document.addEventListener('keydown', markGesture, { capture: true, once: true });

	// ── Observer + active-section tracking ──────────────────────────────────────
	let observer = null;
	let currentSection = null;
	let debounceTimer = 0;
	let sections = [];

	function setMode(next) {
		if (!MODES.includes(next)) return mode;
		mode = next;
		writeMode(mode);
		if (mode === 'off') {
			// Silence immediately: stop any clip and drop the caption.
			speaker.cancel();
			caption.hide();
		} else if (mode === 'caption') {
			// Keep the caption, mute audio at once.
			speaker.cancel();
		}
		return mode;
	}

	function cycleMode() {
		// Cycling via the toggle counts as the opt-in gesture for audio.
		markGesture();
		const idx = MODES.indexOf(mode);
		return setMode(MODES[(idx + 1) % MODES.length]);
	}

	function narrate(el) {
		const text = extractText(el);
		if (!text || mode === 'off') return;

		const wantVoice = mode === 'voice' && userGestureSeen;
		// Caption is the always-on channel; show it immediately. When audio is
		// coming we mark the speaker glyph and hold the caption open until the
		// clip ends (the speaker's onEnd hides it); otherwise it auto-dismisses.
		if (wantVoice) {
			caption.show(text, { speaker: true, hold: 0 });
			speaker.speak(text, {
				onEnd: () => {
					// Only retract if this is still the active section's caption.
					if (currentSection === el) caption.hide();
				},
			});
		} else {
			speaker.cancel();
			caption.show(text, { speaker: false, hold: CAPTION_HOLD_MS });
		}
	}

	function onSectionVisible(el) {
		if (el === currentSection) return;
		clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(() => {
			currentSection = el;
			narrate(el);
		}, SECTION_DEBOUNCE_MS);
	}

	function buildObserver() {
		observer?.disconnect();
		sections = findSections();
		if (sections.length === 0) {
			observer = null;
			return;
		}
		observer = new IntersectionObserver(
			(entries) => {
				let best = null;
				for (const entry of entries) {
					if (entry.isIntersecting && entry.intersectionRatio >= VISIBILITY_RATIO) {
						if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
					}
				}
				if (best) onSectionVisible(best.target);
			},
			{ threshold: [VISIBILITY_RATIO, 0.75, 1] },
		);
		for (const el of sections) observer.observe(el);
	}

	// Rescan when the DOM changes substantially (route swaps in the SPA, lazy
	// content). Debounced so a burst of mutations costs one rescan. We compare
	// the section set so a no-op mutation doesn't churn the observer.
	let rescanTimer = 0;
	function scheduleRescan() {
		clearTimeout(rescanTimer);
		rescanTimer = window.setTimeout(() => {
			const next = findSections();
			const changed =
				next.length !== sections.length || next.some((el, i) => el !== sections[i]);
			if (changed) {
				currentSection = null;
				buildObserver();
			}
		}, RESCAN_DEBOUNCE_MS);
	}

	const mutationObserver = new MutationObserver(scheduleRescan);

	function startObserving() {
		buildObserver();
		try {
			mutationObserver.observe(document.body, { childList: true, subtree: true });
		} catch {
			/* no body yet — the poll below will retry via tryWire */
		}
	}

	if (document.body) {
		startObserving();
	} else {
		document.addEventListener('DOMContentLoaded', startObserving, { once: true });
	}

	// ── Wire the toggle into the host (re-assert across avatar/host swaps) ───────
	let tries = 0;
	let wireTimer = 0;
	function tryWire() {
		const host = resolveHost();
		if (host) ensureToggle(host, () => mode, cycleMode);
		if (!sections.length && document.body) buildObserver();
		if (tries++ < 600) wireTimer = window.setTimeout(tryWire, 500);
	}
	tryWire();

	// Expose a small programmatic surface so the host/console can drive narration.
	const api = {
		get mode() {
			return mode;
		},
		setMode,
		cycleMode,
		rescan: scheduleRescan,
	};

	function uninstall() {
		clearTimeout(debounceTimer);
		clearTimeout(rescanTimer);
		clearTimeout(wireTimer);
		observer?.disconnect();
		mutationObserver.disconnect();
		document.removeEventListener('pointerdown', markGesture, { capture: true });
		document.removeEventListener('keydown', markGesture, { capture: true });
		speaker.cancel();
		caption.dispose();
		resolveHost()?.querySelector('.walk-companion-narrate')?.remove();
	}

	return { uninstall, api };
}
