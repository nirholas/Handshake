// Styles for the Task 08 human-citizen layer, shipped as a string and injected
// once by me-hud.js. Self-contained + namespaced under .agora-h-* so it can't
// collide with the scaffold (agora.css) or the other Agora layers. Reuses the
// page's shared .agora-btn / .agora-btn-primary for buttons. Honours
// prefers-reduced-motion and gives every interactive element a focus ring.

let _injected = false;
export function injectHumansCss() {
	if (_injected || typeof document === 'undefined') return;
	_injected = true;
	const style = document.createElement('style');
	style.id = 'agora-humans-css';
	style.textContent = HUMANS_CSS;
	document.head.appendChild(style);
}

const HUMANS_CSS = `
.agora-h-root {
	--h-bg: rgba(12, 15, 22, 0.82);
	--h-border: rgba(255, 255, 255, 0.12);
	--h-text: #e8eef7;
	--h-dim: #93a1b5;
	--h-accent: #6ea8ff;
	--h-ok: #36d399;
	--h-err: #ff6b6b;
	--h-human: #7ee0a6;
	font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
	color: var(--h-text);
}
.agora-h-root *, .agora-h-root *::before { box-sizing: border-box; }

/* ── Dock (bottom-left) ──────────────────────────────────────────────────── */
/* The dock sits at the bottom-left, but it is not alone there: the population
   chip is pinned below it and the economy ticker stacks above it. It used to
   claim a flat 16px bottom like both of them, so all three drew on the same corner
   and the dock (z-index 60) simply covered the other two. --agora-dock-floor is
   the shared bottom-up stack the whole world's furniture measures from; see the
   token block at the top of src/agora/agora.css. */
#agora-humans-dock {
	position: fixed; left: 16px; bottom: var(--agora-dock-floor, 67px); z-index: 60;
	display: flex; align-items: stretch; gap: 8px;
	max-width: min(92vw, 420px);
}
/* On a phone the dock goes full width, which walks it straight into the global
   language switcher pinned to the bottom-right corner (src/i18n.js, 16px up and
   the topmost z-index on the page). At 320px the switcher covered the dock's own
   "Sign in to join" button. --agora-dock-floor (src/agora/agora.css) drops to
   clear that corner strip at this breakpoint, so the dock only has to go full
   width here; its bottom edge is already handled by the rule above. */
@media (max-width: 640px) {
	#agora-humans-dock { left: 8px; right: 8px; max-width: none; }
}

.agora-h-card {
	display: flex; align-items: center; gap: 10px;
	background: var(--h-bg); border: 1px solid var(--h-border);
	border-radius: 14px; padding: 10px 12px;
	backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
	box-shadow: 0 8px 32px rgba(0,0,0,0.5);
	min-width: 0;
}
.agora-h-dot {
	width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
	background: var(--h-human); display: grid; place-items: center;
	color: #07120c; font-weight: 700; font-size: 13px; overflow: hidden;
}
.agora-h-dot img { width: 100%; height: 100%; object-fit: cover; }
.agora-h-meta { min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.agora-h-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agora-h-line { font-size: 11px; color: var(--h-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agora-h-status-pill {
	display: inline-block; width: 7px; height: 7px; border-radius: 50%;
	background: var(--h-dim); margin-right: 5px; vertical-align: middle;
}
.agora-h-status-pill.is-busy { background: var(--h-accent); }
.agora-h-status-pill.is-idle { background: var(--h-ok); }
.agora-h-dock-btns { display: flex; gap: 6px; align-items: center; }

/* Shared button look (falls back if .agora-btn is unstyled on this page). */
.agora-h-root .agora-btn, .agora-h-form .agora-btn {
	font: inherit; cursor: pointer; border-radius: 10px;
	padding: 8px 12px; border: 1px solid var(--h-border);
	background: rgba(255,255,255,0.06); color: var(--h-text);
	transition: background .15s ease, transform .1s ease;
}
.agora-h-root .agora-btn:hover { background: rgba(255,255,255,0.12); }
.agora-h-root .agora-btn:active { transform: translateY(1px); }
.agora-h-root .agora-btn-primary, .agora-h-form .agora-btn-primary {
	background: var(--h-accent); border-color: transparent; color: #061018; font-weight: 600;
}
.agora-h-root .agora-btn-primary:hover { background: #84b6ff; }
.agora-h-root .agora-btn:disabled { opacity: .55; cursor: progress; }
.agora-h-root :focus-visible, .agora-h-form :focus-visible {
	outline: 2px solid var(--h-accent); outline-offset: 2px;
}
.agora-h-btn-sm { padding: 6px 10px !important; font-size: 12px; }

/* ── "You" drawer body sections ──────────────────────────────────────────── */
.agora-h-section { margin: 0 0 18px; }
.agora-h-section h3 { margin: 0 0 8px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--h-dim); }
.agora-h-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.agora-h-stat { background: rgba(255,255,255,0.04); border: 1px solid var(--h-border); border-radius: 10px; padding: 8px 10px; }
.agora-h-stat .k { font-size: 11px; color: var(--h-dim); display: block; }
.agora-h-stat .v { font-size: 16px; font-weight: 600; }
.agora-h-wallet { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--h-dim); flex-wrap: wrap; }
.agora-h-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.agora-h-list li {
	display: flex; align-items: center; justify-content: space-between; gap: 8px;
	background: rgba(255,255,255,0.03); border: 1px solid var(--h-border);
	border-radius: 8px; padding: 7px 10px; font-size: 13px;
}
.agora-h-list button { font: inherit; }
.agora-h-empty { font-size: 13px; color: var(--h-dim); }

/* ── Compose form ────────────────────────────────────────────────────────── */
.agora-h-form { display: flex; flex-direction: column; gap: 12px; }
.agora-h-field { display: flex; flex-direction: column; gap: 5px; }
.agora-h-field-label { font-size: 11px; color: var(--h-dim); letter-spacing: .03em; }
.agora-h-input {
	font: inherit; color: var(--h-text); background: rgba(255,255,255,0.05);
	border: 1px solid var(--h-border); border-radius: 9px; padding: 9px 11px; width: 100%;
}
.agora-h-input:focus { border-color: var(--h-accent); outline: none; }
.agora-h-textarea { resize: vertical; min-height: 84px; }
.agora-h-row { display: grid; grid-template-columns: 1.3fr 0.8fr 0.8fr; gap: 8px; }
.agora-h-reward { display: flex; align-items: center; gap: 6px; }
.agora-h-unit { font-size: 12px; color: var(--h-dim); }
.agora-h-net { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--h-dim); }
.agora-h-hint { font-size: 12px; color: var(--h-dim); }
.agora-h-actions { display: flex; gap: 8px; }
.agora-h-status { font-size: 12.5px; min-height: 1em; }
.agora-h-status.is-error { color: var(--h-err); }
.agora-h-status.is-ok { color: var(--h-ok); }
.agora-h-link { color: var(--h-accent); }
.agora-h-muted { color: var(--h-dim); }
/* Recoverable-failure state: the address to fund, right where the error lands. */
.agora-h-fund {
	display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
	margin-top: 8px; color: var(--h-text);
}
.agora-h-addr {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
	background: rgba(255,255,255,0.04); border: 1px solid var(--h-border); border-radius: 6px;
	padding: 3px 6px; overflow-wrap: anywhere; user-select: all;
}

/* ── Toasts ──────────────────────────────────────────────────────────────── */
#agora-humans-toasts {
	position: fixed; right: 16px; bottom: 16px; z-index: 70;
	display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
	pointer-events: none;
}
.agora-h-toast {
	background: var(--h-bg); border: 1px solid var(--h-border); color: var(--h-text);
	border-radius: 10px; padding: 10px 14px; font-size: 13px; max-width: 360px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.5); backdrop-filter: blur(12px);
	animation: agora-h-in .25s ease; pointer-events: auto;
}
.agora-h-toast.is-error { border-color: rgba(255,107,107,0.5); }
.agora-h-toast.is-ok { border-color: rgba(54,211,153,0.5); }
.agora-h-toast a { color: var(--h-accent); }
@keyframes agora-h-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .agora-h-toast { animation: none; } }
`;
