// First-join onboarding + economy clarity for /play.
//
// Three deliverables in one self-contained module:
//
//   1. First-join overlay — a 3-step modal shown once per browser:
//        Step 1: Welcome — names the world and its coin; shared-world framing.
//        Step 2: Controls — the real input bindings from the input handler.
//        Step 3: Economy — grounded in agent-commerce.js and the market reactor.
//      Persists dismissal in localStorage so it never nags returning players.
//      ESC / ← → keyboard navigation; focus-trapped; prefers-reduced-motion respected.
//
//   2. Economy clarity strip — always-visible info panel below the coin banner.
//      Every world hosts the live Agent Exchange (ORACLE/NOVA), the intel kiosk,
//      and the trade-driven environment, so the strip describes the same economy
//      everywhere, prefixed with the coin's ticker.
//
//   3. Controls help button — "Controls" button that opens a full reference panel
//      sourced from the real _bindInput() / _stepLocal() bindings.
//
// Never frames /play as single-player. Connecting/offline states use correct copy.

const ONBOARD_KEY = 'cc-onboarded-v1';

// ── Real controls sourced from coincommunities.js _bindInput() / _stepLocal() ─

// `essential` marks the handful a first-timer needs in the 3-step overlay; the
// Controls help panel always shows the full reference. Keep both in sync with
// _bindInput(): a control listed here that no longer exists is worse than one
// that is missing, because the player trusts it and it silently does nothing.

const DESK_CONTROLS = [
	{ group: 'Move' },
	{ key: 'W A S D', desc: 'Move', essential: true },
	{ key: '↑ ↓ ← →', desc: 'Move (arrows)' },
	{ key: 'Shift', desc: 'Sprint', essential: true },
	{ key: 'Space', desc: 'Jump (handbrake while driving)', essential: true },
	{ key: 'Drag', desc: 'Look around', essential: true },
	{ key: 'Scroll', desc: 'Zoom camera' },
	{ key: 'C', desc: 'Cycle camera: follow, cinematic, first person, top down' },

	{ group: 'Interact' },
	{ key: 'E', desc: 'Talk to whoever is near: townsfolk, kiosk, agent exchange', essential: true },
	{ key: 'F', desc: 'Drive a nearby vehicle, work a station, or cast a line', essential: true },
	{ key: 'X', desc: 'Attack with the equipped weapon' },
	{ key: '1-6', desc: 'Hotbar slot' },
	{ key: 'I', desc: 'Inspect the nearest avatar' },
	{ key: 'Click', desc: 'Tap a player, agent, vehicle, or screen to use it' },

	{ group: 'Social' },
	{ key: 'Enter', desc: 'Chat', essential: true },
	{ key: 'Q', desc: 'Hold for the emote wheel, release to play', essential: true },
	{ key: 'J', desc: 'Friends' },
	{ key: 'V', desc: 'Change your avatar' },

	{ group: 'Build' },
	{ key: 'B', desc: 'Build mode' },
	{ key: '1-0', desc: 'Pick a block (while building)' },
	{ key: 'R', desc: 'Rotate the armed prop or piece' },
	{ key: 'Right-click', desc: 'Break a block (hold also works)' },
	{ key: 'Ctrl/⌘ + Z', desc: 'Undo your last build edit' },

	{ group: 'View' },
	{ key: 'P', desc: 'Photo mode', essential: true },
	{ key: 'Z', desc: 'Zen mode: hide every panel' },
	{ key: 'Esc', desc: 'Close the open drawer or panel' },
];

const TOUCH_CONTROLS = [
	{ group: 'Move' },
	{ key: 'Joystick', desc: 'Move (bottom-left)', essential: true },
	{ key: 'Drag', desc: 'Look around', essential: true },
	{ key: 'Pinch', desc: 'Zoom camera' },

	{ group: 'Tap to use' },
	{ key: 'A person', desc: 'Talk to townsfolk, agents, and kiosks', essential: true },
	{ key: 'A vehicle', desc: 'Take the wheel', essential: true },
	{ key: 'A player', desc: 'Inspect them' },
	{ key: 'A screen', desc: 'Open the live chart on pump.fun' },

	{ group: 'Social' },
	{ key: 'Chat bar', desc: 'Chat', essential: true },
	{ key: 'HUD buttons', desc: 'Emotes, friends, avatar, jobs' },

	{ group: 'Build' },
	{ key: '⛏ button', desc: 'Build mode' },
	{ key: 'Tap', desc: 'Place a block (while building)' },
	{ key: 'Hold', desc: 'Break a block (while building)' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTouch() {
	return typeof matchMedia === 'function' &&
		matchMedia('(hover: none), (pointer: coarse)').matches;
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function mk(tag, attrs = {}, ...children) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'className') n.className = v;
		else if (k === 'innerHTML') n.innerHTML = v;
		else if (k === 'textContent') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
		else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : String(v));
	}
	children.flat().forEach((c) => c != null && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
	return n;
}

// ── Main class ────────────────────────────────────────────────────────────────

export class PlayOnboard {
	/**
	 * @param {object} opts
	 * @param {object} opts.coin   The coin this world is keyed to { mint, name, symbol, image }.
	 */
	constructor({ coin }) {
		this.coin = coin;
		this._disposed = false;
		this._step = 0;
		this._overlay = null;
		this._helpPanel = null;
		this._strip = null;
		this._keyFn = null;
		this._showTimer = null;

		this._injectStyles();
		this._buildStrip();

		if (!lsGet(ONBOARD_KEY)) {
			// Delay slightly so the world geometry is visible behind the overlay.
			this._showTimer = setTimeout(() => {
				if (!this._disposed) this._showOverlay();
			}, 650);
		}
	}

	// ── Slide content ──────────────────────────────────────────────────────────

	_slides() {
		const { coin } = this;
		const sym   = coin.symbol ? '$' + coin.symbol.toUpperCase() : '';
		const name  = coin.name || 'Community';

		return [
			{
				tag:   'Welcome',
				title: name + (sym ? ' · ' + sym : ''),
				body:
					'A shared 3D world — everyone in ' +
					(sym || `the ${name} community`) +
					' meets here. Walk around, chat, build, and trade together. ' +
					'Others are in this world with you right now.',
			},
			{
				tag:         'Controls',
				title:       'How to move',
				isControls:  true,
			},
			{
				tag:   'Economy',
				title: 'The economy',
				body:
					'Real ' + (sym || name) + ' trades drive this world: buys light the boundary ring green, sells ripple red, volume spins the totem, and price momentum shifts the weather. ' +
					'Two AI agents — ORACLE and NOVA — trade on-chain here too: NOVA pays ORACLE in USDC via x402, and every settlement is a real Solana transaction with a Solscan link. Walk up to them by the plaza and press E (or tap them) to watch a live payment round. ' +
					'Across the plaza, the ' + (sym || name) + ' Intel Kiosk sells live market intel — pay $0.01 USDC from your own wallet to light up its screen.',
			},
		];
	}

	// ── Overlay ────────────────────────────────────────────────────────────────

	_showOverlay() {
		if (this._overlay) return;
		this._step = 0;

		// Non-modal coach card, not a blocking modal. The dimmed backdrop is purely
		// visual (pointer-events:none in CSS) so the movement joystick and look-drag
		// stay live behind it — a first-time touch player can start walking the
		// instant the world loads instead of facing a dead joystick under the intro.
		// `po-onboarding` on <body> lifts the joystick crisp above the backdrop.
		const overlay = mk('div', {
			id: 'po-overlay',
			role: 'dialog',
			'aria-label': 'Welcome to this world',
		});
		document.body.appendChild(overlay);
		document.body.classList.add('po-onboarding');
		this._overlay = overlay;
		this._renderSlide();

		this._keyFn = (e) => {
			if (!this._overlay) return;
			// Escape tears the card down, which nulls `_overlay`. Return on the spot:
			// the focus check below dereferences it, and falling through threw
			// "Cannot read properties of null" on every Escape.
			if (e.key === 'Escape') { e.preventDefault(); this._dismiss(); return; }
			// Arrows page the card ONLY while it holds focus. They are also the
			// avatar's movement keys, and this card is deliberately non-blocking
			// ("start walking the moment the world loads"), so swallowing left/right
			// globally made that promise false for anyone not using WASD.
			if (!this._overlay.contains(document.activeElement)) return;
			if (e.key === 'ArrowRight') { e.preventDefault(); this._stepTo(this._step + 1); }
			if (e.key === 'ArrowLeft')  { e.preventDefault(); this._stepTo(this._step - 1); }
		};
		document.addEventListener('keydown', this._keyFn);

		requestAnimationFrame(() => {
			overlay.classList.add('po-show');
			overlay.querySelector('.po-btn-primary')?.focus();
		});
	}

	_renderSlide() {
		const overlay = this._overlay;
		if (!overlay) return;
		overlay.textContent = '';

		const slides  = this._slides();
		const slide   = slides[this._step];
		const total   = slides.length;
		const isLast  = this._step === total - 1;
		const isFirst = this._step === 0;

		// ── Dots ──
		const dots = mk('div', { className: 'po-dots', 'aria-hidden': 'true' });
		for (let i = 0; i < total; i++) {
			dots.appendChild(mk('span', { className: 'po-dot' + (i === this._step ? ' po-dot-on' : '') }));
		}

		// ── Header ──
		const tag   = mk('p',  { className: 'po-tag',   textContent: slide.tag.toUpperCase() });
		const title = mk('h2', { className: 'po-title', textContent: slide.title });

		// ── Body ──
		let body;
		if (slide.isControls) {
			body = this._buildControlsGrid(isTouch(), true);
		} else {
			body = mk('p', { className: 'po-body', textContent: slide.body });
		}

		// ── Actions ──
		const actions = mk('div', { className: 'po-actions' });

		if (!isFirst) {
			const back = mk('button', {
				className: 'po-btn po-btn-ghost', type: 'button', textContent: 'Back',
				onclick: () => this._stepTo(this._step - 1),
			});
			actions.appendChild(back);
		}

		const cta = mk('button', {
			className: 'po-btn po-btn-primary', type: 'button',
			textContent: isLast ? 'Enter the world' : 'Continue',
			onclick: () => isLast ? this._dismiss() : this._stepTo(this._step + 1),
		});
		actions.appendChild(cta);

		// ── Close (skip) ──
		const closeBtn = mk('button', {
			className: 'po-close', type: 'button',
			'aria-label': 'Skip intro',
			textContent: '×',
			onclick: () => this._dismiss(),
		});

		const card = mk('div', { className: 'po-card' });
		card.appendChild(closeBtn);
		card.appendChild(dots);
		card.appendChild(tag);
		card.appendChild(title);
		card.appendChild(body);
		card.appendChild(actions);
		overlay.appendChild(card);
	}

	_stepTo(idx) {
		const slides = this._slides();
		const next = Math.max(0, Math.min(slides.length - 1, idx));
		if (next === this._step) return;
		this._step = next;
		this._renderSlide();
		this._overlay?.querySelector('.po-btn-primary')?.focus();
	}

	_dismiss() {
		lsSet(ONBOARD_KEY, '1');
		const overlay = this._overlay;
		if (!overlay) return;
		overlay.classList.remove('po-show');
		document.body.classList.remove('po-onboarding');
		setTimeout(() => overlay.remove(), 250);
		this._overlay = null;
		if (this._keyFn) { document.removeEventListener('keydown', this._keyFn); this._keyFn = null; }
	}

	// ── Controls grid (used in overlay slide + help panel) ─────────────────────

	// `essentialsOnly` trims the list to what a first-timer needs mid-onboarding;
	// the help panel passes false and gets every binding, grouped.
	_buildControlsGrid(touch, essentialsOnly = false) {
		const all = touch ? TOUCH_CONTROLS : DESK_CONTROLS;
		const list = essentialsOnly ? all.filter((c) => c.essential) : all;
		const grid = mk('div', { className: 'po-ctrl-grid' });
		for (const { group, key, desc } of list) {
			if (group) {
				grid.appendChild(mk('div', { className: 'po-ctrl-group', textContent: group }));
				continue;
			}
			const row = mk('div', { className: 'po-ctrl-row' });
			row.appendChild(mk('kbd', { className: 'po-kbd', textContent: key }));
			row.appendChild(mk('span', { className: 'po-ctrl-desc', textContent: desc }));
			grid.appendChild(row);
		}
		return grid;
	}

	// ── Economy + controls strip (always-visible in-world) ─────────────────────

	_buildStrip() {
		const { coin } = this;
		const sym  = coin.symbol ? '$' + coin.symbol.toUpperCase() : '';

		const econText = (sym ? sym + ' community · ' : '') +
			'AI agents trading on-chain · press E near them';

		// Economy row: live dot + label
		const dot   = mk('span', { className: 'po-live-dot', 'aria-hidden': 'true' });
		const label = mk('span', { className: 'po-econ-label', textContent: econText });
		const econRow = mk('div', { className: 'po-econ-row' }, dot, label);

		// Controls toggle button
		const ctrlBtn = mk('button', {
			className: 'po-ctrl-btn', type: 'button',
			'aria-label': 'Show controls reference',
			textContent: 'Controls',
			onclick: () => this._toggleHelp(),
		});

		const strip = mk('div', { id: 'po-strip' }, econRow, ctrlBtn);
		document.body.appendChild(strip);
		this._strip = strip;
	}

	// ── Controls help panel ────────────────────────────────────────────────────

	_toggleHelp() {
		if (this._helpPanel) {
			this._helpPanel.classList.remove('po-show');
			const p = this._helpPanel;
			this._helpPanel = null;
			setTimeout(() => p.remove(), 200);
			return;
		}

		const closeBtn = mk('button', {
			className: 'po-help-close', type: 'button',
			'aria-label': 'Close controls',
			textContent: '×',
			onclick: () => this._toggleHelp(),
		});
		const head = mk('div', { className: 'po-help-head' },
			mk('span', { className: 'po-help-title', textContent: 'CONTROLS' }),
			closeBtn,
		);

		const panel = mk('div', {
			id: 'po-help',
			role: 'dialog',
			'aria-label': 'Controls reference',
		}, head, this._buildControlsGrid(isTouch()));

		document.body.appendChild(panel);
		this._helpPanel = panel;

		requestAnimationFrame(() => {
			panel.classList.add('po-show');
			closeBtn.focus();
		});
	}

	// ── Styles ─────────────────────────────────────────────────────────────────

	_injectStyles() {
		if (document.getElementById('po-styles')) return;
		const s = document.createElement('style');
		s.id = 'po-styles';
		/* Tokens mirror coincommunities.css --cc-* so this stands alone if /play
		   ever loads without the main sheet. Values match the monochrome design lang. */
		s.textContent = `
/* ── PlayOnboard ─────────────────────────────────────────────────────────── */

/* First-join overlay — a non-blocking coach card. The dimmed/blurred backdrop is
   visual only: pointer-events:none lets the movement joystick, look-drag, and
   world taps stay live behind it, so a first-time touch player can move the
   moment the world loads instead of hitting a dead joystick under the intro.
   Only the card itself (.po-card) re-enables pointer input. */
#po-overlay {
  position: fixed; inset: 0; z-index: 45;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  background: rgba(4,4,5,0.74); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  opacity: 0; transition: opacity 0.22s ease;
  pointer-events: none;
}
#po-overlay.po-show { opacity: 1; }

/* Keep the joystick above the backdrop while the intro is up so it reads crisp
   (not blurred) and is obviously usable — it sits bottom-left, clear of the
   centered card. Scoped to onboarding so default stacking is untouched. */
body.po-onboarding #cc-joystick { z-index: 60; }

.po-card {
  position: relative;
  pointer-events: auto;
  width: min(440px, calc(100vw - 32px));
  background: var(--cc-panel-solid, #0c0c0e);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius, 4px);
  box-shadow: var(--cc-shadow, 0 16px 50px rgba(0,0,0,0.7));
  padding: 22px 22px 20px;
  transform: translateY(10px) scale(0.99);
  transition: transform 0.22s cubic-bezier(0.2,0.7,0.2,1);
}
#po-overlay.po-show .po-card { transform: none; }

.po-close {
  position: absolute; top: 12px; right: 12px;
  width: 28px; height: 28px;
  border-radius: var(--cc-radius-sm, 2px);
  background: var(--cc-bg2, #101012);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  color: var(--cc-dim, #8c8c92); font-size: 20px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.12s ease, border-color 0.12s ease;
}
.po-close:hover { color: var(--cc-text, #f5f5f6); border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); }
.po-close:focus-visible { outline: none; border-color: #fff; box-shadow: 0 0 0 1px #fff; }

/* Progress dots */
.po-dots { display: flex; gap: 6px; margin-bottom: 16px; }
.po-dot {
  height: 3px; width: 18px; border-radius: 2px;
  background: var(--cc-edge-soft, rgba(255,255,255,0.07));
  transition: background 0.18s ease, width 0.18s ease;
}
.po-dot.po-dot-on { background: #fff; width: 26px; }

/* Slide text */
.po-tag {
  font-size: 10px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--cc-faint, #5a5a60); margin: 0 0 6px;
}
.po-title {
  font-size: 19px; font-weight: 800; letter-spacing: 0.01em;
  color: var(--cc-text, #f5f5f6); margin: 0 0 14px;
}
.po-body {
  font-size: 13.5px; line-height: 1.65; color: var(--cc-dim, #8c8c92);
  margin: 0 0 20px; max-width: 44ch;
}

/* Controls grid (used in overlay + help panel) */
.po-ctrl-grid {
  display: grid; grid-template-columns: auto 1fr; gap: 6px 14px;
  margin-bottom: 20px;
  max-height: 230px; overflow-y: auto; padding-right: 2px;
}
.po-ctrl-grid::-webkit-scrollbar { width: 4px; }
.po-ctrl-grid::-webkit-scrollbar-thumb { background: var(--cc-edge, rgba(255,255,255,0.12)); }
.po-ctrl-row { display: contents; }
.po-ctrl-group {
  grid-column: 1 / -1;
  margin-top: 10px; padding-bottom: 3px;
  border-bottom: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--cc-dim, #8c8c92);
}
.po-ctrl-group:first-child { margin-top: 0; }
.po-kbd {
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius-sm, 2px); padding: 2px 7px;
  font-size: 11px; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--cc-text, #f5f5f6); white-space: nowrap; align-self: center;
}
.po-ctrl-desc {
  font-size: 12px; color: var(--cc-dim, #8c8c92); align-self: center;
}

/* Slide actions */
.po-actions {
  display: flex; align-items: center; justify-content: flex-end; gap: 9px;
  padding-top: 18px; border-top: 1px solid var(--cc-edge-soft, rgba(255,255,255,0.07));
}
.po-btn {
  padding: 9px 20px; border-radius: var(--cc-radius-sm, 2px);
  font: inherit; font-weight: 700; font-size: 13px; letter-spacing: 0.03em; cursor: pointer;
  transition: filter 0.12s ease, transform 0.1s ease, border-color 0.12s ease, color 0.12s ease;
}
.po-btn:active { transform: translateY(1px); }
.po-btn-primary {
  background: #fff; color: var(--cc-ink, #060607); border: 1px solid #fff;
  box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.35));
}
.po-btn-primary:hover { filter: brightness(0.92); }
.po-btn-primary:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--cc-bg, #060607), 0 0 0 4px #fff; }
.po-btn-ghost {
  background: none; border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  color: var(--cc-dim, #8c8c92);
}
.po-btn-ghost:hover { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); color: var(--cc-text, #f5f5f6); }
.po-btn-ghost:focus-visible { outline: none; border-color: #fff; box-shadow: 0 0 0 1px #fff; }

/* ── In-world info strip (economy + controls toggle) ── */
#po-strip {
  position: fixed; left: 14px; top: 128px; z-index: 19;
  display: flex; flex-direction: column; gap: 6px;
  pointer-events: auto;
}
/* Phones kept the whole strip hidden, which took the Controls button with it:
   once the first-join card was dismissed there was no way back to the control
   reference on the device that needs it most. Keep the button, drop the economy
   label (it is the part that does not fit), and sit clear of the coin banner. */
@media (max-width: 640px) {
  #po-strip { top: 84px; left: 12px; }
  #po-strip .po-econ-row { display: none; }
}

.po-econ-row {
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--cc-panel, rgba(12,12,14,0.78));
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius, 4px); padding: 6px 11px;
  backdrop-filter: blur(10px);
  max-width: min(310px, 52vw);
}
.po-live-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--cc-live, #fff);
  box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.35));
  animation: po-blink 1.8s ease-in-out infinite;
}
@keyframes po-blink { 50% { opacity: 0.3; } }
.po-econ-label {
  font-size: 11px; color: var(--cc-dim, #8c8c92); letter-spacing: 0.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.po-ctrl-btn {
  display: inline-flex; align-items: center;
  background: var(--cc-panel, rgba(12,12,14,0.78));
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius, 4px); padding: 5px 11px;
  backdrop-filter: blur(10px);
  color: var(--cc-dim, #8c8c92); font: inherit;
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  cursor: pointer;
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}
.po-ctrl-btn:hover { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); color: var(--cc-text, #f5f5f6); }
.po-ctrl-btn:focus-visible { outline: none; border-color: #fff; box-shadow: 0 0 0 1px #fff; }

/* ── Controls reference panel ── */
#po-help {
  position: fixed; left: 14px; top: 202px; z-index: 46;
  width: min(268px, calc(100vw - 28px));
  background: var(--cc-panel-solid, #0c0c0e);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  border-radius: var(--cc-radius, 4px);
  box-shadow: var(--cc-shadow, 0 16px 50px rgba(0,0,0,0.7));
  padding: 12px 14px;
  opacity: 0; transform: translateY(-4px); pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
#po-help.po-show { opacity: 1; transform: none; pointer-events: auto; }
/* On small screens anchor to bottom-left above the joystick */
@media (max-width: 640px) {
  #po-help { left: 14px; top: auto; bottom: 160px; }
}

.po-help-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;
}
.po-help-title {
  font-size: 10px; font-weight: 700; letter-spacing: 0.14em; color: var(--cc-faint, #5a5a60);
}
.po-help-close {
  width: 22px; height: 22px; border-radius: var(--cc-radius-sm, 2px);
  background: var(--cc-bg2, #101012);
  border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
  color: var(--cc-dim, #8c8c92); font-size: 16px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.12s ease, border-color 0.12s ease;
}
.po-help-close:hover { color: var(--cc-text, #f5f5f6); border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); }
.po-help-close:focus-visible { outline: none; border-color: #fff; box-shadow: 0 0 0 1px #fff; }

#po-help .po-ctrl-grid { margin-bottom: 0; max-height: 280px; }

/* Reduced-motion overrides */
@media (prefers-reduced-motion: reduce) {
  #po-overlay, .po-card, #po-help { transition: none; }
  .po-dot { transition: none; }
  .po-live-dot { animation: none; }
}
`;
		document.head.appendChild(s);
	}

	// ── Teardown ───────────────────────────────────────────────────────────────

	dispose() {
		this._disposed = true;
		clearTimeout(this._showTimer);
		document.body.classList.remove('po-onboarding');
		if (this._keyFn) { document.removeEventListener('keydown', this._keyFn); this._keyFn = null; }
		if (this._overlay) { this._overlay.remove(); this._overlay = null; }
		if (this._helpPanel) { this._helpPanel.remove(); this._helpPanel = null; }
		if (this._strip) { this._strip.remove(); this._strip = null; }
	}
}
