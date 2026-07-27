/**
 * Mission Control — live launch feed pane.
 *
 * The left rail. Three real sources, switchable:
 *   • Live    — SSE /api/pump/trades-stream (global new-mint firehose). Brand-new
 *               pump.fun launches stream in; each row is enriched on demand with
 *               its intel score, firewall verdict, and smart-money count.
 *   • Signals — GET /api/pump/intel?view=feed: the intel engine's scored launches
 *               (already carrying quality_score + verdict), refreshed live.
 *   • Radar   — GET /api/sniper/radar (pre-launch precursors, epic task 04). When
 *               that source isn't live yet the pane shows an honest degraded
 *               state — never fabricated rows.
 *
 * The list is virtualized (fixed row height, windowed render) so a fast feed
 * never janks, and only rows actually on screen get enriched.
 */

import { createSseClient } from './realtime.js';
import {
	escapeHtml,
	formatCompactUsd,
	ageFrom,
	verdictChip,
	formatCompact,
} from './format.js';

const ROW_H = 50;
const OVERSCAN = 6;
const SIGNALS_REFRESH_MS = 12_000;

export function createFeedPane({ store, bus, enrich, mount }) {
	mount.classList.add('mc-pane', 'mc-pane--feed');
	mount.setAttribute('role', 'region');
	mount.setAttribute('aria-label', 'Live launch feed');
	mount.innerHTML = `
		<div class="mc-pane-head">
			<span class="mc-pane-title">Feed</span>
			<div class="mc-tabs" role="tablist" aria-label="Feed source">
				<button class="mc-tab" role="tab" data-src="live" aria-selected="true">Live</button>
				<button class="mc-tab" role="tab" data-src="signals" aria-selected="false">Signals</button>
				<button class="mc-tab" role="tab" data-src="radar" aria-selected="false">Radar</button>
			</div>
			<span class="mc-pane-head-spacer"></span>
			<span class="mc-pane-count" data-host="count"></span>
		</div>
		<div class="mc-filterbar" data-host="filterbar"></div>
		<div class="mc-pane-body" data-host="body" tabindex="-1">
			<div class="mc-vlist" data-host="vlist" role="listbox" aria-label="Token feed"><div class="mc-vlist-spacer" data-host="spacer" aria-hidden="true"></div></div>
		</div>
	`;

	const body = mount.querySelector('[data-host="body"]');
	const vlist = mount.querySelector('[data-host="vlist"]');
	const spacer = mount.querySelector('[data-host="spacer"]');
	const countEl = mount.querySelector('[data-host="count"]');
	const filterbar = mount.querySelector('[data-host="filterbar"]');
	const tabs = [...mount.querySelectorAll('.mc-tab')];

	let source = store.getFilters().source || 'live';
	let sse = null;
	let signalsTimer = null;
	let radarTimer = null;
	let radarState = null; // null | 'loading' | 'empty' | 'down' | 'ok'
	let connState = 'reconnecting'; // mirror of conn:feed so the body can show an honest down-state
	let rafToken = 0;
	const rowEls = new Map(); // mint -> element (in current window)

	// Single place that publishes feed connection health — drives both the topbar
	// pill and the in-pane state panel so a dead source never shows a forever-skeleton.
	function setConn(state) {
		connState = state;
		bus.emit('conn:feed', state);
		scheduleRender();
	}

	// ── filter bar ────────────────────────────────────────────────────────────
	renderFilterBar();
	function renderFilterBar() {
		const f = store.getFilters();
		filterbar.innerHTML = `
			<input class="mc-search" data-host="search" type="search" placeholder="Filter name / symbol / mint  ( / )" aria-label="Filter feed" value="${escapeHtml(f.query)}" />
			<button class="mc-chipbtn" data-f="smartOnly" aria-pressed="${f.smartOnly}">◎ Smart</button>
			<button class="mc-chipbtn" data-f="socialsOnly" aria-pressed="${f.socialsOnly}">Socials</button>
			<button class="mc-chipbtn" data-f="verdict" aria-pressed="${f.verdict !== 'any'}" title="Hide blocked / show only cleared">Safe</button>
			<button class="mc-chipbtn" data-cycle="minIntel" aria-pressed="${f.minIntel > 0}">Intel ${f.minIntel > 0 ? '≥' + f.minIntel : 'any'}</button>
			<button class="mc-chipbtn" data-cycle="mcBand" aria-pressed="${f.mcBand !== 'any'}">${mcBandLabel(f.mcBand)}</button>
			<span class="mc-views" data-host="views"></span>
		`;
		const search = filterbar.querySelector('[data-host="search"]');
		search.addEventListener('input', () => store.setFilters({ query: search.value.trim() }));
		filterbar.querySelector('[data-f="smartOnly"]').addEventListener('click', () =>
			store.setFilters({ smartOnly: !store.getFilters().smartOnly }));
		filterbar.querySelector('[data-f="socialsOnly"]').addEventListener('click', () =>
			store.setFilters({ socialsOnly: !store.getFilters().socialsOnly }));
		filterbar.querySelector('[data-f="verdict"]').addEventListener('click', () =>
			store.setFilters({ verdict: store.getFilters().verdict === 'any' ? 'warn' : 'any' }));
		filterbar.querySelector('[data-cycle="minIntel"]').addEventListener('click', () => {
			const steps = [0, 40, 60, 80];
			const cur = store.getFilters().minIntel;
			store.setFilters({ minIntel: steps[(steps.indexOf(cur) + 1) % steps.length] || 0 });
		});
		filterbar.querySelector('[data-cycle="mcBand"]').addEventListener('click', () => {
			const steps = ['any', 'nano', 'micro', 'small', 'mid'];
			const cur = store.getFilters().mcBand;
			store.setFilters({ mcBand: steps[(steps.indexOf(cur) + 1) % steps.length] });
		});
		renderViews();
	}
	function mcBandLabel(b) {
		return { any: 'Mcap any', nano: '<$10K', micro: '$10–50K', small: '$50–250K', mid: '>$250K' }[b] || 'Mcap';
	}
	function renderViews() {
		const host = filterbar.querySelector('[data-host="views"]');
		if (!host) return;
		const views = store.listViews();
		host.innerHTML = `
			${views.map((v) => `<button class="mc-chipbtn" data-view="${escapeHtml(v.name)}" title="Apply saved view">${escapeHtml(v.name)}</button>`).join('')}
			<button class="mc-chipbtn" data-host="saveview" title="Save current filters as a view">＋ Save view</button>
		`;
		host.querySelectorAll('[data-view]').forEach((b) =>
			b.addEventListener('click', () => { store.applyView(b.dataset.view); }));
		host.querySelector('[data-host="saveview"]').addEventListener('click', () => {
			const name = prompt('Name this view (filters will be saved):');
			if (name && name.trim()) store.saveView(name.trim().slice(0, 24));
		});
	}

	// ── source tabs ─────────────────────────────────────────────────────────
	for (const t of tabs) {
		t.addEventListener('click', () => switchSource(t.dataset.src));
		t.setAttribute('aria-selected', String(t.dataset.src === source));
	}

	function switchSource(next) {
		if (next === source) return;
		source = next;
		store.setFilters({ source: next });
		for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.src === next));
		stopStreams();
		store.resetFeed();
		startSource();
	}

	function stopStreams() {
		if (sse) { sse.stop(); sse = null; }
		if (signalsTimer) { clearInterval(signalsTimer); signalsTimer = null; }
		if (radarTimer) { clearInterval(radarTimer); radarTimer = null; }
		radarState = null;
		setConn('reconnecting');
	}

	function startSource() {
		if (source === 'live') startLive();
		else if (source === 'signals') startSignals();
		else startRadar();
		scheduleRender();
	}

	// Live — global pump.fun new-mint firehose.
	function startLive() {
		sse = createSseClient({
			url: '/api/pump/trades-stream',
			onState: (s) => setConn(s),
			events: {
				open: () => {},
				mint: (d) => {
					if (!d?.mint) return;
					store.upsertRow({
						mint: d.mint,
						name: d.name,
						symbol: d.symbol,
						creator: d.creator,
						market_cap_usd: d.market_cap_usd ?? null,
						market_cap_sol: d.market_cap_sol ?? null,
						image_uri: d.image_uri || null,
						twitter: d.twitter || null,
						telegram: d.telegram || null,
						website: d.website || null,
						created_at: d.created_at || Math.floor(Date.now() / 1000),
						creator_launches: d.creator_coins_count ?? null,
						creator_graduated: d.creator_graduated ?? null,
						source: 'live',
					});
					scheduleRender();
				},
				graduation: () => {},
				ping: () => {},
				close: () => {},
				error: () => {},
			},
		});
		sse.start();
	}

	// Signals — intel engine's scored feed (already carries quality_score + verdict).
	function startSignals() {
		setConn('reconnecting');
		const tick = async () => {
			try {
				const r = await fetch(`/api/pump/intel?view=feed&network=${store.getNetwork()}&limit=120`, {
					headers: { accept: 'application/json' },
				});
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const data = await r.json();
				setConn('live');
				const coins = Array.isArray(data?.coins) ? data.coins : [];
				// Newest first — the intel feed returns recent-first already.
				for (let i = coins.length - 1; i >= 0; i--) {
					const c = coins[i];
					if (!c?.mint) continue;
					store.upsertRow({
						mint: c.mint,
						name: c.name,
						symbol: c.symbol,
						creator: c.creator,
						market_cap_usd: c.market_cap_usd ?? null,
						image_uri: c.image_uri || null,
						twitter: c.twitter || null,
						telegram: c.telegram || null,
						website: c.website || null,
						created_at: c.first_seen_at_ms ? Math.floor(c.first_seen_at_ms / 1000) : null,
						intel: c, // full intel row → quality_score, verdict, risk_flags…
						source: 'signals',
					});
				}
				scheduleRender();
			} catch {
				setConn('down');
			}
		};
		tick();
		signalsTimer = setInterval(tick, SIGNALS_REFRESH_MS);
	}

	// Radar — pre-launch precursors (epic task 04, GET /api/sniper/radar). The
	// precursor stream records `events`, some of which already carry a minted
	// `mint` — those are the tradeable rows. Polled (the endpoint is cached ~5s).
	// Honest states: down (unreachable), empty (watching, nothing minted yet), ok.
	async function startRadar() {
		if (radarState == null) radarState = 'loading';
		const tick = async () => {
			try {
				const r = await fetch(`/api/sniper/radar?network=${store.getNetwork()}`, { headers: { accept: 'application/json' } });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const data = await r.json();
				const events = (Array.isArray(data?.events) ? data.events : []).filter((e) => e?.mint);
				if (data?.ok === false) { radarState = 'down'; setConn('down'); return; }
				if (!events.length) {
					radarState = 'empty';
					setConn('live'); // the source IS reachable; it just has no minted precursor yet
					return;
				}
				radarState = 'ok';
				setConn('live');
				for (const e of events) {
					const created = e.observed_ts || e.created_at;
					store.upsertRow({
						mint: e.mint,
						created_at: created ? Math.floor(new Date(created).getTime() / 1000) : Math.floor(Date.now() / 1000),
						radar: { reason: e.watch_reason || e.kind, confidence: e.confidence, score: e.watch_score, fired: e.fired },
						source: 'radar',
					});
				}
			} catch {
				// Unreachable (404 / network) — degrade honestly, no fabricated rows.
				radarState = 'down';
				setConn('down');
			}
		};
		await tick();
		radarTimer = setInterval(tick, SIGNALS_REFRESH_MS);
	}

	// ── virtualized render ─────────────────────────────────────────────────────
	function scheduleRender() {
		if (rafToken) return;
		rafToken = requestAnimationFrame(() => {
			rafToken = 0;
			render();
		});
	}

	function render() {
		const rows = store.visibleRows();
		countEl.textContent = `${rows.length}${store.allRowsCount() > rows.length ? ` / ${store.allRowsCount()}` : ''}`;

		// Non-list states own the whole body.
		const statePanel = pickStatePanel(rows);
		if (statePanel) {
			vlist.style.display = 'none';
			ensureStateHost().innerHTML = statePanel.html;
			statePanel.wire?.(ensureStateHost());
			return;
		}
		removeStateHost();
		vlist.style.display = '';

		// The list owns the scroll height; absolutely-positioned rows are windowed
		// into it. (The spacer is just a sizing sentinel kept for clarity.)
		const totalH = `${rows.length * ROW_H}px`;
		vlist.style.height = totalH;
		spacer.style.height = totalH;
		const scrollTop = body.scrollTop;
		const viewport = body.clientHeight || 600;
		const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
		const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);

		// Reconcile the window — keep elements for mints still in range, drop others.
		const wantMints = new Set();
		const selected = store.getSelected();
		const enrichSize = store.getActiveSize();
		for (let i = start; i < end; i++) {
			const row = rows[i];
			if (!row) continue;
			wantMints.add(row.mint);
			let el = rowEls.get(row.mint);
			if (!el) {
				el = document.createElement('button');
				el.className = 'mc-row';
				el.type = 'button';
				el.setAttribute('role', 'option');
				el.dataset.mint = row.mint;
				el.addEventListener('click', () => store.select(row.mint));
				vlist.appendChild(el);
				rowEls.set(row.mint, el);
				if (Date.now() - (row.firstSeen || 0) < 1200) el.classList.add('mc-enter');
			}
			el.style.transform = `translateY(${i * ROW_H}px)`;
			el.setAttribute('aria-selected', String(row.mint === selected));
			el.innerHTML = rowInnerHtml(row);
			// Enrich only what's on screen.
			if (needsEnrich(row)) enrich.ensureRow(row.mint, enrichSize);
		}
		for (const [mint, el] of rowEls) {
			if (!wantMints.has(mint)) { el.remove(); rowEls.delete(mint); }
		}
	}

	function needsEnrich(row) {
		// Signals rows arrive with intel; everything still wants safety + smart.
		return row.safety === undefined || row.smart === undefined || row.intel === undefined;
	}

	function rowInnerHtml(row) {
		const sym = escapeHtml(row.symbol || row.mint.slice(0, 4));
		const name = escapeHtml(row.name || '');
		const age = row.created_at ? ageFrom(row.created_at) : '';
		const mc = formatCompactUsd(row.market_cap_usd);
		return `
			<span class="mc-row-top">
				<span class="mc-row-sym">${sym}</span>
				<span class="mc-row-name">${name}</span>
			</span>
			<span class="mc-row-age mc-num">${age}</span>
			<span class="mc-row-meta">
				<span class="mc-row-mc mc-num">MC <b>${mc}</b></span>
				${radarChip(row)}
				${intelChip(row)}
				${safetyChip(row)}
				${smartChip(row)}
			</span>`;
	}

	function radarChip(row) {
		if (!row.radar) return '';
		const conf = row.radar.confidence != null ? ` ${Math.round(Number(row.radar.confidence) * 100)}%` : '';
		const reason = row.radar.reason ? String(row.radar.reason).replace(/_/g, ' ') : 'precursor';
		return `<span class="mc-chip mc-chip--smart" title="Pre-launch radar signal">◬ ${escapeHtml(reason)}${conf}</span>`;
	}

	function intelChip(row) {
		if (row.intel === undefined) return `<span class="mc-chip-skel"></span>`;
		const q = row.intel?.quality_score;
		if (q == null) return '';
		const v = row.intel?.verdict;
		return `<span class="mc-chip mc-chip--intel" title="Intel quality score">${Math.round(q)}${v?.label ? ` · ${escapeHtml(v.label)}` : ''}</span>`;
	}
	function safetyChip(row) {
		if (row.safety === undefined) return `<span class="mc-chip-skel"></span>`;
		if (row.safety === null) return '';
		const c = verdictChip(row.safety.verdict);
		return `<span class="mc-chip mc-chip--${c.tone}" title="Firewall verdict">${c.label}</span>`;
	}
	function smartChip(row) {
		if (row.smart === undefined) return '';
		if (!row.smart || !(row.smart.count > 0)) return '';
		return `<span class="mc-chip mc-chip--smart" title="Smart-money buyers">◎ ${formatCompact(row.smart.count)}</span>`;
	}

	// ── state panels (loading / empty / degraded) ──────────────────────────────
	function pickStatePanel(rows) {
		if (source === 'radar') {
			if (radarState === 'loading') return { html: skeletonHtml() };
			if (radarState === 'down') {
				return {
					html: stateHtml('⚠', 'Pre-launch radar is unreachable', 'We can’t reach the radar precursor stream right now and we’re retrying. Switch to <b>Live</b> for the new-launch firehose or <b>Signals</b> for scored launches.', 'Switch to Live'),
					wire: (host) => host.querySelector('button')?.addEventListener('click', () => switchSource('live')),
				};
			}
			if (radarState === 'empty' && !rows.length) {
				return {
					html: stateHtml('◎', 'Radar armed — watching', 'The pre-launch radar is tracking smart-money wallets, but none have minted a coin yet. New precursors that mint will appear here the moment they do.', 'See Live launches'),
					wire: (host) => host.querySelector('button')?.addEventListener('click', () => switchSource('live')),
				};
			}
		}
		if (!rows.length) {
			if (store.allRowsCount() === 0) {
				// Source unreachable with nothing received yet — show an honest,
				// actionable down-state instead of a skeleton that never resolves.
				if (connState === 'down') {
					const label = source === 'signals' ? 'Signals' : 'Live';
					return {
						html: stateHtml('⚠', `${label} feed is unreachable`, 'We can’t reach this source right now and we’re retrying automatically. No stale or placeholder rows are shown.', 'Retry now'),
						wire: (host) => host.querySelector('button')?.addEventListener('click', () => { stopStreams(); store.resetFeed(); startSource(); }),
					};
				}
				// Connecting / waiting for the first launch to stream in.
				return { html: skeletonHtml() };
			}
			// Rows exist but all filtered out.
			return {
				html: stateHtml('⛶', 'No launches match your filters', 'Loosen the filters above to see the live feed.', 'Clear filters'),
				wire: (host) => host.querySelector('button')?.addEventListener('click', () => { store.resetFilters(); }),
			};
		}
		return null;
	}
	function skeletonHtml() {
		return `<div>${Array.from({ length: 9 }, () => `<div class="mc-skelrow"><i></i><i></i></div>`).join('')}</div>`;
	}
	function stateHtml(ico, title, body, btn) {
		return `<div class="mc-empty"><div class="mc-empty-ico" aria-hidden="true">${ico}</div><h3>${title}</h3><p>${body}</p>${btn ? `<button class="mc-chipbtn">${btn}</button>` : ''}</div>`;
	}
	let stateHost = null;
	function ensureStateHost() {
		if (!stateHost) {
			stateHost = document.createElement('div');
			stateHost.style.height = '100%';
			body.appendChild(stateHost);
		}
		return stateHost;
	}
	function removeStateHost() {
		if (stateHost) { stateHost.remove(); stateHost = null; }
	}

	// ── events ─────────────────────────────────────────────────────────────────
	const onScroll = () => scheduleRender();
	body.addEventListener('scroll', onScroll, { passive: true });

	const unsubs = [
		bus.on('feed:add', scheduleRender),
		bus.on('feed:update', () => {
			// Re-render only the touched row's chips if it's in the window; cheap full render otherwise.
			scheduleRender();
		}),
		bus.on('feed:reset', () => { rowEls.forEach((el) => el.remove()); rowEls.clear(); scheduleRender(); }),
		bus.on('filters', scheduleRender),
		bus.on('views', renderViews),
		bus.on('select', (mint) => {
			for (const [m, el] of rowEls) el.setAttribute('aria-selected', String(m === mint));
			scrollToMint(mint);
		}),
		bus.on('network', () => { stopStreams(); store.resetFeed(); startSource(); }),
	];

	function scrollToMint(mint) {
		const rows = store.visibleRows();
		const idx = rows.findIndex((r) => r.mint === mint);
		if (idx < 0) return;
		const top = idx * ROW_H;
		const viewTop = body.scrollTop;
		const viewBot = viewTop + body.clientHeight;
		if (top < viewTop) body.scrollTop = top;
		else if (top + ROW_H > viewBot) body.scrollTop = top + ROW_H - body.clientHeight;
	}

	startSource();

	return {
		focusSearch() { filterbar.querySelector('[data-host="search"]')?.focus(); },
		scrollTop() { body.scrollTop = 0; scheduleRender(); },
		destroy() {
			stopStreams();
			body.removeEventListener('scroll', onScroll);
			unsubs.forEach((u) => u());
			if (rafToken) cancelAnimationFrame(rafToken);
			rowEls.clear();
		},
	};
}
