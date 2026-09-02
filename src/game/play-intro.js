// Lobby cold-open for /play — the first thing a newcomer sees.
//
// The audit found /play opens straight onto a grid of pump.fun coins with no
// context: a visitor expecting a game lands in what reads like a token-economy
// sim and bounces. This module fixes the *first ten seconds* — before any coin,
// wallet, or avatar decision is asked for — with one plain-language card:
//
//   • What this is, in human words: a live 3D world you explore with other
//     people. The on-chain economy is named as a hook, never as a gate.
//   • A concrete first objective so the player knows what to *do*.
//   • A primary "Drop in now" action that enters the $THREE home town with the
//     default character — zero friction, no wallet, no coin to understand. The
//     economy stays fully discoverable in-world (see play-onboard.js), just not
//     mandatory up front.
//
// Shown once per browser (localStorage), skippable (×/Esc), focus-trapped,
// prefers-reduced-motion respected. Re-openable any time via mountIntroReopener.
//
// Framing rules honored: never single-player ("with other people", "others are
// here too"); the only coin named anywhere is $THREE.

const INTRO_KEY = 'cc-lobby-intro-v1';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode — just re-show */ } }

function mk(tag, attrs = {}, ...children) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'className') n.className = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
		else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : String(v));
	}
	children.flat().forEach((c) => c != null && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
	return n;
}

let stylesInjected = false;
function injectStyles() {
	if (stylesInjected || document.getElementById('pi-styles')) { stylesInjected = true; return; }
	stylesInjected = true;
	const s = document.createElement('style');
	s.id = 'pi-styles';
	// Tokens mirror coincommunities.css --cc-* with safe fallbacks, so the card
	// stands alone even if the lobby sheet hasn't painted yet.
	s.textContent = `
#pi-overlay {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  background: rgba(4,4,5,0.78); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  opacity: 0; transition: opacity 0.24s ease;
}
#pi-overlay.pi-show { opacity: 1; }

.pi-card {
  position: relative; box-sizing: border-box;
  width: min(480px, calc(100vw - 32px));
  background: var(--cc-panel-solid, #0c0c0e);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius, 4px);
  box-shadow: var(--cc-shadow, 0 18px 56px rgba(0,0,0,0.72));
  padding: 26px 26px 22px;
  transform: translateY(12px) scale(0.985);
  transition: transform 0.24s cubic-bezier(0.2,0.7,0.2,1);
}
#pi-overlay.pi-show .pi-card { transform: none; }

/* Skip control. The BUTTON is 44x44 (the WCAG 2.5.5 / iOS minimum) while the
   drawn square stays 30px: the extra 7px on each side is invisible touch slop,
   so a thumb aiming at "skip" on a phone lands on it without the intro card
   gaining a chunky close box. Offsets are 6px (13px minus the 7px slop) so the
   visible square sits exactly where it always did. */
.pi-close {
  position: absolute; top: 6px; right: 6px;
  width: 44px; height: 44px; padding: 0;
  background: none; border: none; isolation: isolate;
  color: var(--cc-dim, #8c8c92); font-size: 21px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.12s ease;
}
.pi-close::before {
  content: ""; position: absolute; inset: 7px; z-index: -1;
  border-radius: var(--cc-radius-sm, 2px);
  background: var(--cc-bg2, #101012);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.pi-close:hover { color: var(--cc-text, #f5f5f6); }
.pi-close:hover::before { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); }
.pi-close:focus-visible { outline: none; }
.pi-close:focus-visible::before { border-color: #fff; box-shadow: 0 0 0 1px #fff; }

.pi-tag {
  font-size: 10px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--cc-faint, #5a5a60); margin: 0 0 8px;
}
.pi-title {
  font-size: 23px; font-weight: 800; line-height: 1.2; letter-spacing: 0.005em;
  color: var(--cc-text, #f5f5f6); margin: 0 0 12px; max-width: 22ch;
}
.pi-body {
  font-size: 14px; line-height: 1.6; color: var(--cc-dim, #8c8c92);
  margin: 0 0 18px; max-width: 46ch;
}

/* First-objective callout */
.pi-goal {
  display: flex; align-items: flex-start; gap: 11px;
  background: var(--cc-bg2, #101012);
  border: 1px solid var(--cc-edge-soft, rgba(255,255,255,0.07));
  border-radius: var(--cc-radius, 4px);
  padding: 12px 14px; margin: 0 0 22px;
}
.pi-goal-ico {
  flex: none; width: 26px; height: 26px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  color: var(--cc-text, #f5f5f6); font-size: 13px;
}
.pi-goal-txt { font-size: 12.5px; line-height: 1.5; color: var(--cc-dim, #8c8c92); }
.pi-goal-txt strong { color: var(--cc-text, #f5f5f6); font-weight: 700; }

.pi-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pi-btn {
  appearance: none; font: inherit; cursor: pointer;
  /* 11px padding on a 13.5px/1 line box measured 40px tall, just under the 44px
     WCAG 2.5.5 / iOS minimum. min-height carries the target the last 4px without
     changing the padding rhythm on wider rows. */
  padding: 11px 22px; min-height: 44px; border-radius: var(--cc-radius-sm, 2px);
  font-weight: 700; font-size: 13.5px; letter-spacing: 0.02em;
  display: inline-flex; align-items: center; gap: 8px;
  transition: filter 0.12s ease, transform 0.1s ease, border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.pi-btn:active { transform: translateY(1px); }
.pi-btn-primary {
  background: #fff; color: var(--cc-ink, #060607); border: 1px solid #fff;
  box-shadow: var(--cc-glow, 0 0 16px rgba(255,255,255,0.32));
}
.pi-btn-primary:hover { filter: brightness(0.92); }
.pi-btn-primary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--cc-bg, #060607), 0 0 0 4px #fff; }
.pi-btn-ghost {
  background: none; border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  color: var(--cc-dim, #8c8c92);
}
.pi-btn-ghost:hover { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); color: var(--cc-text, #f5f5f6); }
.pi-btn-ghost:focus-visible { outline: none; border-color: #fff; box-shadow: 0 0 0 1px #fff; }
.pi-btn-arrow { transition: transform 0.14s ease; }
.pi-btn-primary:hover .pi-btn-arrow { transform: translateX(2px); }

.pi-fine {
  margin: 16px 0 0; font-size: 11px; line-height: 1.5;
  color: var(--cc-faint, #5a5a60);
}

/* "New here?" lobby re-opener */
.pi-reopen {
  appearance: none; cursor: pointer; font: inherit;
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--cc-panel, rgba(12,12,14,0.78));
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius, 4px); padding: 6px 12px;
  color: var(--cc-dim, #8c8c92);
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  transition: border-color 0.12s ease, color 0.12s ease;
}
.pi-reopen:hover { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); color: var(--cc-text, #f5f5f6); }
.pi-reopen:focus-visible { outline: none; border-color: #fff; box-shadow: 0 0 0 1px #fff; }
.pi-reopen .pi-reopen-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--cc-live, #fff); box-shadow: var(--cc-glow, 0 0 12px rgba(255,255,255,0.35));
}

@media (max-width: 520px) {
  .pi-card { padding: 22px 20px 20px; }
  .pi-title { font-size: 20px; }
  .pi-actions { flex-direction: column; align-items: stretch; }
  .pi-btn { justify-content: center; }
}

@media (prefers-reduced-motion: reduce) {
  #pi-overlay, .pi-card { transition: none; }
  .pi-btn-arrow { transition: none; }
  .pi-reopen .pi-reopen-dot { box-shadow: none; }
}
`;
	document.head.appendChild(s);
}

/**
 * Mount the cold-open card. Self-contained; returns nothing.
 * @param {object} opts
 * @param {() => void} opts.onDropIn  Enter the $THREE home town with the default
 *   character — the zero-friction path. Called after the card closes.
 * @param {boolean} [opts.force]  Show even if already dismissed (re-open).
 */
export function showPlayIntro({ onDropIn, force = false } = {}) {
	if (!force && lsGet(INTRO_KEY)) return null;
	if (document.getElementById('pi-overlay')) return null;
	injectStyles();

	const overlay = mk('div', {
		id: 'pi-overlay', role: 'dialog', 'aria-modal': 'true',
		'aria-label': 'Welcome to three.ws Play',
	});

	let prevFocus = document.activeElement;
	let keyFn = null;
	let trapFn = null;

	const close = () => {
		lsSet(INTRO_KEY, '1');
		overlay.classList.remove('pi-show');
		if (keyFn) document.removeEventListener('keydown', keyFn);
		if (trapFn) document.removeEventListener('keydown', trapFn);
		setTimeout(() => overlay.remove(), 260);
		try { prevFocus?.focus?.(); } catch { /* element gone */ }
	};

	const dropIn = () => { close(); try { onDropIn?.(); } catch { /* caller logs */ } };

	const closeBtn = mk('button', {
		className: 'pi-close', type: 'button', 'aria-label': 'Skip intro', text: '×',
		onclick: close,
	});

	const goal = mk('div', { className: 'pi-goal' },
		mk('span', { className: 'pi-goal-ico', 'aria-hidden': 'true', text: '◎' }),
		mk('span', { className: 'pi-goal-txt', html:
			'<strong>Your first move:</strong> drop into the $THREE home town, then walk up to the two AI traders in the plaza and watch them strike a live on-chain deal.' }),
	);

	const actions = mk('div', { className: 'pi-actions' },
		mk('button', {
			className: 'pi-btn pi-btn-primary', type: 'button', onclick: dropIn,
		}, 'Drop in now', mk('span', { className: 'pi-btn-arrow', 'aria-hidden': 'true', text: '→' })),
		mk('button', {
			className: 'pi-btn pi-btn-ghost', type: 'button', onclick: close,
		}, 'Pick a character first'),
	);

	const card = mk('div', { className: 'pi-card' },
		closeBtn,
		mk('p',  { className: 'pi-tag', text: 'Welcome' }),
		mk('h2', { className: 'pi-title', text: 'A 3D world you explore together' }),
		mk('p',  { className: 'pi-body', text:
			'three.ws is a live 3D world you walk around with other people: chat, build, and explore side by side. AI agents even trade on-chain in the town square. You can look around with no wallet and no crypto; the economy is there when you want it, never in the way.' }),
		goal,
		actions,
		mk('p', { className: 'pi-fine', text: 'Move with WASD or the on-screen joystick · drag to look around · Enter to chat. You can change your character any time.' }),
	);

	overlay.appendChild(card);
	document.body.appendChild(overlay);

	// Focus trap so Tab can't escape to the lobby behind the modal.
	const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
	trapFn = (e) => {
		if (e.key !== 'Tab') return;
		const els = Array.from(overlay.querySelectorAll(FOCUSABLE));
		if (!els.length) return;
		const first = els[0], last = els[els.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	};
	keyFn = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
	document.addEventListener('keydown', keyFn);
	document.addEventListener('keydown', trapFn);

	requestAnimationFrame(() => {
		overlay.classList.add('pi-show');
		// Focus the primary action only once the boot loader is gone: the intro
		// mounts underneath the still-opaque #kx-loading, and a focused button
		// there turns a stray Enter during loading into an invisible "Drop in".
		const focusPrimary = () => card.querySelector('.pi-btn-primary')?.focus();
		const loader = document.getElementById('kx-loading');
		if (!loader || loader.classList.contains('kx-hidden')) { focusPrimary(); return; }
		const watch = new MutationObserver(() => {
			const gone = !document.getElementById('kx-loading')
				|| document.getElementById('kx-loading').classList.contains('kx-hidden');
			if (gone) { watch.disconnect(); focusPrimary(); }
		});
		watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
	});

	return { close };
}

/**
 * Build a small, always-available "New here?" button that re-opens the intro.
 * Returns the element for the caller to place in the lobby chrome.
 * @param {() => void} onDropIn  same drop-in handler as showPlayIntro.
 */
export function makeIntroReopener(onDropIn) {
	injectStyles();
	return mk('button', {
		className: 'pi-reopen', type: 'button', 'aria-label': 'New here? Replay the intro',
		title: 'New here? Replay the intro',
		onclick: () => showPlayIntro({ onDropIn, force: true }),
	}, mk('span', { className: 'pi-reopen-dot', 'aria-hidden': 'true' }), 'New here?');
}
