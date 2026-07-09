/* Oracle — full standalone coin page hydration.
 * ---------------------------------------------
 * Drives /oracle/coin/<mint>. The server (api/oracle-share.js) renders the
 * conviction hero above the fold from the persisted verdict; this script wires
 * that hero's buttons and fills the deep + live sections that only the live
 * APIs can answer: the Oracle's take, why-this-score reasons, wallet structure,
 * narrative, community pulse, who's-in, ground-truth outcome, the full live
 * market intel, conviction history, agent exits, related coins, and a live
 * PumpPortal trade tape.
 *
 * Buildless on purpose (served straight from /public) so the server-rendered
 * page can reference it by a stable URL. It re-implements the drawer's render
 * surface from src/oracle.js against the same stable API contracts
 * (/api/oracle/coin, /api/oracle/market, /api/oracle/history, /api/oracle/trades)
 * so the full page and the in-feed modal read identically. */

(() => {
	'use strict';

	const NETWORK = 'mainnet';
	const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
	const WATCH_KEY = 'ld_watchlist'; // shared with the feed + drawer on /oracle
	const BOOT = window.__OC_BOOT || {}; // server-embedded identity + pump snapshot

	const $ = (sel, root = document) => root.querySelector(sel);
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

	// ── formatters (ported 1:1 from src/oracle.js) ─────────────────────────────
	const fmtSol = (n) => (n == null ? '—' : `${Number(n) < 0.01 && Number(n) > 0 ? Number(n).toFixed(4) : Number(n).toFixed(2)}◎`);
	function fmtUsd(n) {
		if (n == null || !Number.isFinite(Number(n))) return '—';
		const v = Number(n), abs = Math.abs(v);
		if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
		if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
		if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
		return `$${v.toFixed(2)}`;
	}
	function fmtPrice(n) {
		if (n == null || !Number.isFinite(Number(n))) return '—';
		const v = Number(n);
		if (v === 0) return '$0';
		if (v >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
		const decimals = Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(v))));
		return `$${v.toFixed(decimals)}`;
	}
	const fmtInt = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString());
	function changeStr(n) {
		if (n == null || !Number.isFinite(Number(n))) return { txt: '—', cls: 'flat' };
		const v = Number(n);
		const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
		const txt = `${v > 0 ? '+' : ''}${v.toFixed(v <= -100 || v >= 100 ? 0 : 2)}%`;
		return { txt, cls };
	}
	function ago(ts) {
		if (!ts) return '—';
		const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
		if (s < 60) return `${Math.floor(s)}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m`;
		if (s < 86400) return `${Math.floor(s / 3600)}h`;
		return `${Math.floor(s / 86400)}d`;
	}
	const shortAddr = (a) => (a && a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a || '—'));
	const solscan = (addr) => `https://solscan.io/account/${addr}`;
	const pumpUrl = (mint) => `https://pump.fun/coin/${mint}`;

	const ARCH_TITLE = {
		smart_money: 'Smart Money', kol: 'KOL', top_dev: 'Top Dev', sniper: 'Sniper',
		dumper: 'Dumper', rugger: 'Rugger', fresh: 'Fresh', neutral: 'Neutral', unproven: 'Unproven',
	};
	const TAKE_TIER = {
		prime: 'A prime setup', strong: 'A strong setup', lean: 'A lean setup',
		watch: 'One to watch', avoid: 'A pass',
	};

	// ── watchlist (shared localStorage contract with /oracle) ──────────────────
	function watchedMints() {
		try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]')); } catch { return new Set(); }
	}
	function toggleWatch(mint) {
		try {
			const list = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
			const i = list.indexOf(mint);
			if (i >= 0) list.splice(i, 1); else list.unshift(mint);
			localStorage.setItem(WATCH_KEY, JSON.stringify(list.slice(0, 200)));
		} catch { /* storage blocked — non-fatal */ }
	}

	async function api(path, { timeout = 12000 } = {}) {
		try {
			const res = await fetch(path, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
			let data = null;
			try { data = await res.json(); } catch { /* empty body */ }
			return { ok: res.ok, status: res.status, data };
		} catch {
			return { ok: false, status: 0, data: null };
		}
	}

	// ── conviction render helpers (ported from the drawer) ─────────────────────
	function pillar(kind, label, val) {
		return `<div class="pil ${kind}"><div class="lab">${label}<b>${val ?? '—'}</b></div>
			<div class="track"><div class="fill" style="width:${Math.max(0, Math.min(100, val || 0))}%"></div></div></div>`;
	}

	function drawerTake(d) {
		const c = d.conviction || {};
		const lead = TAKE_TIER[c.tier] || 'One to watch';
		const rs = (d.reasons || []).map((r) => r.text).filter(Boolean);
		if (!rs.length) return '';
		const body = rs.slice(0, 2).map((t) => t.replace(/\.$/, '')).join('; ');
		return `<div class="coin-take"><span class="ct-q">“</span><span><b>${esc(lead)} at ${c.score}</b> — ${esc(body)}.</span></div>`;
	}

	function structurePanel(st) {
		if (!st) return '';
		const pct = (n) => (n == null ? '—' : `${Math.round(Number(n))}%`);
		const bar = (val, color) => `<div class="str-track"><div class="str-fill" style="width:${Math.max(0, Math.min(100, val || 0))}%;background:${color}"></div></div>`;
		const organic = Number(st.organicScore ?? 0);
		const bundle = Number(st.bundleScore ?? 0);
		const top10 = Number(st.top10Pct ?? 0);
		const connect = Number(st.bubblemapConnectivity ?? 0);
		const devSold = Number(st.devSoldPct ?? 0);
		const devBuy = st.creatorHoldPct != null ? `${Math.round(Number(st.creatorHoldPct))}%` : '—';
		const buyers = st.uniqueBuyers ?? '—';
		const bundleFl = st.bundleFlag;
		if (!st.organicScore && !st.bundleScore && !st.top10Pct && !st.bubblemapConnectivity) return '';
		return `
			<div class="dr-sec">Structure <span style="color:var(--faint);font-weight:400;font-size:10px">wallet graph · buy pattern</span></div>
			<div class="str-grid">
				<div class="str-row"><span class="str-lbl">Organic buy</span>${bar(organic, 'var(--up)')}<span class="str-val" style="color:var(--up)">${pct(organic)}</span></div>
				<div class="str-row"><span class="str-lbl">Bundle / coord</span>${bar(bundle, bundleFl ? 'var(--down)' : 'var(--amber)')}<span class="str-val" style="color:${bundleFl ? 'var(--down)' : 'var(--amber)'}">${pct(bundle)}${bundleFl ? ' ⚑' : ''}</span></div>
				${top10 ? `<div class="str-row"><span class="str-lbl">Top 10 hold</span>${bar(top10, top10 > 60 ? 'var(--down)' : 'var(--gold)')}<span class="str-val" style="color:${top10 > 60 ? 'var(--down)' : 'var(--gold)'}">${pct(top10)}</span></div>` : ''}
				${connect ? `<div class="str-row"><span class="str-lbl">Graph density</span>${bar(connect, connect > 50 ? 'var(--down)' : 'var(--muted)')}<span class="str-val" style="color:${connect > 50 ? 'var(--down)' : 'var(--muted)'}">${pct(connect)}</span></div>` : ''}
			</div>
			<div class="coin-meta" style="margin-top:10px">
				${buyers !== '—' ? `<span class="chip">buyers <b>${buyers}</b></span>` : ''}
				${devBuy !== '—' ? `<span class="chip ${devSold > 50 ? 'flag' : ''}">dev hold <b>${devBuy}</b>${devSold > 20 ? ` · sold ${Math.round(devSold)}%` : ''}</span>` : ''}
			</div>`;
	}

	function whoRow(w) {
		const title = ARCH_TITLE[w.label] || 'Unproven';
		const sub = [
			w.is_creator ? 'creator' : null,
			w.tag ? `@${w.tag}` : null,
			w.source === 'gmgn' ? 'gmgn-known' : (w.score != null ? `rep ${Math.round(w.score)}` : null),
			w.win_rate != null ? `${Math.round(w.win_rate)}% win` : null,
		].filter(Boolean).join(' · ');
		return `<div class="nwallet">
			<div class="nw-left">
				<span class="nw-addr"><span class="nlabel lb-${esc(w.label)}">${esc(title)}</span><a class="solscan" href="${solscan(w.wallet)}" target="_blank" rel="noopener">${esc(shortAddr(w.wallet))}</a></span>
				<span class="nw-sub">${esc(sub || '—')}</span>
			</div>
			<span class="nw-buy">${fmtSol(w.buy_sol)}</span>
		</div>`;
	}

	// ── live market intel (ported from renderMarket) ───────────────────────────
	const statTile = (label, value, sub = '') => `<div class="mkt-tile"><span class="mkt-tile-lbl">${esc(label)}</span><span class="mkt-tile-val">${value}</span>${sub ? `<span class="mkt-tile-sub">${sub}</span>` : ''}</div>`;
	const changeChip = (label, n) => { const c = changeStr(n); return `<span class="mkt-chg mkt-${c.cls}"><span class="mkt-chg-lbl">${esc(label)}</span><b>${c.txt}</b></span>`; };
	function secChip(ok, label, warnLabel = null) {
		if (ok == null) return `<span class="chip" title="not measured">${esc(label)} <b>?</b></span>`;
		return ok ? `<span class="chip sm" title="safe">✓ ${esc(label)}</span>` : `<span class="chip flag" title="risk">⚠ ${esc(warnLabel || label)}</span>`;
	}

	function renderMarket(m) {
		const p = m.price || {}, ch = p.change || {};
		const changeH24 = changeStr(ch.h24);
		const tiles = [
			statTile('Price', fmtPrice(p.usd), `<span class="mkt-${changeH24.cls}">${changeH24.txt} 24h</span>`),
			statTile('Market cap', fmtUsd(m.market_cap_usd)),
			m.fdv_usd != null && m.fdv_usd !== m.market_cap_usd ? statTile('FDV', fmtUsd(m.fdv_usd)) : '',
			statTile('Liquidity', fmtUsd(m.liquidity_usd)),
			statTile('24h volume', fmtUsd(m.volume?.h24)),
			statTile('Holders', fmtInt(m.holders)),
		].filter(Boolean).join('');

		const changeWins = [['5m', ch.m5], ['1h', ch.h1], ['6h', ch.h6], ['24h', ch.h24], ['7d', ch.d7]].filter(([, v]) => v != null);
		const changeRow = changeWins.length ? `<div class="mkt-chg-row">${changeWins.map(([l, v]) => changeChip(l, v)).join('')}</div>` : '';

		const pf = m.pumpfun;
		let curveHtml = '';
		if (pf?.is_pump) {
			if (pf.graduated || pf.complete) {
				curveHtml = `<div class="mkt-row"><span class="chip sm">Graduated to DEX ✓</span>${pf.ath_market_cap_usd ? `<span class="chip">ATH mcap <b>${fmtUsd(pf.ath_market_cap_usd)}</b></span>` : ''}</div>`;
			} else if (pf.bonding_curve_pct != null) {
				const pct = Math.round(pf.bonding_curve_pct);
				curveHtml = `<div class="mkt-curve">
					<div class="mkt-curve-top"><span>Bonding curve</span><b>${pct}% to graduation</b></div>
					<div class="mkt-curve-track"><div class="mkt-curve-fill" style="width:${Math.max(2, Math.min(100, pct))}%"></div></div>
					${pf.real_sol_reserves != null ? `<div class="mkt-curve-sub">${pf.real_sol_reserves.toFixed(1)} ◎ in curve${pf.reply_count ? ` · ${fmtInt(pf.reply_count)} replies` : ''}${pf.is_live ? ' · <span class="mkt-up">live now</span>' : ''}</div>` : ''}
				</div>`;
			}
		}

		const act = m.activity;
		let activityHtml = '';
		if (act && act.txns_24h) {
			const buyPct = Math.round((act.buy_ratio ?? 0.5) * 100);
			activityHtml = `<div class="mkt-act">
				<div class="mkt-act-top"><span>24h activity</span><span class="mkt-faint">${fmtInt(act.txns_24h)} txns</span></div>
				<div class="mkt-act-track"><div class="mkt-act-buy" style="width:${buyPct}%"></div></div>
				<div class="mkt-act-legend"><span class="mkt-up">${fmtInt(act.buys_24h)} buys</span><span class="mkt-down">${fmtInt(act.sells_24h)} sells</span></div>
			</div>`;
		}

		const sup = m.supply || {};
		const supplyChips = [
			sup.total != null ? `<span class="chip">supply <b>${fmtInt(sup.total)}</b></span>` : '',
			sup.circulating != null && Math.abs((sup.circulating || 0) - (sup.total || 0)) > (sup.total || 0) * 0.01 ? `<span class="chip">circulating <b>${fmtInt(sup.circulating)}</b></span>` : '',
			m.identity?.created_at ? `<span class="chip" title="First trade / launch">age <b>${ago(m.identity.created_at)}</b></span>` : '',
		].filter(Boolean).join('');

		const sec = m.security;
		const secHtml = sec ? `<div class="dr-sec">Security <span style="color:var(--faint);font-weight:400;font-size:10px">GoPlus</span></div>
			<div class="coin-meta">
				${secChip(sec.mint_authority_revoked, 'Mint revoked', 'Mint authority live')}
				${secChip(sec.freeze_authority_revoked, 'Freeze revoked', 'Can freeze')}
				${secChip(sec.metadata_mutable === false ? true : (sec.metadata_mutable === true ? false : null), 'Metadata locked', 'Mutable metadata')}
				${sec.transfer_fee_pct != null ? (sec.transfer_fee_pct > 0 ? `<span class="chip flag" title="transfer tax">⚠ ${sec.transfer_fee_pct}% fee</span>` : `<span class="chip sm">No transfer fee</span>`) : ''}
				${sec.top10_holder_pct != null ? `<span class="chip ${sec.top10_holder_pct > 50 ? 'flag' : ''}" title="Top 10 holder concentration">top 10 <b>${Math.round(sec.top10_holder_pct)}%</b></span>` : ''}
				${sec.trusted_token ? '<span class="chip sm" title="GoPlus verified list">Trusted ✓</span>' : ''}
			</div>` : '';

		const lst = m.listing;
		let listingHtml = '';
		if (lst && (lst.market_cap_rank != null || lst.ath_usd != null || (lst.categories && lst.categories.length))) {
			const athChg = changeStr(lst.ath_change_pct);
			listingHtml = `<div class="dr-sec">Listed market <span style="color:var(--faint);font-weight:400;font-size:10px">CoinGecko</span></div>
				<div class="coin-meta">
					${lst.market_cap_rank != null ? `<span class="chip">rank <b>#${lst.market_cap_rank}</b></span>` : ''}
					${lst.ath_usd != null ? `<span class="chip" title="All-time high">ATH <b>${fmtPrice(lst.ath_usd)}</b> <span class="mkt-${athChg.cls}">${athChg.txt}</span></span>` : ''}
					${lst.atl_usd != null ? `<span class="chip" title="All-time low">ATL <b>${fmtPrice(lst.atl_usd)}</b></span>` : ''}
				</div>
				${lst.categories && lst.categories.length ? `<div class="coin-meta" style="margin-top:6px">${lst.categories.slice(0, 5).map((c) => `<span class="chip cat">${esc(c)}</span>`).join('')}</div>` : ''}`;
		}

		const pairs = Array.isArray(m.pairs) ? m.pairs.filter((pr) => pr.url) : [];
		const pairsHtml = pairs.length ? `<div class="dr-sec">Markets <span style="color:var(--faint);font-weight:400;font-size:10px">${pairs.length} pair${pairs.length > 1 ? 's' : ''}</span></div>
			<div class="mkt-pairs">${pairs.slice(0, 5).map((pr) => `
				<a class="mkt-pair" href="${esc(pr.url)}" target="_blank" rel="noopener">
					<span class="mkt-pair-dex">${esc(pr.dex || 'dex')}${pr.quote_symbol ? ` <span class="mkt-faint">/${esc(pr.quote_symbol)}</span>` : ''}</span>
					<span class="mkt-pair-liq">${fmtUsd(pr.liquidity_usd)} liq</span>
					<span class="mkt-pair-arrow">↗</span>
				</a>`).join('')}</div>` : '';

		const lk = m.links || {};
		const linkBtns = [
			lk.dexscreener ? `<a class="dr-act" href="${esc(lk.dexscreener)}" target="_blank" rel="noopener">DexScreener ↗</a>` : '',
			lk.geckoterminal ? `<a class="dr-act" href="${esc(lk.geckoterminal)}" target="_blank" rel="noopener">GeckoTerminal ↗</a>` : '',
			lk.birdeye ? `<a class="dr-act" href="${esc(lk.birdeye)}" target="_blank" rel="noopener">Birdeye ↗</a>` : '',
			lk.website ? `<a class="dr-act" href="${esc(lk.website)}" target="_blank" rel="noopener">Website ↗</a>` : '',
			lk.twitter ? `<a class="dr-act" href="${esc(lk.twitter)}" target="_blank" rel="noopener">X ↗</a>` : '',
			lk.telegram ? `<a class="dr-act" href="${esc(lk.telegram)}" target="_blank" rel="noopener">Telegram ↗</a>` : '',
		].filter(Boolean).join('');

		const srcNote = Array.isArray(m.sources) && m.sources.length ? `<div class="mkt-src">Live · ${m.sources.map(esc).join(' · ')}</div>` : '';

		return `<div class="dr-sec">Market <span style="color:var(--faint);font-weight:400;font-size:10px">live${p.native_sol ? ` · ${p.native_sol < 0.0001 ? p.native_sol.toExponential(2) : p.native_sol.toFixed(6)} ◎` : ''}</span></div>
			<div class="mkt-stats">${tiles}</div>
			${changeRow}${curveHtml}${activityHtml}
			${supplyChips ? `<div class="coin-meta" style="margin-top:10px">${supplyChips}</div>` : ''}
			${secHtml}${listingHtml}${pairsHtml}
			${linkBtns ? `<div class="dr-actions" style="margin-top:12px">${linkBtns}</div>` : ''}
			${srcNote}`;
	}

	function renderSparkline(points, trend) {
		const W = 220, H = 40, PAD = 4;
		const scores = points.map((p) => Number(p.score));
		const min = Math.max(0, Math.min(...scores) - 5);
		const max = Math.min(100, Math.max(...scores) + 5);
		const range = max - min || 1;
		const n = scores.length;
		const xs = scores.map((_, i) => PAD + (i / (n - 1)) * (W - PAD * 2));
		const ys = scores.map((s) => PAD + (1 - (s - min) / range) * (H - PAD * 2));
		const trendColor = trend === 'rising' ? '#e4e8f2' : trend === 'falling' ? '#6c7280' : '#8a92a8';
		const trendArrow = trend === 'rising' ? '↑' : trend === 'falling' ? '↓' : '→';
		const delta = scores[n - 1] - scores[0];
		const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
		return `<div style="display:flex;align-items:center;gap:8px;padding:8px 0 4px">
			<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="flex-shrink:0;overflow:visible" aria-label="Conviction history">
				<polyline points="${xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')}" fill="none" stroke="${trendColor}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
				<circle cx="${xs[n - 1].toFixed(1)}" cy="${ys[n - 1].toFixed(1)}" r="2.5" fill="${trendColor}"/>
			</svg>
			<div style="font-size:11px;line-height:1.4;flex-shrink:0">
				<div style="color:${trendColor};font-weight:700;letter-spacing:.02em">${trendArrow} ${deltaStr} pts</div>
				<div style="color:var(--muted)">${points.length} readings · 48 h</div>
			</div>
		</div>`;
	}

	// ── section loaders ────────────────────────────────────────────────────────
	async function loadHistory(mint) {
		const wrap = $('#ocHistory');
		if (!wrap) return;
		const { ok, data } = await api(`/api/oracle/history?mint=${encodeURIComponent(mint)}&network=${NETWORK}&hours=48`);
		if (!ok || !data?.points?.length || data.points.length < 2) { wrap.innerHTML = ''; return; }
		wrap.innerHTML = `<div class="dr-sec">Conviction history</div>${renderSparkline(data.points, data.trend)}`;
	}

	async function loadMarket(mint) {
		const wrap = $('#ocMarket');
		if (!wrap) return;
		const { ok, status, data } = await api(`/api/oracle/market?mint=${encodeURIComponent(mint)}&network=${NETWORK}`, { timeout: 15000 });
		wrap.classList.remove('mkt-loading');
		wrap.removeAttribute('aria-busy');
		if (!ok || !data || data.price?.usd == null) {
			// No DEX/aggregator price yet — but a brand-new pump.fun launch still has
			// a real bonding-curve state, which the server captured into __OC_BOOT.
			// Render that so a curve-stage coin gets a live market card, not a void.
			if (status === 404 && BOOT.pump) {
				wrap.innerHTML = renderPumpMarket(BOOT.pump);
				return;
			}
			wrap.innerHTML = status === 404
				? `<div class="dr-sec">Market</div><div class="state" style="padding:20px 0">No live market yet — this mint hasn't started trading. Price, liquidity and holders appear the moment it does.</div>`
				: `<div class="dr-sec">Market</div><div class="state" style="padding:20px 0">Live market data is momentarily unavailable. <button type="button" class="dr-act" id="ocMktRetry">Retry</button></div>`;
			const retry = $('#ocMktRetry');
			if (retry) retry.addEventListener('click', () => { wrap.classList.add('mkt-loading'); wrap.setAttribute('aria-busy', 'true'); loadMarket(mint); });
			return;
		}
		wrap.innerHTML = renderMarket(data);
		fillDescription(data.identity?.description);
	}

	// Fill the hero's description slot from the market identity — the SSR only
	// knows it for pump-identified launches, so scored coins get it here.
	function fillDescription(text) {
		const el = $('#ocDesc');
		const t = String(text || '').trim();
		if (!el || el.textContent.trim() || !t) return;
		el.textContent = t.slice(0, 400);
		el.hidden = false;
	}

	// Pre-graduation market card from the pump.fun bonding-curve snapshot the server
	// embedded — used when no aggregator price exists yet (a coin still on the curve).
	function renderPumpMarket(pf) {
		const pct = pf.bonding_curve_pct;
		const curve = pf.complete
			? `<div class="mkt-row"><span class="chip sm">Graduated to DEX ✓</span></div>`
			: (pct != null ? `<div class="mkt-curve">
					<div class="mkt-curve-top"><span>Bonding curve</span><b>${Math.round(pct)}% to graduation</b></div>
					<div class="mkt-curve-track"><div class="mkt-curve-fill" style="width:${Math.max(2, Math.min(100, pct))}%"></div></div>
					${pf.real_sol_reserves != null ? `<div class="mkt-curve-sub">${pf.real_sol_reserves.toFixed(1)} ◎ in curve${pf.reply_count ? ` · ${fmtInt(pf.reply_count)} replies` : ''}${pf.is_live ? ' · <span class="mkt-up">live now</span>' : ''}</div>` : ''}
				</div>` : '');
		const tiles = [
			pf.market_cap_usd != null ? statTile('Market cap', fmtUsd(pf.market_cap_usd)) : '',
			pf.real_sol_reserves != null ? statTile('In curve', `${pf.real_sol_reserves.toFixed(1)} ◎`) : '',
			pf.created_at ? statTile('Age', ago(pf.created_at)) : '',
		].filter(Boolean).join('');
		const chips = [
			pf.reply_count != null ? `<span class="chip">replies <b>${fmtInt(pf.reply_count)}</b></span>` : '',
			pf.creator ? `<span class="chip">creator <b>${esc(shortAddr(pf.creator))}</b></span>` : '',
		].filter(Boolean).join('');
		return `<div class="dr-sec">Market <span style="color:var(--faint);font-weight:400;font-size:10px">pump.fun · pre-DEX</span></div>
			${tiles ? `<div class="mkt-stats">${tiles}</div>` : ''}
			${curve}
			${chips ? `<div class="coin-meta" style="margin-top:10px">${chips}</div>` : ''}
			<div class="mkt-src">Live · pumpfun — full metrics populate once it lists on a DEX</div>`;
	}

	// ── price chart ────────────────────────────────────────────────────────────
	// A TradingView-grade candlestick view via the DexScreener embed (keyed by the
	// mint, resolves the most-liquid pair itself), plus a native SVG line chart from
	// /api/pump/price-history for coins still on the bonding curve with no DEX pair.
	const CHART_KEY = 'oc_chart_view';

	function dexEmbedUrl(mint) {
		const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
		const p = new URLSearchParams({ embed: '1', loadChartSettings: '0', theme, chartTheme: theme, chartType: 'usd', interval: '15', info: '0' });
		return `https://dexscreener.com/solana/${encodeURIComponent(mint)}?${p}`;
	}

	function areaChartSvg(points) {
		const w = 720, h = 240, volH = 38, priceH = h - volH, pad = { t: 12, r: 8, b: 4, l: 8 };
		const closes = points.map((p) => p.c), vols = points.map((p) => p.v || 0);
		const min = Math.min(...closes), max = Math.max(...closes), span = (max - min) || max || 1, maxVol = Math.max(...vols) || 1;
		const innerW = w - pad.l - pad.r, innerH = priceH - pad.t - pad.b;
		const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * innerW;
		const y = (v) => pad.t + innerH - ((v - min) / span) * innerH;
		const up = points.length > 1 && closes[closes.length - 1] >= closes[0];
		const col = up ? 'var(--up)' : 'var(--down)';
		const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.c).toFixed(1)}`).join(' ');
		const area = `${line} L${x(points.length - 1).toFixed(1)} ${(priceH - pad.b).toFixed(1)} L${x(0).toFixed(1)} ${(priceH - pad.b).toFixed(1)} Z`;
		const barW = Math.max(1, (innerW / points.length) * 0.6);
		const bars = points.map((p, i) => {
			const bh = Math.max(1, (p.v / maxVol) * (volH - 6)), bx = x(i) - barW / 2, by = h - bh - 2;
			return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${p.c >= p.o ? 'var(--up)' : 'var(--down)'}" opacity="0.45"/>`;
		}).join('');
		return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="oc-chart-svg" role="img" aria-label="Price history chart" style="color:${col}">
			<defs><linearGradient id="ocgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="0.25"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
			${bars}
			<line x1="${pad.l}" y1="${priceH}" x2="${w - pad.r}" y2="${priceH}" stroke="var(--line)" stroke-width="1"/>
			<path d="${area}" fill="url(#ocgrad)" stroke="none"/>
			<path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
		</svg>`;
	}

	async function loadNativeChart(canvas, mint) {
		canvas.innerHTML = '<div class="oc-chart-skel"></div>';
		const to = Math.floor(Date.now() / 1000), from = to - 36 * 3600;
		const { ok, data } = await api(`/api/pump/price-history?mint=${encodeURIComponent(mint)}&interval=15m&from=${from}&to=${to}`, { timeout: 12000 });
		const pts = ((data && data.data) || []).filter((p) => Number.isFinite(p.c));
		if (!ok || pts.length < 2) { canvas.innerHTML = '<div class="state" style="padding:34px 0">Chart appears once this coin has trade history.</div>'; return; }
		const first = pts[0].c, last = pts[pts.length - 1].c;
		const chg = changeStr(first ? ((last - first) / first) * 100 : 0);
		canvas.innerHTML = `<div class="oc-chart-readout"><span class="oc-chart-price">${fmtPrice(last)}</span><span class="mkt-${chg.cls}">${chg.txt} · 36h</span></div>${areaChartSvg(pts)}`;
	}

	function mountChart(container, mint) {
		let stored = null; try { stored = localStorage.getItem(CHART_KEY); } catch {}
		const preCurve = BOOT.pump && !BOOT.pump.complete; // no DEX pair yet → native by default
		const view = stored || (preCurve ? 'line' : 'candles');
		container.innerHTML = `<div class="dr-sec" style="margin-top:0">Price <span style="color:var(--faint);font-weight:400;font-size:10px">live</span></div>
			<div class="oc-chart-controls">
				<div class="oc-seg">
					<button type="button" class="oc-seg-btn${view === 'candles' ? ' on' : ''}" data-view="candles">Candles</button>
					<button type="button" class="oc-seg-btn${view === 'line' ? ' on' : ''}" data-view="line">Line</button>
				</div>
				<a class="dr-act" href="https://dexscreener.com/solana/${encodeURIComponent(mint)}" target="_blank" rel="noopener">DexScreener ↗</a>
			</div>
			<div class="oc-chart-canvas" id="ocChartCanvas"></div>`;
		const canvas = container.querySelector('#ocChartCanvas');
		let watchdog = 0;
		function renderCandles() {
			canvas.classList.remove('ready');
			canvas.innerHTML = '<div class="oc-chart-skel"></div>';
			const frame = document.createElement('iframe');
			frame.className = 'oc-chart-frame';
			frame.title = 'DexScreener live chart';
			frame.loading = 'lazy';
			frame.src = dexEmbedUrl(mint);
			frame.addEventListener('load', () => { clearTimeout(watchdog); canvas.classList.add('ready'); });
			canvas.replaceChildren(frame);
			// Embed blocked / offline → fall back to the native line chart.
			watchdog = setTimeout(() => { if (!canvas.classList.contains('ready')) loadNativeChart(canvas, mint); }, 9000);
		}
		function apply(v) {
			try { localStorage.setItem(CHART_KEY, v); } catch {}
			container.querySelectorAll('.oc-seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
			clearTimeout(watchdog);
			if (v === 'candles') renderCandles(); else loadNativeChart(canvas, mint);
		}
		container.querySelectorAll('.oc-seg-btn').forEach((b) => b.addEventListener('click', () => apply(b.dataset.view)));
		if (view === 'candles') renderCandles(); else loadNativeChart(canvas, mint);
	}

	async function loadSentiment(mint) {
		const wrap = $('#ocPulse');
		if (!wrap) return;
		try {
			const res = await fetch('/api/social/sentiment-pulse', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: mint }), signal: AbortSignal.timeout(10000),
			});
			if (!res.ok) { wrap.innerHTML = ''; return; }
			const d = await res.json();
			if (!d.ok || !d.overall || d.overall.count < 3) { wrap.innerHTML = ''; return; }
			const o = d.overall;
			const scoreColor = o.score >= 60 ? 'var(--up)' : o.score <= 40 ? 'var(--down)' : 'var(--muted)';
			const sentLabel = o.score >= 60 ? 'bullish' : o.score <= 40 ? 'bearish' : 'mixed';
			const sentChipCls = o.score >= 60 ? 'sm' : o.score <= 40 ? 'flag' : '';
			const exHtml = (o.examples || []).slice(0, 2).map((ex) => `<div class="reason" style="font-size:11.5px;opacity:.75"><span class="rdot narrative"></span><span>${esc(ex)}</span></div>`).join('');
			wrap.innerHTML = `
				<div class="dr-sec">Community pulse <span style="color:var(--faint);font-weight:400;font-size:10px">pump.fun · ${o.count} comments</span></div>
				<div class="coin-meta" style="margin-bottom:8px"><span class="chip ${sentChipCls}" style="color:${scoreColor}">${sentLabel} · ${o.score}</span></div>
				<div class="str-grid">
					<div class="str-row"><span class="str-lbl">Positive</span><div class="str-track"><div class="str-fill" style="width:${Math.round(o.posPct)}%;background:var(--up)"></div></div><span class="str-val" style="color:var(--up)">${Math.round(o.posPct)}%</span></div>
					<div class="str-row"><span class="str-lbl">Negative</span><div class="str-track"><div class="str-fill" style="width:${Math.round(o.negPct)}%;background:var(--down)"></div></div><span class="str-val" style="color:var(--down)">${Math.round(o.negPct)}%</span></div>
					<div class="str-row"><span class="str-lbl">Neutral</span><div class="str-track"><div class="str-fill" style="width:${Math.round(o.neuPct)}%;background:var(--muted)"></div></div><span class="str-val" style="color:var(--muted)">${Math.round(o.neuPct)}%</span></div>
				</div>${exHtml}`;
		} catch { wrap.innerHTML = ''; }
	}

	async function loadProofTrades(mint) {
		const wrap = $('#ocProof');
		if (!wrap) return;
		try {
			const r = await fetch(`/api/trades/feed?mint=${encodeURIComponent(mint)}&min_pnl_pct=0&limit=8`, { signal: AbortSignal.timeout(10000) });
			if (!r.ok) return;
			const { items = [] } = await r.json();
			if (!items.length) { wrap.innerHTML = ''; return; }
			const rows = items.map((t) => {
				const agent = esc(t.agent_name || t.agent_id?.slice(0, 8) || 'Agent');
				const mult = t.multiple != null ? `${t.multiple.toFixed(2)}×` : null;
				const pct = t.realized_pnl_pct != null ? `+${Math.round(t.realized_pnl_pct)}%` : null;
				const pnlSol = t.realized_pnl_sol != null ? `+${t.realized_pnl_sol.toFixed(3)} ◎` : null;
				const isPos = (t.realized_pnl_sol ?? 0) >= 0;
				const color = isPos ? 'var(--up)' : 'var(--down)';
				return `<div class="dr-ptrade">
					<span class="dr-ptrade-mult" style="color:${color}">${mult || pct || pnlSol || '+?'}</span>
					<div class="dr-ptrade-mid"><span class="dr-ptrade-agent">${agent}</span>${pnlSol ? `<span style="color:${color};font-size:11px">${pnlSol}</span>` : ''}</div>
					<a class="dr-act" href="/trader/${encodeURIComponent(t.agent_id || '')}" style="font-size:11.5px">Copy →</a>
				</div>`;
			}).join('');
			wrap.innerHTML = `<div class="dr-sec">Agent exits on this coin <span style="color:var(--faint);font-weight:400;font-size:10px">${items.length} found</span></div>
				<div style="display:flex;flex-direction:column;gap:4px">${rows}</div>`;
		} catch { /* non-fatal */ }
	}

	async function loadRelated(mint, category) {
		const wrap = $('#ocRelated');
		if (!wrap || !category) return;
		const { ok, data } = await api(`/api/oracle/feed?network=${NETWORK}&category=${encodeURIComponent(category)}&limit=6&min_score=60`);
		if (!ok || !data?.items?.length) return;
		const related = data.items.filter((it) => it.mint !== mint).slice(0, 3);
		if (!related.length) return;
		wrap.innerHTML = `<div class="dr-sec">Related · ${esc(category)}</div>
			<div style="display:flex;flex-direction:column;gap:6px">
				${related.map((r) => {
					const imgEl = r.image_uri
						? `<img src="${esc(r.image_uri)}" alt="" style="width:28px;height:28px;border-radius:7px;object-fit:cover;flex:none;border:1px solid var(--line)" loading="lazy">`
						: `<div style="width:28px;height:28px;border-radius:7px;background:var(--line);display:grid;place-items:center;font:700 11px/1 var(--mono);color:var(--faint);flex:none">${esc((r.symbol || '?')[0])}</div>`;
					return `<a class="dr-related" href="/oracle/coin/${encodeURIComponent(r.mint)}" data-related-mint="${esc(r.mint)}">
						${imgEl}
						<span style="flex:1;min-width:0">
							<span style="font-weight:700;font-size:13px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.symbol || r.mint.slice(0, 8))}</span>
							<span style="font-size:11px;color:var(--muted)">${esc(r.name || '')}</span>
						</span>
						<span style="display:flex;flex-direction:column;align-items:flex-end;flex:none">
							<span style="font:700 14px/1 var(--mono);color:var(--ink)">${r.score}</span>
							<span class="tierpill tp-${esc(r.tier)}" style="margin-top:3px;padding:1px 5px;font-size:9px">${esc(r.tier)}</span>
						</span>
					</a>`;
				}).join('')}
			</div>`;
		// Related coins are plain links to their own full pages — each gets its own
		// server-rendered hero + social card on navigation.
	}

	// ── live trade tape (ported from src/oracle-tape.js) ───────────────────────
	function mountTape(container, mint) {
		container.innerHTML = `<div class="tape-header"><span class="tape-dot"></span><span class="tape-status" id="ocTapeStatus">Connecting…</span><span class="tape-ct" id="ocTapeCt"></span></div><div class="tape-list" id="ocTapeList"></div>`;
		const statusEl = container.querySelector('#ocTapeStatus');
		const ctEl = container.querySelector('#ocTapeCt');
		const listEl = container.querySelector('#ocTapeList');
		let tradeCount = 0, es = null, active = true, reconnectTimer = null;
		const MAX_ROWS = 60, DELAY = 2000;

		const setStatus = (text, live = false) => { statusEl.textContent = text; container.querySelector('.tape-dot')?.classList.toggle('live', live); };

		function addRow(trade) {
			tradeCount++; ctEl.textContent = tradeCount;
			const isBuy = trade.is_buy;
			const title = ARCH_TITLE[trade.label] || null;
			const tag = trade.tag ? `@${esc(trade.tag)}` : '';
			const row = document.createElement('div');
			row.className = `tape-row ${isBuy ? 'buy' : 'sell'}`;
			row.innerHTML = `
				<span class="tape-type">${isBuy ? '▲ BUY' : '▼ SELL'}</span>
				${title ? `<span class="nlabel lb-${esc(trade.label)}">${esc(title)}</span>` : ''}
				${tag ? `<span class="tape-tag">${tag}</span>` : ''}
				<span class="tape-addr">${esc(shortAddr(trade.wallet))}</span>
				<span class="tape-sol ${isBuy ? 'buy' : 'sell'}">${fmtSol(trade.sol)}</span>
				${trade.mc_sol != null ? `<span class="tape-mc">${trade.mc_sol.toFixed(1)}◎ mc</span>` : ''}`;
			listEl.prepend(row);
			row.classList.add('flash');
			setTimeout(() => row.classList.remove('flash'), 600);
			const rows = listEl.querySelectorAll('.tape-row');
			if (rows.length > MAX_ROWS) rows[rows.length - 1].remove();
		}

		function open() {
			if (!active) return;
			es = new EventSource(`/api/oracle/trades?mint=${encodeURIComponent(mint)}&network=${encodeURIComponent(NETWORK)}`);
			es.addEventListener('hello', (e) => { const d = JSON.parse(e.data || '{}'); setStatus('Live trades', true); if (d.roster_size) statusEl.title = `${d.roster_size} wallets annotated`; });
			es.addEventListener('trade', (e) => { let t; try { t = JSON.parse(e.data); } catch { return; } addRow(t); });
			es.addEventListener('ping', () => {});
			es.addEventListener('bye', () => { es.close(); if (active) reconnectTimer = setTimeout(open, DELAY); });
			es.onerror = () => { setStatus('Reconnecting…', false); es.close(); if (active) reconnectTimer = setTimeout(open, DELAY * 2); };
		}
		open();
		return { destroy() { active = false; clearTimeout(reconnectTimer); try { es?.close(); } catch {} container.innerHTML = ''; } };
	}

	// ── wire hero buttons (server-rendered) ────────────────────────────────────
	function wireHero(mint) {
		const watchBtn = $('#ocWatch');
		if (watchBtn) {
			const sync = () => { const on = watchedMints().has(mint); watchBtn.textContent = on ? '★ Watching' : '☆ Watch'; watchBtn.setAttribute('aria-pressed', String(on)); };
			sync();
			watchBtn.addEventListener('click', () => { toggleWatch(mint); sync(); });
		}
		const copyMint = $('#ocCopyMint');
		if (copyMint) copyMint.addEventListener('click', () => {
			navigator.clipboard.writeText(mint).then(() => { const o = copyMint.textContent; copyMint.textContent = 'Copied!'; setTimeout(() => { copyMint.textContent = o; }, 1600); }).catch(() => {});
		});
		const copyLink = $('#ocCopyLink');
		if (copyLink) copyLink.addEventListener('click', () => {
			navigator.clipboard.writeText(`https://three.ws/oracle/coin/${mint}`).then(() => { const o = copyLink.textContent; copyLink.textContent = 'Copied!'; setTimeout(() => { copyLink.textContent = o; }, 1600); }).catch(() => {});
		});
	}

	// ── main ───────────────────────────────────────────────────────────────────
	function mintFromPath() {
		const m = location.pathname.match(/\/oracle\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
		if (m) return m[1];
		const q = new URLSearchParams(location.search).get('mint');
		return q && MINT_RE.test(q) ? q : null;
	}

	// Patch the server-rendered hero dial + pillars once a live verdict arrives.
	// For a fresh launch the SSR hero shows a "reading" state; this fills it in the
	// moment /api/oracle/coin returns a score, so the top of the page never lies.
	function updateHero(c) {
		const dial = $('#ocDial');
		if (dial && c.score != null) {
			dial.className = `dial t-${c.tier || 'watch'}`;
			dial.innerHTML = `<b>${c.score}</b><div class="tierpill tp-${esc(c.tier || 'watch')}">${esc(c.tier || 'watch')} conviction</div>`;
		}
		const p = c.pillars || {};
		const set = (kind, val) => {
			const el = $(`#ocPillars .pil.${kind}`);
			if (!el || val == null) return;
			const b = el.querySelector('.lab b'); if (b) b.textContent = Math.round(val);
			const fill = el.querySelector('.fill'); if (fill) fill.style.width = `${Math.max(0, Math.min(100, val))}%`;
		};
		set('ped', p.pedigree); set('str', p.structure); set('nar', p.narrative); set('mom', p.momentum);
	}

	// The conviction-independent scaffold: identity is already in the SSR hero, so
	// market + live trades render immediately for ANY mint. The conviction column
	// fills in (or shows an "observing" state) once /api/oracle/coin resolves.
	function buildScaffold(mint) {
		const deep = $('#ocDeep');
		if (!deep) return;
		deep.innerHTML = `
			<div id="ocTake"></div>
			<div id="ocChart" class="oc-chart"></div>
			<div id="ocHistory"></div>
			<div class="oc-cols">
				<div id="ocConviction">
					<div class="dr-sec">Conviction</div>
					<div class="oc-spinner" aria-label="Reading conviction"></div>
				</div>
				<div>
					<div id="ocMarket" class="mkt-loading" aria-busy="true">
						<div class="dr-sec">Market <span style="color:var(--faint);font-weight:400;font-size:10px">live</span></div>
						<div class="mkt-skel"><span></span><span></span><span></span><span></span><span></span><span></span></div>
					</div>
					<div class="dr-sec">Live trades</div>
					<div id="ocTape" class="trade-tape"></div>
					<div id="ocRelated"></div>
				</div>
			</div>`;
		const chartEl = $('#ocChart');
		if (chartEl) mountChart(chartEl, mint);
		loadMarket(mint);
		loadHistory(mint);
		loadProofTrades(mint); // renders into #ocProof once the conviction column exists
		if (window.__ocTape) { try { window.__ocTape.destroy(); } catch {} }
		const tapeEl = $('#ocTape');
		if (tapeEl) window.__ocTape = mountTape(tapeEl, mint);
	}

	function fillConviction(data, mint) {
		const col = $('#ocConviction');
		if (!col) return;
		const c = data.conviction;
		document.title = `${c.symbol ? `$${c.symbol}` : mint.slice(0, 8)} — ${c.score}/100 ${c.tier || ''} conviction · Oracle · three.ws`;
		updateHero(c);
		const reasons = (data.reasons || []).map((r) => `<div class="reason"><span class="rdot ${esc(r.pillar)}"></span><span>${esc(r.text)}</span></div>`).join('') || '<div class="state" style="padding:20px 0">No breakdown available.</div>';
		const narr = data.narrative;
		const whos = (data.whos_in || []).map(whoRow).join('') || '<div class="state" style="padding:20px 0">No wallet footprint recorded yet.</div>';
		const out = data.outcome;
		const comp = data.components || {};
		col.innerHTML = `
			<div class="dr-sec">Why this score</div>${reasons}
			${narr ? `<div class="dr-sec">Narrative</div><div style="font-size:13.5px;color:var(--ink)">${esc(narr.narrative || '')}</div>
				<div class="coin-meta" style="margin-top:8px"><span class="chip cat">${esc(narr.category)}</span><span class="chip">virality <b>${narr.virality ?? '—'}</b></span><span class="chip">${esc(narr.source || '')}</span></div>` : ''}
			<div id="ocPulse"></div>
			${structurePanel(comp.structure)}
			${out ? `<div class="dr-sec">Outcome</div><div class="coin-meta">
				<span class="chip ${out.graduated ? 'sm' : out.rugged ? 'flag' : ''}">${out.graduated ? 'graduated ✓' : out.rugged ? 'rugged ✕' : 'live'}</span>
				${out.ath_multiple ? `<span class="chip">ATH <b>${Number(out.ath_multiple).toFixed(1)}×</b></span>` : ''}</div>` : ''}
			<div class="dr-sec">Who's in <span style="color:var(--faint)">(${(data.whos_in || []).length})</span></div>${whos}
			<div id="ocProof"></div>`;
		const take = $('#ocTake');
		if (take) take.innerHTML = drawerTake(data);
		loadHistory(mint);
		loadSentiment(mint);
		loadProofTrades(mint);
		loadRelated(mint, c.category);
	}

	function renderObserving(mint, retry) {
		const col = $('#ocConviction');
		if (!col) return;
		col.innerHTML = `<div class="dr-sec">Conviction</div>
			<div class="state" style="padding:28px 20px">
				<b>Oracle is reading this launch</b>
				A conviction score fuses who's buying, how, what it is, and how it's moving — it appears here within moments of a coin surfacing on pump.fun. The live market and trade tape are already streaming.
				<div style="margin-top:14px"><button type="button" class="dr-act" id="ocRetry">${retry >= 4 ? 'Check again' : 'Checking…'}</button></div>
			</div>`;
		$('#ocRetry')?.addEventListener('click', () => render(mint, { retry: 0 }));
	}

	async function render(mint, { retry = 0 } = {}) {
		const deep = $('#ocDeep');
		if (!deep) return;
		if (deep.dataset.scaffold !== mint) { deep.dataset.scaffold = mint; buildScaffold(mint); }
		const { ok, data } = await api(`/api/oracle/coin?mint=${encodeURIComponent(mint)}&network=${NETWORK}`, { timeout: 20000 });
		if (ok && data && data.conviction) { fillConviction(data, mint); return; }
		// Not scored yet — /api/oracle/coin lazy-scores on the first hit, so a short
		// backoff usually fills it. Keep the streaming market + tape untouched.
		renderObserving(mint, retry);
		if (retry < 4 && deep.dataset.scaffold === mint) {
			setTimeout(() => { if (deep.dataset.scaffold === mint) render(mint, { retry: retry + 1 }); }, 4000 + retry * 2000);
		}
	}

	function boot() {
		const mint = mintFromPath();
		if (!mint) { location.replace('/oracle'); return; }
		wireHero(mint);
		render(mint);
		window.addEventListener('popstate', () => {
			const m = mintFromPath();
			if (m && m !== $('#ocDeep')?.dataset.scaffold) location.reload();
		});
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
	else boot();
})();
