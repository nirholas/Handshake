// Meetup event layer for /play: the in-world experience for live community
// events in the $THREE home town.
//
// Self-attaching, like ambient-crowd.js and event-countdown.js: ZERO edits to
// coincommunities.js or coincommunities-ui.js. It polls window.__CC__, and while
// the player stands in the home town during an event window it mounts:
//
//   1. A countdown chip docked under the King of the Totem card that opens the
//      full agenda drawer (what's on, what's next, and when, in local time).
//   2. Go-live and segment-change moment banners (the gold King-banner look).
//   3. A synchronized fireworks show: sparse bursts through the live window, a
//      barrage in the finale. Deterministic per wall-clock bucket
//      (meetup-schedule.js fireworkPlan), so every client sees the same sky
//      without a single packet, the same trick the shared day/night clock uses.
//   4. A commemorative photo button: one tap captures the world, frames it with
//      the event title and date, and shares/downloads it.
//   5. A live $THREE pulse row (price, 24h, market cap) off /api/three-signal,
//      plus a one-tap Buy $THREE into the app's existing trade widget.
//
// Config comes from /event.json, the SAME file event-countdown.js reads, so the
// lobby banner, the wayfinding pill, and this layer can never disagree about
// when the event is. While this layer's chip is mounted it suppresses the
// generic pill (body.cc-meetup-ui in meetup-event.css): one countdown at a time.
//
// No event, wrong world, or malformed config: nothing mounts, the world owes
// the player zero pixels.

import './meetup-event.css';
import { isHomeTown } from './home-town.js';
import { getPowerSaver } from '../shared/frame-governor.js';
import {
	parseEvent, eventState, formatCountdown, fireworkPlan, applyPreviewOverride, PHASE, BUCKET_MS,
} from './meetup-schedule.js';

const CONFIG_URL = '/event.json';
const SIGNAL_URL = '/api/three-signal';
const REFRESH_MS = 500;           // DOM refresh cadence
const FINALE_MS = 15 * 60 * 1000; // the closing barrage window
const RING_RADIUS = 38;           // fireworks launch ring around the plaza
const MAX_LIVE_BURSTS = 14;       // hard cap on simultaneous shells
const CATCHUP_MS = 2 * 4000;      // never replay more than two buckets of missed show

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) if (c) n.appendChild(c);
	return n;
}

function fmtLocal(ts) {
	return new Intl.DateTimeFormat(undefined, {
		weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
	}).format(new Date(ts));
}

function fmtPrice(v) {
	const n = Number(v);
	if (!isFinite(n) || n <= 0) return null;
	if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
	return `$${n.toPrecision(3)}`;
}

function fmtCompactUsd(v) {
	const n = Number(v);
	if (!isFinite(n) || n <= 0) return null;
	if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
	return `$${n.toFixed(0)}`;
}

export class MeetupEvent {
	/**
	 * @param {object} opts
	 * @param {object} opts.event      parsed event (meetup-schedule.js parseEvent)
	 * @param {object} opts.cc         the live CoinCommunities app (window.__CC__)
	 * @param {Function} opts.Fireworks the Fireworks class, injected so the heavy
	 *   three.js module stays a lazy import at the boot edge and tests can run the
	 *   whole DOM layer without a WebGL scene.
	 */
	constructor({ event, cc, Fireworks }) {
		this.ev = event;
		this.cc = cc;
		this._Fireworks = Fireworks;
		this.chip = null;
		this.panel = null;
		this.banner = null;
		this.fireworks = null;
		this.mounted = false;
		this._prevPhase = null;
		this._prevSegAt = null;
		this._queue = [];          // scheduled local volley launches {atMs, angle, radiusFrac, palette, apex}
		this._lastShowMs = 0;      // deterministic-show high-water mark
		this._acc = 0;
		this._lastFrame = performance.now();
		this._signal = null;
		this._signalTimer = 0;
		this._raf = 0;
		this._loop = this._loop.bind(this);
		this._raf = requestAnimationFrame(this._loop);
		this._onKey = (e) => {
			if (e.key === 'Escape' && this.panel?.classList.contains('cc-meetup-panel--open')) this._closePanel();
		};
		window.addEventListener('keydown', this._onKey);
	}

	// ------------------------------------------------------------------ loop
	_loop(now) {
		this._raf = requestAnimationFrame(this._loop);
		const dt = Math.min(0.05, (now - this._lastFrame) / 1000);
		this._lastFrame = now;

		const cc = this.cc;
		const inWorld = cc.phase === 'world' && isHomeTown(cc.coin?.mint);
		const state = eventState(this.ev, Date.now());

		if (state.phase === PHASE.ENDED) { this.destroy(); return; }

		if (!inWorld || state.phase === PHASE.FAR) {
			if (this.mounted) this._unmount();
			this._prevPhase = null;
			return;
		}

		if (!this.mounted) this._mount(state);
		this._tickMoments(state);
		this._tickFireworks(dt, state);

		this._acc += dt * 1000;
		if (this._acc >= REFRESH_MS) {
			this._acc = 0;
			this._refreshChip(state);
			if (this.panel?.classList.contains('cc-meetup-panel--open')) this._refreshPanel(state);
		}
	}

	// ------------------------------------------------------------ mount/unmount
	_mount(state) {
		this.mounted = true;
		document.body.classList.add('cc-meetup-ui');
		this.chip = el('button', {
			id: 'cc-meetup-chip', type: 'button',
			'aria-label': `${this.ev.title}: open event agenda`, 'aria-expanded': 'false',
			onclick: () => this._togglePanel(),
		}, [
			el('span', { class: 'cc-meetup-ico', 'aria-hidden': 'true', text: '🎉' }),
			el('span', { class: 'cc-meetup-copy' }, [
				this._chipTitle = el('span', { class: 'cc-meetup-title', text: this.ev.title }),
				this._chipWhen = el('span', { class: 'cc-meetup-when' }),
			]),
		]);
		document.body.appendChild(this.chip);
		this._refreshChip(state);
		// Seed transition tracking so joining mid-event never replays the go-live
		// moment or the current segment's banner.
		if (this._prevPhase == null) {
			this._prevPhase = state.phase;
			this._prevSegAt = state.active ? state.active.atMin : null;
		}
	}

	_unmount() {
		this.mounted = false;
		document.body.classList.remove('cc-meetup-ui');
		this.chip?.remove(); this.chip = null;
		this.banner?.remove(); this.banner = null;
		this._closePanel(true);
		this.panel?.remove(); this.panel = null;
		this.fireworks?.dispose(); this.fireworks = null;
		this._queue = [];
		this._lastShowMs = 0;
		clearInterval(this._signalTimer);
		this._signalTimer = 0;
	}

	destroy() {
		cancelAnimationFrame(this._raf);
		window.removeEventListener('keydown', this._onKey);
		this._unmount();
	}

	// ------------------------------------------------------------------ chip
	_refreshChip(state) {
		if (!this.chip) return;
		// Dock under the King of the Totem card when it is up; top slot otherwise.
		const king = document.getElementById('cc-king-hud');
		const kingVisible = king && !king.hidden && king.offsetParent !== null;
		this.chip.style.top = kingVisible ? `${Math.round(king.getBoundingClientRect().bottom) + 8}px` : '12px';

		this.chip.classList.toggle('cc-meetup-preshow', state.phase === PHASE.PRESHOW);
		this.chip.classList.toggle('cc-meetup-islive', state.phase === PHASE.LIVE);
		if (state.phase === PHASE.LIVE) {
			const nxt = state.next ? ` · next: ${state.next.icon || ''} ${formatCountdown(state.msToNext)}` : '';
			this._chipWhen.innerHTML = '';
			this._chipWhen.append(el('span', { class: 'cc-meetup-live-dot', 'aria-hidden': 'true' }), `LIVE${nxt}`);
		} else if (state.phase === PHASE.AFTERGLOW) {
			this._chipWhen.textContent = 'That was the meetup. Grab a photo';
		} else {
			this._chipWhen.textContent = `Starts in ${formatCountdown(state.msToStart)}`;
		}
	}

	// ------------------------------------------------------------------ panel
	_buildPanel() {
		this._agendaList = el('div', { class: 'cc-meetup-agenda', role: 'list' });
		this._pulseRow = el('div', { class: 'cc-meetup-pulse', hidden: true });
		this.panel = el('aside', {
			id: 'cc-meetup-panel', role: 'dialog', 'aria-label': `${this.ev.title} agenda`,
		}, [
			el('div', { class: 'cc-meetup-panel-head' }, [
				el('div', {}, [
					el('div', { class: 'cc-meetup-panel-title', text: this.ev.title }),
					this.ev.subtitle ? el('div', { class: 'cc-meetup-panel-sub', text: this.ev.subtitle }) : null,
					this._panelWhen = el('div', { class: 'cc-meetup-panel-when' }),
				]),
				el('button', {
					type: 'button', class: 'cc-meetup-close', 'aria-label': 'Close agenda',
					onclick: () => this._closePanel(),
				}, [el('span', { 'aria-hidden': 'true', text: '✕' })]),
			]),
			this._agendaList,
			el('div', { class: 'cc-meetup-panel-foot' }, [
				this._pulseRow,
				el('button', {
					type: 'button', class: 'cc-meetup-photo-btn',
					onclick: () => this._capturePhoto(),
				}, [el('span', { 'aria-hidden': 'true', text: '📸' }), el('span', { text: 'Commemorative photo' })]),
				el('button', {
					type: 'button', class: 'cc-meetup-buy-btn',
					onclick: () => { this._closePanel(); try { this.cc._openBuy?.(); } catch { /* widget owns its errors */ } },
				}, [el('span', { 'aria-hidden': 'true', text: '⚡' }), el('span', { text: 'Buy $THREE' })]),
			]),
		]);
		document.body.appendChild(this.panel);
	}

	_togglePanel() {
		if (!this.panel) this._buildPanel();
		const open = !this.panel.classList.contains('cc-meetup-panel--open');
		this.panel.classList.toggle('cc-meetup-panel--open', open);
		this.chip?.setAttribute('aria-expanded', String(open));
		if (open) {
			this._refreshPanel(eventState(this.ev, Date.now()));
			this._refreshSignal();
			clearInterval(this._signalTimer);
			this._signalTimer = setInterval(() => this._refreshSignal(), 60_000);
		} else {
			clearInterval(this._signalTimer);
			this._signalTimer = 0;
		}
	}

	_closePanel(silent = false) {
		if (!this.panel) return;
		this.panel.classList.remove('cc-meetup-panel--open');
		this.chip?.setAttribute('aria-expanded', 'false');
		clearInterval(this._signalTimer);
		this._signalTimer = 0;
		if (!silent) this.chip?.focus?.();
	}

	_refreshPanel(state) {
		if (!this.panel) return;
		if (state.phase === PHASE.LIVE) {
			this._panelWhen.textContent = `LIVE · ends in ${formatCountdown(state.msToEnd)}`;
		} else if (state.phase === PHASE.AFTERGLOW) {
			this._panelWhen.textContent = 'Just wrapped. Thanks for coming';
		} else {
			this._panelWhen.textContent = `${fmtLocal(this.ev.startsAt)} · starts in ${formatCountdown(state.msToStart)}`;
		}
		const minsIn = (Date.now() - this.ev.startsAt) / 60000;
		this._agendaList.replaceChildren(...this.ev.agenda.map((seg) => {
			const done = state.phase === PHASE.AFTERGLOW
				|| (state.phase === PHASE.LIVE && state.active && seg.atMin < state.active.atMin);
			const active = state.phase === PHASE.LIVE && state.active && seg.atMin === state.active.atMin;
			const label = active ? 'now' : done ? 'done' : formatCountdown(Math.max(0, (seg.atMin - Math.max(0, minsIn)) * 60000) + Math.max(0, this.ev.startsAt - Date.now()));
			return el('div', {
				class: `cc-meetup-seg${active ? ' cc-meetup-seg--active' : ''}${done ? ' cc-meetup-seg--done' : ''}`,
				role: 'listitem',
			}, [
				el('span', { class: 'cc-meetup-seg-ico', 'aria-hidden': 'true', text: seg.icon || '•' }),
				el('span', {}, [
					el('div', { class: 'cc-meetup-seg-title', text: seg.title }),
					seg.detail ? el('div', { class: 'cc-meetup-seg-detail', text: seg.detail }) : null,
				]),
				el('span', { class: 'cc-meetup-seg-at', text: label }),
			]);
		}));
	}

	// ---------------------------------------------------------------- $THREE pulse
	async _refreshSignal() {
		try {
			const res = await fetch(SIGNAL_URL, { headers: { accept: 'application/json' } });
			if (!res.ok) return;
			const body = await res.json();
			const latest = body?.latest;
			const price = fmtPrice(latest?.price_usd);
			if (!price || !this._pulseRow) return;
			const chg = Number(latest?.change_24h);
			const mcap = fmtCompactUsd(latest?.market_cap_usd);
			this._pulseRow.replaceChildren(
				el('span', {}, [el('b', { text: '$THREE ' }), el('span', { text: price })]),
				isFinite(chg)
					? el('span', { class: chg >= 0 ? 'cc-meetup-up' : 'cc-meetup-down', text: `${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h` })
					: el('span', { text: '' }),
				mcap ? el('span', {}, [el('span', { text: 'MC ' }), el('b', { text: mcap })]) : el('span', { text: '' }),
			);
			this._pulseRow.hidden = false;
		} catch { /* pulse row simply stays hidden */ }
	}

	// ---------------------------------------------------------------- moments
	_tickMoments(state) {
		const prev = this._prevPhase;
		if (prev == null) return; // seeded on mount
		if (state.phase !== prev) {
			this._prevPhase = state.phase;
			if (state.phase === PHASE.PRESHOW) {
				this.cc.ui?.toast?.(`${this.ev.title} starts in ${formatCountdown(state.msToStart)}. Stick around!`, 'info');
			} else if (state.phase === PHASE.LIVE) {
				this._moment('🎉', this.ev.title, 'LIVE NOW');
				this._volley(12, 7000);
				try { this.cc.env?.flashRing?.(0xffce5c, 1); } catch { /* cosmetic */ }
				this._prevSegAt = state.active ? state.active.atMin : null;
			} else if (state.phase === PHASE.AFTERGLOW) {
				this._moment('📸', 'Thanks for being here', 'Grab your commemorative photo from the event menu');
				this._volley(10, 6000);
			}
			return;
		}
		if (state.phase === PHASE.LIVE) {
			const at = state.active ? state.active.atMin : null;
			if (at !== this._prevSegAt) {
				this._prevSegAt = at;
				if (state.active) {
					this._moment(state.active.icon || '🎪', state.active.title, state.active.detail || '');
					this._volley(4, 3000);
				}
			}
		}
	}

	_moment(icon, title, sub) {
		if (!this.banner) {
			this.banner = el('div', { id: 'cc-meetup-banner', 'aria-live': 'assertive' });
			document.body.appendChild(this.banner);
		}
		this.banner.replaceChildren(
			el('div', { class: 'cc-meetup-banner-ico', 'aria-hidden': 'true', text: icon }),
			el('div', { class: 'cc-meetup-banner-title', text: title }),
			sub ? el('div', { class: 'cc-meetup-banner-sub', text: sub }) : null,
		);
		this.banner.classList.remove('cc-meetup-banner--show');
		void this.banner.offsetWidth;
		this.banner.classList.add('cc-meetup-banner--show');
		clearTimeout(this._bannerTimer);
		this._bannerTimer = setTimeout(() => this.banner?.classList.remove('cc-meetup-banner--show'), 4500);
	}

	// --------------------------------------------------------------- fireworks
	_ensureFireworks() {
		if (!this.fireworks && this._Fireworks && this.cc.scene) this.fireworks = new this._Fireworks({ scene: this.cc.scene });
		return this.fireworks;
	}

	// A local celebratory volley (go-live, segment change). Spread over spanMs.
	_volley(count, spanMs) {
		const n = getPowerSaver() ? Math.ceil(count / 2) : count;
		const now = Date.now();
		for (let i = 0; i < n; i++) {
			this._queue.push({
				atMs: now + (i / n) * spanMs + Math.random() * 400,
				angle: Math.random() * Math.PI * 2,
				radiusFrac: 0.55 + Math.random() * 0.45,
				palette: Math.floor(Math.random() * 6),
				apex: 16 + Math.random() * 10,
			});
		}
	}

	_tickFireworks(dt, state) {
		const now = Date.now();
		// Deterministic shared show: sparse through the live window, barrage in
		// the finale. Everyone computes the same plan from the same wall clock.
		if (state.phase === PHASE.LIVE) {
			let intensity = 0.3;
			if (state.msToEnd <= FINALE_MS) intensity = 1 + 1.6 * (1 - state.msToEnd / FINALE_MS);
			if (getPowerSaver()) intensity *= 0.5;
			if (this._lastShowMs === 0) this._lastShowMs = now;
			// Never replay a backlog. requestAnimationFrame is paused while the tab
			// is hidden, so a player who tabs away for ten minutes would otherwise
			// come back to every missed bucket detonating in one frame. The show is
			// a shared moment, not a queue to catch up on: drop what was missed and
			// rejoin it live.
			this._lastShowMs = Math.max(this._lastShowMs, now - CATCHUP_MS);
			// Cover the buckets the window [lastShowMs, now] touches.
			for (let b = Math.floor(this._lastShowMs / BUCKET_MS); b <= Math.floor(now / BUCKET_MS); b++) {
				for (const l of fireworkPlan(this.ev.id, b * BUCKET_MS, { intensity })) {
					if (l.atMs > this._lastShowMs && l.atMs <= now) {
						this._queue.push({ atMs: l.atMs, angle: l.angle, radiusFrac: l.radius, palette: l.palette, apex: l.apex });
					}
				}
			}
			this._lastShowMs = now;
		} else {
			this._lastShowMs = 0;
		}

		if (this._queue.length) {
			const due = this._queue.filter((q) => q.atMs <= now);
			if (due.length) {
				this._queue = this._queue.filter((q) => q.atMs > now);
				const fw = this._ensureFireworks();
				if (fw) {
					for (const q of due) {
						if (fw.liveCount >= MAX_LIVE_BURSTS) break;
						fw.launch(Math.cos(q.angle) * RING_RADIUS * q.radiusFrac, Math.sin(q.angle) * RING_RADIUS * q.radiusFrac, {
							apex: q.apex, palette: q.palette,
						});
					}
				}
			}
		}
		this.fireworks?.tick(dt);
	}

	// ------------------------------------------------------------------ photo
	// The commemorative photo IS /play's photo mode (src/game/photo-mode.js): the
	// same offscreen capture, the same monochrome share card, the same download
	// and clipboard actions. It stamps itself with this event's name on its own,
	// because it reads the same /event.json this layer does, so there is nothing
	// event-specific to pass and nothing to keep in sync. Closing the agenda first
	// keeps the drawer out from behind the preview.
	_capturePhoto() {
		this._closePanel();
		this.cc._openPhotoMode?.();
	}
}

// Fireworks drags in three.js geometry churn, so it is imported only once an
// event that can actually mount is confirmed: a plain /play visit with no live
// event never pays for it.
export async function boot() {
	let cfg = null;
	try {
		const res = await fetch(CONFIG_URL, { cache: 'no-cache' });
		if (res.ok) cfg = parseEvent(await res.json());
	} catch { /* no event, mount nothing */ }

	// Local preview: ?meetup=now starts the event 20s from load; ?meetup=<ISO>
	// shifts the whole window to that start (applyPreviewOverride, shared with
	// every other surface that reads the event).
	cfg = applyPreviewOverride(cfg, location.search);

	if (!cfg) return null;
	if (eventState(cfg, Date.now()).phase === PHASE.ENDED) return null;

	const { Fireworks } = await import('./fireworks.js');

	// Wait for the app the same way ambient-crowd.js does.
	return new Promise((resolve) => {
		let tries = 0;
		(function wait() {
			const cc = window.__CC__;
			if (cc) resolve(new MeetupEvent({ event: cfg, cc, Fireworks }));
			else if (++tries < 300) setTimeout(wait, 300);
			else resolve(null);
		})();
	});
}

boot();
