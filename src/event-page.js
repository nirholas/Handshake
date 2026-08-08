// /event: the one link the community shares before and during a live event.
//
// Everything on this page is derived from ONE file: public/event.json, served at
// /event.json. That is the same config the /play lobby banner and in-world pill
// read (src/game/event-countdown.js) and the same one the in-world experience
// layer reads (src/game/meetup-event.js), so the countdown here and the countdown
// there can never disagree. There is deliberately no copy of the times in this
// module or in pages/event.html: change the schedule in one file and every
// surface moves together.
//
// Three states, all designed, all reachable:
//   upcoming: ticking days/hours/minutes/seconds to the doors opening
//   live:     a LIVE marker plus the real population of the event world
//   ended:    says the event happened and still routes people into the world,
//              because /play is open whether or not an event is running
// A missing or malformed config is a fourth, honest state: "no event scheduled",
// with the same door into the world. The page never invents an event.
//
// The schedule is rendered in the visitor's own timezone (Intl, no server round
// trip) and the "Add to calendar" button builds a real RFC 5545 .ics in the
// browser, so no third-party calendar service ever sees who is coming.

import { log } from './shared/log.js';

const CONFIG_URL = '/event.json';

// How often the live panel re-reads the world population. Slow on purpose: the
// number moves on a human timescale and this page is left open for hours.
const POPULATION_POLL_MS = 20_000;

const $ = (sel) => document.querySelector(sel);

const els = {
	hero: $('#ev-hero'),
	chipLabel: $('#ev-chip-label'),
	name: $('#ev-name'),
	tagline: $('#ev-tagline'),
	clock: $('#ev-clock'),
	cta: $('#ev-cta'),
	ctaLabel: $('#ev-cta-label'),
	cal: $('#ev-cal'),
	calNote: $('#ev-cal-note'),
	when: $('#ev-when'),
	live: $('#ev-live'),
	liveNum: $('#ev-live-num'),
	liveTitle: $('#ev-live-title'),
	liveNote: $('#ev-live-note'),
	scheduleSec: $('#ev-schedule-sec'),
	scheduleHeading: $('#ev-schedule-h'),
	scheduleLede: $('#ev-schedule-lede'),
	agenda: $('#ev-agenda'),
};

// ── config ──────────────────────────────────────────────────────────────────
// The config is a repo file, but it arrives over the network and its `link`
// becomes an href and an .ics URL. Accept only a same-origin http(s) target, so
// a swapped or tampered event.json cannot turn the page's one big button into a
// `javascript:` payload or an off-site redirect. Anything else falls back to
// /play, which is always the right door.
function safeLink(raw) {
	if (!raw) return '/play';
	try {
		const u = new URL(String(raw), location.origin);
		if (u.origin !== location.origin) return '/play';
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return '/play';
		return u.pathname + u.search + u.hash;
	} catch {
		return '/play';
	}
}

// Deliberately the same window definition the rest of the platform uses: an event
// with no usable end time is six hours long. The `rawEnd > startsAt` guard matches
// the server's parseEventWindow (multiplayer/src/event-window.js), which gates the
// event quests and leaderboard, so an inverted window in the config reads as "six
// hours from the start" on both sides instead of "already over" here and "running"
// there. That module is not imported directly because it reads process.env at load
// and would not survive the browser bundle.
function parseConfig(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const startsAt = Date.parse(raw.startsAt);
	if (!Number.isFinite(startsAt)) return null;
	const rawEnd = Date.parse(raw.endsAt);
	const endsAt = Number.isFinite(rawEnd) && rawEnd > startsAt ? rawEnd : startsAt + 6 * 3600 * 1000;
	return {
		id: String(raw.id || 'three-ws-event'),
		name: String(raw.name || 'Live event'),
		tagline: raw.tagline ? String(raw.tagline) : '',
		startsAt,
		endsAt,
		link: safeLink(raw.link),
		linkLabel: raw.linkLabel ? String(raw.linkLabel) : 'Join the event',
		agenda: Array.isArray(raw.agenda)
			? raw.agenda
					.filter((a) => a && Number.isFinite(Number(a.atMin)) && a.title)
					.map((a) => ({
						atMin: Math.max(0, Math.floor(Number(a.atMin))),
						title: String(a.title),
						detail: a.detail ? String(a.detail) : '',
						icon: a.icon ? String(a.icon) : '·',
					}))
					.sort((a, b) => a.atMin - b.atMin)
			: [],
	};
}

// ── formatting ──────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

function fmtDateTime(ts) {
	return new Intl.DateTimeFormat(undefined, {
		weekday: 'long', month: 'long', day: 'numeric',
		hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
	}).format(new Date(ts));
}

function fmtTimeOnly(ts) {
	return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
}

function fmtDateOnly(ts) {
	return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ts));
}

function localZoneName() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
	} catch {
		return '';
	}
}

// The formatted time already carries a short zone label ("UTC", "GMT+2"), so
// appending the IANA zone on top of it read "5:00 PM UTC (UTC)" for every
// visitor whose clock is on UTC. Append the zone only when it adds something
// the short label did not: "(Europe/Berlin)" after "GMT+2" tells you which city
// the clock belongs to, "(UTC)" after "UTC" is noise on the event's own page.
function zoneSuffix(ts) {
	const zone = localZoneName();
	if (!zone) return '';
	let short = '';
	try {
		short = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
			.formatToParts(new Date(ts))
			.find((p) => p.type === 'timeZoneName')?.value || '';
	} catch {
		short = '';
	}
	const norm = (s) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
	return norm(zone) === norm(short) ? '' : ` (${zone})`;
}

function segments(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

function el(tag, attrs = {}, children = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null) continue;
		if (k === 'text') n.textContent = v;
		else n.setAttribute(k, v);
	}
	for (const c of children) if (c) n.appendChild(c);
	return n;
}

function segTile(value, label, wide = false) {
	return el('div', { class: wide ? 'ev-seg ev-seg-wide' : 'ev-seg' }, [
		el('b', { text: value }),
		el('span', { text: label }),
	]);
}

// ── .ics ────────────────────────────────────────────────────────────────────
// A real RFC 5545 file, built here rather than handed to a calendar service, so
// the guest list never leaves the browser.
function icsEscape(s) {
	return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsStamp(ts) {
	const d = new Date(ts);
	return (
		d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
		pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z'
	);
}

// RFC 5545 caps a content line at 75 octets; longer lines continue on the next
// line prefixed with a single space. Folding on octets (not characters) keeps a
// multi-byte glyph in an agenda title from being split down the middle.
function icsFold(line) {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const bytes = enc.encode(line);
	if (bytes.length <= 75) return line;
	const out = [];
	let start = 0;
	let limit = 75;
	while (start < bytes.length) {
		let end = Math.min(start + limit, bytes.length);
		// Back off the cut point until it lands on a character boundary.
		while (end > start && end < bytes.length && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
		out.push((start === 0 ? '' : ' ') + dec.decode(bytes.subarray(start, end)));
		start = end;
		limit = 74; // continuation lines spend one octet on the leading space
	}
	return out.join('\r\n');
}

function buildIcs(cfg, absoluteLink) {
	const agendaLines = cfg.agenda.map((a) => `${fmtTimeOnly(cfg.startsAt + a.atMin * 60_000)} - ${a.title}`);
	const description = [cfg.tagline, ...agendaLines, `Join: ${absoluteLink}`].filter(Boolean).join('\n');
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//three.ws//Live event//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'BEGIN:VEVENT',
		`UID:${icsEscape(cfg.id)}@three.ws`,
		`DTSTAMP:${icsStamp(Date.now())}`,
		`DTSTART:${icsStamp(cfg.startsAt)}`,
		`DTEND:${icsStamp(cfg.endsAt)}`,
		`SUMMARY:${icsEscape(cfg.name)}`,
		`DESCRIPTION:${icsEscape(description)}`,
		`LOCATION:${icsEscape(absoluteLink)}`,
		`URL:${icsEscape(absoluteLink)}`,
		'END:VEVENT',
		'END:VCALENDAR',
	];
	return lines.map(icsFold).join('\r\n') + '\r\n';
}

function downloadIcs(cfg, absoluteLink) {
	const blob = new Blob([buildIcs(cfg, absoluteLink)], { type: 'text/calendar;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `${cfg.id || 'three-ws-event'}.ics`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke on the next frame: revoking synchronously races the download start
	// in Safari and the file arrives empty.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── live population ─────────────────────────────────────────────────────────
// /play presence lives in Colyseus rooms, so the count comes from the multiplayer
// server via /api/play/population. When that is unreachable the panel keeps the
// live state and drops the number: a landing page must never invent a crowd.
function coinFromLink(link) {
	try {
		return new URL(link, location.origin).searchParams.get('coin') || '';
	} catch {
		return '';
	}
}

class Population {
	constructor(coin) {
		this.coin = coin;
		this.timer = 0;
	}

	start() {
		if (this.timer) return;
		// Show the panel in its loading state rather than a placeholder digit: a
		// stand-in number would be a number the visitor could believe.
		els.liveNum.hidden = true;
		els.liveTitle.textContent = 'Checking who is in the world';
		els.liveNote.textContent = 'Reading the live count from the event world.';
		this._read();
		this.timer = setInterval(() => this._read(), POPULATION_POLL_MS);
	}

	stop() {
		clearInterval(this.timer);
		this.timer = 0;
	}

	async _read() {
		const url = this.coin
			? `/api/play/population?coin=${encodeURIComponent(this.coin)}`
			: '/api/play/population';
		let body = null;
		try {
			const res = await fetch(url, { headers: { accept: 'application/json' } });
			if (res.ok) body = await res.json();
		} catch (err) {
			log.warn('[event] population read failed:', err?.message || err);
		}
		this._render(body);
	}

	_render(body) {
		if (!body || body.ok !== true) {
			els.liveNum.hidden = true;
			els.liveTitle.textContent = 'The doors are open';
			els.liveNote.textContent = 'The event world is live right now. Walk in and find the plaza.';
			return;
		}
		const n = Math.max(0, Math.floor(Number(body.players) || 0));
		els.liveNum.hidden = false;
		els.liveNum.textContent = String(n);
		els.liveTitle.textContent = n === 1 ? 'person is in the world right now' : 'people are in the world right now';
		els.liveNote.textContent = n === 0
			? 'Nobody has walked in yet. Be the one who starts it.'
			: 'A live count from the event world, refreshed every 20 seconds.';
	}
}

// ── render ──────────────────────────────────────────────────────────────────
function renderAgenda(cfg, now, state) {
	if (!cfg.agenda.length) {
		els.scheduleSec.hidden = true;
		return;
	}
	els.scheduleSec.hidden = false;
	const zone = localZoneName();
	const inZone = zone ? ` (${zone})` : '';
	if (state === 'ended') {
		els.scheduleHeading.textContent = 'What happened';
		els.scheduleLede.textContent = `It ran ${fmtDateOnly(cfg.startsAt)}, ${fmtTimeOnly(cfg.startsAt)} to ${fmtTimeOnly(cfg.endsAt)} in your own timezone${inZone}.`;
	} else {
		els.scheduleHeading.textContent = 'The run of show';
		els.scheduleLede.textContent = `Doors at ${fmtTimeOnly(cfg.startsAt)}, wrap at ${fmtTimeOnly(cfg.endsAt)}. Every time below is converted into your own timezone${inZone}.`;
	}

	const rows = cfg.agenda.map((a, i) => {
		const at = cfg.startsAt + a.atMin * 60_000;
		const nextAt = i + 1 < cfg.agenda.length ? cfg.startsAt + cfg.agenda[i + 1].atMin * 60_000 : cfg.endsAt;
		const isNow = now >= at && now < nextAt;
		const isPast = now >= nextAt;
		const title = el('p', { class: 'ev-slot-title', text: a.title });
		if (isNow) title.appendChild(el('span', { class: 'ev-slot-badge', text: 'now' }));
		return el('div', { class: 'ev-slot', 'data-now': String(isNow), 'data-past': String(isPast) }, [
			el('div', { class: 'ev-slot-time', text: fmtTimeOnly(at) }),
			el('div', { class: 'ev-slot-mark', 'aria-hidden': 'true', text: a.icon }),
			el('div', {}, [title, a.detail ? el('p', { class: 'ev-slot-detail', text: a.detail }) : null]),
		]);
	});
	els.agenda.replaceChildren(...rows);
}

function renderNoEvent() {
	els.hero.setAttribute('data-state', 'ended');
	els.chipLabel.textContent = 'No event scheduled';
	els.name.textContent = 'The world is open anyway.';
	els.tagline.textContent =
		'Nothing is on the calendar right this minute. The three.ws world does not wait for one: ' +
		'build an avatar, walk into the shared town, and see who is already there.';
	els.clock.replaceChildren();
	els.cta.href = '/play';
	els.ctaLabel.textContent = 'Enter the three.ws world';
	els.cal.hidden = true;
	els.when.textContent = 'Follow the changelog to hear about the next one before it starts.';
	els.live.hidden = true;
	els.scheduleSec.hidden = true;
}

class EventPage {
	constructor(cfg) {
		this.cfg = cfg;
		this.absoluteLink = new URL(cfg.link, location.origin).href;
		this.population = new Population(coinFromLink(cfg.link));
		this.state = null;
		this.agendaMinute = -1;

		els.name.textContent = cfg.name;
		els.tagline.textContent = cfg.tagline || 'A live gathering inside the three.ws world.';
		els.cta.href = cfg.link;

		els.cal.addEventListener('click', () => {
			try {
				downloadIcs(cfg, this.absoluteLink);
				els.calNote.textContent = 'Calendar file downloaded. Open it to add the event.';
			} catch (err) {
				log.warn('[event] ics build failed:', err?.message || err);
				els.calNote.textContent = 'That download was blocked. The event runs ' + fmtDateTime(cfg.startsAt) + '.';
			}
		});

		this._tick();
		this.timer = setInterval(() => this._tick(), 1000);
		// A tab left open for hours drifts: recompute the moment it comes back.
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) this._tick();
		});
	}

	_tick() {
		const now = Date.now();
		const state = now >= this.cfg.endsAt ? 'ended' : now >= this.cfg.startsAt ? 'live' : 'upcoming';
		if (state !== this.state) {
			this._enterState(state);
			this.agendaMinute = -1; // force the agenda to redraw under the new state
		}
		this.state = state;

		if (state === 'upcoming') {
			const t = segments(this.cfg.startsAt - now);
			const tiles = [];
			if (t.d > 0) tiles.push(segTile(String(t.d), t.d === 1 ? 'day' : 'days'));
			tiles.push(segTile(pad(t.h), 'hours'), segTile(pad(t.m), 'minutes'), segTile(pad(t.s), 'seconds'));
			els.clock.replaceChildren(...tiles);
		} else if (state === 'live') {
			const t = segments(this.cfg.endsAt - now);
			els.clock.replaceChildren(
				segTile('LIVE', 'right now', true),
				segTile((t.d > 0 ? `${t.d}d ` : '') + `${pad(t.h)}:${pad(t.m)}:${pad(t.s)}`, 'left to join', true),
			);
		}

		// The agenda only changes on a minute boundary; redrawing it every second
		// would fight the hover state for no gain.
		const minute = Math.floor(now / 60_000);
		if (minute !== this.agendaMinute) {
			this.agendaMinute = minute;
			renderAgenda(this.cfg, now, state);
		}
	}

	_enterState(state) {
		els.hero.setAttribute('data-state', state);

		if (state === 'upcoming') {
			els.chipLabel.textContent = 'Upcoming';
			els.ctaLabel.textContent = this.cfg.linkLabel;
			els.cal.hidden = false;
			els.when.textContent = `Doors open ${fmtDateTime(this.cfg.startsAt)}${zoneSuffix(this.cfg.startsAt)}. Runs until ${fmtTimeOnly(this.cfg.endsAt)}.`;
			els.live.hidden = true;
			this.population.stop();
			return;
		}

		if (state === 'live') {
			els.chipLabel.textContent = 'Live now';
			els.ctaLabel.textContent = this.cfg.linkLabel;
			els.cal.hidden = false;
			els.when.textContent = `Running now until ${fmtTimeOnly(this.cfg.endsAt)}${zoneSuffix(this.cfg.endsAt)}.`;
			els.live.hidden = false;
			this.population.start();
			return;
		}

		// Ended. The event is over; the world is not. Say what happened, then hold
		// the door open rather than leaving a dead page behind.
		els.chipLabel.textContent = 'This event has ended';
		els.clock.replaceChildren();
		els.cta.href = this.cfg.link;
		els.ctaLabel.textContent = 'Enter the world anyway';
		els.cal.hidden = true;
		els.calNote.textContent = '';
		els.when.textContent = `It ran on ${fmtDateOnly(this.cfg.startsAt)}. The world is still open, and the next event will show up here.`;
		els.live.hidden = true;
		this.population.stop();
	}
}

async function boot() {
	let raw = null;
	try {
		const res = await fetch(CONFIG_URL, { cache: 'no-cache', headers: { accept: 'application/json' } });
		if (res.ok) raw = await res.json();
	} catch (err) {
		log.warn('[event] config fetch failed:', err?.message || err);
	}
	const cfg = parseConfig(raw);
	if (!cfg) {
		renderNoEvent();
		return;
	}
	new EventPage(cfg);
}

boot();
