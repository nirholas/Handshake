// dashboard-next — Pre-Launch Radar.
//
// The earliest edge on the platform: instead of reacting to a launch after it hits
// the feed, the radar watches proven creator + smart-money wallets on-chain and
// surfaces launch PRECURSORS — a watched wallet funding a fresh deploy wallet, or
// submitting a pump.fun create — at block-0. This view renders that live tape, the
// auto-curated watchlist (why each wallet is watched), and — for the owner — which
// precursors their armed agents actually fired on.
//
// Every number traces to real on-chain activity (radar_events / radar_watchlist).
// The radar's own state is read honestly from the worker heartbeat: live, paused
// (no RPC / disabled), or unknown (not reporting). Nothing here is synthesized.
//
// Endpoints:
//   GET /api/sniper/radar          → { status, watchlist, events, counts, armed? }
//   GET /api/sniper/radar-stream   → SSE: precursor events (live)

import { mountShell } from '../shell.js';
import { get, esc, relTime } from '../api.js';
import { emptyStateHTML, errorStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';

const POLL_REFRESH_MS = 30_000;

const KIND_LABEL = {
	create: 'Direct deploy',
	funding: 'Funded fresh wallet',
	correlated_mint: 'Funded → deployed',
};
const KIND_HINT = {
	create: 'A watched wallet submitted a pump.fun create instruction.',
	funding: 'A watched wallet funded a brand-new wallet — a likely deploy wallet.',
	correlated_mint: 'A wallet a watched address freshly funded just minted a coin.',
};
const REASON_LABEL = {
	creator_graduated: 'Proven creator',
	smart_money: 'Smart money',
	manual: 'Manually pinned',
};

function pumpUrl(mint) { return `https://pump.fun/coin/${encodeURIComponent(mint)}`; }
function solscanAddr(a) { return `https://solscan.io/account/${encodeURIComponent(a)}`; }
function pct(n) { return n == null ? '—' : `${Math.round(Number(n) * 100)}%`; }

const STYLE = `<style>
.rd-wrap { display: grid; gap: 20px; }
.rd-banner { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
	background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 14px 18px; }
.rd-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; box-shadow: 0 0 0 4px transparent; }
.rd-dot.live { background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.18); animation: rd-pulse 2s infinite; }
.rd-dot.paused { background: #fbbf24; }
.rd-dot.down { background: #f87171; }
.rd-dot.unknown { background: var(--nxt-ink-faint); }
@keyframes rd-pulse { 0%,100% { box-shadow: 0 0 0 4px rgba(52,211,153,.18);} 50% { box-shadow: 0 0 0 7px rgba(52,211,153,0);} }
.rd-state { font-weight: 700; font-size: 14px; }
.rd-state-sub { color: var(--nxt-ink-faint); font-size: 12.5px; }
.rd-banner .rd-spacer { flex: 1 1 auto; }
.rd-src { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .05em; }

.rd-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; }
.rd-kpi { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); padding: 14px 16px; }
.rd-kpi-label { font-size: 11px; color: var(--nxt-ink-faint); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
.rd-kpi-val { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }

.rd-cols { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; align-items: start; }
@media (max-width: 880px) { .rd-cols { grid-template-columns: 1fr; } }
.rd-panel { background: var(--nxt-panel); border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius); overflow: hidden; }
.rd-panel-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--nxt-stroke); }
.rd-panel-title { font-weight: 700; font-size: 14px; }
.rd-conn { margin-left: auto; font-size: 11px; color: var(--nxt-ink-faint); display: inline-flex; align-items: center; gap: 6px; }
.rd-conn .rd-dot { width: 7px; height: 7px; box-shadow: none; }

.rd-list { display: flex; flex-direction: column; }
.rd-ev { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--nxt-stroke); transition: background .12s; }
.rd-ev:last-child { border-bottom: 0; }
.rd-ev:hover { background: color-mix(in srgb, var(--nxt-accent) 5%, transparent); }
.rd-ev.rd-new { animation: rd-flash 1.4s ease-out; }
@keyframes rd-flash { 0% { background: color-mix(in srgb, var(--nxt-accent) 22%, transparent);} 100% { background: transparent; } }
.rd-kind { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 3px 8px; border-radius: 999px; white-space: nowrap;
	border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-soft); }
.rd-kind.create, .rd-kind.correlated_mint { color: #34d399; border-color: color-mix(in srgb, #34d399 45%, var(--nxt-stroke)); }
.rd-kind.funding { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 45%, var(--nxt-stroke)); }
.rd-ev-main { min-width: 0; }
.rd-ev-line1 { font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rd-ev-line2 { font-size: 11.5px; color: var(--nxt-ink-faint); margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
.rd-mono { font-family: var(--nxt-mono, ui-monospace, monospace); font-size: 12px; }
.rd-link { color: var(--nxt-accent); text-decoration: none; }
.rd-link:hover { text-decoration: underline; }
.rd-ev-right { text-align: right; font-size: 11px; color: var(--nxt-ink-faint); white-space: nowrap; }
.rd-conf { font-weight: 700; font-variant-numeric: tabular-nums; }
.rd-fired { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
	color: #34d399; border: 1px solid color-mix(in srgb, #34d399 45%, var(--nxt-stroke)); border-radius: 999px; padding: 2px 7px; }

.rd-wl { display: flex; flex-direction: column; max-height: 560px; overflow-y: auto; }
.rd-wl-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--nxt-stroke); }
.rd-wl-row:last-child { border-bottom: 0; }
.rd-wl-addr { display: flex; gap: 8px; align-items: center; min-width: 0; }
.rd-wl-reason { font-size: 11px; color: var(--nxt-ink-faint); margin-top: 2px; }
.rd-tag { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-soft); }
.rd-tag.creator { color: #818cf8; border-color: color-mix(in srgb, #818cf8 45%, var(--nxt-stroke)); }
.rd-tag.smart_money { color: #34d399; border-color: color-mix(in srgb, #34d399 45%, var(--nxt-stroke)); }
.rd-score { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 15px; }
.rd-sk { height: 64px; border-radius: var(--nxt-radius); background: linear-gradient(90deg, var(--nxt-panel) 25%, color-mix(in srgb, var(--nxt-stroke) 40%, var(--nxt-panel)) 37%, var(--nxt-panel) 63%); background-size: 400% 100%; animation: rd-shimmer 1.4s infinite; margin-bottom: 12px; }
@keyframes rd-shimmer { 0% { background-position: 100% 0;} 100% { background-position: 0 0; } }
.rd-cta { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--nxt-accent); text-decoration: none; }
.rd-cta:hover { text-decoration: underline; }
.rd-armed { font-size: 12.5px; color: var(--nxt-ink-soft); }
.rd-armed b { color: var(--nxt-ink); }

/* Long addresses must never force page-level horizontal overflow */
.rd-mono { overflow-wrap: anywhere; }
.rd-ev-line2, .rd-wl-addr { min-width: 0; }

/* Keyboard focus rings */
.rd-link:focus-visible, .rd-cta:focus-visible, .rd-wl:focus-visible {
	outline: 2px solid var(--nxt-accent); outline-offset: 2px; border-radius: var(--nxt-radius-sm);
}

@media (prefers-reduced-motion: reduce) {
	.rd-dot.live, .rd-ev.rd-new, .rd-sk { animation: none !important; }
	.rd-ev { transition: none; }
}
</style>`;

let _seen = new Set();
let _sse = null;
let _sseTimer = null;
let _sseRetry = 0;
let _refreshTimer = null;
let _isOwner = false;

(async function boot() {
	let main;
	try {
		main = await mountShell();
		ensureStateKitStyles();
		main.innerHTML = `
			<h1 class="dn-h1">Pre-Launch Radar</h1>
			<p class="dn-h1-sub">Block-zero launch detection — watch proven creator &amp; smart-money wallets on-chain and pre-arm the snipe on the launch precursor, not the feed.</p>
			<div id="rd-root" aria-busy="true" aria-label="Loading pre-launch radar"><div class="rd-sk"></div><div class="rd-sk"></div><div class="rd-sk"></div></div>
		`;
		main.insertAdjacentHTML('beforeend', STYLE);
		await refresh(main.querySelector('#rd-root'));
		_refreshTimer = setInterval(() => refresh(main.querySelector('#rd-root'), true), POLL_REFRESH_MS);
	} catch (e) {
		const root = document.getElementById('rd-root') || main;
		if (root) {
			root.innerHTML = errorStateHTML({
				title: 'Couldn’t load the radar',
				body: esc(e?.message || 'Try again shortly.'),
			});
			attachRetry(root, () => location.reload());
		}
	}
})();

async function refresh(root, quiet = false) {
	if (!root) return;
	let data;
	try {
		data = await get('/api/sniper/radar?network=mainnet');
	} catch (e) {
		if (!quiet) {
			root.innerHTML = errorStateHTML({
				title: 'Radar unavailable',
				body: esc(e?.message || 'Try again shortly.'),
			});
			attachRetry(root, () => refresh(root));
		}
		return;
	}
	_isOwner = !!data.owner;
	root.innerHTML = render(data);
	root.removeAttribute('aria-busy');
	root.removeAttribute('aria-label');
	startSse();
}

// The API returns the top 100 watched wallets by score, not the whole set, so
// say which of the two this panel is showing rather than letting the shown count
// contradict the "Watched wallets" KPI beside it.
function watchlistCaption(data) {
	const shown = (data.watchlist || []).length;
	const total = data.counts?.watched ?? shown;
	return total > shown ? `top ${shown} of ${total}` : `${shown} wallets`;
}

function render(data) {
	const st = data.status || { state: 'unknown' };
	const counts = data.counts || {};
	return `
	<div class="rd-wrap">
		${banner(st)}
		<div class="rd-strip">
			${kpi('Watched wallets', counts.watched ?? (data.watchlist || []).length)}
			${kpi('Precursors · 1h', counts.events_1h ?? 0)}
			${kpi('Precursors · 24h', counts.events_24h ?? 0)}
			${kpi('Launches caught · 24h', counts.armable_24h ?? 0)}
		</div>
		${data.armed ? armedStrip(data.armed) : ownerCta()}
		<div class="rd-cols">
			<div class="rd-panel">
				<div class="rd-panel-head">
					<span class="rd-panel-title">Live precursors</span>
					<span class="rd-conn" id="rd-conn" role="status" aria-live="polite"><span class="rd-dot unknown" aria-hidden="true"></span>Connecting…</span>
				</div>
				<div class="rd-list" id="rd-events" role="log" aria-live="polite" aria-relevant="additions" aria-label="Live launch precursors">${eventsList(data.events || [])}</div>
			</div>
			<div class="rd-panel">
				<div class="rd-panel-head">
					<span class="rd-panel-title">Watchlist</span>
					<span class="rd-src">${watchlistCaption(data)}</span>
				</div>
				<div class="rd-wl" tabindex="0" role="region" aria-label="Watched wallets (scrollable)">${watchlistList(data.watchlist || [])}</div>
			</div>
		</div>
	</div>`;
}

function banner(st) {
	const state = st.state || 'unknown';
	const cls = state === 'live' ? 'live' : state === 'paused' ? 'paused' : state === 'down' ? 'down' : 'unknown';
	const title = state === 'live' ? 'Radar live' : state === 'paused' ? 'Radar paused' : state === 'down' ? 'Worker offline' : 'Radar status unknown';
	let sub;
	if (state === 'live') {
		const bits = [];
		if (st.watched != null) bits.push(`${st.watched} wallets watched`);
		if (st.deployWatch) bits.push(`${st.deployWatch} fresh deploy wallets tracked`);
		if (st.lastEventAgeMs != null) bits.push(`last precursor ${relTime(Date.now() - st.lastEventAgeMs)}`);
		sub = bits.join(' · ') || 'Scanning the chain for launch precursors.';
	} else if (state === 'paused') {
		sub = st.reason === 'no_rpc'
			? 'No RPC endpoint configured — falling back to the feed-based snipe. Set HELIUS_API_KEY to enable on-chain detection.'
			: st.reason === 'disabled' ? 'The radar is disabled on this worker.' : 'Detection is paused; the feed snipe still runs.';
	} else if (state === 'down') {
		sub = 'The sniper worker is not reporting a heartbeat. The radar resumes when it comes back.';
	} else {
		sub = st.reason || 'The radar has not reported yet. It reports the moment the worker boots.';
	}
	return `
	<div class="rd-banner" role="status" aria-live="polite">
		<span class="rd-dot ${cls}" aria-hidden="true"></span>
		<div>
			<div class="rd-state">${esc(title)}</div>
			<div class="rd-state-sub">${esc(sub)}</div>
		</div>
		<span class="rd-spacer"></span>
		${st.source ? `<span class="rd-src">via ${esc(st.source)}</span>` : ''}
	</div>`;
}

function kpi(label, val) {
	return `<div class="rd-kpi"><div class="rd-kpi-label">${esc(label)}</div><div class="rd-kpi-val">${esc(String(val))}</div></div>`;
}

function ownerCta() {
	return `<div class="rd-banner"><div class="rd-armed">Arm an agent with the <b>Pre-launch radar</b> trigger to pre-arm snipes on these precursors automatically. <a class="rd-cta" href="/dashboard/sniper">Open Sniper Strategies →</a></div></div>`;
}

function armedStrip(armed) {
	const strategies = armed.strategies || [];
	if (!strategies.length) {
		return `<div class="rd-banner"><div class="rd-armed">No agent is armed with the pre-launch radar trigger yet. <a class="rd-cta" href="/dashboard/sniper">Arm one →</a></div></div>`;
	}
	const active = strategies.filter((s) => s.enabled && !s.kill_switch).length;
	const fired = (armed.positions || []).length;
	return `<div class="rd-banner"><div class="rd-armed">
		<b>${strategies.length}</b> radar ${strategies.length === 1 ? 'strategy' : 'strategies'} armed · <b>${active}</b> active · <b>${fired}</b> ${fired === 1 ? 'snipe' : 'snipes'} fired on recent precursors.
		<a class="rd-cta" href="/dashboard/sniper" style="margin-left:8px">Manage →</a>
	</div></div>`;
}

function eventsList(events) {
	if (!events.length) {
		return emptyStateHTML({
			icon: '📡',
			title: 'The radar is learning',
			body: 'No launch precursors yet. As proven creators and smart-money wallets move, their funding and deploys appear here in real time — usually before the coin hits any feed.',
			actions: [{ label: 'Arm a radar strategy', href: '/dashboard/sniper', primary: true }],
		});
	}
	return events.map((e) => eventRow(e, false)).join('');
}

function eventRow(e, isNew) {
	const kind = e.kind || 'create';
	const label = KIND_LABEL[kind] || kind;
	const fired = e.fired ? `<span class="rd-fired" title="Your agent sniped this">⚡ Sniped</span>` : '';
	const mintCell = e.mint
		? `<a class="rd-link rd-mono" href="${pumpUrl(e.mint)}" target="_blank" rel="noopener" title="${esc(e.mint)}">${esc(short(e.mint))}</a>`
		: `<span class="rd-state-sub">awaiting deploy…</span>`;
	const trig = e.trigger_wallet
		? (_isOwner
			? `<a class="rd-link rd-mono" href="${solscanAddr(e.trigger_wallet)}" target="_blank" rel="noopener" title="${esc(e.trigger_wallet)}" aria-label="Trigger wallet ${esc(short(e.trigger_wallet))} on Solscan">${esc(short(e.trigger_wallet))}</a>`
			: `<span class="rd-mono" title="Watched wallet (address shown to the owner)">${esc(short(e.trigger_wallet))}</span>`)
		: '—';
	const reason = e.watch_reason ? (REASON_LABEL[e.watch_reason] || e.watch_reason) : 'watched';
	return `
	<div class="rd-ev ${isNew ? 'rd-new' : ''}" data-id="${esc(e.id || '')}">
		<span class="rd-kind ${esc(kind)}" title="${esc(KIND_HINT[kind] || '')}">${esc(label)}</span>
		<div class="rd-ev-main">
			<div class="rd-ev-line1">${mintCell} ${fired}</div>
			<div class="rd-ev-line2">${esc(reason)} · ${trig}</div>
		</div>
		<div class="rd-ev-right">
			<div class="rd-conf" title="Detection confidence" aria-label="Detection confidence ${pct(e.confidence)}">${pct(e.confidence)}</div>
			<div>${e.at || e.created_at ? esc(relTime(e.at || e.created_at)) : ''}</div>
		</div>
	</div>`;
}

function watchlistList(wl) {
	if (!wl.length) {
		return emptyStateHTML({
			icon: '🛰️',
			title: 'Curating the watchlist',
			body: 'The radar auto-selects proven creators (graduated coins) and top smart-money wallets. It populates as the graph learns from real outcomes.',
		});
	}
	return wl.map((w) => {
		const reason = REASON_LABEL[w.reason] || w.reason;
		const tags = (w.labels || []).slice(0, 2).map((l) => `<span class="rd-tag ${esc(l)}">${esc(l.replace('_', ' '))}</span>`).join(' ');
		const detail = w.reason === 'creator_graduated' && w.creator_graduated != null
			? `${w.creator_graduated} graduated`
			: w.realized_score != null ? `rep ${Math.round(w.realized_score)}` : '';
		const addrLink = _isOwner
			? `<a class="rd-link rd-mono" href="${solscanAddr(w.address)}" target="_blank" rel="noopener" title="${esc(w.address)}" aria-label="Wallet ${esc(short(w.address))} on Solscan">${esc(short(w.address))}</a>`
			: `<span class="rd-mono" title="Address shown to the owner">${esc(short(w.address))}</span>`;
		return `
		<div class="rd-wl-row">
			<div>
				<div class="rd-wl-addr">${addrLink} ${tags}</div>
				<div class="rd-wl-reason">${esc(reason)}${detail ? ` · ${esc(detail)}` : ''}${w.last_hit_at ? ` · last hit ${esc(relTime(w.last_hit_at))}` : ''}</div>
			</div>
			<div class="rd-score" title="Signal score">${Math.round(Number(w.score))}</div>
		</div>`;
	}).join('');
}

function short(a) { return a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a; }

// ── live SSE ─────────────────────────────────────────────────────────────────
function setConn(state, label) {
	const el = document.getElementById('rd-conn');
	if (el) el.innerHTML = `<span class="rd-dot ${esc(state)}"></span>${esc(label)}`;
}

function startSse() {
	if (_sse) { try { _sse.close(); } catch {} _sse = null; }
	const src = new EventSource('/api/sniper/radar-stream?network=mainnet');
	_sse = src;
	src.addEventListener('open', () => { _sseRetry = 0; setConn('live', 'Live'); });
	src.addEventListener('precursor', (e) => {
		try { ingest(JSON.parse(e.data)); } catch {}
	});
	src.addEventListener('close', () => { try { src.close(); } catch {} scheduleReconnect(); });
	src.onerror = () => { try { src.close(); } catch {} if (_sse === src) _sse = null; scheduleReconnect(); };
}

function ingest(ev) {
	const list = document.getElementById('rd-events');
	if (!list || !ev.id) return;
	if (_seen.has(ev.id)) return;
	_seen.add(ev.id);
	if (_seen.size > 3000) _seen = new Set([...(_seen)].slice(-1500));
	// Drop the empty-state (shared state-kit block) before inserting the first live row.
	const empty = list.querySelector('.tws-es');
	if (empty) list.innerHTML = '';
	list.insertAdjacentHTML('afterbegin', eventRow(ev, true));
	// Trim to a sane cap.
	const rows = list.querySelectorAll('.rd-ev');
	for (let i = rows.length - 1; i >= 80; i--) rows[i].remove();
}

function scheduleReconnect() {
	if (_sseTimer) return;
	if (!document.getElementById('rd-events')) return;
	_sseRetry = Math.min(_sseRetry + 1, 6);
	const delay = Math.min(1000 * 2 ** (_sseRetry - 1), 30000);
	setConn('paused', `Reconnecting in ${Math.round(delay / 1000)}s…`);
	_sseTimer = setTimeout(() => { _sseTimer = null; if (document.getElementById('rd-events')) startSse(); }, delay);
}

window.addEventListener('beforeunload', () => {
	if (_sse) try { _sse.close(); } catch {}
	if (_refreshTimer) clearInterval(_refreshTimer);
});
