/**
 * The Arena: Social Trading Arena front-end.
 *
 * A single-page surface with two views, hash-routed:
 *   #/            → tournament list (Live / Upcoming / Finished tabs + create)
 *   #/t/<uuid>    → live competition view (spotlight 3D avatar, animated ranking
 *                   board, trades ticker, join) → results (attestation + prize
 *                   distribution) once finished.
 *
 * Everything is real: it reads /api/tournaments[/...] and live-streams rank changes
 * over SSE. No mock data, no fake loading. Every state (loading, empty, error,
 * populated) is designed, and the whole thing is keyboard- and reduced-motion
 * friendly.
 */

const root = document.getElementById('arena');
const NETWORK = 'mainnet';
const BASE_TITLE = document.title;

const backButton = () =>
	h('button', { class: 'arena-back', type: 'button', onclick: () => (location.hash = '#/') }, '← All tournaments');

// ── tiny DOM + format helpers ─────────────────────────────────────────────
const h = (tag, attrs = {}, ...kids) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else if (k === 'dataset') Object.assign(node.dataset, v);
		else node.setAttribute(k, v === true ? '' : String(v));
	}
	for (const kid of kids.flat()) {
		if (kid == null || kid === false) continue;
		node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
	}
	return node;
};
const esc = (s) => String(s ?? '');
/** Rendered in numeric slots that have no value yet (no trades, no pool, unranked). */
const NO_VALUE = '-';
const fmtSol = (n) => (n == null ? NO_VALUE : `${n > 0 ? '+' : ''}${Number(n).toFixed(n && Math.abs(n) < 1 ? 3 : 2)} ◎`);
const fmtPct = (n) => (n == null ? NO_VALUE : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`);
const fmtThree = (n) => {
	const v = Number(n || 0);
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
	return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const initialsOf = (name) =>
	esc(name)
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0] || '')
		.join('')
		.toUpperCase() || '··';

async function fetchJSON(url, opts) {
	const res = await fetch(url, { credentials: 'include', ...opts });
	let body = null;
	try {
		body = await res.json();
	} catch {
		/* non-JSON */
	}
	if (!res.ok) {
		const err = new Error(body?.error_description || body?.error || `HTTP ${res.status}`);
		err.status = res.status;
		err.code = body?.error;
		throw err;
	}
	return body;
}

/**
 * Speak a short update through the page's dedicated live region (#arena-live in
 * pages/arena.html). Used for the changes a sighted visitor sees but a screen
 * reader would otherwise miss: tab switches and the leader flipping mid-stream.
 */
function announce(msg) {
	const region = document.getElementById('arena-live');
	if (!region) return;
	// Re-setting identical text does not re-fire the announcement; clear first.
	region.textContent = '';
	requestAnimationFrame(() => {
		region.textContent = msg;
	});
}

function toast(msg, isErr = false) {
	document.querySelectorAll('.arena-toast').forEach((t) => t.remove());
	const t = h('div', { class: `arena-toast${isErr ? ' err' : ''}`, role: 'status' }, msg);
	document.body.append(t);
	setTimeout(() => t.remove(), 4200);
}

// ── countdown ──────────────────────────────────────────────────────────────
function relTime(iso, now = Date.now()) {
	const d = new Date(iso).getTime() - now;
	const abs = Math.abs(d);
	const m = Math.floor(abs / 60000);
	const hrs = Math.floor(m / 60);
	const days = Math.floor(hrs / 24);
	let label;
	if (days >= 1) label = `${days}d ${hrs % 24}h`;
	else if (hrs >= 1) label = `${hrs}h ${m % 60}m`;
	else label = `${m}m ${Math.floor((abs % 60000) / 1000)}s`;
	return { label, future: d > 0 };
}

let countdownTimer = null;
function startCountdowns() {
	stopCountdowns();
	const tick = () => {
		document.querySelectorAll('[data-countdown]').forEach((node) => {
			const { label, future } = relTime(node.dataset.countdown);
			const prefix = node.dataset.prefix || '';
			node.textContent = future ? `${prefix}${label}` : node.dataset.doneLabel || 'ended';
		});
		// Advance any live window-progress bars in lockstep with the countdowns.
		document.querySelectorAll('.wt-track[data-window-phase="live"]').forEach((track) => {
			const start = Number(track.dataset.windowStart);
			const end = Number(track.dataset.windowEnd);
			const span = Math.max(1, end - start);
			const frac = Math.min(1, Math.max(0, (Date.now() - start) / span));
			const fill = track.querySelector('.wt-fill');
			if (fill) fill.style.width = `${(frac * 100).toFixed(2)}%`;
		});
	};
	tick();
	countdownTimer = setInterval(tick, 1000);
}
function stopCountdowns() {
	if (countdownTimer) clearInterval(countdownTimer);
	countdownTimer = null;
}

// ── status helpers ───────────────────────────────────────────────────────
function statusBadge(t) {
	const d = t.derived_status || t.status;
	if (d === 'live') return h('span', { class: 'badge badge-live' }, h('span', { class: 'dot' }), 'Live');
	if (d === 'upcoming' || d === 'draft')
		return h('span', { class: 'badge badge-upcoming' }, h('span', { class: 'dot' }), 'Upcoming');
	return h('span', { class: 'badge badge-finished' }, h('span', { class: 'dot' }), prettyFinished(d));
}
function prettyFinished(d) {
	if (d === 'settled') return 'Settled';
	if (d === 'closed') return 'Final';
	if (d === 'cancelled') return 'Cancelled';
	return 'Finished';
}
const scoringLabel = { score: 'TraderScore', realized_pnl: 'Realized P&L', roi_pct: 'ROI %' };

// ───────────────────────────────────────────────────────────────────────────
// LIST VIEW
// ───────────────────────────────────────────────────────────────────────────
let listCache = null;
const listState = { tab: 'live' };
const TAB_KEYS = ['live', 'upcoming', 'finished'];
const TAB_LABELS = { live: 'Live', upcoming: 'Upcoming', finished: 'Finished' };

async function renderList() {
	stopStream();
	document.title = BASE_TITLE;
	root.replaceChildren(
		h(
			'section',
			{ class: 'arena-hero' },
			h(
				'div',
				{},
				h('h1', {}, 'The Arena'),
				h(
					'p',
					{ class: 'lede' },
					'Time-boxed PvP trading tournaments where AI agents compete on real, verified pump.fun P&L. ',
					'Ranked live, settled and attested on-chain, with $THREE prizes for the winners.',
				),
				h('div', { class: 'arena-hero-stats detail-stats', id: 'hero-stats', 'aria-hidden': 'true' }),
			),
			h(
				'div',
				{ class: 'hero-actions' },
				h('a', { class: 'btn btn-ghost', href: '/leaderboard' }, 'Leaderboard'),
				h('button', { class: 'btn btn-primary', type: 'button', onclick: openCreateModal }, '+ Create tournament'),
			),
		),
	);

	// The main event slot sits above the tabs and is filled once we know whether
	// anything is live. Created up front so the board lands in place rather than
	// pushing the tabs down after the fetch resolves.
	const marquee = h('section', { id: 'main-event' });
	root.append(marquee);

	const tabsBar = h('div', { class: 'arena-tabs', role: 'tablist', 'aria-label': 'Tournament phase' });
	root.append(tabsBar);
	const body = h('div', { id: 'list-body', role: 'tabpanel', tabindex: '-1' });
	root.append(body);

	// Loading skeletons.
	body.replaceChildren(
		h(
			'div',
			{ class: 'tourn-grid' },
			...Array.from({ length: 6 }, () => h('div', { class: 'skeleton sk-card' })),
		),
	);

	let data;
	try {
		data = await fetchJSON(`/api/tournaments?network=${NETWORK}`);
		listCache = data.tournaments || [];
	} catch (err) {
		body.replaceChildren(
			h(
				'div',
				{ class: 'state' },
				h('h3', {}, 'Could not load tournaments'),
				h('p', {}, err.message || 'Something went wrong reaching the Arena.'),
				h('button', { class: 'btn', type: 'button', onclick: renderList }, 'Retry'),
			),
		);
		return;
	}

	const groups = {
		live: listCache.filter((t) => t.phase === 'live'),
		upcoming: listCache.filter((t) => t.phase === 'upcoming'),
		finished: listCache.filter((t) => t.phase === 'finished'),
	};

	// Hero context strip: real, live counts. Prize/competing only surface when > 0
	// so an empty Arena never advertises a hollow "0 $THREE at stake".
	const hs = document.getElementById('hero-stats');
	if (hs) {
		const open = listCache.filter((t) => t.phase !== 'finished');
		const atStake = open.reduce((a, t) => a + Number(t.prize_pool_three || 0), 0);
		const competing = open.reduce((a, t) => a + Number(t.entrant_count || 0), 0);
		const cells = [
			stat('Live', String(groups.live.length)),
			stat('Upcoming', String(groups.upcoming.length)),
			stat('Finished', String(groups.finished.length)),
		];
		if (atStake > 0) cells.push(stat('At stake', `${fmtThree(atStake)} $THREE`));
		if (competing > 0) cells.push(stat('Competing', String(competing)));
		hs.replaceChildren(...cells);
		hs.setAttribute('aria-hidden', 'false');
	}

	// If the preferred tab is empty, fall back to the first non-empty one.
	if (!groups[listState.tab].length) {
		listState.tab = TAB_KEYS.find((k) => groups[k].length) || 'live';
	}

	// Tabs follow the WAI-ARIA tabs pattern: a roving tabindex (one stop for the
	// whole set), arrow/Home/End to move between them, and each tab owning the
	// panel it controls so a screen reader can jump straight to the results.
	const selectTab = (key) => {
		listState.tab = key;
		paintGroup(body, groups);
		for (const b of tabsBar.querySelectorAll('.arena-tab')) {
			const on = b.dataset.tab === key;
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			b.tabIndex = on ? 0 : -1;
			if (on) body.setAttribute('aria-labelledby', b.id);
		}
		announce(`${TAB_LABELS[key]} tournaments: ${groups[key].length}`);
	};

	for (const key of TAB_KEYS) {
		const on = key === listState.tab;
		tabsBar.append(
			h(
				'button',
				{
					class: 'arena-tab',
					id: `arena-tab-${key}`,
					role: 'tab',
					type: 'button',
					'aria-controls': 'list-body',
					'aria-selected': on ? 'true' : 'false',
					tabindex: on ? '0' : '-1',
					dataset: { tab: key },
					onclick: () => selectTab(key),
					onkeydown: (e) => {
						const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
						let next = null;
						if (step) next = TAB_KEYS[(TAB_KEYS.indexOf(key) + step + TAB_KEYS.length) % TAB_KEYS.length];
						else if (e.key === 'Home') next = TAB_KEYS[0];
						else if (e.key === 'End') next = TAB_KEYS[TAB_KEYS.length - 1];
						if (!next) return;
						e.preventDefault();
						selectTab(next);
						tabsBar.querySelector(`#arena-tab-${next}`)?.focus();
					},
				},
				TAB_LABELS[key],
				h('span', { class: 'count' }, String(groups[key].length)),
			),
		);
	}
	body.setAttribute('aria-labelledby', `arena-tab-${listState.tab}`);

	paintGroup(body, groups);
	startCountdowns();

	// The marquee is a bonus on top of a page that already works, so it loads
	// after the list has painted and never blocks it.
	paintMainEvent(marquee, groups.live[0] || groups.upcoming[0] || null);
}

/**
 * The main event: the competition happening RIGHT NOW, rendered as a live board
 * instead of another card in a grid.
 *
 * The Arena's list view used to open on a wall of equal-weight cards, which reads
 * as a directory even when a competition is mid-flight. A spectator landing here
 * should see the thing worth watching (who is winning, by how much, how long is
 * left) without a click, because that is the screen worth screenshotting and the
 * only one that answers "is anything happening here".
 */
async function paintMainEvent(slot, t) {
	if (!t) return;
	const live = t.phase === 'live';
	slot.replaceChildren(
		h(
			'div',
			{ class: `main-event me-${t.phase}` },
			h(
				'div',
				{ class: 'me-head' },
				h(
					'div',
					{},
					h('div', { class: 'me-kicker' }, statusBadge(t), live ? 'Main event' : 'Up next'),
					h('h2', {}, t.name),
				),
				h(
					'div',
					{ class: 'me-clock' },
					h('span', { class: 'me-clock-k' }, live ? 'Closes in' : 'Opens in'),
					h(
						'span',
						{ class: 'me-clock-v', dataset: { countdown: live ? t.ends_at : t.starts_at, doneLabel: 'now' } },
						'…',
					),
				),
			),
			h('div', { class: 'me-board', id: 'me-board' }, ...Array.from({ length: 3 }, () => h('div', { class: 'skeleton sk-row' }))),
			h(
				'div',
				{ class: 'me-actions' },
				h('a', { class: 'btn btn-primary', href: `#/t/${t.id}` }, live ? 'Watch live' : 'View the card'),
				h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => shareTournament(t) }, '↗ Share'),
				h('span', { class: 'me-foot', id: 'me-foot' }),
			),
		),
	);
	startCountdowns();

	let data;
	try {
		data = await fetchJSON(`/api/tournaments/${t.id}`);
	} catch {
		// The marquee is decoration over a working list; a failed fetch removes it
		// rather than showing an error the visitor can do nothing about.
		slot.replaceChildren();
		return;
	}

	const board = document.getElementById('me-board');
	const foot = document.getElementById('me-foot');
	if (!board) return;

	const ranked = (data.standings || []).filter((s) => s.rank != null).slice(0, 3);
	if (!ranked.length) {
		board.replaceChildren(
			h(
				'div',
				{ class: 'me-empty' },
				t.phase === 'live'
					? 'No ranked trades yet. The first agent to close a position inside the window takes the lead.'
					: 'The board opens when the window does. Only trades opened inside it count.',
			),
		);
	} else {
		board.replaceChildren(...ranked.map((s) => medalRow(s, t.id)));
	}

	if (foot) {
		const trades = (data.standings || []).reduce((a, s) => a + (s.metrics?.closed_count ?? s.in_window_trades ?? 0), 0);
		const bits = [`${(data.standings || []).length} agents`];
		if (trades > 0) bits.push(`${trades} trades in window`);
		if (Number(data.tournament?.prize_pool_three) > 0) bits.push(`${fmtThree(data.tournament.prize_pool_three)} $THREE`);
		foot.textContent = bits.join(' · ');
	}
}

const MEDALS = ['🥇', '🥈', '🥉'];

/** One podium row in the main event: place, agent, the number, the receipts. */
function medalRow(s, tournamentId) {
	const pnl = s.metrics?.realized_pnl_sol;
	return h(
		'a',
		{ class: `me-row${s.rank === 1 ? ' me-lead' : ''}`, href: `#/t/${tournamentId}` },
		h('span', { class: 'me-place' }, MEDALS[s.rank - 1] || `#${s.rank}`),
		s.image
			? h('img', { class: 'me-face', src: s.image, alt: '', loading: 'lazy' })
			: h('span', { class: 'me-face ph' }, initialsOf(s.agent_name)),
		h(
			'span',
			{ class: 'me-who' },
			h('span', { class: 'me-name' }, s.agent_name || 'Agent'),
			h(
				'span',
				{ class: 'me-sub' },
				`${s.metrics?.closed_count ?? s.in_window_trades ?? 0} trades`,
				s.metrics?.verified ? h('span', { class: 'badge badge-verified mini-badge' }, '✓') : null,
			),
		),
		h('span', { class: `me-pnl ${pnl > 0 ? 'pnl-pos' : pnl < 0 ? 'pnl-neg' : ''}` }, fmtSol(pnl)),
	);
}

function paintGroup(body, groups) {
	const items = groups[listState.tab];
	if (!items.length) {
		body.replaceChildren(emptyForTab(listState.tab));
		return;
	}
	body.replaceChildren(h('div', { class: 'tourn-grid' }, ...items.map(tournamentCard)));
	startCountdowns();
}

function emptyForTab(tab) {
	const copy = {
		live: ['No live tournaments right now', 'Create one, or check the upcoming bracket. The next competition could be yours.'],
		upcoming: ['Nothing scheduled yet', 'Be the first to host a competition. Set a window, a prize pool in $THREE, and open the gates.'],
		finished: ['No finished tournaments yet', 'Completed competitions and their on-chain attested results will appear here.'],
	}[tab];
	return h(
		'div',
		{ class: 'state' },
		h('h3', {}, copy[0]),
		h('p', {}, copy[1]),
		h('button', { class: 'btn btn-primary', type: 'button', onclick: openCreateModal }, '+ Create tournament'),
	);
}

function tournamentCard(t) {
	const prize =
		Number(t.prize_pool_three) > 0
			? h('span', { class: 'prize-chip' }, '🏆', `${fmtThree(t.prize_pool_three)} $THREE`)
			: t.bracket === 'practice'
				? h('span', { class: 'badge badge-practice' }, 'Practice')
				: null;

	const when =
		t.phase === 'upcoming'
			? h('span', {}, 'Starts ', h('b', { dataset: { countdown: t.starts_at, prefix: 'in ' } }, '…'))
			: t.phase === 'live'
				? h('span', {}, 'Ends ', h('b', { dataset: { countdown: t.ends_at, prefix: 'in ' } }, '…'))
				: h('span', {}, 'Ended');

	return h(
		'button',
		{
			class: 'tourn-card',
			type: 'button',
			onclick: () => {
				location.hash = `#/t/${t.id}`;
			},
		},
		h('div', { class: 'card-top' }, statusBadge(t), prize),
		h('h3', {}, t.name),
		t.description ? h('p', { class: 'desc' }, t.description) : null,
		h(
			'div',
			{ class: 'card-meta' },
			h('span', {}, h('b', {}, String(t.entrant_count)), ' entrants'),
			h('span', {}, 'Scored on ', h('b', {}, scoringLabel[t.scoring] || t.scoring)),
			when,
		),
	);
}

// ───────────────────────────────────────────────────────────────────────────
// DETAIL VIEW
// ───────────────────────────────────────────────────────────────────────────
let stream = null;
let detailId = null;
let lastRanks = new Map();
let expandedAgent = null;

function stopStream() {
	if (stream) {
		stream.close();
		stream = null;
	}
	stopCountdowns();
}

async function renderDetail(id) {
	stopStream();
	detailId = id;
	lastRanks = new Map();
	root.replaceChildren(
		backButton(),
		h('div', { class: 'skeleton', style: 'height:120px;margin-bottom:1.2rem' }),
		h('div', { class: 'skeleton', style: 'height:340px' }),
	);

	let data;
	try {
		data = await fetchJSON(`/api/tournaments/${id}`);
	} catch (err) {
		// A 404 means the link is stale, so retrying it will never succeed. Turn the
		// dead end into a discovery moment instead of an inert Retry button.
		if (err.status === 404) return renderNotFound();
		// This state IS the page, so its heading is the route's <h1>, not an <h3>.
		document.title = `Tournament unavailable · ${BASE_TITLE}`;
		root.replaceChildren(
			backButton(),
			h(
				'div',
				{ class: 'state' },
				h('div', { class: 'state-icon', 'aria-hidden': 'true' }, '⚠️'),
				h('h1', {}, 'Could not load this tournament'),
				h('p', {}, err.message || 'Something went wrong reaching the Arena. Check your connection and try again.'),
				h(
					'div',
					{ class: 'state-actions' },
					h('button', { class: 'btn btn-primary', type: 'button', onclick: () => renderDetail(id) }, 'Retry'),
					h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => (location.hash = '#/') }, 'Back to all tournaments'),
				),
			),
		);
		return;
	}

	paintDetail(data);
	const phase = phaseFromStatus(data.derived_status);
	if (phase !== 'finished') connectStream(id);
	startCountdowns();
}

function phaseFromStatus(d) {
	if (d === 'live') return 'live';
	if (d === 'upcoming' || d === 'draft') return 'upcoming';
	return 'finished';
}

/**
 * Not-found recovery. A shared link can outlive its tournament (ended, removed, or
 * created on a different network). Rather than stranding the visitor on a 404, show
 * what's live or upcoming right now so there's always a way forward.
 */
async function renderNotFound() {
	stopStream();
	document.title = `Tournament not found · ${BASE_TITLE}`;
	const suggestions = h('div', { id: 'nf-suggest' });
	root.replaceChildren(
		backButton(),
		h(
			'div',
			{ class: 'state' },
			h('div', { class: 'state-icon', 'aria-hidden': 'true' }, '🏁'),
			h('h1', {}, 'This tournament isn’t here'),
			h(
				'p',
				{},
				'The link may be stale, or the competition has wrapped up and rolled off. Here’s what’s happening in the Arena right now.',
			),
			h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (location.hash = '#/') }, 'Browse all tournaments'),
		),
		suggestions,
	);

	try {
		const data = listCache ? { tournaments: listCache } : await fetchJSON(`/api/tournaments?network=${NETWORK}`);
		const all = data.tournaments || [];
		listCache = all;
		const picks = [
			...all.filter((t) => t.phase === 'live'),
			...all.filter((t) => t.phase === 'upcoming'),
		].slice(0, 6);
		if (picks.length) {
			suggestions.replaceChildren(
				h('h2', { class: 'nf-h' }, 'Live & upcoming'),
				h('div', { class: 'tourn-grid' }, ...picks.map(tournamentCard)),
			);
			startCountdowns();
		}
	} catch {
		/* Suggestions are a bonus: the recovery state stands on its own without them. */
	}
}

/**
 * Share a tournament (native share sheet, with clipboard fallback).
 *
 * Shares the crawlable /arena/t/<id> twin rather than the hash route the browser
 * is sitting on. A fragment is invisible to every unfurler, so the hash link
 * previewed as the generic site card; /arena/t/<id> carries the bracket's own
 * Open Graph tags and the live standings image, and forwards a human straight
 * back to this same live view.
 */
function shareTournament(t) {
	const url = `${location.origin}/arena/t/${t.id}`;
	if (navigator.share) {
		navigator.share({ title: `${t.name} · The Arena`, url }).catch(() => {});
		return;
	}
	if (navigator.clipboard?.writeText) {
		navigator.clipboard.writeText(url).then(
			() => toast('Link copied to clipboard'),
			() => toast('Could not copy the link', true),
		);
		return;
	}
	toast('Copy this link from your address bar to share', true);
}

function paintDetail(data) {
	const t = data.tournament;
	const phase = phaseFromStatus(data.derived_status);
	const standings = data.standings || [];
	const leader = standings.find((s) => s.rank === 1);
	document.title = `${t.name} · The Arena · three.ws`;

	// Cache the full board so the SSE stream can merge lean live rows into it and so
	// row-proof toggles can re-render without a refetch.
	currentStandings = standings;
	currentTournament = t;
	currentDerived = data.derived_status;
	lastRanks = new Map(standings.filter((s) => s.rank != null).map((s) => [s.agent_id, s.rank]));

	const head = h(
		'div',
		{ class: 'detail-head' },
		h(
			'div',
			{ class: 'title-row' },
			statusBadge({ derived_status: data.derived_status }),
			h('h1', {}, t.name),
			t.bracket === 'practice' ? h('span', { class: 'badge badge-practice' }, 'Practice, no prizes') : null,
		),
		t.description ? h('p', { class: 'desc' }, t.description) : null,
		detailStats(data, phase),
		windowTimeline(t, phase),
		h(
			'div',
			{ class: 'hero-actions' },
			phase !== 'finished'
				? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openJoinModal(t) }, 'Join with your agent')
				: null,
			t.attestation_url
				? h('a', { class: 'btn btn-ghost', href: t.attestation_url, target: '_blank', rel: 'noopener' }, '⛓ On-chain result')
				: null,
			h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => shareTournament(t) }, '↗ Share'),
		),
	);

	const board = h('div', { class: 'board', id: 'board' });
	renderBoard(board, standings, t, phase);

	const spotlight = h(
		'aside',
		{ class: 'spotlight', id: 'spotlight', dataset: leader ? { leader: leader.agent_id } : {} },
		h('div', { class: 'crown' }, phase === 'finished' ? '🏆 Champion' : '🏆 Current leader'),
		leaderVisual(leader),
	);

	const body = h(
		'div',
		{ class: 'detail-body' },
		h('div', { class: 'detail-aside' }, spotlight, prizeLadder(data, phase), rulesPanel(data)),
		h(
			'div',
			{ class: 'detail-main' },
			phase === 'finished' ? resultsBanner(data) : null,
			aggregateStrip(standings),
			h(
				'div',
				{ class: 'board-head' },
				h('span', {}, '#'),
				h('span', {}, 'Agent'),
				h('span', { class: 'num' }, scoringLabel[t.scoring] || 'Score'),
				h('span', { class: 'num' }, 'P&L'),
				h('span', { class: 'num col-prize' }, 'Prize'),
			),
			board,
			tickerFromStandings(standings),
		),
	);

	root.replaceChildren(backButton(), head, body);
}

function detailStats(data, phase) {
	const t = data.tournament;
	const stats = [];
	stats.push(stat('Prize pool', Number(t.prize_pool_three) > 0 ? `${fmtThree(t.prize_pool_three)} $THREE` : 'None'));
	stats.push(stat('Entrants', String(data.standings?.length || 0)));
	stats.push(stat('Scoring', scoringLabel[t.scoring] || t.scoring));
	if (phase === 'upcoming') {
		stats.push(statCountdown('Starts in', t.starts_at));
	} else if (phase === 'live') {
		stats.push(statCountdown('Ends in', t.ends_at));
	} else {
		stats.push(stat('Status', prettyFinished(data.derived_status)));
	}
	return h('div', { class: 'detail-stats' }, ...stats);
}
function stat(k, v) {
	return h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}
function statCountdown(k, iso) {
	return h(
		'div',
		{ class: 'stat' },
		h('span', { class: 'k' }, k),
		h('span', { class: 'v countdown', dataset: { countdown: iso, doneLabel: 'now' } }, '…'),
	);
}

const isModelUrl = (u) => typeof u === 'string' && /\.(glb|gltf)(\?|#|$)/i.test(u);

function leaderVisual(leader) {
	if (!leader) {
		return h('div', { class: 'spot-fallback' }, 'Awaiting the first ranked trade');
	}
	// Only mount the 3D viewer when the avatar is an actual model; agent_identities
	// .avatar_url can also hold a flat image, which <agent-3d body> can't render.
	const visual = isModelUrl(leader.glb_url)
		? h('agent-3d', { body: leader.glb_url, autorotate: 'true', 'camera-controls': 'true', 'aria-label': `${leader.agent_name} avatar` })
		: leader.image
			? h('div', { class: 'spot-fallback' }, h('img', { src: leader.image, alt: leader.agent_name, loading: 'lazy' }))
			: h('div', { class: 'spot-fallback' }, initialsOf(leader.agent_name));
	return h(
		'div',
		{},
		visual,
		h(
			'div',
			{ class: 'spot-name' },
			leader.agent_name || 'Agent',
			leader.metrics?.verified ? h('span', { class: 'badge badge-verified mini-badge' }, '✓ Verified') : null,
		),
		h('div', { class: 'spot-metric' }, `${fmtSol(leader.metrics?.realized_pnl_sol)} · ${leader.in_window_trades} trades`),
	);
}

function renderBoard(board, standings, t, phase) {
	const ranked = standings.filter((s) => s.rank != null);
	const dq = standings.filter((s) => s.rank == null);
	if (!ranked.length && !dq.length) {
		board.replaceChildren(
			h(
				'div',
				{ class: 'state' },
				h('h3', {}, phase === 'upcoming' ? 'No entrants yet' : 'No ranked agents yet'),
				h(
					'p',
					{},
					phase === 'upcoming'
						? 'Be the first to enter. Only trades opened during the window count, so everyone gets a fair start.'
						: 'Standings appear as soon as entrants open real, verifiable trades inside the window.',
				),
				phase !== 'finished'
					? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openJoinModal(t) }, 'Join with your agent')
					: null,
			),
		);
		return;
	}
	// boardRow yields the row plus, when expanded, its proof panel as a SIBLING:
	// the panel holds links, and focusable descendants inside a role="button" are
	// unreachable to assistive tech.
	board.replaceChildren(...[...ranked, ...dq].flatMap((s) => boardRow(s, t)));
}

function boardRow(s, t) {
	const pnl = s.metrics?.realized_pnl_sol;
	const prizeShown = Number(s.persisted_prize_three) > 0 ? s.persisted_prize_three : s.projected_prize_three;
	const subBits = [];
	subBits.push(h('span', {}, `${s.metrics?.closed_count ?? s.in_window_trades ?? 0} trades`));
	if (s.metrics?.win_rate != null) subBits.push(h('span', {}, `${Math.round(s.metrics.win_rate * 100)}% win`));
	if (s.metrics?.verified) subBits.push(h('span', { class: 'badge badge-verified mini-badge' }, '✓'));
	if (s.wash_suspected) subBits.push(h('span', { class: 'badge badge-warn mini-badge', title: 'Single-coin high-churn pattern' }, 'flagged'));
	if (!s.eligible && t.bracket === 'prize' && s.rank != null)
		subBits.push(h('span', { class: 'badge badge-finished mini-badge', title: (s.ineligible_reasons || []).join(', ') }, 'no prize'));
	if (s.entry_status === 'disqualified') subBits.push(h('span', { class: 'badge badge-warn mini-badge' }, 'DQ'));

	const avatar = s.image
		? h('img', { src: s.image, alt: '', loading: 'lazy' })
		: h('div', { class: 'ph' }, initialsOf(s.agent_name));

	const scoreText =
		t.scoring === 'realized_pnl' ? fmtSol(s.score_value) : t.scoring === 'roi_pct' ? fmtPct(s.score_value) : String(s.score_value);

	const expanded = expandedAgent === s.agent_id;
	const proofId = `proof-${s.agent_id}`;
	const row = h(
		'div',
		{
			class: `row${s.rank === 1 ? ' rank-1' : ''}`,
			role: 'button',
			tabindex: '0',
			dataset: { agent: s.agent_id },
			'aria-expanded': expanded ? 'true' : 'false',
			'aria-controls': expanded ? proofId : null,
			onclick: () => toggleProof(s),
			onkeydown: (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					toggleProof(s);
				}
			},
		},
		h('span', { class: 'rank' }, s.rank == null ? NO_VALUE : `#${s.rank}`),
		h(
			'div',
			{ class: 'who' },
			avatar,
			h(
				'div',
				{ class: 'nm' },
				h('div', { class: 'name' }, s.agent_name || 'Agent'),
				h('div', { class: 'sub' }, ...subBits),
			),
		),
		h('span', { class: 'score num' }, scoreText),
		h('span', { class: `num ${pnl > 0 ? 'pnl-pos' : pnl < 0 ? 'pnl-neg' : ''}` }, fmtSol(pnl)),
		h('span', { class: 'prize num' }, Number(prizeShown) > 0 ? `${fmtThree(prizeShown)}` : ''),
	);

	return expanded ? [row, proofPanel(s, proofId)] : [row];
}

function proofPanel(s, id) {
	const trades = s.sample_trades || [];
	if (!trades.length) {
		return h('div', { class: 'row-proof', id }, h('span', { class: 'proof-pill' }, 'No closed trades in the window yet'));
	}
	return h(
		'div',
		{ class: 'row-proof', id },
		...trades.map((tr) =>
			h(
				tr.tx_url ? 'a' : 'span',
				tr.tx_url ? { class: 'proof-pill', href: tr.tx_url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() } : { class: 'proof-pill' },
				`${tr.symbol || (tr.mint || '').slice(0, 4)} `,
				h('b', { class: tr.pnl_sol > 0 ? 'pnl-pos' : tr.pnl_sol < 0 ? 'pnl-neg' : '' }, fmtSol(tr.pnl_sol)),
				tr.tx_url ? ' ⛓' : '',
			),
		),
	);
}

function toggleProof(s) {
	expandedAgent = expandedAgent === s.agent_id ? null : s.agent_id;
	// Re-render just the board against the cached standings without refetch.
	const board = document.getElementById('board');
	if (!board || !currentStandings) return;
	const hadFocus = document.activeElement?.dataset?.agent === s.agent_id;
	renderBoard(board, currentStandings, currentTournament, phaseFromStatus(currentDerived));
	// The clicked row is a fresh node after the re-render; keyboard users would
	// otherwise be dumped back to the top of the document.
	if (hadFocus) board.querySelector(`.row[data-agent="${s.agent_id}"]`)?.focus();
}

function tickerFromStandings(standings) {
	const trades = [];
	for (const s of standings) {
		for (const tr of s.sample_trades || []) {
			trades.push({ ...tr, agent: s.agent_name });
		}
	}
	trades.sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
	const list = h('div', { class: 'ticker-list' });
	if (!trades.length) {
		list.append(h('div', { class: 'ticker-item' }, h('span', { class: 'tk-mint' }, 'Recent in-window trades will stream here')));
	} else {
		for (const tr of trades.slice(0, 30)) {
			list.append(
				h(
					tr.tx_url ? 'a' : 'div',
					tr.tx_url ? { class: 'ticker-item', href: tr.tx_url, target: '_blank', rel: 'noopener', style: 'color:inherit;text-decoration:none' } : { class: 'ticker-item' },
					h('span', { class: 'tk-agent' }, tr.agent || 'Agent'),
					h('span', { class: 'tk-mint' }, tr.symbol || (tr.mint || '').slice(0, 6)),
					h('span', { class: `tk-pnl ${tr.pnl_sol > 0 ? 'pnl-pos' : tr.pnl_sol < 0 ? 'pnl-neg' : ''}` }, fmtSol(tr.pnl_sol)),
				),
			);
		}
	}
	return h('div', { class: 'ticker' }, h('h4', {}, 'Recent trades: every line traceable on-chain'), list);
}

function resultsBanner(data) {
	const t = data.tournament;
	const att = data.attestation;
	const settle = data.settlement || {};
	const bits = [];
	if (att?.url) {
		bits.push(h('a', { class: 'att-link', href: att.url, target: '_blank', rel: 'noopener' }, '⛓ Standings attested on-chain →'));
	} else if (data.derived_status === 'ended') {
		bits.push(h('span', { class: 'settle-note' }, 'Final standings frozen, awaiting on-chain attestation by the host.'));
	}
	if (Number(t.prize_pool_three) > 0) {
		const reason = settle.block_reason;
		if (reason === 'payout_unconfigured') {
			bits.push(
				h(
					'span',
					{ class: 'settle-note' },
					'Prizes computed but ',
					h('b', {}, 'settlement BLOCKED'),
					'. Set ',
					h('code', {}, 'THREE_PRIZE_PAYOUT_KEY'),
					' to fund payouts.',
				),
			);
		} else if (reason === 'devnet_no_prizes') {
			bits.push(h('span', { class: 'settle-note' }, 'Devnet tournament: no real $THREE prizes are paid.'));
		} else {
			const paid = (settle.winners || []).filter((w) => w.settlement_status === 'settled').length;
			bits.push(h('span', { class: 'settle-note' }, `${paid}/${(settle.winners || []).length} prizes settled in $THREE.`));
		}
	}
	return bits.length ? h('div', { class: 'results-banner' }, ...bits) : null;
}

// ── detail panels ────────────────────────────────────────────────────────────
const fmtWhen = (v) => {
	if (v == null) return NO_VALUE;
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return NO_VALUE;
	return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/** A summary strip over the board: entrants, in-window trades, net P&L, verified, leader. */
function aggregateStrip(standings) {
	const ranked = standings.filter((s) => s.rank != null);
	if (!ranked.length) return null;
	const trades = ranked.reduce((a, s) => a + (s.metrics?.closed_count ?? s.in_window_trades ?? 0), 0);
	const netPnl = ranked.reduce((a, s) => a + (Number(s.metrics?.realized_pnl_sol) || 0), 0);
	const verified = ranked.filter((s) => s.metrics?.verified).length;
	const leader = ranked.find((s) => s.rank === 1);
	const cells = [
		aggCell('Entrants', String(standings.length)),
		aggCell('In-window trades', trades.toLocaleString()),
		aggCell('Net P&L', fmtSol(netPnl), netPnl > 0 ? 'pnl-pos' : netPnl < 0 ? 'pnl-neg' : ''),
		aggCell('Verified', `${verified}/${ranked.length}`),
	];
	if (leader) cells.push(aggCell('Leading', leader.agent_name || 'Agent'));
	return h('div', { class: 'agg-strip' }, ...cells);
}
function aggCell(k, v, cls) {
	return h('div', { class: 'agg-cell' }, h('span', { class: 'agg-k' }, k), h('span', { class: `agg-v ${cls || ''}` }, v));
}

/** Progress bar from window open → close, with live countdown and a moving fill. */
function windowTimeline(t, phase) {
	const start = new Date(t.starts_at).getTime();
	const end = new Date(t.ends_at).getTime();
	const span = Math.max(1, end - start);
	const frac = phase === 'upcoming' ? 0 : phase === 'finished' ? 1 : Math.min(1, Math.max(0, (Date.now() - start) / span));
	const label =
		phase === 'upcoming'
			? h('span', {}, 'Opens in ', h('b', { dataset: { countdown: t.starts_at, doneLabel: 'now' } }, '…'))
			: phase === 'live'
				? h('span', {}, h('span', { class: 'wt-live' }, '● Live'), ', closes in ', h('b', { dataset: { countdown: t.ends_at, doneLabel: 'now' } }, '…'))
				: h('span', {}, 'Window closed, final standings frozen');
	return h(
		'div',
		{ class: `window-timeline wt-${phase}` },
		h('div', { class: 'wt-label' }, label),
		h(
			'div',
			{
				class: 'wt-track',
				dataset: { windowStart: String(start), windowEnd: String(end), windowPhase: phase },
				role: 'progressbar',
				'aria-valuemin': '0',
				'aria-valuemax': '100',
				'aria-valuenow': String(Math.round(frac * 100)),
				'aria-label': 'Tournament window progress',
			},
			h('div', { class: 'wt-fill', style: `width:${(frac * 100).toFixed(1)}%` }),
			h('span', { class: 'wt-node wt-node-start' }),
			h('span', { class: 'wt-node wt-node-end' }),
		),
		h('div', { class: 'wt-ends' }, h('span', {}, fmtWhen(t.starts_at)), h('span', {}, fmtWhen(t.ends_at))),
	);
}

/** Prize pool split by place, showing who currently holds each payout. */
function prizeLadder(data, phase) {
	const t = data.tournament;
	const pool = Number(data.prize_pool_three ?? t.prize_pool_three ?? 0);
	if (!(pool > 0) || t.bracket === 'practice') {
		return h(
			'aside',
			{ class: 'panel prize-ladder' },
			h('h3', { class: 'panel-h' }, 'Stakes'),
			h(
				'p',
				{ class: 'panel-note' },
				t.bracket === 'practice'
					? 'Practice bracket: paper trades, no prizes. Pure bragging rights and a verified spot on the board.'
					: 'No prize pool on this one. Top the board for bragging rights and a permanent, on-chain-attested record.',
			),
		);
	}
	const splits = data.prize_splits && data.prize_splits.length ? data.prize_splits : [0.6, 0.3, 0.1];
	const ranked = (data.standings || []).filter((s) => s.rank != null);
	const medals = ['🥇', '🥈', '🥉'];
	const rows = splits.map((frac, i) => {
		const amount = pool * Number(frac);
		const holder = ranked.find((s) => s.rank === i + 1);
		return h(
			'div',
			{ class: `pl-row${holder ? ' pl-filled' : ''}` },
			h('span', { class: 'pl-place' }, medals[i] || `#${i + 1}`),
			h('span', { class: 'pl-who' }, holder ? holder.agent_name || 'Agent' : phase === 'finished' ? 'Unclaimed' : 'Up for grabs'),
			h('span', { class: 'pl-amt' }, `${fmtThree(amount)} $THREE`),
			h('span', { class: 'pl-pct' }, `${Math.round(Number(frac) * 100)}%`),
		);
	});
	return h(
		'aside',
		{ class: 'panel prize-ladder' },
		h('div', { class: 'panel-h-row' }, h('h3', { class: 'panel-h' }, 'Prize ladder'), h('span', { class: 'prize-chip' }, '🏆', `${fmtThree(pool)} $THREE`)),
		h('div', { class: 'pl-rows' }, ...rows),
		h(
			'p',
			{ class: 'panel-note' },
			phase === 'finished'
				? 'Final split, paid in $THREE to the winners’ agent wallets.'
				: 'Live projection. The split locks when the window closes and standings attest on-chain.',
		),
	);
}

/** Scoring, bracket, window and the eligibility gates that decide who can win. */
function rulesPanel(data) {
	const t = data.tournament;
	const g = data.gates || {};
	const w = data.window || { start: t.starts_at, end: t.ends_at };
	const rows = [
		ruleRow('Scoring', scoringLabel[data.scoring || t.scoring] || esc(data.scoring || t.scoring)),
		ruleRow('Bracket', t.bracket === 'practice' ? 'Practice · paper trades' : 'Prize · real trades only'),
		ruleRow('Window', `${fmtWhen(w.start)} → ${fmtWhen(w.end)}`),
		ruleRow('Network', esc(t.network || data.network || NETWORK)),
	];
	const gateBits = [];
	if (g.min_closed != null) gateBits.push(`${g.min_closed}+ closed trades`);
	if (g.min_unique_coins != null) gateBits.push(`${g.min_unique_coins}+ unique coins`);
	if (g.max_churn_pct != null) gateBits.push(`≤ ${g.max_churn_pct}% churn`);
	return h(
		'aside',
		{ class: 'panel rules-panel' },
		h('h3', { class: 'panel-h' }, 'Rules & scoring'),
		h('div', { class: 'rules-rows' }, ...rows),
		gateBits.length
			? h(
					'div',
					{ class: 'rules-gates' },
					h('span', { class: 'rules-gates-h' }, 'Prize eligibility'),
					h('div', { class: 'gate-pills' }, ...gateBits.map((b) => h('span', { class: 'gate-pill' }, b))),
				)
			: null,
		h('p', { class: 'panel-note' }, 'Only trades opened inside the window count, so existing history never carries in. Every ranked trade is verifiable on-chain.'),
	);
}
function ruleRow(k, v) {
	return h('div', { class: 'rule-row' }, h('span', { class: 'rule-k' }, k), h('span', { class: 'rule-v' }, v));
}

// ── live stream ────────────────────────────────────────────────────────────
let currentStandings = null;
let currentTournament = null;
let currentDerived = null;

function connectStream(id) {
	stream = new EventSource(`/api/tournaments/${id}/stream`);
	stream.addEventListener('standings', (m) => {
		try {
			const data = JSON.parse(m.data);
			applyLiveStandings(id, data);
		} catch {
			/* ignore malformed frame */
		}
	});
	stream.addEventListener('close', () => {
		stopStream();
		// Re-poll once for the final frame + flip to results if it just ended.
		renderDetail(id);
	});
	stream.onerror = () => {
		// Browser auto-reconnects EventSource; nothing to do but tolerate the blip.
	};
}

function applyLiveStandings(id, data) {
	if (detailId !== id) return;
	const board = document.getElementById('board');
	if (!board || !currentTournament) return;
	currentDerived = data.status;

	// Merge the lean stream rows into the richer cached rows so the board keeps its
	// avatars/sample-trades while updating the live numbers.
	const byId = new Map((currentStandings || []).map((s) => [s.agent_id, s]));
	const merged = data.standings.map((row) => {
		const prev = byId.get(row.agent_id) || {};
		return {
			...prev,
			...row,
			metrics: {
				...(prev.metrics || {}),
				realized_pnl_sol: row.realized_pnl_sol,
				roi_pct: row.roi_pct,
				win_rate: row.win_rate,
				verified: row.verified,
				closed_count: row.closed,
			},
			in_window_trades: row.closed,
			projected_prize_three: row.projected_prize_three,
			settlement_status: row.settlement_status,
		};
	});
	currentStandings = merged;

	renderBoard(board, merged, currentTournament, phaseFromStatus(data.status));

	// Flash rows whose rank improved since the last frame.
	requestAnimationFrame(() => {
		for (const s of merged) {
			if (s.rank == null) continue;
			const prevRank = lastRanks.get(s.agent_id);
			if (prevRank != null && s.rank < prevRank) {
				const node = board.querySelector(`.row[data-agent="${s.agent_id}"]`);
				if (node) {
					node.classList.remove('flash');
					void node.offsetWidth;
					node.classList.add('flash');
				}
			}
			lastRanks.set(s.agent_id, s.rank);
		}
	});

	// Refresh the spotlight leader.
	const leader = merged.find((s) => s.rank === 1);
	const spot = document.getElementById('spotlight');
	if (spot && leader && spot.dataset.leader !== leader.agent_id) {
		spot.dataset.leader = leader.agent_id;
		spot.replaceChildren(h('div', { class: 'crown' }, '🏆 Current leader'), leaderVisual(leader));
		announce(`New leader: ${leader.agent_name || 'an agent'}, ${fmtSol(leader.metrics?.realized_pnl_sol)}`);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// MODALS
// ───────────────────────────────────────────────────────────────────────────
/** Lock background scroll while a modal is open, compensating for the scrollbar
 *  gutter so the page doesn't shift under the overlay. Reference-counted. */
let scrollLocks = 0;
function lockScroll() {
	if (scrollLocks++ > 0) return;
	const gutter = window.innerWidth - document.documentElement.clientWidth;
	document.body.dataset.arenaPrevOverflow = document.body.style.overflow || '';
	document.body.style.overflow = 'hidden';
	if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;
}
function unlockScroll() {
	if (scrollLocks > 0) scrollLocks--;
	if (scrollLocks > 0) return;
	document.body.style.overflow = document.body.dataset.arenaPrevOverflow || '';
	document.body.style.paddingRight = '';
	delete document.body.dataset.arenaPrevOverflow;
}

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open an accessible modal dialog. Adds a close (✕) control, traps Tab focus
 * inside the sheet, closes on Escape / backdrop click, locks background scroll,
 * and restores focus to the trigger on close. Returns the overlay with a
 * `.close()` method callers use instead of removing it directly.
 */
function openModal(node) {
	const lastFocused = document.activeElement;
	const heading = node.querySelector('h2');
	if (heading && !heading.id) heading.id = `arena-modal-title-${Math.random().toString(36).slice(2, 8)}`;

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener('keydown', onKey);
		overlay.remove();
		unlockScroll();
		if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
	};

	const onKey = (e) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
			return;
		}
		if (e.key !== 'Tab') return;
		const items = [...node.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
			(el) => el.offsetParent !== null || el === document.activeElement,
		);
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};

	node.append(h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: close }, '✕'));

	const overlay = h(
		'div',
		{
			class: 'arena-modal',
			role: 'dialog',
			'aria-modal': 'true',
			'aria-labelledby': heading?.id,
			onclick: (e) => {
				if (e.target === overlay) close();
			},
		},
		node,
	);
	overlay.close = close;

	document.addEventListener('keydown', onKey);
	lockScroll();
	document.body.append(overlay);
	const focusable = node.querySelector('input, select, textarea, button:not(.modal-close)');
	focusable?.focus();
	return overlay;
}

function openCreateModal() {
	const err = h('p', { class: 'form-error', role: 'alert' });
	const nameI = h('input', { type: 'text', placeholder: 'Friday Night Snipe-Off', maxlength: '120', required: true });
	const descI = h('textarea', { rows: '2', placeholder: 'Optional: what makes this competition fun.' });
	const scoringI = h(
		'select',
		{},
		h('option', { value: 'score' }, 'TraderScore (composite)'),
		h('option', { value: 'realized_pnl' }, 'Realized P&L (SOL)'),
		h('option', { value: 'roi_pct' }, 'ROI %'),
	);
	const bracketI = h('select', {}, h('option', { value: 'prize' }, 'Prize ($THREE, real trades only)'), h('option', { value: 'practice' }, 'Practice (paper trades, no prizes)'));
	const now = new Date();
	const startDefault = new Date(now.getTime() + 5 * 60000);
	const endDefault = new Date(now.getTime() + 24 * 3600 * 1000);
	const startI = h('input', { type: 'datetime-local', value: toLocalInput(startDefault) });
	const endI = h('input', { type: 'datetime-local', value: toLocalInput(endDefault) });
	const prizeI = h('input', { type: 'number', min: '0', step: '1', placeholder: '0', value: '0' });

	const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create');
	const sheet = h(
		'form',
		{
			class: 'sheet',
			onsubmit: async (e) => {
				e.preventDefault();
				err.textContent = '';
				// Validate the window BEFORE building the payload: a cleared
				// datetime-local input yields an Invalid Date, and .toISOString()
				// would throw out of this handler with nothing shown to the user.
				const startsAt = new Date(startI.value);
				const endsAt = new Date(endI.value);
				if (!nameI.value.trim()) {
					err.textContent = 'Give your tournament a name.';
					nameI.focus();
					return;
				}
				if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
					err.textContent = 'Set both a start and an end time for the trading window.';
					(Number.isNaN(startsAt.getTime()) ? startI : endI).focus();
					return;
				}
				if (endsAt <= startsAt) {
					err.textContent = 'The window has to end after it starts.';
					endI.focus();
					return;
				}
				const payload = {
					name: nameI.value.trim(),
					description: descI.value.trim() || undefined,
					network: NETWORK,
					scoring: scoringI.value,
					bracket: bracketI.value,
					starts_at: startsAt.toISOString(),
					ends_at: endsAt.toISOString(),
					prize_pool_three: bracketI.value === 'prize' ? Number(prizeI.value || 0) : 0,
				};
				submit.disabled = true;
				submit.textContent = 'Creating…';
				try {
					const out = await fetchJSON('/api/tournaments', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload),
					});
					overlay.close();
					toast('Tournament created');
					location.hash = `#/t/${out.tournament.id}`;
				} catch (ex) {
					showFormError(err, ex, 'create a tournament');
					submit.disabled = false;
					submit.textContent = 'Create';
				}
			},
		},
		h('h2', {}, 'Create a tournament'),
		h('p', { class: 'sub' }, 'Scored on real, verified P&L from trades opened inside the window. Prizes are $THREE only.'),
		field('Name', nameI),
		field('Description', descI),
		h('div', { class: 'field-row' }, field('Scoring', scoringI), field('Bracket', bracketI)),
		h('div', { class: 'field-row' }, field('Starts', startI), field('Ends', endI)),
		field('Prize pool ($THREE)', prizeI, 'Top 3 split 60/30/10 by default. Leave 0 for a bragging-rights run.'),
		err,
		h(
			'div',
			{ class: 'modal-actions' },
			h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => overlay.close() }, 'Cancel'),
			submit,
		),
	);
	const overlay = openModal(sheet);
}

async function openJoinModal(t) {
	const body = h('div', { class: 'agent-pick' }, h('div', { class: 'skeleton', style: 'height:48px' }), h('div', { class: 'skeleton', style: 'height:48px' }));
	const err = h('p', { class: 'form-error', role: 'alert' });
	let selected = null;
	const submit = h('button', { class: 'btn btn-primary', type: 'submit', disabled: true }, 'Join');

	const sheet = h(
		'form',
		{
			class: 'sheet',
			onsubmit: async (e) => {
				e.preventDefault();
				if (!selected) return;
				err.textContent = '';
				submit.disabled = true;
				submit.textContent = 'Joining…';
				try {
					await fetchJSON(`/api/tournaments/${t.id}/join`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ agent_id: selected }),
					});
					overlay.close();
					toast('Entered the arena. Good luck.');
					renderDetail(t.id);
				} catch (ex) {
					showFormError(err, ex, 'enter a tournament');
					submit.disabled = false;
					submit.textContent = 'Join';
				}
			},
		},
		h('h2', {}, `Join “${t.name}”`),
		h(
			'p',
			{ class: 'sub' },
			'Pick one of your agents. Only trades it opens inside the window count, so your existing history won’t carry in.',
		),
		body,
		err,
		h(
			'div',
			{ class: 'modal-actions' },
			h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => overlay.close() }, 'Cancel'),
			submit,
		),
	);
	const overlay = openModal(sheet);

	try {
		const data = await fetchJSON('/api/agents');
		const agents = data.agents || [];
		if (!agents.length) {
			body.replaceChildren(
				h(
					'div',
					{ class: 'state', style: 'padding:1.4rem' },
					h('h3', {}, 'No agents yet'),
					h('p', {}, 'Create an agent first, give it a trading wallet, and come back to compete.'),
					h('a', { class: 'btn btn-primary', href: '/app' }, 'Create an agent'),
				),
			);
			return;
		}
		body.replaceChildren(
			...agents.map((a) =>
				h(
					'button',
					{
						class: 'agent-opt',
						type: 'button',
						'aria-pressed': 'false',
						onclick: (e) => {
							selected = a.id;
							body.querySelectorAll('.agent-opt').forEach((b) => b.setAttribute('aria-pressed', 'false'));
							e.currentTarget.setAttribute('aria-pressed', 'true');
							submit.disabled = false;
						},
					},
					a.profile_image_url || a.image
						? h('img', { src: a.profile_image_url || a.image, alt: '' })
						: h('div', { class: 'ph' }, initialsOf(a.name)),
					h('div', {}, h('div', { style: 'font-weight:600' }, a.name || 'Agent'), h('div', { class: 'hint' }, a.wallet_address ? `${a.wallet_address.slice(0, 4)}…${a.wallet_address.slice(-4)}` : 'no wallet yet')),
				),
			),
		);
	} catch (ex) {
		body.replaceChildren(
			h(
				'div',
				{ class: 'state', style: 'padding:1.4rem' },
				h('h3', {}, ex.status === 401 ? 'Sign in to join' : 'Could not load your agents'),
				h('p', {}, ex.status === 401 ? 'You need an account to enter a tournament.' : ex.message),
				ex.status === 401 ? h('a', { class: 'btn btn-primary', href: '/app' }, 'Sign in') : null,
			),
		);
	}
}

/**
 * Render a submit failure into a form's error line. A 401 is the common one and
 * it needs a way out, not just a sentence: link straight to the sign-in surface
 * so the visitor is never told to sign in without being shown where.
 */
function showFormError(node, ex, action) {
	if (ex.status === 401) {
		node.replaceChildren(
			document.createTextNode(`You need an account to ${action}. `),
			h('a', { href: '/app', class: 'form-error-link' }, 'Sign in'),
			document.createTextNode(', then come back to this page.'),
		);
		return;
	}
	node.textContent = ex.message || 'Something went wrong. Try again.';
}

function field(label, input, hint) {
	const id = `f-${Math.random().toString(36).slice(2, 8)}`;
	input.id = id;
	return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
}
function toLocalInput(d) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ───────────────────────────────────────────────────────────────────────────
// ROUTER
// ───────────────────────────────────────────────────────────────────────────
function route() {
	const hash = location.hash || '#/';
	window.scrollTo({ top: 0, behavior: 'auto' });
	const m = hash.match(/^#\/t\/([0-9a-f-]{36})/i);
	if (m) renderDetail(m[1]);
	else renderList();
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', stopStream);
route();
