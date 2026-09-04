// Trader Wrapped: the season recap, as a swipeable deck.
//
// Reads /api/pump/wrapped twice: once without an agent for the picker, once with
// one for the deck. Every state is designed here (loading, empty, too-little
// history, error, populated) because a recap that renders a blank void is worse
// than no recap.
//
// State lives in the URL (?agent&window) so a deck is deep-linkable and a share
// lands the reader on the exact slide the sharer was looking at (#s=3). The share
// link carries the sharer's referral code when they have one, which is the entire
// loop: the artifact travels, the referral comes back.
//
// The page signs and spends nothing. Every number is arithmetic over round-trips
// that already settled on-chain; the cross-links (Fork, Ghost-copy, the verified
// profile) are where a reader goes to act.

import { initFork, forkButton } from './fork-trade.js';

const viewEl = document.getElementById('wrView');
const windowSeg = document.getElementById('wrWindowSeg');
const headLinksEl = document.getElementById('wrHeadLinks');
const toastEl = document.getElementById('wrToast');

const WINDOW_LABEL = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' };
const WINDOW_SHORT = { '24h': '24h', '7d': '7 days', '30d': '30 days', all: 'all time' };
const HOUR_LABEL = (h) => `${String(h).padStart(2, '0')}:00 UTC`;

const state = { agent: null, window: '30d', slide: 0 };
let deck = null;
let loadSeq = 0;

// ── helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
	return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}
function num(n) {
	return n != null && Number.isFinite(Number(n)) ? Number(n) : null;
}
function sol(n, dp = 3) {
	const v = num(n);
	if (v == null) return null;
	const s = v.toFixed(dp);
	return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
}
function signedSol(n, dp = 3) {
	const v = num(n);
	if (v == null) return null;
	return `${v > 0 ? '+' : ''}${sol(v, dp)}`;
}
function signedPct(n, dp = 0) {
	const v = num(n);
	if (v == null) return null;
	return `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`;
}
function usd(n) {
	const v = num(n);
	if (v == null) return null;
	const abs = Math.abs(v);
	const s = abs >= 1000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toFixed(2);
	return `${v < 0 ? '-' : ''}$${s}`;
}
function signClass(n) {
	const v = num(n);
	if (v == null || v === 0) return '';
	return v > 0 ? 'pos' : 'neg';
}
function coinLabel(c) {
	if (!c) return 'a coin';
	if (c.symbol) return `$${c.symbol}`;
	if (c.name) return c.name;
	return c.mint ? `${c.mint.slice(0, 4)}…${c.mint.slice(-4)}` : 'a coin';
}
function avatar(src, name, cls = 'wr-av') {
	return src
		? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" />`
		: `<span class="${cls}" aria-hidden="true">${esc(initials(name))}</span>`;
}
function dayLabel(day) {
	if (!day) return null;
	const d = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return day;
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

let toastTimer = null;
function toast(msg) {
	if (!toastEl) return;
	toastEl.textContent = msg;
	toastEl.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// ── URL state ───────────────────────────────────────────────────────────────

function readUrl() {
	const q = new URLSearchParams(location.search);
	const agent = (q.get('agent') || '').trim();
	state.agent = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent) ? agent : null;
	const win = q.get('window');
	state.window = ['7d', '30d', 'all'].includes(win) ? win : '30d';
	const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
	const s = parseInt(hash.get('s') || '0', 10);
	state.slide = Number.isFinite(s) && s > 0 ? s : 0;
}

function writeUrl({ replace = false } = {}) {
	const q = new URLSearchParams();
	if (state.agent) q.set('agent', state.agent);
	if (state.window !== '30d') q.set('window', state.window);
	const hash = state.agent && state.slide > 0 ? `#s=${state.slide}` : '';
	const url = `${location.pathname}${q.toString() ? `?${q}` : ''}${hash}`;
	history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

// ── the sharer's referral code, when they have one ──────────────────────────

let refP = null;
function referralCode() {
	if (!refP) {
		refP = fetch('/api/users/referrals', { credentials: 'include', headers: { accept: 'application/json' } })
			.then((r) => (r.ok ? r.json() : null))
			.then((c) => c?.referral_code || c?.code || c?.referralCode || null)
			.catch(() => null);
	}
	return refP;
}

async function shareUrl() {
	const url = new URL(`/wrapped/${state.agent}/share`, location.origin);
	if (state.window !== '30d') url.searchParams.set('window', state.window);
	const ref = await referralCode();
	if (ref) url.searchParams.set('ref', ref);
	return url.toString();
}

function shareText() {
	if (!deck?.headline) return 'Trader Wrapped on three.ws';
	return `${deck.headline} Verified on-chain, three.ws Trader Wrapped.`;
}

async function doShare() {
	const url = await shareUrl();
	const text = shareText();
	if (navigator.share) {
		try {
			await navigator.share({ title: 'Trader Wrapped', text, url });
			return;
		} catch (err) {
			if (err?.name === 'AbortError') return;
		}
	}
	try {
		await navigator.clipboard.writeText(`${text}\n${url}`);
		toast('Recap copied to your clipboard');
	} catch {
		window.prompt('Copy this recap link', url);
	}
}

async function openOnX() {
	const url = await shareUrl();
	const intent = new URL('https://x.com/intent/tweet');
	intent.searchParams.set('text', shareText());
	intent.searchParams.set('url', url);
	window.open(intent.toString(), '_blank', 'noopener,noreferrer');
}

// ── data ────────────────────────────────────────────────────────────────────

async function fetchJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	let body = null;
	try { body = await res.json(); } catch { body = null; }
	if (!res.ok) {
		const err = new Error(body?.message || body?.error || `Request failed (${res.status})`);
		err.status = res.status;
		throw err;
	}
	return body;
}

// ── picker ──────────────────────────────────────────────────────────────────

function skeleton(cards = 6) {
	return `<div class="wr-grid">${Array.from({ length: cards }, () => `
		<div class="wr-skel" aria-hidden="true">
			<div class="wr-sk" style="width:56%"></div>
			<div class="wr-sk" style="width:34%"></div>
			<div class="wr-sk" style="width:88%;height:28px"></div>
		</div>`).join('')}</div>`;
}

function renderPicker(data) {
	const traders = data?.traders || [];
	if (!traders.length) {
		viewEl.innerHTML = `
			<div class="wr-note">
				<h2>No recap to cut for ${esc(WINDOW_LABEL[state.window])} yet</h2>
				<p>A season needs at least ${esc(String(data?.min_closed || 3))} settled round-trips before the numbers mean anything.
				Widen the window, or watch a trader build one.</p>
				<div class="wr-links" style="margin-top:14px">
					<a class="wr-lnk" href="/leaderboard">Trader leaderboard</a>
					<a class="wr-lnk" href="/trades">Live trade feed</a>
					<a class="wr-lnk" href="/ghost-copy">Ghost-copy a leader</a>
				</div>
			</div>`;
		return;
	}
	viewEl.innerHTML = `
		<p class="wr-kicker" id="wrPickLabel">${traders.length} trader${traders.length === 1 ? '' : 's'} with a season worth reading</p>
		<div class="wr-grid" role="list" aria-labelledby="wrPickLabel">
			${traders.map((t) => `
				<a class="wr-card" role="listitem" href="/wrapped?agent=${esc(t.agent_id)}${state.window !== '30d' ? `&window=${esc(state.window)}` : ''}" data-agent="${esc(t.agent_id)}">
					<div class="wr-card-top">
						${avatar(t.avatar, t.name)}
						<div style="min-width:0">
							<div class="wr-card-name">${esc(t.name)}</div>
							<div class="wr-card-meta">${t.closed} round-trip${t.closed === 1 ? '' : 's'} · ${t.coins} coin${t.coins === 1 ? '' : 's'}</div>
						</div>
					</div>
					<div class="wr-stats">
						<div class="wr-stat"><div class="k">P&amp;L</div><div class="v ${signClass(t.pnl_sol)}">${esc(signedSol(t.pnl_sol) ?? '-')}</div></div>
						<div class="wr-stat"><div class="k">Win rate</div><div class="v">${t.win_rate_pct != null ? `${Math.round(t.win_rate_pct)}%` : '-'}</div></div>
						<div class="wr-stat"><div class="k">Coins</div><div class="v">${t.coins}</div></div>
					</div>
				</a>`).join('')}
		</div>`;
}

// ── slides ──────────────────────────────────────────────────────────────────

function tile(k, v, note) {
	if (v == null || v === '') return '';
	return `<div class="wr-tile"><div class="k">${esc(k)}</div><div class="v">${v}</div>${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
}

/** Cumulative realized-P&L sparkline. Zero line drawn so a red season looks red. */
function sparkline(series) {
	const pts = (series || []).map(Number).filter(Number.isFinite);
	if (pts.length < 2) return '';
	const w = 560, h = 62, pad = 3;
	const min = Math.min(0, ...pts);
	const max = Math.max(0, ...pts);
	const span = max - min || 1;
	const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
	const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
	const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
	const zero = y(0).toFixed(1);
	const end = pts[pts.length - 1];
	const stroke = end >= 0 ? 'var(--wr-green)' : 'var(--wr-red)';
	return `<svg class="wr-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Cumulative realized profit and loss across the season">
		<line x1="0" y1="${zero}" x2="${w}" y2="${zero}" stroke="var(--wr-line)" stroke-width="1" stroke-dasharray="3 3" />
		<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
	</svg>`;
}

function tradeLinks(t) {
	const links = [];
	if (t?.buy_url) links.push(`<a class="wr-lnk" href="${esc(t.buy_url)}" target="_blank" rel="noopener noreferrer">Buy tx</a>`);
	if (t?.sell_url) links.push(`<a class="wr-lnk" href="${esc(t.sell_url)}" target="_blank" rel="noopener noreferrer">Sell tx</a>`);
	return links.length ? `<div class="wr-links">${links.join('')}</div>` : '';
}

function slideIntro(s) {
	const span = s.first_active_at && s.last_active_at
		? `${new Date(s.first_active_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to ${new Date(s.last_active_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
		: WINDOW_LABEL[s.window] || 'this season';
	return `
		<div class="wr-eyebrow">${esc(WINDOW_SHORT[s.window] || s.window)} · the season</div>
		<div class="wr-mid">${esc(s.title)}</div>
		<p class="wr-say">${esc(span)}. Here is what the ledger actually says.</p>
		<div class="wr-row">
			${tile('Round-trips', String(s.closed_count))}
			${tile('Coins traded', String(s.unique_coins))}
			${tile('Active days', String(s.active_days))}
		</div>`;
}

function slideScoreboard(s) {
	const verdictCopy = {
		green: 'The season closed green.',
		red: 'The season closed red. That is the number, not a spin on it.',
		flat: 'The season closed flat.',
		no_trades: 'Nothing settled in this window.',
	}[s.verdict] || '';
	return `
		<div class="wr-eyebrow">Realized profit and loss</div>
		<div class="wr-big ${signClass(s.realized_pnl_sol)}">${esc(signedSol(s.realized_pnl_sol, 3) ?? '-')} SOL</div>
		<p class="wr-say">${s.realized_pnl_usd != null ? `${esc(usd(s.realized_pnl_usd))} at today's SOL price. ` : ''}${esc(verdictCopy)}</p>
		${sparkline(s.pnl_series)}
		<div class="wr-row">
			${tile('Win rate', `${Math.round((s.win_rate || 0) * 100)}%`, `${s.wins} won, ${s.losses} lost`)}
			${tile('ROI', `<span class="${signClass(s.roi_pct)}">${esc(signedPct(s.roi_pct, 1) ?? '-')}</span>`, `${sol(s.invested_sol, 2)} SOL deployed`)}
			${s.profit_factor != null ? tile('Profit factor', s.profit_factor.toFixed(2), 'gross won over gross lost') : ''}
		</div>`;
}

function slideBestTrade(s) {
	const t = s.trade || {};
	const mult = num(t.multiple);
	return `
		<div class="wr-eyebrow">The best trade of the season</div>
		<div class="wr-big pos">${mult != null && mult >= 1 ? `${mult.toFixed(2)}x` : esc(signedPct(t.pnl_pct) ?? '-')}</div>
		<div class="wr-mid">${esc(coinLabel(t))}${t.name && t.symbol ? ` <span style="color:var(--wr-faint);font-weight:600;font-size:15px">${esc(t.name)}</span>` : ''}</div>
		<p class="wr-say">
			${esc(sol(t.entry_sol, 4) ?? '-')} SOL in, held ${esc(t.held_human || '-')}, out for ${esc(signedSol(t.pnl_sol, 4) ?? '-')} SOL${t.pnl_usd != null ? ` (${esc(usd(t.pnl_usd))})` : ''}.
			${t.exit_reason ? `Exit: ${esc(String(t.exit_reason).replace(/_/g, ' '))}.` : ''}
			${t.moonbag_held ? ' The initials came out and the rest still rides.' : ''}
		</p>
		${tradeLinks(t)}
		<div class="wr-links" data-fork-slot="${esc(t.mint || '')}"></div>`;
}

function slideWorstTrade(s) {
	const t = s.trade || {};
	return `
		<div class="wr-eyebrow">The one that hurt</div>
		<div class="wr-big neg">${esc(signedPct(t.pnl_pct) ?? '-')}</div>
		<div class="wr-mid">${esc(coinLabel(t))}</div>
		<p class="wr-say">
			${esc(sol(t.entry_sol, 4) ?? '-')} SOL in, held ${esc(t.held_human || '-')}, closed at ${esc(signedSol(t.pnl_sol, 4) ?? '-')} SOL${t.pnl_usd != null ? ` (${esc(usd(t.pnl_usd))})` : ''}.
			${t.exit_reason ? `Exit: ${esc(String(t.exit_reason).replace(/_/g, ' '))}.` : ''}
			Losers are counted here, not hidden. That is what makes the rest of the record worth reading.
		</p>
		${tradeLinks(t)}`;
}

function slideTopCoins(s) {
	const top = s.top_coin || {};
	const rest = (s.top_coins || []).slice(0, 3);
	return `
		<div class="wr-eyebrow">The coin that carried the season</div>
		<div class="wr-big ${signClass(top.pnl_sol)}">${esc(signedSol(top.pnl_sol, 3) ?? '-')} SOL</div>
		<div class="wr-mid">${esc(coinLabel(top))}</div>
		<p class="wr-say">
			${top.trades} round-trip${top.trades === 1 ? '' : 's'}, ${top.wins} won${top.roi_pct != null ? `, ${esc(signedPct(top.roi_pct, 1))} on what went in` : ''}.
			A coin ranks by what it actually returned, so one that cost the season money can rank too.
		</p>
		${rest.length > 1 ? `<div style="display:grid;gap:8px">${rest.map((c) => `
			<div class="wr-coinrow">
				<div><div class="sym">${esc(coinLabel(c))}</div><div class="sub">${c.trades} trade${c.trades === 1 ? '' : 's'} · ${c.wins} won</div></div>
				<div class="v ${signClass(c.pnl_sol)}" style="font-weight:700;font-variant-numeric:tabular-nums">${esc(signedSol(c.pnl_sol, 3) ?? '-')} SOL</div>
			</div>`).join('')}</div>` : ''}`;
}

function slideRhythm(s) {
	const peak = s.peak_hour;
	const best = s.best_day;
	return `
		<div class="wr-eyebrow">How they traded</div>
		<div class="wr-mid">${s.longest_win_streak > 1 ? `${s.longest_win_streak} wins in a row, at best` : 'No streak longer than a single win'}</div>
		<p class="wr-say">
			${s.active_days} active day${s.active_days === 1 ? '' : 's'}, ${esc(String(s.trades_per_active_day ?? '-'))} round-trips on an average one.
			Median hold ${esc(s.median_hold_human || '-')}.
			${peak ? `Most entries landed around ${esc(HOUR_LABEL(peak.hour_utc))} (${Math.round(peak.share_pct)}% of them).` : ''}
		</p>
		<div class="wr-row">
			${s.longest_loss_streak > 1 ? tile('Worst run', `${s.longest_loss_streak} straight`, 'losses back to back') : ''}
			${best ? tile('Best day', `<span class="${signClass(best.pnl_sol)}">${esc(signedSol(best.pnl_sol, 3) ?? '-')}</span>`, `${dayLabel(best.day)} · ${best.trades} trades`) : ''}
			${s.busiest_day ? tile('Busiest day', `${s.busiest_day.trades}`, `${dayLabel(s.busiest_day.day)} · ${s.busiest_day.wins} won`) : ''}
			${s.fastest_win ? tile('Fastest win', esc(s.fastest_win.held_human), coinLabel(s.fastest_win)) : ''}
			${s.longest_hold ? tile('Longest hold', esc(s.longest_hold.held_human), coinLabel(s.longest_hold)) : ''}
		</div>`;
}

function slideRank(s) {
	const r = s.rival;
	const beat = num(s.beat_pct);
	return `
		<div class="wr-eyebrow">Against the field</div>
		<div class="wr-big">#${s.rank}<span style="font-size:.4em;color:var(--wr-faint);font-weight:700"> of ${s.sample}</span></div>
		<p class="wr-say">
			${beat != null ? `Ahead of ${Math.round(beat)}% of the ${s.sample} traders` : `Ranked among the ${s.sample} traders`}
			who settled at least ${s.min_closed} round-trips on three.ws in ${esc(WINDOW_LABEL[state.window])}.
			It is a real field, not a percentile of everyone who ever traded a memecoin.
		</p>
		${r ? `
			<div class="wr-coinrow">
				<div style="display:flex;align-items:center;gap:10px;min-width:0">
					${avatar(r.avatar, r.name)}
					<div style="min-width:0">
						<div class="sym">${esc(r.name)}</div>
						<div class="sub">${r.ahead === 'them' ? 'One place ahead' : 'One place behind'} · ${r.closed} round-trips</div>
					</div>
				</div>
				<div style="text-align:right">
					<div class="${signClass(r.gap_sol)}" style="font-weight:700;font-variant-numeric:tabular-nums">${esc(signedSol(r.gap_sol, 3) ?? '-')} SOL</div>
					<div class="sub">the gap</div>
				</div>
			</div>
			<div class="wr-links">
				<a class="wr-lnk" href="${esc(r.profile_url)}">See their record</a>
				<a class="wr-lnk" href="/wrapped?agent=${esc(r.agent_id)}${state.window !== '30d' ? `&window=${esc(state.window)}` : ''}">Their wrapped</a>
			</div>` : ''}`;
}

function slideReceipt(s) {
	return `
		<div class="wr-eyebrow">The receipt</div>
		<div class="wr-big">${s.score}<span style="font-size:.35em;color:var(--wr-faint);font-weight:700"> / 100</span></div>
		<p class="wr-say">
			${s.verified ? 'Verified track record: enough settled round-trips across enough coins, with churn below the gate.' : 'Not yet verified: the record needs more settled round-trips across more coins before the badge is honest.'}
			${s.self_dealing_count > 0 ? ` ${s.self_dealing_count} round-trip${s.self_dealing_count === 1 ? '' : 's'} on self-launched coins ${s.self_dealing_count === 1 ? 'was' : 'were'} excluded from every number here.` : ''}
		</p>
		<div class="wr-row">
			${tile('Max drawdown', `${Math.round(s.max_drawdown_pct)}%`)}
			${tile('Consistency', s.sharpe != null ? s.sharpe.toFixed(2) : null, 'Sharpe-like')}
			${s.snipe_sample > 0 && s.snipe_hit_rate != null ? tile('Snipe hit rate', `${Math.round(s.snipe_hit_rate * 100)}%`, `over ${s.snipe_sample} proven launches`) : ''}
			${s.moonbags_held > 0 ? tile('Moon bags riding', String(s.moonbags_held), 'initials already out') : ''}
		</div>`;
}

const RENDERERS = {
	intro: slideIntro,
	scoreboard: slideScoreboard,
	best_trade: slideBestTrade,
	worst_trade: slideWorstTrade,
	top_coins: slideTopCoins,
	rhythm: slideRhythm,
	rank: slideRank,
	receipt: slideReceipt,
};

// ── deck ────────────────────────────────────────────────────────────────────

function renderDeck() {
	const slides = deck.slides || [];
	state.slide = Math.min(Math.max(0, state.slide), slides.length - 1);
	const s = slides[state.slide];
	const render = RENDERERS[s.kind];
	const body = render ? render(s) : '';
	const a = deck.agent;

	viewEl.innerHTML = `
		<div class="wr-deck" id="wrDeck" tabindex="0" role="group" aria-roledescription="carousel" aria-label="Trader Wrapped slides">
			<div class="wr-deckhead">
				${avatar(a.image, a.name)}
				<div style="min-width:0">
					<div class="nm">${esc(a.name)}</div>
					<div class="wn">${esc(WINDOW_LABEL[deck.window] || deck.window)} · ${deck.closed_count} settled round-trips</div>
				</div>
			</div>
			<div class="wr-bars" aria-hidden="true">
				${slides.map((_, i) => `<span class="wr-bar ${i < state.slide ? 'done' : i === state.slide ? 'now' : ''}"><i></i></span>`).join('')}
			</div>
			<div class="wr-slide" id="wrSlide" role="group" aria-roledescription="slide" aria-label="Slide ${state.slide + 1} of ${slides.length}">${body}</div>
			<div class="wr-nav">
				<button type="button" class="wr-btn" id="wrPrev" ${state.slide === 0 ? 'disabled' : ''}>Back</button>
				<span class="wr-count">${state.slide + 1} / ${slides.length}</span>
				${state.slide < slides.length - 1
					? '<button type="button" class="wr-btn primary" id="wrNext">Next</button>'
					: '<button type="button" class="wr-btn primary" id="wrShare">Share this recap</button>'}
			</div>
		</div>
		<div class="wr-after">
			<a class="wr-btn" href="${esc(a.profile_url)}">Verify this record on-chain</a>
			<a class="wr-btn" href="/ghost-copy?leader=${esc(a.id)}&window=${esc(deck.window === 'all' ? '30d' : deck.window)}">Ghost-copy this trader</a>
			<button type="button" class="wr-btn" id="wrX">Post to X</button>
			<button type="button" class="wr-btn" id="wrCopy">Copy link</button>
			<a class="wr-btn" href="/wrapped${state.window !== '30d' ? `?window=${esc(state.window)}` : ''}">Another trader</a>
		</div>
		<p class="wr-sub" style="margin-top:16px;font-size:13px">
			Cut from ${deck.closed_count} closed round-trips with on-chain buy and sell signatures. Read-only:
			this page never signs, spends, or takes custody. Past results are a record, not a promise.
		</p>`;

	const deckEl = document.getElementById('wrDeck');
	document.getElementById('wrPrev')?.addEventListener('click', () => go(state.slide - 1));
	document.getElementById('wrNext')?.addEventListener('click', () => go(state.slide + 1));
	document.getElementById('wrShare')?.addEventListener('click', doShare);
	document.getElementById('wrX')?.addEventListener('click', openOnX);
	document.getElementById('wrCopy')?.addEventListener('click', doShare);

	// A slide about a coin the trader actually traded gets a Fork button, so the
	// recap converts on the spot instead of being a dead end.
	const slot = deckEl?.querySelector('[data-fork-slot]');
	const mint = slot?.getAttribute('data-fork-slot');
	if (slot && mint) {
		const t = s.trade || {};
		slot.insertAdjacentHTML('beforeend', forkButton(
			{ mint, symbol: t.symbol, name: t.name },
			{ className: 'wr-lnk', label: `Fork ${coinLabel(t)}` },
		));
	}

	attachSwipe(deckEl);
	if (deckEl && document.activeElement === document.body) deckEl.focus({ preventScroll: true });
}

function go(i) {
	const slides = deck?.slides || [];
	if (!slides.length) return;
	const next = Math.min(Math.max(0, i), slides.length - 1);
	if (next === state.slide) return;
	state.slide = next;
	writeUrl({ replace: true });
	renderDeck();
}

function attachSwipe(el) {
	if (!el) return;
	let x0 = null;
	el.addEventListener('touchstart', (e) => { x0 = e.changedTouches[0].clientX; }, { passive: true });
	el.addEventListener('touchend', (e) => {
		if (x0 == null) return;
		const dx = e.changedTouches[0].clientX - x0;
		x0 = null;
		if (Math.abs(dx) < 44) return;
		go(state.slide + (dx < 0 ? 1 : -1));
	}, { passive: true });
}

// ── load ────────────────────────────────────────────────────────────────────

function renderHeadLinks() {
	headLinksEl.innerHTML = state.agent
		? '<a class="wr-lnk" href="/wrapped">All traders</a><a class="wr-lnk" href="/leaderboard">Leaderboard</a>'
		: '<a class="wr-lnk" href="/leaderboard">Leaderboard</a><a class="wr-lnk" href="/ghost-copy">Ghost-copy</a><a class="wr-lnk" href="/trades">Live trades</a>';
}

function renderError(err) {
	viewEl.innerHTML = `
		<div class="wr-note err">
			<h2>That recap could not be cut</h2>
			<p>${esc(err?.message || 'The request failed.')}</p>
			<div class="wr-links" style="margin-top:14px">
				<button type="button" class="wr-lnk" id="wrRetry">Try again</button>
				<a class="wr-lnk" href="/wrapped">Pick another trader</a>
			</div>
		</div>`;
	document.getElementById('wrRetry')?.addEventListener('click', () => load());
}

function renderThin(data) {
	viewEl.innerHTML = `
		<div class="wr-note">
			<h2>${esc(data.agent?.name || 'This trader')} has no season yet</h2>
			<p>
				${data.closed_count === 0 ? 'Nothing settled' : `Only ${data.closed_count} round-trip${data.closed_count === 1 ? '' : 's'} settled`}
				in ${esc(WINDOW_LABEL[data.window] || data.window)}. A recap needs at least ${data.min_closed}
				before any of its numbers would mean something, and we would rather say that than draw a chart out of noise.
			</p>
			<div class="wr-links" style="margin-top:14px">
				${data.window !== 'all' ? '<button type="button" class="wr-lnk" id="wrAllTime">Try all time</button>' : ''}
				<a class="wr-lnk" href="${esc(data.agent?.profile_url || '/leaderboard')}">See their profile</a>
				<a class="wr-lnk" href="/wrapped">Pick another trader</a>
			</div>
		</div>`;
	document.getElementById('wrAllTime')?.addEventListener('click', () => {
		state.window = 'all';
		syncSeg();
		writeUrl();
		load();
	});
}

async function load() {
	const seq = ++loadSeq;
	renderHeadLinks();
	viewEl.innerHTML = state.agent
		? '<div class="wr-skel" aria-hidden="true"><div class="wr-sk" style="width:40%"></div><div class="wr-sk" style="width:70%;height:44px"></div><div class="wr-sk" style="width:90%"></div><div class="wr-sk" style="width:60%"></div></div>'
		: skeleton();

	const q = new URLSearchParams({ window: state.window });
	if (state.agent) q.set('agent', state.agent);

	try {
		const data = await fetchJson(`/api/pump/wrapped?${q}`);
		if (seq !== loadSeq) return;
		if (!state.agent) {
			deck = null;
			renderPicker(data);
			return;
		}
		if (!data.enough_history) {
			deck = null;
			renderThin(data);
			return;
		}
		deck = data;
		document.title = `${data.agent.name} wrapped: ${WINDOW_SHORT[data.window] || data.window} on pump.fun · three.ws`;
		renderDeck();
	} catch (err) {
		if (seq !== loadSeq) return;
		deck = null;
		renderError(err);
	}
}

function syncSeg() {
	windowSeg?.querySelectorAll('button').forEach((b) => {
		b.setAttribute('aria-pressed', String(b.dataset.window === state.window));
	});
}

// ── wiring ──────────────────────────────────────────────────────────────────

windowSeg?.addEventListener('click', (e) => {
	const btn = e.target.closest('button[data-window]');
	if (!btn || btn.dataset.window === state.window) return;
	state.window = btn.dataset.window;
	state.slide = 0;
	syncSeg();
	writeUrl();
	load();
});

viewEl?.addEventListener('click', (e) => {
	const card = e.target.closest('a.wr-card[data-agent]');
	if (!card || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
	e.preventDefault();
	state.agent = card.dataset.agent;
	state.slide = 0;
	writeUrl();
	load();
});

document.addEventListener('keydown', (e) => {
	if (!deck || e.metaKey || e.ctrlKey || e.altKey) return;
	const tag = document.activeElement?.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
	if (e.key === 'ArrowRight' || e.key === 'j' || e.key === ' ') { e.preventDefault(); go(state.slide + 1); }
	else if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); go(state.slide - 1); }
});

window.addEventListener('popstate', () => {
	readUrl();
	syncSeg();
	load();
});

initFork({ deepLink: true });
readUrl();
syncSeg();
load();
