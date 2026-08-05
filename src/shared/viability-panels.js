/**
 * Viability panels — the marketplace and trading "honest signal" sections.
 *
 * These render the real, fully-guarded health of the two money loops:
 *   - Marketplace: real $THREE skill purchases — GMV, take-rate, repeat buyers,
 *     trading pairs, top skills and top sellers.
 *   - Trading: real coin trades through agent wallets — flow, cost and the
 *     realized P&L on positions that have actually closed.
 *
 * Both read GET /api/pulse (view=marketplace | view=trading) and degrade quietly:
 * a supplementary panel never blocks the page — on failure it simply hides.
 *
 * Extracted from /pulse so they own the dedicated /viability page, while the
 * Money Pulse stays focused on the live feed. The markup contract (element IDs)
 * is shared, so any host page that ships the same IDs drives these unchanged.
 */

import { wireWalletChips } from './agent-wallet-chip.js';
import { createLogger } from './log.js';
import { esc, fmtUsd, fmtSol, fmtNum, fmtThree, fmtPct, fmtSignedSol, agentCardHTML } from './pulse-format.js';

const log = createLogger('viability');
const $ = (id) => document.getElementById(id);

export async function loadMarketplace(network) {
	try {
		const res = await fetch(`/api/pulse?view=marketplace&network=${network}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`marketplace ${res.status}`);
		const { data } = await res.json();
		renderMarketplace(data);
	} catch (e) {
		log.warn('marketplace failed', e?.message);
		// Supplementary panel — never block the page; just hide it on failure.
		$('px-market')?.setAttribute('hidden', '');
		$('px-sellers-card')?.setAttribute('hidden', '');
	}
}

function renderMarketplace(d) {
	const panel = $('px-market');
	if (!panel) return;
	const w24 = d.window_24h || {};
	const w7 = d.window_7d || {};
	const anyActivity = (w7.purchases || 0) > 0 || (w7.trials || 0) > 0 || (w24.purchases || 0) > 0;
	panel.hidden = false;

	// Fee tag — surfaces the live take-rate, or that it's off (honest either way).
	const feeEl = $('px-mkt-fee');
	if (feeEl) {
		feeEl.textContent = d.fee_bps > 0 ? `${d.fee_pct}% take-rate` : 'take-rate off';
		feeEl.classList.toggle('px-market-tag--off', !(d.fee_bps > 0));
	}

	$('px-mkt-gmv24').textContent = fmtThree(w24.gmv_three);
	$('px-mkt-gmv24-sub').textContent = `$THREE · ${w24.purchases || 0} buy${w24.purchases === 1 ? '' : 's'}`;
	$('px-mkt-gmv7').textContent = fmtThree(w7.gmv_three);
	$('px-mkt-gmv7-sub').textContent = `$THREE · ${w7.purchases || 0} buy${w7.purchases === 1 ? '' : 's'}`;
	$('px-mkt-ticket').textContent = fmtThree(w7.avg_ticket_three);
	$('px-mkt-repeat').textContent = fmtPct(d.repeat_buyer_rate_7d);
	$('px-mkt-repeat-sub').textContent = `${d.repeat_buyers_7d || 0}/${d.buyers_7d || 0} buyers · 7d`;
	$('px-mkt-pairs').textContent = String(w7.pairs || 0);
	// Take-rate = fees ACTUALLY charged on-chain (real, persisted per purchase).
	const take7 = w7.take_rate_three || 0;
	$('px-mkt-take').textContent = take7 > 0 ? fmtThree(take7) : '—';
	$('px-mkt-take-sub').textContent = take7 > 0
		? '$THREE earned · 7d'
		: (d.fee_bps > 0 ? 'no fees yet · 7d' : 'fee off');

	renderMarketSpark(d.series_7d);

	// Top skills — what the market is paying for.
	const skillsHost = $('px-mkt-skills');
	if (d.top_skills?.length) {
		skillsHost.innerHTML = d.top_skills
			.map((s) => (
				`<div class="px-skill-row">` +
				`<span class="px-skill-name">${esc(s.skill)}</span>` +
				`<span class="px-skill-meta">${fmtThree(s.gmv_three)} <small>$THREE · ${s.purchases} buy${s.purchases === 1 ? '' : 's'}</small></span>` +
				`</div>`
			))
			.join('');
	} else {
		skillsHost.innerHTML = anyActivity
			? `<p class="px-lb-empty">No paid skills cleared in the last 7 days.</p>`
			: `<p class="px-lb-empty">No marketplace sales yet. Fund agents and list paid skills to start the loop. <a href="/marketplace">Open marketplace.</a></p>`;
	}

	// Top sellers rail card — the supply side that's actually clearing.
	const sellersCard = $('px-sellers-card');
	const sellersHost = $('px-sellers');
	if (sellersCard && sellersHost && d.top_sellers?.length) {
		sellersCard.hidden = false;
		sellersHost.innerHTML = d.top_sellers
			.map((a) => agentCardHTML(a, `${fmtThree(a.gmv_three)} <small>$THREE · ${a.sales} sale${a.sales === 1 ? '' : 's'}</small>`))
			.join('');
		wireWalletChips(sellersHost);
	} else if (sellersCard) {
		sellersCard.hidden = true;
	}
}

// 7-day GMV sparkline for the marketplace panel; today highlighted, bars scale to peak.
function renderMarketSpark(series) {
	const host = $('px-mkt-spark');
	const totalEl = $('px-mkt-spark-total');
	if (!host) return;
	const days = Array.isArray(series) ? series : [];
	const total = days.reduce((s, d) => s + (d.gmv_three || 0), 0);
	if (totalEl) totalEl.textContent = total > 0 ? `${fmtThree(total)} $THREE` : '—';
	if (!days.length) { host.innerHTML = `<p class="px-lb-empty">No activity yet.</p>`; return; }
	const peak = Math.max(1e-9, ...days.map((d) => d.gmv_three || 0));
	host.innerHTML = days
		.map((d, i) => {
			const v = d.gmv_three || 0;
			const h = v > 0 ? Math.max(6, Math.round((v / peak) * 100)) : 2;
			const today = i === days.length - 1;
			return (
				`<div class="px-spark-col${today ? ' px-spark-col--now' : ''}" title="${esc(d.day)}: ${fmtThree(v)} $THREE · ${d.purchases || 0} buys">` +
				`<div class="px-spark-bar px-spark-bar--mkt" style="height:${h}%"></div>` +
				`<span class="px-spark-lbl">${esc(d.label)}</span>` +
				`</div>`
			);
		})
		.join('');
}

export async function loadTrading(network) {
	try {
		const res = await fetch(`/api/pulse?view=trading&network=${network}`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`trading ${res.status}`);
		const { data } = await res.json();
		renderTrading(data);
	} catch (e) {
		log.warn('trading failed', e?.message);
		// Supplementary panel — never block the page; just hide it on failure.
		$('px-trading')?.setAttribute('hidden', '');
	}
}

function renderTrading(d) {
	const panel = $('px-trading');
	if (!panel) return;
	// Guard against a deploy-skew response (e.g. an older backend answering this view
	// with the feed shape): without the windowed aggregates there's nothing honest to
	// show, so hide rather than render a panel full of em-dashes.
	if (!d || (!d.window_24h && !d.window_7d)) { panel.hidden = true; return; }
	const w24 = d.window_24h || {};
	const w7 = d.window_7d || {};
	const pnl = d.realized_pnl_7d || {};
	panel.hidden = false;

	$('px-trade-c24').textContent = fmtNum(w24.trades);
	$('px-trade-c24-sub').textContent = `${w24.traders || 0} wallet${w24.traders === 1 ? '' : 's'}`;
	$('px-trade-c7').textContent = fmtNum(w7.trades);
	$('px-trade-c7-sub').textContent = `${w7.buys || 0} buy · ${w7.sells || 0} sell`;
	$('px-trade-dep7').textContent = fmtSol(w7.deployed_sol);
	$('px-trade-dep7-sub').textContent = w7.deployed_usd > 0 ? `${fmtUsd(w7.deployed_usd)} · into buys` : 'into buys';
	$('px-trade-avg').textContent = fmtSol(w7.avg_trade_sol);
	$('px-trade-act').textContent = fmtNum(w24.traders);

	// Realized P&L — only meaningful once positions have closed. Until then it's an
	// honest "—" rather than a fake zero, so a fresh pilot reads as "no closes yet".
	const pnlEl = $('px-trade-pnl');
	const pnlSub = $('px-trade-pnl-sub');
	const pnlTag = $('px-trade-pnl-tag');
	if (pnl.closed_positions > 0) {
		pnlEl.textContent = fmtSignedSol(pnl.net_sol);
		pnlEl.classList.toggle('px-pnl--up', pnl.net_sol > 0);
		pnlEl.classList.toggle('px-pnl--down', pnl.net_sol < 0);
		pnlSub.textContent = `${pnl.closed_positions} closed · ${fmtPct(pnl.win_rate)} win`;
		pnlTag.textContent = `${pnl.closed_positions} closed · 7d`;
		pnlTag.classList.remove('px-market-tag--off');
	} else {
		pnlEl.textContent = '—';
		pnlEl.classList.remove('px-pnl--up', 'px-pnl--down');
		pnlSub.textContent = 'no closes yet';
		pnlTag.textContent = 'no closes · 7d';
		pnlTag.classList.add('px-market-tag--off');
	}

	// One honest, plain-language readout of the week — what ran, what it cost, and
	// whether anything has closed yet. Sells carry no SOL out, so cost is over buys.
	// The element is created once, just after the KPI grid, if the markup omits it.
	let insight = $('px-trade-insight');
	if (!insight) {
		const kpis = panel.querySelector('.px-market-kpis');
		if (kpis) {
			insight = document.createElement('p');
			insight.id = 'px-trade-insight';
			insight.className = 'px-trade-insight';
			insight.hidden = true;
			kpis.insertAdjacentElement('afterend', insight);
		}
	}
	if (insight) {
		if ((w7.trades || 0) > 0) {
			let line = `Agents ran ${fmtNum(w7.trades)} trade${w7.trades === 1 ? '' : 's'} this week, deploying ${fmtSol(w7.deployed_sol)} into buys (${fmtSol(w7.avg_trade_sol)} avg).`;
			line += pnl.closed_positions > 0
				? ` ${pnl.closed_positions} position${pnl.closed_positions === 1 ? '' : 's'} closed for ${fmtSignedSol(pnl.net_sol)} realized — ${fmtPct(pnl.win_rate)} win rate.`
				: ` No positions have closed yet, so realized P&L is still pending.`;
			insight.textContent = line;
			insight.hidden = false;
		} else {
			insight.hidden = true;
		}
	}

	// Reveal the in-panel "show trades in feed" action only when there's something to
	// show. It carries data-filter="trades" so the shared counter wiring drives it —
	// matching the headline Trades counter exactly (both count category='trade' and
	// reveal the trades+snipes feed slice, the platform-wide "Trades" convention).
	const filterBtn = $('px-trade-filter');
	if (filterBtn) filterBtn.hidden = !((w24.trades || 0) > 0 || (w7.trades || 0) > 0);

	renderTradeSpark(d.series_7d);

	// Top traders — the wallets actually putting capital to work.
	const host = $('px-trade-traders');
	if (d.top_traders?.length) {
		host.innerHTML = d.top_traders
			.map((a) => agentCardHTML(a, `${a.trades} <small>trade${a.trades === 1 ? '' : 's'} · ${fmtSol(a.deployed_sol)}</small>`))
			.join('');
		wireWalletChips(host);
	} else {
		host.innerHTML = `<p class="px-lb-empty">No agent trades in the last 7 days. Fund a treasury and enable circulation to start the loop.</p>`;
	}
}

// 7-day trade-count sparkline; today highlighted, bars scale to the busiest day.
function renderTradeSpark(series) {
	const host = $('px-trade-spark');
	const totalEl = $('px-trade-spark-total');
	if (!host) return;
	const days = Array.isArray(series) ? series : [];
	const total = days.reduce((s, d) => s + (d.trades || 0), 0);
	if (totalEl) totalEl.textContent = `${fmtNum(total)} trade${total === 1 ? '' : 's'}`;
	// Fold the live total into the chart's accessible name so a screen reader hears
	// the number, not just "Daily trade count" — the bars themselves are decorative.
	host.setAttribute('aria-label', `Daily trades, last 7 days — ${total} total`);
	if (!days.length) { host.innerHTML = `<p class="px-lb-empty">No activity yet.</p>`; return; }
	const peak = Math.max(1, ...days.map((d) => d.trades || 0));
	host.innerHTML = days
		.map((d, i) => {
			const n = d.trades || 0;
			const h = n > 0 ? Math.max(6, Math.round((n / peak) * 100)) : 2;
			const today = i === days.length - 1;
			return (
				`<div class="px-spark-col${today ? ' px-spark-col--now' : ''}" title="${esc(d.day)}: ${n} trade${n === 1 ? '' : 's'} · ${fmtSol(d.deployed_sol)}">` +
				`<div class="px-spark-bar px-spark-bar--trade" style="height:${h}%"></div>` +
				`<span class="px-spark-lbl">${esc(d.label)}</span>` +
				`</div>`
			);
		})
		.join('');
}
