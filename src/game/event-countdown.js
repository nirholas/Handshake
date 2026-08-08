// Event countdown for /play: lobby banner + in-world pill.
//
// Self-attaching, like ambient-crowd.js: ZERO edits to coincommunities.js or
// coincommunities-ui.js. The event window comes from src/shared/event-config.js,
// which reads /event.json (public/event.json in the repo) and is the same reader
// the home-page strip uses, so the two surfaces cannot drift apart. While an
// event is upcoming or live this mounts two views:
//
//   1. A lobby banner at the top of the lobby scroll, with the event name,
//      a ticking countdown, the start time in the player's own timezone, and
//      a CTA into the event world.
//   2. A compact fixed pill at the top of the screen while the player is
//      in-world (the lobby is `hidden`), dismissible per event.
//
// States are explicit: upcoming (countdown ticks), live (pulsing LIVE marker,
// CTA if the player is not already in the event world), and over (everything
// unmounts and the interval stops). A missing or malformed event.json mounts
// nothing; the page owes the player zero pixels when there is no event.

import {
	loadEventConfig, eventState, segments, pad, clockString, formatStart, alreadyAtEvent,
} from '../shared/event-config.js';

function el(tag, attrs = {}, children = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null) continue;
		if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const c of children) if (c) n.appendChild(c);
	return n;
}

const STYLE = `
.cc-event-banner {
	display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
	margin: 14px 0 4px; padding: 13px 16px;
	background: var(--cc-panel, rgba(12,12,14,0.78));
	border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
	border-radius: var(--cc-radius, 4px);
	color: var(--cc-text, #f5f5f6);
}
.cc-event-banner[data-state="live"] { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.35)); }
.cc-event-copy { flex: 1 1 240px; min-width: 0; }
.cc-event-kicker {
	display: inline-flex; align-items: center; gap: 7px;
	font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
	color: var(--cc-dim, #8c8c92);
}
.cc-event-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cc-live, #fff); }
[data-state="live"] .cc-event-dot { animation: cc-event-pulse 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { [data-state="live"] .cc-event-dot { animation: none; } }
@keyframes cc-event-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.75); } }
.cc-event-name { font-weight: 700; font-size: 16px; margin-top: 3px; }
.cc-event-tagline { color: var(--cc-dim, #8c8c92); font-size: 12.5px; line-height: 1.45; margin-top: 2px; }
.cc-event-when { color: var(--cc-faint, #5a5a60); font-size: 12px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.cc-event-clock { display: flex; gap: 8px; align-items: baseline; font-variant-numeric: tabular-nums; }
.cc-event-seg { text-align: center; min-width: 40px; }
.cc-event-seg b { display: block; font-size: 22px; font-weight: 700; line-height: 1.1; }
.cc-event-seg span { display: block; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--cc-dim, #8c8c92); margin-top: 2px; }
.cc-event-cta {
	display: inline-block; padding: 10px 18px; border-radius: var(--cc-radius, 4px);
	background: var(--cc-accent, #fff); color: var(--cc-ink, #060607);
	font-weight: 600; font-size: 13.5px; text-decoration: none; white-space: nowrap;
	transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.cc-event-cta:hover { box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.35)); transform: translateY(-1px); }
.cc-event-cta:active { transform: translateY(0); }
.cc-event-cta:focus-visible { outline: 2px solid var(--cc-edge-hi, rgba(255,255,255,0.55)); outline-offset: 2px; }
.cc-event-pill {
	position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 21;
	display: flex; align-items: center; gap: 10px;
	padding: 7px 8px 7px 13px;
	background: var(--cc-panel, rgba(12,12,14,0.78)); backdrop-filter: blur(8px);
	border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
	border-radius: 999px; color: var(--cc-text, #f5f5f6);
	font-size: 12.5px; font-variant-numeric: tabular-nums;
	transition: opacity 0.25s ease;
}
/* `display: flex` above outranks the browser's [hidden] { display: none }, so
   without this the pill kept rendering over the lobby banner while _tick marked
   it hidden: two countdowns stacked on the one screen that already has one. */
.cc-event-pill[hidden] { display: none; }
.cc-event-pill[data-state="live"] { border-color: var(--cc-edge-hi, rgba(255,255,255,0.55)); }
.cc-event-pill a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.cc-event-pill a:hover { color: #fff; }
.cc-event-pill a:focus-visible { outline: 2px solid var(--cc-edge-hi, rgba(255,255,255,0.55)); outline-offset: 2px; border-radius: 2px; }
.cc-event-pill-x {
	display: grid; place-items: center; width: 22px; height: 22px;
	border: 0; border-radius: 50%; background: transparent; color: var(--cc-dim, #8c8c92);
	font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
	transition: background 0.15s ease, color 0.15s ease;
}
.cc-event-pill-x:hover { background: rgba(255,255,255,0.12); color: #fff; }
.cc-event-pill-x:active { transform: scale(0.94); }
.cc-event-pill-x:focus-visible { outline: 2px solid var(--cc-edge-hi, rgba(255,255,255,0.55)); outline-offset: 1px; }
body.is-zen .cc-event-pill { opacity: 0; pointer-events: none; }
@media (max-width: 640px) {
	.cc-event-banner { gap: 10px; }
	.cc-event-seg { min-width: 34px; }
	.cc-event-seg b { font-size: 18px; }
	.cc-event-pill { top: auto; bottom: 148px; max-width: calc(100vw - 24px); }
}
`;

class EventCountdown {
	constructor(cfg) {
		this.cfg = cfg;
		this.dismissKey = 'cc-event-dismissed:' + cfg.startsAt;
		this.banner = null;
		this.pill = null;
		this.timer = 0;
		document.head.appendChild(el('style', { text: STYLE }));
		this._mountBanner();
		this._mountPill();
		this._tick();
		this.timer = setInterval(() => this._tick(), 1000);
	}

	_mountBanner() {
		const inner = document.querySelector('#cc-lobby .cc-lobby-inner');
		if (!inner) return;
		this.bannerClock = el('div', { class: 'cc-event-clock', 'aria-hidden': 'true' });
		this.bannerKicker = el('span', { class: 'cc-event-kicker' }, [
			el('span', { class: 'cc-event-dot', 'aria-hidden': 'true' }),
			this.bannerKickerText = el('span', { text: 'Upcoming event' }),
		]);
		this.banner = el('section', { class: 'cc-event-banner', 'aria-label': `Event: ${this.cfg.name}` }, [
			el('div', { class: 'cc-event-copy' }, [
				this.bannerKicker,
				el('div', { class: 'cc-event-name', text: this.cfg.name }),
				this.cfg.tagline ? el('div', { class: 'cc-event-tagline', text: this.cfg.tagline }) : null,
				el('div', { class: 'cc-event-when', text: `Starts ${formatStart(this.cfg.startsAt)}` }),
			]),
			this.bannerClock,
			this.cfg.link ? el('a', { class: 'cc-event-cta', href: this.cfg.link, text: this.cfg.linkLabel }) : null,
		]);
		const head = inner.querySelector('.cc-lobby-head');
		inner.insertBefore(this.banner, head ? head.nextSibling : inner.firstChild);
	}

	_mountPill() {
		if (localStorage.getItem(this.dismissKey)) return;
		this.pillText = el('span', { role: 'timer' });
		this.pillLink = this.cfg.link && !alreadyAtEvent(this.cfg)
			? el('a', { href: this.cfg.link, text: this.cfg.linkLabel })
			: null;
		this.pill = el('div', { class: 'cc-event-pill', role: 'status', hidden: true }, [
			el('span', { class: 'cc-event-dot', 'aria-hidden': 'true' }),
			this.pillText,
			this.pillLink,
			el('button', {
				type: 'button', class: 'cc-event-pill-x', 'aria-label': 'Dismiss event reminder', title: 'Dismiss',
				onclick: () => {
					localStorage.setItem(this.dismissKey, '1');
					this.pill.remove();
					this.pill = null;
				},
			}, [el('span', { 'aria-hidden': 'true', text: '×' })]),
		]);
		document.body.appendChild(this.pill);
	}

	_tick() {
		const now = Date.now();
		const state = eventState(this.cfg, now);
		if (state === 'over') return this.destroy();
		const live = state === 'live';

		if (this.banner) {
			this.banner.setAttribute('data-state', state);
			this.bannerKickerText.textContent = live ? 'Live now' : 'Upcoming event';
			if (live) {
				this.bannerClock.replaceChildren(
					el('div', { class: 'cc-event-seg' }, [el('b', { text: 'LIVE' }), el('span', { text: 'right now' })]),
				);
			} else {
				const t = segments(this.cfg.startsAt - now);
				const segs = [];
				if (t.d > 0) segs.push(['' + t.d, t.d === 1 ? 'day' : 'days']);
				segs.push([pad(t.h), 'hrs'], [pad(t.m), 'min'], [pad(t.s), 'sec']);
				this.bannerClock.replaceChildren(...segs.map(([v, label]) =>
					el('div', { class: 'cc-event-seg' }, [el('b', { text: v }), el('span', { text: label })])));
			}
		}

		if (this.pill) {
			// Only show the pill in-world; the lobby already has the full banner.
			const lobby = document.getElementById('cc-lobby');
			this.pill.hidden = !lobby || !lobby.hidden;
			this.pill.setAttribute('data-state', state);
			if (live) {
				this.pillText.textContent = `${this.cfg.name} · LIVE`;
			} else {
				this.pillText.textContent = `${this.cfg.name} · ${clockString(this.cfg.startsAt - now)}`;
			}
		}
	}

	destroy() {
		clearInterval(this.timer);
		this.banner?.remove();
		this.pill?.remove();
		this.banner = this.pill = null;
	}
}

async function boot() {
	const cfg = await loadEventConfig();
	if (!cfg) return;

	// The lobby is built by coincommunities.js at boot; wait for it to exist so
	// the banner has somewhere to mount. No deadline: a cold dev server can take
	// minutes to serve the world bundle, and a countdown that quietly skips slow
	// boots is a countdown that misses exactly the overloaded event-day machines.
	// The observer is inert until the lobby lands and disconnects the moment it
	// does; if boot dies outright, the watchdog in play.html owns that story.
	if (document.querySelector('#cc-lobby .cc-lobby-inner')) {
		new EventCountdown(cfg);
		return;
	}
	const obs = new MutationObserver(() => {
		if (!document.querySelector('#cc-lobby .cc-lobby-inner')) return;
		obs.disconnect();
		new EventCountdown(cfg);
	});
	obs.observe(document.body, { childList: true, subtree: true });
}

boot();
