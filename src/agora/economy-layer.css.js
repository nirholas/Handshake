// Styles for the Task 06 economy layer, shipped as a string and injected once by
// economy-layer.js. Kept self-contained (no dependency on the Task 05 page
// stylesheet) and namespaced under .agora-econ-* so it can't collide with the
// scaffold's chrome. Honours prefers-reduced-motion and exposes focus rings on
// every interactive element.

export const ECON_LAYER_CSS = `
.agora-econ-root {
	position: fixed; inset: 0; z-index: 40;
	pointer-events: none;
	font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
	--econ-bg: rgba(12, 15, 22, 0.72);
	--econ-bg-solid: #0c0f16;
	--econ-border: rgba(255, 255, 255, 0.1);
	--econ-text: #e8eef7;
	--econ-dim: #93a1b5;
	--econ-gold: #f0b429;
	--econ-rep: #36d399;
}
.agora-econ-root *,
.agora-econ-root *::before { box-sizing: border-box; }
.agora-econ-root button {
	font: inherit; color: inherit; background: none; border: none;
	cursor: pointer; text-align: left;
}
.agora-econ-root button:focus-visible {
	outline: 2px solid #4ea1ff; outline-offset: 2px; border-radius: 8px;
}

/* ── Job board roster (right) ─────────────────────────────────────────────── */
.agora-econ-board-panel {
	position: absolute; top: 64px; right: 16px; width: 300px;
	max-height: calc(100vh - 96px); display: flex; flex-direction: column;
	background: var(--econ-bg); border: 1px solid var(--econ-border);
	border-radius: 14px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
	padding: 14px; pointer-events: auto; color: var(--econ-text);
	box-shadow: 0 18px 50px rgba(0,0,0,0.45);
}
.agora-econ-board-title {
	margin: 0 0 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
	text-transform: uppercase; color: var(--econ-dim); display: flex; align-items: baseline;
}
.agora-econ-board-count { color: var(--econ-text); font-weight: 700; }
.agora-econ-board-list {
	list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex;
	flex-direction: column; gap: 6px; scrollbar-width: thin;
}
.agora-econ-board-item {
	width: 100%; display: flex; gap: 10px; align-items: flex-start;
	padding: 9px 10px; border-radius: 10px; border: 1px solid transparent;
	transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}
.agora-econ-board-item:hover { background: rgba(255,255,255,0.06); border-color: var(--econ-border); }
.agora-econ-board-item:active { transform: translateY(1px); }
.agora-econ-board-dot {
	width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto;
	background: var(--accent, #9fb4cc); box-shadow: 0 0 8px var(--accent, #9fb4cc);
}
.agora-econ-board-item-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agora-econ-board-item-title {
	font-size: 13px; font-weight: 600; line-height: 1.25;
	overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
	-webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.agora-econ-board-item-meta { font-size: 11.5px; color: var(--econ-dim); }
/* Overflow line: the board renders a bounded set of markers, so the roster says
   out loud how much open work it isn't showing. Never a silent cap. */
.agora-econ-board-more {
	font-size: 11.5px; color: var(--econ-dim); text-align: center;
	padding: 7px 10px 3px; font-variant-numeric: tabular-nums;
}
/* Arena / Guild type badge (Task 09) — a small inline tag on a multi-worker task. */
.agora-econ-board-badge {
	display: inline-flex; align-items: center; gap: 3px;
	font-size: 10px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;
	padding: 1px 6px; border-radius: 6px; margin-right: 6px; vertical-align: middle;
	border: 1px solid transparent;
}
.agora-econ-board-badge.is-arena { color: #ff6b57; background: rgba(255,107,87,0.14); border-color: rgba(255,107,87,0.4); }
.agora-econ-board-badge.is-guild { color: #38d39f; background: rgba(56,211,159,0.14); border-color: rgba(56,211,159,0.4); }
.agora-econ-board-fill {
	font-variant-numeric: tabular-nums; font-weight: 700; color: var(--econ-text);
	background: rgba(255,255,255,0.07); padding: 0 5px; border-radius: 5px;
}
.agora-econ-board-empty { text-align: center; padding: 22px 8px; color: var(--econ-dim); }
.agora-econ-board-empty-glyph { font-size: 30px; opacity: 0.7; }
.agora-econ-board-empty-title { margin: 8px 0 4px; font-size: 14px; font-weight: 700; color: var(--econ-text); }
.agora-econ-board-empty-sub { margin: 0; font-size: 12px; line-height: 1.5; }

/* ── Marker tooltip ────────────────────────────────────────────────────────── */
.agora-econ-tooltip {
	position: absolute; top: 0; left: 0; max-width: 260px; z-index: 60;
	background: var(--econ-bg-solid); border: 1px solid var(--econ-border);
	border-radius: 10px; padding: 9px 11px; color: var(--econ-text);
	box-shadow: 0 12px 32px rgba(0,0,0,0.5); pointer-events: none;
	will-change: transform;
}
.agora-econ-tip-title { font-size: 13px; font-weight: 700; margin-bottom: 5px; line-height: 1.3; }
.agora-econ-tip-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.agora-econ-tip-prof {
	font-size: 11px; font-weight: 700; color: var(--accent, #9fb4cc);
	padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor;
}
.agora-econ-tip-reward { font-size: 12px; font-weight: 700; color: var(--econ-gold); }
.agora-econ-tip-sub { margin-top: 5px; font-size: 11px; color: var(--econ-dim); }

/* ── Ticker (left) ─────────────────────────────────────────────────────────── */
/* Rides on top of the humans dock in the shared bottom-left stack (the tokens
   are documented at the top of src/agora/agora.css). Pinned to a flat 16px it
   sat underneath the dock, which hid the tail of the live activity feed. */
.agora-econ-ticker {
	position: absolute; left: 16px; width: 320px;
	bottom: calc(var(--agora-dock-floor, 67px) + var(--agora-dock-h, 0px) + 10px);
	max-height: calc(100vh - 120px - var(--agora-dock-floor, 67px) - var(--agora-dock-h, 0px));
	display: flex; flex-direction: column; gap: 12px;
	background: var(--econ-bg); border: 1px solid var(--econ-border);
	border-radius: 14px; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
	padding: 14px; pointer-events: auto; color: var(--econ-text);
	box-shadow: 0 18px 50px rgba(0,0,0,0.45);
}
.agora-econ-readout { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.agora-econ-stat {
	display: flex; flex-direction: column; gap: 2px; padding: 8px;
	background: rgba(255,255,255,0.04); border-radius: 10px; text-align: center;
}
.agora-econ-stat-v { font-size: 18px; font-weight: 800; line-height: 1; }
.agora-econ-stat-l { font-size: 10px; color: var(--econ-dim); letter-spacing: 0.02em; }
.agora-econ-earners-h, .agora-econ-feed-h {
	font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
	color: var(--econ-dim); margin-bottom: 6px;
}
.agora-econ-earners-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; counter-reset: rank; }
.agora-econ-earner {
	width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 8px;
	padding: 5px 8px; border-radius: 8px; transition: background 0.15s ease;
}
.agora-econ-earner::before {
	counter-increment: rank; content: counter(rank); font-size: 10px; font-weight: 700;
	color: var(--accent, #9fb4cc); width: 14px; flex: 0 0 auto;
}
.agora-econ-earner:hover { background: rgba(255,255,255,0.06); }
.agora-econ-earner-name { flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agora-econ-earner-amt { font-size: 12px; font-weight: 700; color: var(--econ-gold); white-space: nowrap; }
.agora-econ-earners-empty, .agora-econ-feed-empty { font-size: 12px; color: var(--econ-dim); padding: 4px 2px; }
.agora-econ-feed-wrap { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.agora-econ-feed {
	list-style: none; margin: 0; padding: 0; overflow-y: auto; display: flex;
	flex-direction: column; gap: 3px; scrollbar-width: thin; min-height: 0;
}
.agora-econ-feed-item { overflow: hidden; }
.agora-econ-feed-item.enter .agora-econ-feed-btn { animation: agora-econ-slide-in 0.4s ease; }
@keyframes agora-econ-slide-in {
	from { opacity: 0; transform: translateY(-8px); }
	to { opacity: 1; transform: translateY(0); }
}
.agora-econ-feed-btn {
	width: 100%; display: flex; gap: 8px; align-items: flex-start; padding: 7px 8px;
	border-radius: 9px; border-left: 2px solid var(--accent, #9fb4cc);
	background: rgba(255,255,255,0.03); transition: background 0.15s ease;
}
.agora-econ-feed-btn:hover { background: rgba(255,255,255,0.08); }
.agora-econ-feed-glyph { font-size: 13px; flex: 0 0 auto; line-height: 1.4; }
.agora-econ-feed-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agora-econ-feed-narr {
	font-size: 12px; line-height: 1.35;
	overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
	-webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.agora-econ-feed-reward { font-size: 11.5px; font-weight: 700; color: var(--econ-gold); }

/* ── Floating world labels (coin reward + reputation tick) ─────────────────── */
.agora-econ-float {
	position: absolute; top: 0; left: 0; z-index: 55; pointer-events: none;
	font-size: 15px; font-weight: 800; white-space: nowrap; will-change: transform, opacity;
	text-shadow: 0 2px 8px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9);
}
.agora-econ-float-reward { color: var(--econ-gold); }
.agora-econ-float-rep { color: var(--econ-rep); }

/* ── Offline pip ───────────────────────────────────────────────────────────── */
.agora-econ-offline .agora-econ-ticker::after {
	content: 'reconnecting…'; position: absolute; top: 10px; right: 12px;
	font-size: 10px; color: #ffb454; opacity: 0.9;
}

/* ── Responsive ────────────────────────────────────────────────────────────── */
@media (max-width: 880px) {
	.agora-econ-board-panel { width: 230px; top: 58px; right: 10px; max-height: 42vh; }
	.agora-econ-ticker {
		width: calc(100vw - 250px); max-width: 320px; left: 10px; max-height: 42vh;
		bottom: calc(var(--agora-dock-floor, 67px) + var(--agora-dock-h, 0px) + 10px);
	}
}
/* Phone layout: both economy panels go full width and stack up from the bottom.
   They sit above the world's other bottom furniture (the language switcher's
   corner strip, the humans dock, the "Enter the Commons" button) rather than
   under it, which is what used to clip the board's last few rows out of reach.
   --agora-econ-floor is the top of that furniture; both panels measure from it,
   so the stack stays sound when the dock changes height. */
@media (max-width: 560px) {
	.agora-econ-root {
		--agora-econ-floor: calc(var(--agora-dock-floor, 56px) + var(--agora-dock-h, 0px) + 54px);
	}
	.agora-econ-board-panel {
		top: auto; bottom: var(--agora-econ-floor); right: 10px; left: 10px; width: auto;
		max-height: 26vh; flex-direction: column;
	}
	.agora-econ-ticker {
		left: 10px; right: 10px; width: auto; max-width: none;
		bottom: calc(var(--agora-econ-floor) + 26vh + 10px);
		max-height: 26vh;
	}
	.agora-econ-readout { grid-template-columns: repeat(3, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
	.agora-econ-feed-item.enter .agora-econ-feed-btn { animation: none; }
	.agora-econ-board-item, .agora-econ-feed-btn, .agora-econ-earner { transition: none; }
}
`;
