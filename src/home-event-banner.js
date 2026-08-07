// Home-page event strip.
//
// The countdown used to live only on /play, which meant the event was invisible
// to anyone who never opened the world. This mounts a compact announcement bar
// between the nav and the hero on `/`, reading the SAME window as the /play
// surfaces through src/shared/event-config.js. There is exactly one copy of the
// event times in this repo (public/event.json); this file adds a view, never a
// second source.
//
// Self-attaching and self-removing: it fetches once at boot, mounts nothing when
// there is no event (or the event has ended), ticks once a second while an event
// is upcoming, flips to LIVE without a reload the moment the start time passes,
// and unmounts itself when the end time passes.
//
// Dismissal is shared with the /play in-world pill (the same
// `cc-event-dismissed:<startsAt>` key), so a visitor who waves the reminder away
// on the home page does not meet it again in the world. The /play lobby banner
// is deliberately NOT dismissible: it is lobby content, not an overlay.

import {
	loadEventConfig, eventState, clockString, formatStart, alreadyAtEvent,
} from './shared/event-config.js';

const STYLE = `
.tws-eventbar {
	border-bottom: 1px solid var(--hairline, rgba(255,255,255,0.08));
	background: var(--surface-0, #0e0e0f);
	color: var(--text, #f6f6f6);
	font-family: var(--font-body, 'Inter', system-ui, sans-serif);
}
.tws-eventbar-in {
	max-width: 1400px; margin: 0 auto; padding: 10px 24px;
	display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
}
.tws-eventbar-dot {
	flex: none; width: 6px; height: 6px; border-radius: 50%;
	background: var(--text-3, #8a8a8a);
}
.tws-eventbar[data-state="live"] .tws-eventbar-dot {
	background: var(--accent, #fff); box-shadow: 0 0 6px var(--accent, #fff);
	animation: tws-eventbar-pulse 2.4s ease-in-out infinite;
}
@keyframes tws-eventbar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@media (prefers-reduced-motion: reduce) {
	.tws-eventbar[data-state="live"] .tws-eventbar-dot { animation: none; }
	.tws-eventbar-cta, .tws-eventbar-x { transition: none; }
}
.tws-eventbar-kicker {
	font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px;
	letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3, #8a8a8a);
	white-space: nowrap;
}
.tws-eventbar-name { font-weight: 600; font-size: 14px; }
.tws-eventbar-when { font-size: 13px; color: var(--text-2, #a8a8a8); }
.tws-eventbar-clock {
	font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px;
	font-variant-numeric: tabular-nums; color: var(--text, #f6f6f6);
	padding: 3px 9px; border: 1px solid var(--hairline, rgba(255,255,255,0.08));
	border-radius: 999px; white-space: nowrap;
}
.tws-eventbar-cta {
	margin-left: auto;
	display: inline-flex; align-items: center; gap: 7px;
	padding: 7px 14px; border-radius: 999px;
	border: 1px solid var(--hairline-strong, rgba(255,255,255,0.14));
	color: var(--text, #f6f6f6); text-decoration: none;
	font-size: 13px; font-weight: 500; white-space: nowrap;
	transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.tws-eventbar-cta .tws-eventbar-arrow { display: inline-block; transition: transform 0.15s; }
.tws-eventbar-cta:hover, .tws-eventbar-cta:focus-visible {
	background: rgba(255, 255, 255, 0.05);
	border-color: var(--accent, #fff);
}
.tws-eventbar-cta:hover .tws-eventbar-arrow,
.tws-eventbar-cta:focus-visible .tws-eventbar-arrow { transform: translateX(3px); }
.tws-eventbar-cta:active { transform: translateY(1px); }
.tws-eventbar-cta:focus-visible { outline: 2px solid var(--accent, #fff); outline-offset: 2px; }
.tws-eventbar-x {
	flex: none; display: grid; place-items: center; width: 26px; height: 26px;
	border: 0; border-radius: 50%; background: transparent;
	color: var(--text-3, #8a8a8a); font: inherit; font-size: 15px; line-height: 1;
	transition: background 0.15s, color 0.15s;
}
/* With no CTA the close button takes the right edge itself. */
.tws-eventbar-x { margin-left: auto; }
.tws-eventbar-cta ~ .tws-eventbar-x { margin-left: 0; }
.tws-eventbar-x:hover { background: rgba(255, 255, 255, 0.08); color: var(--text, #f6f6f6); }
.tws-eventbar-x:active { transform: scale(0.94); }
.tws-eventbar-x:focus-visible { outline: 2px solid var(--accent, #fff); outline-offset: 1px; }
[data-theme='light'] .tws-eventbar-cta:hover,
[data-theme='light'] .tws-eventbar-cta:focus-visible { background: rgba(0, 0, 0, 0.05); }
[data-theme='light'] .tws-eventbar-x:hover { background: rgba(0, 0, 0, 0.06); }
@media (max-width: 720px) {
	.tws-eventbar-in { padding: 9px 16px; gap: 8px 10px; }
	.tws-eventbar-when { flex-basis: 100%; order: 4; font-size: 12px; }
	.tws-eventbar-cta { margin-left: 0; order: 5; }
	.tws-eventbar-x { order: 6; margin-left: auto; }
}
`;

function el(tag, attrs = {}, children = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null) continue;
		if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const c of children) if (c) n.appendChild(c);
	return n;
}

class HomeEventBar {
	constructor(cfg, main) {
		this.cfg = cfg;
		this.timer = 0;
		document.head.appendChild(el('style', { text: STYLE }));

		this.kicker = el('span', { class: 'tws-eventbar-kicker', text: 'Upcoming' });
		this.clock = el('span', { class: 'tws-eventbar-clock', role: 'timer' });
		const cta = cfg.link && !alreadyAtEvent(cfg)
			? el('a', { class: 'tws-eventbar-cta', href: cfg.link, 'data-cta': 'event_join', 'data-cta-loc': 'home_eventbar' }, [
					el('span', { text: cfg.linkLabel }),
					el('span', { class: 'tws-eventbar-arrow', 'aria-hidden': 'true', text: '→' }),
				])
			: null;

		this.bar = el('aside', { class: 'tws-eventbar', 'aria-label': `Event: ${cfg.name}` }, [
			el('div', { class: 'tws-eventbar-in' }, [
				el('span', { class: 'tws-eventbar-dot', 'aria-hidden': 'true' }),
				this.kicker,
				el('span', { class: 'tws-eventbar-name', text: cfg.name }),
				el('span', { class: 'tws-eventbar-when', text: formatStart(cfg.startsAt) }),
				this.clock,
				cta,
				el('button', {
					type: 'button', class: 'tws-eventbar-x', title: 'Dismiss',
					'aria-label': 'Dismiss the event announcement',
					onclick: () => {
						try { localStorage.setItem('cc-event-dismissed:' + cfg.startsAt, '1'); } catch { /* private mode: dismiss for this page view only */ }
						this.destroy();
					},
				}, [el('span', { 'aria-hidden': 'true', text: '×' })]),
			]),
		]);

		main.parentNode.insertBefore(this.bar, main);
		this._tick();
		this.timer = setInterval(() => this._tick(), 1000);
	}

	_tick() {
		const now = Date.now();
		const state = eventState(this.cfg, now);
		if (state === 'over') return this.destroy();
		this.bar.setAttribute('data-state', state);
		if (state === 'live') {
			this.kicker.textContent = 'Live now';
			this.clock.textContent = 'LIVE';
		} else {
			this.kicker.textContent = 'Upcoming';
			this.clock.textContent = clockString(this.cfg.startsAt - now);
		}
	}

	destroy() {
		clearInterval(this.timer);
		this.bar?.remove();
		this.bar = null;
	}
}

async function boot() {
	const cfg = await loadEventConfig();
	if (!cfg) return;
	let dismissed = false;
	try { dismissed = !!localStorage.getItem('cc-event-dismissed:' + cfg.startsAt); } catch { dismissed = false; }
	if (dismissed) return;
	const main = document.getElementById('main-content');
	if (!main || !main.parentNode) return;
	new HomeEventBar(cfg, main);
}

boot();
