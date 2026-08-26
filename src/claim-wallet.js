/**
 * Wallet Intelligence — /claim-wallet controller.
 *
 * Paste any Solana wallet → a complete, provable pump.fun trading report:
 * realized P&L (SOL + USD), win rate, smart-money score, ROI distribution,
 * category mix and a full sortable trade ledger. Every coin row drills into its
 * live /launches/<mint> dashboard (price chart, holders, bubblemap, trade tape).
 * A signed-in visitor can claim the wallet via SIWS to publish it as their
 * official three.ws Trader Card.
 *
 * Every number traces to a real on-chain trade aggregate served by
 * /api/traders/preview — no synthesized data.
 */

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const $ = (sel, root = document) => root.querySelector(sel);
const LAMP_NA = '—';

const LABEL_COPY = {
	smart_money: 'Smart Money',
	sniper: 'Sniper',
	dumper: 'Dumper',
	rugger: 'Rugger',
	fresh: 'Fresh',
	neutral: 'Neutral',
	unproven: 'Unproven',
};
const LABEL_BLURB = {
	smart_money: 'Consistently early, consistently profitable — the platform scores this record as smart money.',
	sniper: 'Fast, first-block entries on new launches. High skill, high variance.',
	dumper: 'Frequently exits into early buyers. Followers should size carefully.',
	rugger: 'Linked to launches that collapsed on holders. Treat with caution.',
	fresh: 'A young record — not enough closed trades yet to score conviction.',
	neutral: 'A mixed, middle-of-the-pack track record.',
	unproven: 'Not yet scored by the intelligence brain — trade history is still indexing.',
};

// ── session + linked-wallet truth ──────────────────────────────────────────────
let _session = null;
async function getSession() {
	if (_session !== null) return _session;
	try {
		const r = await fetch('/api/auth/me', { credentials: 'include' });
		_session = r.ok ? await r.json() : false;
	} catch { _session = false; }
	return _session;
}

let _linkedWallets = null;
async function getLinkedSolanaWallets({ force = false } = {}) {
	if (_linkedWallets !== null && !force) return _linkedWallets;
	try {
		const r = await fetch('/api/auth/wallets', { credentials: 'include' });
		if (!r.ok) { _linkedWallets = []; return _linkedWallets; }
		const { wallets } = await r.json();
		_linkedWallets = (wallets || [])
			.filter((w) => (w.chain_type || '').toLowerCase() === 'solana')
			.map((w) => w.address);
	} catch { _linkedWallets = []; }
	return _linkedWallets;
}
async function isWalletClaimed(wallet) {
	const linked = await getLinkedSolanaWallets();
	return linked.includes(wallet);
}

// Live SOL price (USD) for converting on-chain SOL figures. Cached per page load;
// degrades to null (USD hidden) rather than blocking the dashboard.
let _solPrice = null;
async function getSolPrice() {
	if (_solPrice !== null) return _solPrice;
	try {
		const r = await fetch('/api/pump/helius-stats');
		const d = await r.json();
		_solPrice = Number(d?.sol_price) > 0 ? Number(d.sol_price) : 0;
	} catch { _solPrice = 0; }
	return _solPrice;
}

// ── formatting ──────────────────────────────────────────────────────────────────
function esc(s) {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtSol(n, { sign = false } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return LAMP_NA;
	const v = Number(n);
	const s = sign && v > 0 ? '+' : '';
	const abs = Math.abs(v);
	const body = abs >= 1000 ? compact(v) : v.toFixed(abs >= 1 ? 2 : 3);
	return `${s}${body} ◎`;
}
function fmtUsd(n, { sign = false } = {}) {
	if (n == null || !Number.isFinite(Number(n))) return '';
	const v = Number(n);
	const s = sign && v > 0 ? '+' : v < 0 ? '−' : '';
	return `${s}$${compact(Math.abs(v))}`;
}
function compact(n) {
	const v = Number(n);
	const abs = Math.abs(v);
	if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
	if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
	if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'K';
	if (abs >= 1) return v.toFixed(2);
	return v.toFixed(abs >= 0.01 ? 3 : 4);
}
function fmtPct(ratio) {
	if (ratio == null) return LAMP_NA;
	return `${Math.round(Number(ratio) * 100)}%`;
}
// `wallet_reputation` stores win_rate / early_win_rate / dump_rate already in
// percentage points (see pct() in src/pump/wallet-reputation.js, which divides
// then multiplies by 100), so these values must NOT be scaled again. Running a
// 5.7% lifetime win rate through fmtPct printed "570%" on the live card.
function fmtPctPoints(points) {
	if (points == null || !Number.isFinite(Number(points))) return LAMP_NA;
	return `${Math.round(Number(points))}%`;
}
function fmtRoi(roi) {
	if (roi == null) return LAMP_NA;
	const pct = Math.round(roi * 100);
	return `${pct > 0 ? '+' : ''}${pct}%`;
}
function fmtDuration(ms) {
	if (ms == null || ms <= 0) return LAMP_NA;
	const s = ms / 1000;
	if (s < 60) return `${Math.round(s)}s`;
	const m = s / 60;
	if (m < 60) return `${Math.round(m)}m`;
	const h = m / 60;
	if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
	const d = h / 24;
	return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}
function timeAgo(iso) {
	if (!iso) return LAMP_NA;
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return LAMP_NA;
	const s = (Date.now() - t) / 1000;
	if (s < 60) return 'now';
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
	return `${Math.round(s / (86400 * 30))}mo`;
}
function shortAddr(a) {
	if (!a || a.length < 12) return a || '';
	return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
function pnlClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu'; }

// Deterministic gradient avatar from the address bytes — no two wallets alike.
function avatarStyle(addr) {
	let h = 0;
	for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
	const a = h % 360;
	const b = (a + 50 + (h >> 8) % 80) % 360;
	return `background:linear-gradient(135deg,hsl(${a} 62% 52%),hsl(${b} 64% 42%))`;
}

// ── boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
	const input = $('#cwInput');
	const btn = $('#cwBtn');

	getSession();
	getSolPrice();

	const qs = new URL(location.href).searchParams;
	const preWallet = qs.get('wallet');
	if (preWallet && WALLET_RE.test(preWallet)) {
		input.value = preWallet;
		analyze(preWallet);
	}

	btn.addEventListener('click', () => {
		const wallet = input.value.trim();
		if (!WALLET_RE.test(wallet)) { showErr('Paste a valid Solana base-58 wallet address.'); return; }
		hideErr();
		const url = new URL(location.href);
		url.searchParams.set('wallet', wallet);
		history.replaceState(null, '', url.toString());
		analyze(wallet);
	});
	input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
});

function showErr(msg) { const e = $('#cwErr'); e.textContent = msg; e.hidden = false; }
function hideErr() { $('#cwErr').hidden = true; }

// The Analyze button carries data-i18n, so the catalog pass (which lands after
// an async /api/locale fetch) used to overwrite "Analyzing…" with the idle label
// mid-request and the busy state never showed. data-i18n-owned is the codebase's
// opt-out: claim the element while busy, hand it back on release so a later
// locale switch still translates it.
let _idleBtnLabel = null;
function setBtnBusy(btn, label) {
	if (_idleBtnLabel === null) _idleBtnLabel = btn.textContent;
	btn.setAttribute('data-i18n-owned', '1');
	btn.disabled = true;
	btn.setAttribute('aria-busy', 'true');
	btn.textContent = label;
}
function setBtnIdle(btn) {
	btn.disabled = false;
	btn.removeAttribute('aria-busy');
	btn.textContent = _idleBtnLabel ?? btn.textContent;
	btn.removeAttribute('data-i18n-owned');
	// Re-apply in case the catalog landed while the button was owned.
	window.threewsI18n?.apply?.(btn);
}

// ── fetch + orchestrate ─────────────────────────────────────────────────────────
const STATE = { data: null, wallet: null, win: 'all', sortKey: 'last_seen_at', sortDir: -1, q: '', hideClosed: false, creatorOnly: false, hideDust: true };

async function analyze(wallet) {
	const result = $('#cwResult');
	const btn = $('#cwBtn');
	$('#cwHero').classList.add('compact');

	setBtnBusy(btn, 'Analyzing…');
	result.innerHTML = skeletonHtml();

	let data;
	try {
		const [r] = await Promise.all([
			fetch(`/api/traders/preview?wallet=${encodeURIComponent(wallet)}`),
			getSolPrice(),
		]);
		if (!r.ok) {
			const d = await r.json().catch(() => ({}));
			throw new Error(d.message || d.error_description || `The intelligence brain answered HTTP ${r.status}.`);
		}
		data = await r.json();
	} catch (e) {
		// A dead fetch used to blank the page and print the browser's raw
		// "Failed to fetch" next to the search box, with no way forward.
		hideErr();
		result.innerHTML = errorHtml(wallet, e);
		const retry = result.querySelector('#cwRetry');
		if (retry) retry.addEventListener('click', () => analyze(wallet));
		setBtnIdle(btn);
		return;
	}

	setBtnIdle(btn);

	if (!data.claimable && !data.known) {
		result.innerHTML = notFoundHtml(wallet);
		return;
	}

	STATE.data = data;
	STATE.wallet = wallet;
	STATE.win = 'all';

	const session = await getSession();
	const signedIn = !!session?.user;
	const claimed = signedIn ? await isWalletClaimed(wallet) : false;
	STATE.signedIn = signedIn;
	STATE.claimed = claimed;

	renderDashboard();
}

// Filter coins to the active time window by last activity.
function windowedCoins() {
	const coins = STATE.data?.coins || [];
	if (STATE.win === 'all') return coins;
	const days = STATE.win === '7d' ? 7 : 30;
	const cutoff = Date.now() - days * 86400 * 1000;
	return coins.filter((c) => c.last_seen_at && new Date(c.last_seen_at).getTime() >= cutoff);
}

// Recompute window-scoped aggregates client-side so the 7D/30D tabs are honest
// (the server summary covers the full loaded set).
function aggregate(coins) {
	let buy = 0, sell = 0, tx = 0, wins = 0, closed = 0, open = 0, creator = 0;
	const dist = { x5: 0, x2: 0, up: 0, down: 0, rug: 0 };
	const holdMs = [];
	const catMap = new Map();
	let lastActive = 0;
	for (const c of coins) {
		buy += c.buy_sol || 0;
		sell += c.sell_sol || 0;
		tx += c.tx_count || 0;
		if (c.is_creator) creator++;
		if (c.open) open++;
		if (c.hold_ms) holdMs.push(c.hold_ms);
		if (c.last_seen_at) lastActive = Math.max(lastActive, new Date(c.last_seen_at).getTime());
		const k = c.category || 'unknown';
		catMap.set(k, (catMap.get(k) || 0) + 1);
		if (c.roi != null && !c.open) {
			closed++;
			if (c.pnl_sol > 0) wins++;
			if (c.roi >= 5) dist.x5++;
			else if (c.roi >= 2) dist.x2++;
			else if (c.roi >= 0) dist.up++;
			else if (c.roi >= -0.5) dist.down++;
			else dist.rug++;
		}
	}
	const net = sell - buy;
	return {
		count: coins.length, buy, sell, net, volume: buy + sell, tx,
		wins, losses: closed - wins, closed, open, creator,
		winRate: closed ? wins / closed : null,
		avgBuy: coins.length ? buy / coins.length : 0,
		avgSell: coins.length ? sell / coins.length : 0,
		avgHoldMs: holdMs.length ? holdMs.reduce((a, b) => a + b, 0) / holdMs.length : null,
		dist,
		categories: [...catMap.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
		lastActive: lastActive || null,
	};
}

// ── dashboard render ────────────────────────────────────────────────────────────
function renderDashboard() {
	const result = $('#cwResult');
	const { wallet, data } = STATE;
	const coins = windowedCoins();
	const agg = aggregate(coins);
	const profile = data.profile || {};
	const sol = _solPrice || 0;

	result.innerHTML = `
		<div class="cw-dash">
			${identityHtml(wallet, profile)}
			${kpiHtml(agg, profile, sol)}
			<div class="cw-grid">
				${analysisPanel(agg, sol)}
				${reputationPanel(profile, data.summary)}
			</div>
			<div class="cw-grid">
				${distributionPanel(agg)}
				${categoryPanel(agg)}
			</div>
			${ledgerHtml(coins, sol)}
			${ctaHtml(wallet, data)}
		</div>`;

	wireDashboard(result);
}

function identityHtml(wallet, profile) {
	const label = profile.label || 'unproven';
	const labelTxt = LABEL_COPY[label] || label;
	const traderUrl = `/trader/${encodeURIComponent(wallet)}`;
	const solscan = `https://solscan.io/account/${encodeURIComponent(wallet)}`;
	const claimAction = STATE.claimed
		? `<span class="cw-action is-done">✓ Claimed</span>`
		: STATE.signedIn
			? `<button type="button" class="cw-action primary" id="cwClaim">Claim wallet →</button>`
			: `<a class="cw-action primary" href="/login?next=${encodeURIComponent(`/claim-wallet?wallet=${wallet}`)}">Sign in to claim →</a>`;

	return `<div class="cw-id">
		<div class="cw-avatar" style="${avatarStyle(wallet)}" aria-hidden="true">${esc(wallet.slice(0, 2).toUpperCase())}</div>
		<div class="cw-id-main">
			<div class="cw-id-addr">
				<span class="cw-id-short">${esc(shortAddr(wallet))}</span>
				<button type="button" class="cw-copy" id="cwCopy" title="Copy full address" aria-label="Copy wallet address">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
					<span>Copy</span>
				</button>
			</div>
			<div class="cw-id-meta">
				<span class="cw-label ${esc(label)}">${esc(labelTxt)}</span>
				<div class="cw-winbar" role="group" aria-label="Time window">
					${['7d', '30d', 'all'].map((w) => `<button type="button" class="cw-wintab${STATE.win === w ? ' active' : ''}" data-win="${w}" aria-pressed="${STATE.win === w}">${w === 'all' ? 'ALL' : w.toUpperCase()}</button>`).join('')}
				</div>
			</div>
		</div>
		<div class="cw-id-actions">
			${claimAction}
			<button type="button" class="cw-action" id="cwShare" aria-label="Share trader card">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
				Share
			</button>
			<a class="cw-action" href="${esc(traderUrl)}">Trader Card</a>
			<a class="cw-action" href="${esc(solscan)}" target="_blank" rel="noopener" aria-label="View on Solscan">Solscan ↗</a>
		</div>
	</div>`;
}

function kpiHtml(agg, profile, sol) {
	const net = agg.net;
	const netUsd = sol ? net * sol : null;
	const score = profile.smart_money_score != null ? Math.round(profile.smart_money_score) : null;
	const wr = agg.winRate;
	const lifetimeWr = profile.win_rate;

	const spark = sparkline(windowedCoins());
	const circ = 2 * Math.PI * 20;
	const off = score != null ? circ * (1 - score / 100) : circ;

	return `<div class="cw-kpis">
		<div class="cw-kpi">
			<div class="cw-kpi-lbl">Realized P&amp;L</div>
			<div class="cw-kpi-val ${pnlClass(net)}">${fmtSol(net, { sign: true })}</div>
			<div class="cw-kpi-sub">${netUsd != null ? fmtUsd(netUsd, { sign: true }) + ' · ' : ''}<span class="pos">${agg.wins}W</span> / <span class="neg">${agg.losses}L</span></div>
			${spark}
		</div>
		<div class="cw-kpi">
			<div class="cw-kpi-lbl">Win Rate</div>
			<div class="cw-kpi-val ${wr != null && wr >= 0.5 ? 'pos' : ''}">${wr != null ? fmtPct(wr) : LAMP_NA}</div>
			<div class="cw-kpi-sub">${agg.closed} closed${lifetimeWr != null ? ` · ${fmtPctPoints(lifetimeWr)} lifetime` : ''}</div>
		</div>
		<div class="cw-kpi">
			<div class="cw-kpi-lbl">Smart-Money Score</div>
			<div class="cw-kpi-val ${score != null && score >= 70 ? 'pos' : ''}">${score != null ? score : LAMP_NA}<small style="font-size:13px;color:var(--ink-faint)"> / 100</small></div>
			<div class="cw-kpi-sub">${esc(LABEL_COPY[profile.label] || 'Unproven')}</div>
			${score != null ? `<div class="cw-gauge"><svg width="46" height="46" viewBox="0 0 46 46"><circle class="cw-gauge-track" cx="23" cy="23" r="20" fill="none" stroke-width="4"/><circle class="cw-gauge-fill" cx="23" cy="23" r="20" fill="none" stroke-width="4" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg></div>` : ''}
		</div>
		<div class="cw-kpi">
			<div class="cw-kpi-lbl">Coins Traded</div>
			<div class="cw-kpi-val">${agg.count}</div>
			<div class="cw-kpi-sub">${agg.open} open · ${agg.creator} created</div>
		</div>
		<div class="cw-kpi">
			<div class="cw-kpi-lbl">Volume</div>
			<div class="cw-kpi-val">${fmtSol(agg.volume)}</div>
			<div class="cw-kpi-sub">${sol ? fmtUsd(agg.volume * sol) + ' · ' : ''}${agg.tx} txns</div>
		</div>
	</div>`;
}

// Cumulative-PnL sparkline (oldest→newest) — a real micro-equity-curve.
function sparkline(coins) {
	const pts = coins
		.filter((c) => c.pnl_sol != null && c.last_seen_at)
		.slice()
		.sort((a, b) => new Date(a.last_seen_at) - new Date(b.last_seen_at));
	if (pts.length < 2) return '';
	let cum = 0;
	const ys = pts.map((c) => (cum += c.pnl_sol));
	const min = Math.min(0, ...ys), max = Math.max(0, ...ys);
	const range = max - min || 1;
	const w = 56, h = 20;
	const d = ys.map((y, i) => {
		const x = (i / (ys.length - 1)) * w;
		const yy = h - ((y - min) / range) * h;
		return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${yy.toFixed(1)}`;
	}).join(' ');
	const up = ys[ys.length - 1] >= 0;
	const col = up ? 'var(--success)' : 'var(--danger)';
	return `<svg class="cw-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true"><path d="${d}" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/></svg>`;
}

function statRow(k, v, { cls = '', ico = '' } = {}) {
	return `<div class="cw-row"><span class="cw-row-k">${ico ? `<span class="ico">${ico}</span>` : ''}${esc(k)}</span><span class="cw-row-v ${cls}">${v}</span></div>`;
}

function analysisPanel(agg, sol) {
	const rows = [
		statRow('Net flow', `${fmtSol(agg.net, { sign: true })}${sol ? ` <small>${fmtUsd(agg.net * sol, { sign: true })}</small>` : ''}`, { cls: pnlClass(agg.net) }),
		statRow('Total bought', `${fmtSol(agg.buy)}${sol ? ` <small>${fmtUsd(agg.buy * sol)}</small>` : ''}`),
		statRow('Total sold', `${fmtSol(agg.sell)}${sol ? ` <small>${fmtUsd(agg.sell * sol)}</small>` : ''}`),
		statRow('Total volume', fmtSol(agg.volume)),
		statRow('Avg buy / coin', fmtSol(agg.avgBuy)),
		statRow('Avg sold / coin', fmtSol(agg.avgSell)),
		statRow('Total transactions', String(agg.tx)),
		statRow('Avg hold time', fmtDuration(agg.avgHoldMs)),
		statRow('Open positions', String(agg.open)),
		statRow('Last active', agg.lastActive ? timeAgo(new Date(agg.lastActive).toISOString()) + ' ago' : LAMP_NA),
	].join('');
	return `<div class="cw-panel">
		<p class="cw-panel-title">Trade analysis <span class="cw-tag">${STATE.win === 'all' ? 'all-time' : STATE.win.toUpperCase()}</span></p>
		<div class="cw-rows">${rows}</div>
	</div>`;
}

function reputationPanel(profile, summary) {
	const label = profile.label || 'unproven';
	const score = profile.smart_money_score != null ? Math.round(profile.smart_money_score) : null;
	const meter = (val, cls = '') => `<div class="cw-meter ${cls}"><i style="width:${Math.max(0, Math.min(100, val))}%"></i></div>`;
	const rows = [
		`<div class="cw-row"><span class="cw-row-k">Smart-money score</span><span class="cw-row-v" style="display:flex;align-items:center;gap:10px">${score != null ? score : LAMP_NA}${score != null ? meter(score) : ''}</span></div>`,
		`<div class="cw-row"><span class="cw-row-k">Early-entry win rate</span><span class="cw-row-v ${profile.early_win_rate >= 50 ? 'pos' : ''}" style="display:flex;align-items:center;gap:10px">${fmtPctPoints(profile.early_win_rate)}${profile.early_win_rate != null ? meter(profile.early_win_rate, 'pos') : ''}</span></div>`,
		`<div class="cw-row"><span class="cw-row-k">Dump rate</span><span class="cw-row-v ${profile.dump_rate > 30 ? 'neg' : ''}" style="display:flex;align-items:center;gap:10px">${fmtPctPoints(profile.dump_rate)}${profile.dump_rate != null ? meter(profile.dump_rate, 'neg') : ''}</span></div>`,
		statRow('Lifetime coins', String(profile.coins_traded ?? summary?.total_coins ?? 0)),
		statRow('Lifetime wins / duds', `<span class="cw-row-v pos">${profile.wins ?? 0}</span> / <span class="cw-row-v neg">${profile.duds ?? 0}</span>`),
		statRow('Dumps', String(profile.dumps ?? 0), { cls: profile.dumps > 0 ? 'neg' : '' }),
		statRow('Coins created', `${profile.creator_count ?? 0}${profile.creator_wins ? ` · ${profile.creator_wins} won` : ''}`),
	].join('');
	return `<div class="cw-panel">
		<p class="cw-panel-title">Reputation &amp; integrity <span class="cw-tag">lifetime</span></p>
		<div class="cw-rows">${rows}</div>
		<p style="margin:14px 0 0;font:500 var(--text-2xs)/1.5 var(--font-body);color:var(--ink-dim)">${esc(LABEL_BLURB[label] || '')}</p>
	</div>`;
}

function distributionPanel(agg) {
	const d = agg.dist;
	const total = d.x5 + d.x2 + d.up + d.down + d.rug;
	const seg = (cls, n) => total ? `<i class="${cls}" style="width:${(n / total * 100).toFixed(1)}%"></i>` : '';
	const buckets = [
		{ key: 'x5', dot: 'var(--success)', lab: '> 5×', n: d.x5 },
		{ key: 'x2', dot: 'color-mix(in srgb,var(--success) 65%,var(--wallet-accent))', lab: '2× – 5×', n: d.x2 },
		{ key: 'up', dot: 'var(--wallet-accent)', lab: '0 – 2×', n: d.up },
		{ key: 'down', dot: 'color-mix(in srgb,var(--danger) 55%,var(--warn))', lab: '−50% – 0', n: d.down },
		{ key: 'rug', dot: 'var(--danger)', lab: '< −50%', n: d.rug },
	];
	const rows = buckets.map((b) => `<div class="cw-dist-row">
		<span class="cw-dot" style="background:${b.dot}"></span>
		<span class="lab">${b.lab}</span>
		<span class="cnt">${b.n}</span>
		<span class="pct">${total ? Math.round(b.n / total * 100) : 0}%</span>
	</div>`).join('');
	const body = total
		? `<div class="cw-distbar">${seg('cw-dist-x5', d.x5)}${seg('cw-dist-x2', d.x2)}${seg('cw-dist-up', d.up)}${seg('cw-dist-down', d.down)}${seg('cw-dist-rug', d.rug)}</div><div class="cw-dist-rows">${rows}</div>`
		: `<p style="font:500 var(--text-sm)/1.5 var(--font-body);color:var(--ink-faint);padding:24px 0;text-align:center">No closed positions in this window yet — every open bag still counts toward lifetime stats.</p>`;
	return `<div class="cw-panel">
		<p class="cw-panel-title">ROI distribution <span class="cw-tag">${total} closed</span></p>
		${body}
	</div>`;
}

function categoryPanel(agg) {
	const cats = agg.categories.filter((c) => c.category !== 'unknown').slice(0, 7);
	const max = cats.length ? cats[0].count : 1;
	const body = cats.length
		? `<div class="cw-cats">${cats.map((c) => `<div class="cw-cat">
			<span class="cw-cat-name">${esc(c.category)}</span>
			<span class="cw-cat-bar"><i style="width:${Math.round(c.count / max * 100)}%"></i></span>
			<span class="cw-cat-n">${c.count}</span>
		</div>`).join('')}</div>`
		: `<p style="font:500 var(--text-sm)/1.5 var(--font-body);color:var(--ink-faint);padding:24px 0;text-align:center">Coins this wallet traded haven't been categorized yet.</p>`;
	return `<div class="cw-panel">
		<p class="cw-panel-title">Category mix <span class="cw-tag">${agg.count} coins</span></p>
		${body}
	</div>`;
}

// ── trade ledger ──────────────────────────────────────────────────────────────
const COLS = [
	{ key: 'token', label: 'Token', sort: (c) => (c.symbol || c.mint || '').toLowerCase() },
	{ key: 'pnl_sol', label: 'Realized P&L', num: true },
	{ key: 'roi', label: 'ROI', num: true },
	{ key: 'buy_sol', label: 'Bought', num: true },
	{ key: 'sell_sol', label: 'Sold', num: true },
	{ key: 'tx_count', label: 'TXs', num: true },
	{ key: 'hold_ms', label: 'Hold', num: true },
	{ key: 'last_seen_at', label: 'Last', sort: (c) => (c.last_seen_at ? new Date(c.last_seen_at).getTime() : 0) },
];

function filtersActive() {
	return !!STATE.q || STATE.hideDust || STATE.hideClosed || STATE.creatorOnly;
}

// The ledger header must never claim more rows than the table shows: `Hide dust`
// is on by default, so a 60-coin window routinely renders 52 rows.
function ledgerCountLabel(shown, total) {
	const win = STATE.win === 'all' ? 'all-time' : STATE.win.toUpperCase();
	const coins = shown === total ? `${total} coins` : `${shown} of ${total} coins`;
	return `${coins} · ${win}`;
}

function ledgerHtml(coins, sol) {
	const rows = ledgerRows(coins, sol);
	const shown = filteredSortedCoins(coins).length;
	const head = COLS.map((col) => {
		const active = STATE.sortKey === col.key;
		const arr = active ? (STATE.sortDir === -1 ? '↓' : '↑') : '';
		const aria = active ? (STATE.sortDir === -1 ? 'descending' : 'ascending') : 'none';
		return `<th aria-sort="${aria}"><button type="button" class="cw-th-btn" data-sort="${col.key}">${esc(col.label)}<span class="arr">${arr}</span></button></th>`;
	}).join('') + '<th><span class="cw-sr">Open coin dashboard</span></th>';

	// A wallet the brain has graded can still have zero indexed coin rows (the
	// per-coin indexer and the reputation rollup advance independently). Showing
	// the filter chips over an empty table there reads as "your filters are
	// wrong" when nothing was ever loaded, so the panel says which it is.
	if (!coins.length) {
		return `<div class="cw-panel cw-ledger">
			<div class="cw-ledger-bar">
				<div class="cw-ledger-title">Trade ledger <span class="count">${ledgerCountLabel(0, 0)}</span></div>
			</div>
			${ledgerBlankHtml()}
		</div>`;
	}

	return `<div class="cw-panel cw-ledger">
		<div class="cw-ledger-bar">
			<div class="cw-ledger-title">Trade ledger <span class="count" id="cwLedgerCount">${ledgerCountLabel(shown, coins.length)}</span></div>
			<div class="cw-ledger-tools">
				<input type="text" class="cw-tsearch" id="cwSearch" placeholder="Filter token / mint…" value="${esc(STATE.q)}" aria-label="Filter ledger" />
				<button type="button" class="cw-chip${STATE.hideDust ? ' on' : ''}" data-filter="hideDust" aria-pressed="${STATE.hideDust}">Hide dust</button>
				<button type="button" class="cw-chip${STATE.hideClosed ? ' on' : ''}" data-filter="hideClosed" aria-pressed="${STATE.hideClosed}">Open only</button>
				<button type="button" class="cw-chip${STATE.creatorOnly ? ' on' : ''}" data-filter="creatorOnly" aria-pressed="${STATE.creatorOnly}">Created</button>
			</div>
		</div>
		<div class="cw-table-wrap">
			<table class="cw-table">
				<thead><tr>${head}</tr></thead>
				<tbody id="cwTbody">${rows}</tbody>
			</table>
		</div>
	</div>`;
}

// Nothing was loaded for this window at all. Name the cause and offer the one
// control that can change it (a wider window), never a dead end.
function ledgerBlankHtml() {
	const lifetime = Number(STATE.data?.profile?.coins_traded) || 0;
	const wider = STATE.win !== 'all'
		? `<button type="button" class="cw-action" data-win="all">Widen to all-time →</button>`
		: '';
	const body = STATE.win !== 'all'
		? `No pump.fun trades from this wallet in the last ${STATE.win === '7d' ? '7' : '30'} days.`
		: lifetime > 0
			? `The reputation brain has graded ${lifetime} lifetime coin${lifetime === 1 ? '' : 's'} for this wallet, but its per-coin trade rows are still being indexed. The lifetime figures above are live; the ledger fills in as the indexer catches up.`
			: 'No indexed pump.fun trades for this wallet yet.';
	return `<div class="cw-ledger-blank">
		<p>${esc(body)}</p>
		${wider}
	</div>`;
}

function filteredSortedCoins(coins) {
	let out = coins.slice();
	if (STATE.q) {
		const q = STATE.q.toLowerCase();
		out = out.filter((c) => (c.symbol || '').toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q) || (c.mint || '').toLowerCase().includes(q));
	}
	if (STATE.hideDust) out = out.filter((c) => (c.buy_sol || 0) >= 0.01 || (c.sell_sol || 0) >= 0.01);
	if (STATE.hideClosed) out = out.filter((c) => c.open);
	if (STATE.creatorOnly) out = out.filter((c) => c.is_creator);

	const col = COLS.find((c) => c.key === STATE.sortKey) || COLS[1];
	const getter = col.sort || ((c) => (c[col.key] == null ? -Infinity : Number(c[col.key])));
	out.sort((a, b) => {
		const va = getter(a), vb = getter(b);
		if (va < vb) return STATE.sortDir;
		if (va > vb) return -STATE.sortDir;
		return 0;
	});
	return out;
}

function ledgerRows(coins, sol) {
	const rows = filteredSortedCoins(coins);
	if (!rows.length) {
		const why = filtersActive()
			? `<p>None of this window's ${coins.length} coin${coins.length === 1 ? '' : 's'} match the active filters.</p><button type="button" class="cw-action" id="cwClearFilters">Clear filters</button>`
			: `<p>No coins in this window.</p>`;
		return `<tr><td colspan="9" class="cw-nomatch">${why}</td></tr>`;
	}
	return rows.map((c) => {
		const sym = esc((c.symbol || c.mint?.slice(0, 6) || '?').toUpperCase());
		const img = c.image_uri
			? `<img loading="lazy" decoding="async" class="cw-tok-img" src="${esc(c.image_uri)}" alt="" data-fallback="element" data-fallback-class="cw-tok-img" data-fallback-text="${esc(sym.slice(0, 2))}" />`
			: `<div class="cw-tok-img">${esc(sym.slice(0, 2))}</div>`;
		const badges = [
			c.is_creator ? '<span class="cw-badge creator">DEV</span>' : '',
			c.open ? '<span class="cw-badge open">OPEN</span>' : '',
			c.graduated ? '<span class="cw-badge grad">GRAD</span>' : '',
			c.rugged ? '<span class="cw-badge rug">RUG</span>' : '',
		].join('');
		const pnlUsd = sol && c.pnl_sol != null ? ` <small style="color:var(--ink-faint)">${fmtUsd(c.pnl_sol * sol, { sign: true })}</small>` : '';
		const roiPct = c.roi != null ? Math.max(-100, Math.min(100, Math.round(c.roi * 100))) : null;
		const roiBar = c.roi != null
			? `<span class="cw-roi-bar"><i style="width:${Math.abs(roiPct)}%;background:${c.roi >= 0 ? 'var(--success)' : 'var(--danger)'}"></i></span>`
			: '';
		return `<tr data-mint="${esc(c.mint)}">
			<td><div class="cw-tok">${img}<div class="cw-tok-meta"><div class="cw-tok-sym">$${sym} ${badges}</div>${c.name ? `<div class="cw-tok-name">${esc(c.name)}</div>` : ''}</div></div></td>
			<td><span class="cw-pnl ${c.pnl_sol != null ? pnlClass(c.pnl_sol) : 'neu'}">${c.pnl_sol != null ? fmtSol(c.pnl_sol, { sign: true }) : LAMP_NA}</span>${pnlUsd}</td>
			<td><span class="cw-roi-cell"><span class="cw-pnl ${c.roi != null ? pnlClass(c.roi) : 'neu'}">${fmtRoi(c.roi)}</span>${roiBar}</span></td>
			<td>${c.buy_sol != null ? fmtSol(c.buy_sol) : LAMP_NA}</td>
			<td>${c.sell_sol != null ? fmtSol(c.sell_sol) : LAMP_NA}</td>
			<td><span class="cw-muted">${c.buy_count || 0}<span style="opacity:.5">/</span>${c.sell_count || 0}</span></td>
			<td class="cw-muted">${fmtDuration(c.hold_ms)}</td>
			<td class="cw-muted">${timeAgo(c.last_seen_at)}</td>
			<td><a class="cw-go" href="/launches/${encodeURIComponent(c.mint)}" aria-label="Open the $${sym} dashboard">→</a></td>
		</tr>`;
	}).join('');
}

// ── claim CTA ───────────────────────────────────────────────────────────────────
function ctaHtml(wallet, data) {
	const traderUrl = `/trader/${encodeURIComponent(wallet)}`;
	if (STATE.claimed) {
		return `<div class="cw-cta claimed">
			<div class="cw-cta-body">
				<h3>Your Trader Card is live</h3>
				<p>This wallet is verified and linked to your account. Share your record — every number on it traces to an on-chain trade, so anyone you send it to can verify it themselves.</p>
			</div>
			<div class="cw-cta-actions">
				<a class="cw-action primary" href="${esc(traderUrl)}">View Trader Card →</a>
				<button type="button" class="cw-action" id="cwShare2">Share ↗</button>
			</div>
		</div>`;
	}
	const lead = STATE.signedIn
		? `<h3>This is your record — claim it</h3><p>Sign a free, gasless message with this wallet to prove you control it and publish it as your official three.ws Trader Card. Provable, shareable, and verifiable on-chain by anyone.</p>`
		: `<h3>Own this track record</h3><p>Sign in, then prove control of this wallet to publish it as your official three.ws Trader Card — a public, on-chain-verifiable record anyone can check.</p>`;
	const action = STATE.signedIn
		? `<button type="button" class="cw-action primary" id="cwClaim2">Claim this wallet →</button>`
		: `<a class="cw-action primary" href="/login?next=${encodeURIComponent(`/claim-wallet?wallet=${wallet}`)}">Sign in to claim →</a>`;
	return `<div class="cw-cta">
		<div class="cw-cta-body">${lead}</div>
		<div class="cw-cta-actions">${action}<a class="cw-action" href="/leaderboard">Leaderboard</a></div>
	</div>`;
}

// ── interactions ────────────────────────────────────────────────────────────────
function wireDashboard(result) {
	const { wallet, data } = STATE;

	// window tabs, plus the "widen to all-time" escape hatch in the blank ledger
	result.querySelectorAll('[data-win]').forEach((tab) => {
		tab.addEventListener('click', () => {
			STATE.win = tab.dataset.win;
			renderDashboard();
		});
	});

	// copy address
	const copy = result.querySelector('#cwCopy');
	if (copy) copy.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(wallet);
			copy.classList.add('ok');
			copy.querySelector('span').textContent = 'Copied';
			setTimeout(() => { copy.classList.remove('ok'); const s = copy.querySelector('span'); if (s) s.textContent = 'Copy'; }, 1400);
		} catch { /* clipboard blocked — non-critical */ }
	});

	// share (both possible buttons)
	result.querySelectorAll('#cwShare, #cwShare2').forEach((btn) => btn.addEventListener('click', () => shareCard(wallet, data)));

	// claim (header + CTA buttons)
	result.querySelectorAll('#cwClaim, #cwClaim2').forEach((btn) => btn.addEventListener('click', () => claimWallet(wallet, result, data)));

	// ledger: sort headers
	result.querySelectorAll('.cw-table thead .cw-th-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const key = btn.dataset.sort;
			if (STATE.sortKey === key) STATE.sortDir *= -1;
			else { STATE.sortKey = key; STATE.sortDir = -1; }
			refreshLedger(result);
		});
	});

	// ledger: search
	const search = result.querySelector('#cwSearch');
	if (search) {
		let t;
		search.addEventListener('input', () => {
			clearTimeout(t);
			t = setTimeout(() => { STATE.q = search.value.trim(); refreshLedger(result, { keepFocus: true }); }, 160);
		});
	}

	// ledger: filter chips
	result.querySelectorAll('.cw-chip[data-filter]').forEach((chip) => {
		chip.addEventListener('click', () => {
			const f = chip.dataset.filter;
			STATE[f] = !STATE[f];
			refreshLedger(result);
		});
	});

	// ledger: row → full launch dashboard
	wireRows(result);
}

function wireRows(result) {
	result.querySelectorAll('.cw-table tbody tr[data-mint]').forEach((tr) => {
		tr.addEventListener('click', (e) => {
			// The last cell holds a real <a> to the same destination so keyboard
			// users can reach it; let the anchor navigate on its own.
			if (e.target.closest('a')) return;
			const mint = tr.dataset.mint;
			if (mint) window.location.href = `/launches/${encodeURIComponent(mint)}`;
		});
	});
	const clear = result.querySelector('#cwClearFilters');
	if (clear) clear.addEventListener('click', () => {
		STATE.q = '';
		STATE.hideDust = STATE.hideClosed = STATE.creatorOnly = false;
		const s = result.querySelector('#cwSearch');
		if (s) s.value = '';
		refreshLedger(result);
	});
}

// Re-render only the ledger body + chip/sort state without rebuilding the dashboard.
function refreshLedger(result, { keepFocus = false } = {}) {
	const coins = windowedCoins();
	const sol = _solPrice || 0;
	// header arrows + announced sort direction
	result.querySelectorAll('.cw-table thead .cw-th-btn').forEach((btn) => {
		const active = STATE.sortKey === btn.dataset.sort;
		const arr = btn.querySelector('.arr');
		if (arr) arr.textContent = active ? (STATE.sortDir === -1 ? '↓' : '↑') : '';
		const th = btn.closest('th');
		if (th) th.setAttribute('aria-sort', active ? (STATE.sortDir === -1 ? 'descending' : 'ascending') : 'none');
	});
	// chips
	result.querySelectorAll('.cw-chip[data-filter]').forEach((chip) => {
		const on = !!STATE[chip.dataset.filter];
		chip.classList.toggle('on', on);
		chip.setAttribute('aria-pressed', String(on));
	});
	const count = result.querySelector('#cwLedgerCount');
	if (count) count.textContent = ledgerCountLabel(filteredSortedCoins(coins).length, coins.length);
	const tbody = result.querySelector('#cwTbody');
	if (tbody) { tbody.innerHTML = ledgerRows(coins, sol); wireRows(result); }
	if (keepFocus) { const s = result.querySelector('#cwSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
}

function shareCard(wallet, data) {
	const traderUrl = `${location.origin}/trader/${encodeURIComponent(wallet)}`;
	const label = data.profile?.label ? ` (${LABEL_COPY[data.profile.label] || data.profile.label})` : '';
	const wr = data.profile?.win_rate != null ? ` · ${fmtPct(data.profile.win_rate)} WR` : '';
	const text = `My verified pump.fun track record${label}${wr} — provable on-chain on @trythreews`;
	if (navigator.share) {
		navigator.share({ title: 'three.ws Trader Card', text, url: traderUrl }).catch(() => {});
	} else {
		window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(traderUrl)}`, '_blank', 'noopener,width=550,height=420');
	}
}

// ── real claim via SIWS (signature-verified wallet link) ────────────────────────
function detectSolanaProvider() {
	if (typeof window === 'undefined') return null;
	return window.phantom?.solana || window.solana || window.backpack || window.solflare || null;
}
function setClaimMsg(result, text, tone = '') {
	let el = result.querySelector('#cwClaimMsg');
	if (!el) {
		const cta = result.querySelector('.cw-cta');
		if (!cta) return;
		el = document.createElement('p');
		el.id = 'cwClaimMsg';
		cta.appendChild(el);
	}
	el.className = `cw-claim-msg ${tone}`;
	el.textContent = text;
}
async function performLink({ message, signature, takeover }) {
	const body = { message, signature };
	if (takeover) body.takeover = true;
	const res = await fetch('/api/auth/wallets/link-solana', {
		method: 'POST', credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	return { res, data };
}
async function claimWallet(wallet, result, previewData) {
	const btns = [...result.querySelectorAll('#cwClaim, #cwClaim2')];
	const provider = detectSolanaProvider();
	if (!provider) {
		setClaimMsg(result, 'No Solana wallet detected. Install Phantom, Backpack, or Solflare to prove you control this keypair.', 'err');
		return;
	}
	const restore = btns.map((b) => b.textContent);
	const setLabel = (t) => btns.forEach((b) => { b.disabled = true; b.textContent = t; });
	const reset = () => btns.forEach((b, i) => { b.disabled = false; b.textContent = restore[i]; });

	setLabel('Connect wallet…');
	setClaimMsg(result, '', '');
	try {
		if (!provider.isConnected) await provider.connect();
		const connected = provider.publicKey?.toBase58?.() || provider.publicKey?.toString?.();
		if (!connected) throw new Error('Could not read your wallet public key.');
		if (connected !== wallet) {
			setClaimMsg(result, `Your connected wallet (${shortAddr(connected)}) isn't this one. Switch to ${shortAddr(wallet)}, then claim again.`, 'err');
			reset();
			return;
		}

		setLabel('Requesting message…');
		const nonceRes = await fetch('/api/auth/wallets/nonce-solana', {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ address: wallet, chainId: 'mainnet' }),
		});
		const nonceData = await nonceRes.json().catch(() => ({}));
		if (!nonceRes.ok) throw new Error(nonceData.error_description || nonceData.message || 'Could not start the claim.');

		setLabel('Sign to claim…');
		let sigBase64;
		try {
			const msgBytes = new TextEncoder().encode(nonceData.message);
			const { signature } = await provider.signMessage(msgBytes, 'utf8');
			sigBase64 = btoa(String.fromCharCode(...signature));
		} catch (err) {
			if (err?.code === 4001 || /reject|cancel/i.test(err?.message || '')) {
				setClaimMsg(result, 'Signature cancelled — claim again whenever you’re ready.', 'err');
			} else {
				setClaimMsg(result, err?.message || 'Could not sign the claim message.', 'err');
			}
			reset();
			return;
		}

		setLabel('Claiming…');
		let { res, data } = await performLink({ message: nonceData.message, signature: sigBase64 });
		if (res.status === 409 && (data.error === 'address_in_use' || data.code === 'address_in_use')) {
			const confirmed = window.confirm('This wallet is currently claimed by another three.ws account. Your signature proves you control it — move it to this account?');
			if (!confirmed) { setClaimMsg(result, 'Claim cancelled — this wallet stays on its current account.', 'err'); reset(); return; }
			setLabel('Transferring…');
			({ res, data } = await performLink({ message: nonceData.message, signature: sigBase64, takeover: true }));
		}
		if (!res.ok) throw new Error(data.error_description || data.message || `Claim failed (HTTP ${res.status}).`);

		await getLinkedSolanaWallets({ force: true });
		STATE.claimed = true;
		renderDashboard();
		setClaimMsg($('#cwResult'), data.transferred ? 'Moved to your account — your Trader Card is live.' : 'Claimed — your Trader Card is live.', 'ok');
	} catch (err) {
		setClaimMsg(result, err?.message || 'Could not claim this wallet. Try again.', 'err');
		reset();
	}
}

// ── states ──────────────────────────────────────────────────────────────────────
function skeletonHtml() {
	return `<div class="cw-dash" aria-busy="true">
		<div class="cw-skel cw-skel-id"></div>
		<div class="cw-skel-kpis">${'<div class="cw-skel cw-skel-kpi"></div>'.repeat(5)}</div>
		<div class="cw-skel-grid"><div class="cw-skel cw-skel-pan"></div><div class="cw-skel cw-skel-pan"></div></div>
		<div class="cw-skel cw-skel-table"></div>
	</div>`;
}
// A failed report is a state, not an accident: name the cause, keep the address
// on screen, and put the retry one click away.
function errorHtml(wallet, err) {
	const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
	const raw = String(err?.message || '');
	const detail = offline
		? 'Your browser is offline, so the report could not be requested.'
		: /failed to fetch|networkerror|load failed/i.test(raw)
			? 'The request never reached three.ws. That is usually a dropped connection or a blocked request.'
			: raw || 'The intelligence brain could not be reached.';
	return `<div class="cw-empty cw-error" role="alert">
		<div class="ico">⚠</div>
		<h2>Could not load this wallet's report</h2>
		<p>
			<code>${esc(wallet)}</code><br><br>
			${esc(detail)} Nothing about this wallet's on-chain record has changed; only the read failed.
		</p>
		<div class="cw-error-actions">
			<button type="button" class="cw-action primary" id="cwRetry">Try again</button>
			<a class="cw-action" href="/leaderboard">Browse the leaderboard</a>
		</div>
	</div>`;
}

function notFoundHtml(wallet) {
	return `<div class="cw-empty">
		<div class="ico">◎</div>
		<h2>This wallet isn't indexed yet</h2>
		<p>
			<code>${esc(wallet)}</code><br><br>
			The intelligence brain only scores wallets it has seen in pump.fun order books. If this
			wallet has traded recently, its record is still indexing — check back in a few hours, or try another address.
		</p>
		<a class="cw-action primary" href="/leaderboard">Browse the leaderboard →</a>
	</div>`;
}
