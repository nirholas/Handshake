/**
 * Launch deep-dive — the centre column of the trade terminal.
 *
 * For one mint it assembles every real signal the platform holds, from five
 * live endpoints (no mocks, no fabricated numbers):
 *
 *   /api/pump/launch-detail   registry · agent · economics · intel · outcome · trader
 *   /api/pump/curve           price · market cap · graduation progress
 *   /api/pump/intel           wallet footprint · funder clusters (drives the bubblemap)
 *   /api/pump/smart-money      money pedigree of who is in (found:false = not scored yet)
 *   /api/coin/:mint/cohorts    holder count · concentration · cohort distribution.
 *                              Only fetched for coins the platform tracks (a
 *                              three.ws launch or agent token, per launch-detail);
 *                              anything else renders its designed no-data state
 *                              instead of a guaranteed 404 round-trip.
 *
 * Plus three self-fetching live widgets: the candlestick chart (reused from
 * Mission Control), the bonding-curve ring, and the trade tape.
 *
 * Render strategy is progressive: the header + skeleton paint instantly from the
 * feed row that was clicked, the live widgets mount immediately, and each data
 * section fills itself in as its fetch settles. A failed section degrades to an
 * honest "unavailable" note — never a blank void, never a fake value.
 */

import { mountPriceChart } from './mission-control/chart.js';
import { mountBondingCurve } from './widgets/bonding-curve.js';
import { mountBubblemap } from './trades-bubblemap.js';
import { mountTradeTape } from './trades-tape.js';
import { escapeHtml, compact, shortAddr, relTime, identicon } from './trader-format.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// ── formatting ──────────────────────────────────────────────────────────────
const SUBS = '₀₁₂₃₄₅₆₇₈₉';
function fmtPrice(p) {
	const n = Number(p);
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n >= 1) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
	if (n >= 0.01) return `$${n.toFixed(4)}`;
	const exp = Math.floor(Math.log10(n));
	const zeros = -exp - 1;
	const sig = Math.round(n * 10 ** (-exp + 2));
	if (zeros >= 4) return `$0.0${String(zeros).split('').map((d) => SUBS[+d]).join('')}${sig}`;
	return `$${n.toFixed(Math.min(zeros + 3, 12))}`;
}
function fmtMc(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return '—';
	return `$${compact(v)}`;
}
function fmtSol(n, dp = 2) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return `${v.toFixed(dp)} ◎`;
}
function pct(n, dp = 1) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;
}
function changeClass(n) {
	const v = Number(n);
	if (!Number.isFinite(v) || v === 0) return '';
	return v > 0 ? 'up' : 'down';
}

const RISK_LABEL = {
	bundle_launch: 'Bundled launch', dev_dumped: 'Dev dumped', single_whale: 'Single whale',
	low_diversity: 'Low diversity', fresh_wallet_swarm: 'Fresh-wallet swarm',
	sell_pressure: 'Sell pressure', sniped: 'Sniped', coordinated: 'Coordinated buys',
};
function riskLabel(k) { return RISK_LABEL[k] || String(k).replace(/_/g, ' '); }

// A 0..1 signal as a labelled bar. `invert` flips the good/bad colour mapping
// (e.g. bundle_score: high is bad).
function gauge(label, value, { invert = false, hint = '' } = {}) {
	if (value == null || !Number.isFinite(Number(value))) {
		return `<div class="dd-gauge dd-gauge--na"><span class="dd-gauge-l">${label}</span><span class="dd-gauge-v">not measured</span></div>`;
	}
	const v = Math.max(0, Math.min(1, Number(value)));
	const good = invert ? 1 - v : v;
	const tone = good >= 0.66 ? 'g' : good >= 0.33 ? 'a' : 'r';
	const widthPct = Math.round(v * 100);
	return `<div class="dd-gauge" title="${escapeHtml(hint)}">
		<span class="dd-gauge-l">${label}</span>
		<span class="dd-gauge-bar"><i class="dd-tone-${tone}" style="width:${widthPct}%"></i></span>
		<span class="dd-gauge-v">${Math.round(v * 100)}</span>
	</div>`;
}

function stat(label, value, cls = '') {
	return `<div class="dd-stat">
		<div class="dd-stat-v ${cls}">${value}</div>
		<div class="dd-stat-l">${label}</div>
	</div>`;
}

function section(id, title, bodyHtml, { right = '' } = {}) {
	return `<section class="dd-card" data-section="${id}">
		<header class="dd-card-h"><h2>${title}</h2>${right}</header>
		<div class="dd-card-b">${bodyHtml}</div>
	</section>`;
}

// ── socials / links ───────────────────────────────────────────────────────────
function socialLinks(socials = {}) {
	const out = [];
	if (socials.twitter) out.push(`<a href="${escapeHtml(socials.twitter)}" target="_blank" rel="noopener" class="dd-soc" title="X / Twitter">𝕏</a>`);
	if (socials.telegram) out.push(`<a href="${escapeHtml(socials.telegram)}" target="_blank" rel="noopener" class="dd-soc" title="Telegram">✈</a>`);
	if (socials.website) out.push(`<a href="${escapeHtml(socials.website)}" target="_blank" rel="noopener" class="dd-soc" title="Website">🌐</a>`);
	return out.join('');
}

// ──────────────────────────────────────────────────────────────────────────────

export function mountDetail(host, opts = {}) {
	const mint = String(opts.mint || '').trim();
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const seed = opts.seed || {};
	let destroyed = false;
	const teardowns = [];

	const sym = (seed.symbol || mint.slice(0, 4) || '?').toUpperCase();
	const name = seed.name || '';
	const img = seed.image_uri || seed.image || '';
	const isThree = mint === THREE_MINT;

	host.innerHTML = shell({ mint, network, sym, name, img, isThree });
	const $ = (sel) => host.querySelector(sel);

	// ── copy mint ────────────────────────────────────────────────────────────────
	const copyBtn = $('[data-host="copy"]');
	if (copyBtn) {
		copyBtn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(mint);
				copyBtn.classList.add('ok');
				copyBtn.textContent = '✓ Copied';
				setTimeout(() => { if (!destroyed) { copyBtn.classList.remove('ok'); copyBtn.textContent = '⧉ ' + shortAddr(mint, 4, 4); } }, 1400);
			} catch { /* clipboard blocked */ }
		});
	}

	// ── live widgets mount immediately (they self-fetch) ──────────────────────────
	try { teardowns.push(mountPriceChart({ host: $('[data-host="chart"]'), mint })); } catch (e) { chartFail($('[data-host="chart"]')); }
	try { teardowns.push(mountBondingCurve($('[data-host="curve"]'), { mint, network, showPoweredBy: false })); } catch { /* curve optional */ }
	try { teardowns.push(mountTradeTape($('[data-host="tape"]'), { mint })); } catch { /* tape optional */ }

	// ── data fetches ──────────────────────────────────────────────────────────────
	// Cohorts are chained on launch-detail: the platform only holds holder-cohort
	// data for its own launches, so the answer to "is this ours?" decides whether
	// the fetch happens at all.
	loadDetail().then(loadCohorts);
	loadCurve();
	loadIntel();
	loadSmart();

	async function loadCurve() {
		const stripEl = $('[data-host="strip"]');
		try {
			const r = await fetch(`/api/pump/curve?mint=${encodeURIComponent(mint)}&network=${network}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(String(r.status));
			const c = await r.json();
			if (destroyed) return;
			const price = c.price?.priceUsd ?? c.graduatedPrice?.priceUsd;
			const mc = c.price?.marketCapUsd ?? c.graduatedPrice?.marketCapUsd;
			const chg = c.price?.pricePercentChange24H;
			const grad = c.graduation?.isGraduated;
			const progress = c.graduation?.progressBps != null ? c.graduation.progressBps / 100 : null;
			stripEl.innerHTML =
				stat('Price', price != null ? fmtPrice(price) : '—') +
				stat('Market cap', mc != null ? fmtMc(mc) : '—') +
				stat('24h', chg != null ? pct(chg) : '—', changeClass(chg)) +
				stat('Status', grad ? '<span class="dd-grad">Graduated ✦</span>' : (progress != null ? `${progress.toFixed(1)}% to grad` : 'On curve')) +
				stat('SOL', c.price?.solPrice != null ? `$${Number(c.price.solPrice).toFixed(0)}` : '—');
		} catch {
			if (!destroyed) stripEl.innerHTML = stat('Market', 'Live price unavailable', 'dd-muted');
		}
	}

	async function loadDetail() {
		try {
			const r = await fetch(`/api/pump/launch-detail?mint=${encodeURIComponent(mint)}&network=${network}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(String(r.status));
			const d = await r.json();
			if (destroyed) return null;
			renderIdentityFromIntel(d.intel);
			renderFootprint(d.intel);
			renderOutcome(d.outcome);
			renderAgent(d);
			return d;
		} catch {
			if (!destroyed) markUnavailable(['footprint', 'outcome', 'agent']);
			return null;
		}
	}

	async function loadIntel() {
		try {
			const r = await fetch(`/api/pump/intel?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(String(r.status));
			const d = await r.json();
			if (destroyed) return;
			if (d.found === false || !d.coin) { markUnavailable(['signals', 'bubblemap', 'wallets']); return; }
			renderSignals(d.coin);
			renderBubblemap(d.coin, d.wallets, d.clusters);
			renderWallets(d.wallets);
		} catch {
			if (!destroyed) markUnavailable(['signals', 'bubblemap', 'wallets']);
		}
	}

	async function loadSmart() {
		try {
			const r = await fetch(`/api/pump/smart-money?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
			if (r.status === 404) { if (!destroyed) renderSmartNotScored(); return; } // pre-convention deploys
			if (!r.ok) throw new Error(String(r.status));
			const d = await r.json();
			if (destroyed) return;
			if (d.found === false || !d.coin) { renderSmartNotScored(); return; }
			renderSmart(d.coin, d.notable);
		} catch {
			if (!destroyed) markUnavailable(['smart']);
		}
	}

	// Only coins the platform launched carry a holder-cohort snapshot; asking for
	// anyone else's mint is a guaranteed not-found. Decide from the launch-detail
	// answer and render the designed no-data state without a doomed round-trip.
	async function loadCohorts(detailBody) {
		if (destroyed) return;
		if (!detailBody) { markUnavailable(['holders']); return; }
		if (!detailBody.found && !detailBody.agent) { renderHoldersNotTracked(); return; }
		try {
			const r = await fetch(`/api/coin/${encodeURIComponent(mint)}/cohorts`, { headers: { accept: 'application/json' } });
			if (r.status === 404) { if (!destroyed) renderHoldersNotTracked(); return; }
			if (!r.ok) throw new Error(String(r.status));
			const d = await r.json();
			if (destroyed) return;
			renderCohorts(d);
		} catch {
			if (!destroyed) markUnavailable(['holders']);
		}
	}

	// ── section renderers ─────────────────────────────────────────────────────────

	function renderIdentityFromIntel(intel) {
		if (!intel) return;
		const soc = $('[data-host="socials"]');
		if (soc && !soc.innerHTML.trim()) soc.innerHTML = socialLinks(intel.socials || {});
		const catEl = $('[data-host="cat"]');
		if (catEl && intel.category && intel.category !== 'unknown') {
			catEl.textContent = intel.category;
			catEl.hidden = false;
		}
		const ageEl = $('[data-host="age"]');
		if (ageEl && intel.created_at) { ageEl.textContent = `launched ${relTime(intel.created_at)}`; ageEl.hidden = false; }
		const descEl = $('[data-host="desc"]');
		if (descEl && intel.description) { descEl.textContent = intel.description; descEl.hidden = false; }
	}

	function renderSignals(coin) {
		const body = $('[data-section="signals"] .dd-card-b');
		if (!body) return;
		const q = coin.quality_score;
		const flags = Array.isArray(coin.risk_flags) ? coin.risk_flags : [];
		const tone = q == null ? '' : q >= 66 ? 'g' : q >= 40 ? 'a' : 'r';
		body.innerHTML = `
			<div class="dd-quality">
				<div class="dd-quality-ring dd-tone-${tone}">
					<span class="dd-quality-n">${q != null ? Math.round(q) : '—'}</span>
					<span class="dd-quality-l">quality</span>
				</div>
				<div class="dd-gauges">
					${gauge('Organic', coin.organic_score, { hint: 'Share of genuine, non-coordinated buys' })}
					${gauge('Bundle risk', coin.bundle_score, { invert: true, hint: 'Coordinated bundle-launch likelihood' })}
					${gauge('Snipe ratio', coin.snipe_ratio, { invert: true, hint: 'Volume captured by snipers in first seconds' })}
					${gauge('Top-10 conc.', coin.concentration_top10, { invert: true, hint: 'Buy volume held by the top 10 wallets' })}
					${gauge('Fresh wallets', coin.fresh_wallet_ratio, { invert: true, hint: 'Share of brand-new wallets buying' })}
					${gauge('Funder spread', coin.bubblemap_connectivity, { invert: true, hint: 'Wallet-cluster connectivity by shared funder' })}
				</div>
			</div>
			${flags.length ? `<div class="dd-flags">${flags.map((f) => `<span class="dd-flag">${escapeHtml(riskLabel(f))}</span>`).join('')}</div>` : '<div class="dd-clean">No risk flags raised on this launch.</div>'}`;
	}

	function renderFootprint(intel) {
		const body = $('[data-section="footprint"] .dd-card-b');
		if (!body) return;
		if (!intel) { body.innerHTML = unavailable('First-seconds footprint not recorded for this coin.'); return; }
		body.innerHTML = `<div class="dd-stats dd-stats--6">
			${stat('Buys', compact(intel.buy_count ?? 0))}
			${stat('Sells', compact(intel.sell_count ?? 0))}
			${stat('Unique buyers', compact(intel.unique_buyers ?? 0))}
			${stat('Unique sellers', compact(intel.unique_sellers ?? 0))}
			${stat('Buy vol', fmtSol(intel.buy_volume_sol ?? 0))}
			${stat('Sell vol', fmtSol(intel.sell_volume_sol ?? 0))}
			${stat('Largest buy', fmtSol(intel.largest_buy_sol ?? 0))}
			${stat('Dev buy', fmtSol(intel.dev_buy_sol ?? 0))}
			${stat('Dev sold', intel.dev_sold ? '<span class="dd-bad">Yes</span>' : '<span class="dd-good">No</span>')}
			${stat('Observed', intel.observation_seconds != null ? `${intel.observation_seconds}s` : '—')}
		</div>`;
	}

	function renderCohorts(d) {
		const body = $('[data-section="holders"] .dd-card-b');
		if (!body) return;
		const holders = d.holderCount;
		const conc = d.concentration || {};
		const cohorts = (Array.isArray(d.cohorts) ? d.cohorts : []).filter((c) => c.count != null && c.count > 0);
		const top1 = conc.top1Pct ?? conc.top1 ?? null;
		const top10 = conc.top10Pct ?? conc.top10 ?? null;
		const maxCount = Math.max(1, ...cohorts.map((c) => Number(c.count) || 0));
		body.innerHTML = `
			<div class="dd-stats dd-stats--3">
				${stat('Holders', holders != null ? compact(holders) : '—')}
				${stat('Top 1%', top1 != null ? `${(Number(top1) * (top1 <= 1 ? 100 : 1)).toFixed(1)}%` : '—')}
				${stat('Top 10%', top10 != null ? `${(Number(top10) * (top10 <= 1 ? 100 : 1)).toFixed(1)}%` : '—')}
			</div>
			${cohorts.length ? `<div class="dd-cohorts">${cohorts.map((c) => `
				<div class="dd-cohort">
					<span class="dd-cohort-l" title="${escapeHtml(c.description || '')}">${escapeHtml(c.label || c.id)}</span>
					<span class="dd-cohort-bar"><i style="width:${Math.round((Number(c.count) / maxCount) * 100)}%"></i></span>
					<span class="dd-cohort-n">${compact(c.count)}</span>
				</div>`).join('')}</div>` : '<p class="dd-note">Holder cohort breakdown will populate as the holder set is indexed.</p>'}`;
	}

	// Designed no-data state: the platform tracks holder cohorts for its own
	// launches only, so point elsewhere-launched coins at the on-chain truth.
	function renderHoldersNotTracked() {
		const body = $('[data-section="holders"] .dd-card-b');
		if (!body) return;
		body.innerHTML = `
			<p class="dd-note dd-note--na">No holder-cohort snapshot exists for this coin. Cohorts are indexed for coins launched on three.ws; the full holder list lives on-chain.</p>
			<div style="text-align:center"><a href="https://solscan.io/token/${encodeURIComponent(mint)}#holders" target="_blank" rel="noopener" class="dd-btn">View holders on Solscan ↗</a></div>`;
	}

	// Designed no-data state: the radar has not scored this coin (yet).
	function renderSmartNotScored() {
		const body = $('[data-section="smart"] .dd-card-b');
		if (!body) return;
		body.innerHTML = `
			<p class="dd-note dd-note--na">No smart-money read for this coin yet. The radar scores a coin once proven wallets touch it, usually within minutes of real activity.</p>
			<div style="text-align:center"><a href="/radar" class="dd-btn">Open the Smart Money radar →</a></div>`;
	}

	function renderBubblemap(coin, wallets, clusters) {
		const body = $('[data-section="bubblemap"] .dd-card-b');
		if (!body) return;
		const list = Array.isArray(wallets) ? wallets : [];
		const clusterCount = Array.isArray(clusters) ? clusters.filter((c) => (c.wallets || 0) > 1).length : 0;
		const rightEl = $('[data-section="bubblemap"] .dd-card-h .dd-card-meta');
		if (rightEl) rightEl.textContent = list.length ? `${list.length} wallets · ${clusterCount} clusters` : '';
		body.innerHTML = '<div class="dd-bubblemap" data-host="bm"></div>';
		try {
			teardowns.push(mountBubblemap(body.querySelector('[data-host="bm"]'), {
				wallets: list, clusters,
				onSelect: (w) => { if (w?.wallet) window.open(`https://solscan.io/account/${w.wallet}`, '_blank', 'noopener'); },
			}));
		} catch {
			body.innerHTML = unavailable('Wallet graph could not be rendered.');
		}
	}

	function renderWallets(wallets) {
		const body = $('[data-section="wallets"] .dd-card-b');
		if (!body) return;
		const list = (Array.isArray(wallets) ? wallets : [])
			.filter((w) => w && w.wallet)
			.sort((a, b) => Number(b.buy_sol) - Number(a.buy_sol))
			.slice(0, 20);
		if (!list.length) { body.innerHTML = unavailable('No wallet footprint indexed yet.'); return; }
		body.innerHTML = `<div class="dd-wtable">
			<div class="dd-wrow dd-whead"><span>Wallet</span><span>Tags</span><span>Buy</span><span>Sell</span><span>Net</span><span>Share</span></div>
			${list.map((w) => {
				const net = Number(w.net_sol);
				const labels = (Array.isArray(w.labels) ? w.labels : []).slice(0, 2);
				return `<div class="dd-wrow">
					<a href="https://solscan.io/account/${escapeHtml(w.wallet)}" target="_blank" rel="noopener" class="dd-waddr">${escapeHtml(shortAddr(w.wallet, 4, 4))}${w.is_creator ? ' <span class="dd-tag dd-tag--dev">DEV</span>' : ''}</a>
					<span class="dd-wtags">${labels.map((l) => `<span class="dd-tag">${escapeHtml(String(l).replace(/_/g, ' '))}</span>`).join('') || '<span class="dd-dim">—</span>'}</span>
					<span class="dd-wnum">${fmtSol(w.buy_sol)}</span>
					<span class="dd-wnum">${fmtSol(w.sell_sol)}</span>
					<span class="dd-wnum ${changeClass(net)}">${Number.isFinite(net) ? (net >= 0 ? '+' : '') + net.toFixed(2) : '—'}</span>
					<span class="dd-wnum">${w.share != null ? `${(Number(w.share) * 100).toFixed(1)}%` : '—'}</span>
				</div>`;
			}).join('')}
		</div>`;
	}

	function renderSmart(coin, notable) {
		const body = $('[data-section="smart"] .dd-card-b');
		if (!body) return;
		const list = Array.isArray(notable) ? notable : [];
		const score = coin?.smart_money_score;
		const count = coin?.smart_wallet_count;
		body.innerHTML = `
			<div class="dd-smart-top">
				<div class="dd-smart-score">
					<span class="dd-smart-n">${score != null ? Math.round(score) : '—'}</span>
					<span class="dd-smart-l">smart-money score</span>
				</div>
				<div class="dd-smart-meta">
					${count != null ? `<div><b>${count}</b> proven wallets in</div>` : ''}
					${coin?.proven_buy_sol != null ? `<div><b>${fmtSol(coin.proven_buy_sol)}</b> from proven money</div>` : ''}
				</div>
			</div>
			${list.length ? `<ul class="dd-smart-list">${list.slice(0, 8).map((w) => `
				<li>
					<a href="https://solscan.io/account/${escapeHtml(w.wallet)}" target="_blank" rel="noopener">${escapeHtml(shortAddr(w.wallet, 4, 4))}</a>
					<span class="dd-tag">${escapeHtml(String(w.label || '').replace(/_/g, ' ') || 'tracked')}</span>
					<span class="dd-dim">${w.win_rate != null ? `${Math.round(Number(w.win_rate) * 100)}% win` : ''}</span>
					<b>${fmtSol(w.buy_sol)}</b>
				</li>`).join('')}</ul>` : '<p class="dd-note">No proven smart-money wallets detected in this launch yet.</p>'}`;
	}

	function renderOutcome(outcome) {
		const el = $('[data-host="outcome-badge"]');
		if (!el) return;
		if (!outcome || outcome.outcome === 'unknown') { el.hidden = true; return; }
		const map = {
			graduated: ['Graduated', 'g'], pumped: ['Pumped', 'g'], rugged: ['Rugged', 'r'],
		};
		const [label, tone] = map[outcome.outcome] || [outcome.outcome, 'a'];
		const ath = outcome.ath_multiple != null ? ` · ${Number(outcome.ath_multiple).toFixed(1)}× ATH` : '';
		el.className = `dd-outcome dd-tone-${tone}`;
		el.textContent = `${label}${ath}`;
		el.hidden = false;
	}

	function renderAgent(d) {
		const body = $('[data-section="agent"] .dd-card-b');
		if (!body) return;
		const agent = d.agent;
		const trader = d.trader;
		const econ = d.economics;
		if (!agent && !econ) {
			$('[data-section="agent"]').hidden = true;
			body.innerHTML = '';
			return;
		}
		const av = agent?.avatar_thumbnail_url || (agent ? identicon(agent.id) : '');
		const traderStats = trader ? `
			<div class="dd-stats dd-stats--4">
				${stat('TraderScore', trader.score != null ? Math.round(trader.score) : '—')}
				${stat('Win rate', trader.win_rate != null ? `${Math.round(Number(trader.win_rate) * 100)}%` : '—')}
				${stat('Realized PnL', trader.realized_pnl_sol != null ? fmtSol(trader.realized_pnl_sol) : '—', changeClass(trader.realized_pnl_sol))}
				${stat('Closed', trader.closed_count ?? '—')}
			</div>` : '';
		const econRows = econ ? `
			<div class="dd-stats dd-stats--4">
				${stat('Payments', compact(econ.confirmed_payments ?? 0))}
				${stat('Unique payers', compact(econ.unique_payers ?? 0))}
				${stat('Buyback runs', compact(econ.burns?.runs ?? 0))}
				${stat('Creator fees', econ.creator_fees?.earned_sol != null ? fmtSol(econ.creator_fees.earned_sol) : '—')}
			</div>` : '';
		body.innerHTML = `
			${agent ? `<div class="dd-agent-row">
				<img src="${escapeHtml(av)}" alt="" class="dd-agent-av" onerror="this.style.visibility='hidden'" />
				<div class="dd-agent-id">
					<a href="${escapeHtml(agent.url || `/agents/${agent.id}`)}" class="dd-agent-name">${escapeHtml(agent.name || 'three.ws agent')}</a>
					${agent.description ? `<p class="dd-agent-desc">${escapeHtml(agent.description)}</p>` : ''}
				</div>
				${trader?.agent_id ? `<a href="/trader/${escapeHtml(trader.agent_id)}" class="dd-btn dd-btn--primary">Copy trader →</a>` : ''}
			</div>` : ''}
			${traderStats}
			${econRows}`;
		$('[data-section="agent"]').hidden = false;
	}

	// ── degraded-state helpers ─────────────────────────────────────────────────────
	function markUnavailable(ids) {
		for (const id of ids) {
			const body = $(`[data-section="${id}"] .dd-card-b`);
			if (body && body.querySelector('.dd-skel')) body.innerHTML = unavailable();
		}
	}

	return {
		destroy() {
			destroyed = true;
			for (const t of teardowns) { try { t?.destroy?.(); } catch { /* already gone */ } }
			teardowns.length = 0;
			host.innerHTML = '';
		},
	};
}

// ── static markup ─────────────────────────────────────────────────────────────

function unavailable(msg = 'Not available for this coin yet.') {
	return `<p class="dd-note dd-note--na">${escapeHtml(msg)}</p>`;
}
function chartFail(host) {
	if (host) host.innerHTML = '<div class="dd-note dd-note--na" style="padding:40px 0;text-align:center">Chart unavailable for this coin.</div>';
}
const SKEL = '<div class="dd-skel"></div>';

function shell({ mint, network, sym, name, img, isThree }) {
	const initials = sym.slice(0, 2);
	const bubblemapExt = `https://app.bubblemaps.io/sol/token/${encodeURIComponent(mint)}`;
	return `
	<div class="dd-scroll">
		<header class="dd-hero">
			<div class="dd-hero-img">
				${img ? `<img src="${escapeHtml(img)}" alt="" onerror="this.parentNode.classList.add('dd-noimg');this.remove()" />` : ''}
				<span class="dd-hero-ini">${escapeHtml(initials)}</span>
			</div>
			<div class="dd-hero-main">
				<div class="dd-hero-top">
					<h1 class="dd-hero-sym">$${escapeHtml(sym)}</h1>
					${name ? `<span class="dd-hero-name">${escapeHtml(name)}</span>` : ''}
					${isThree ? '<span class="dd-hero-pin">★ Platform coin</span>' : ''}
					<span class="dd-cat" data-host="cat" hidden></span>
					<span class="dd-outcome" data-host="outcome-badge" hidden></span>
				</div>
				<div class="dd-hero-sub">
					<button type="button" class="dd-mint" data-host="copy" title="Copy mint address">⧉ ${escapeHtml(shortAddr(mint, 4, 4))}</button>
					<span class="dd-net">${network}</span>
					<span class="dd-age" data-host="age" hidden></span>
					<span class="dd-socials" data-host="socials"></span>
				</div>
				<p class="dd-desc" data-host="desc" hidden></p>
			</div>
			<div class="dd-hero-actions">
				<a href="https://pump.fun/${escapeHtml(mint)}" target="_blank" rel="noopener" class="dd-btn">pump.fun ↗</a>
				<a href="/oracle/coin/${encodeURIComponent(mint)}" class="dd-btn dd-btn--oracle">Oracle ↗</a>
			</div>
		</header>

		<div class="dd-strip" data-host="strip">${SKEL}</div>

		<div class="dd-grid">
			${section('chart', 'Price', '<div class="dd-chart" data-host="chart"></div>', { right: '' })}
			${section('curve', 'Bonding curve', '<div class="dd-curve" data-host="curve"></div>')}
			${section('signals', 'Coin intelligence', SKEL)}
			${section('holders', 'Holders &amp; distribution', SKEL)}
			${section('bubblemap', 'Funder bubblemap', '<div class="dd-bubblemap-skel">' + SKEL + '</div>', { right: `<span class="dd-card-meta"></span> <a href="${bubblemapExt}" target="_blank" rel="noopener" class="dd-card-link">Bubblemaps ↗</a>` })}
			${section('smart', 'Smart money', SKEL)}
			${section('footprint', 'First-seconds footprint', SKEL)}
			${section('wallets', 'Top wallets', SKEL)}
			${section('tape', 'Live trades', '<div class="dd-tape" data-host="tape"></div>')}
			${section('agent', 'Agent &amp; economics', SKEL)}
		</div>
	</div>`;
}
