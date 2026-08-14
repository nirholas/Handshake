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

	// Token art lives on public IPFS gateways, and roughly half of pump.fun art is
	// a metadata JSON document sharing one `image_uri` column with the real image.
	// Hot-linked, both fail: the gateway answers without CORS headers or with
	// `application/json` and Chrome blocks it (ERR_BLOCKED_BY_ORB), leaving a
	// broken tile. /api/img resolves the metadata hop, retries across gateways and
	// always hands back a valid image. Buildless file, so this mirrors
	// proxiedImageURL() from src/ipfs.js rather than importing it.
	const imgProxy = (url, seed = '') => {
		const raw = String(url ?? '').trim();
		if (!raw || !/^(https?|ipfs|ar):/i.test(raw)) return raw;
		const q = new URLSearchParams({ url: raw });
		if (seed) q.set('seed', seed);
		return `/api/img?${q.toString()}`;
	};

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
		// A resolved coin gets its result first. Pitching a launch in the present
		// tense ("a prime setup at 100") next to a chart that already died is what
		// made a correct call read as a broken one: the call was about the first 90
		// seconds, the chart is about everything since, and only one of them was on
		// the page. The reasons still follow, because why the engine said it stays
		// the interesting part once you know how it ended.
		const past = outcomeSentence(d.outcome);
		return `<div class="coin-take"><span class="ct-q">“</span><span>${past
			? `<b>${esc(past)}</b> Oracle called it ${esc(String(lead).toLowerCase())} at ${c.score} from ${esc(body)}.`
			: `<b>${esc(lead)} at ${c.score}</b> from ${esc(body)}.`}</span></div>`;
	}

	// One plain sentence for what the market did after the call. Mirrors
	// outcomeStripHtml() in api/oracle-share.js (buildless file, no imports).
	function outcomeSentence(out) {
		if (!out) return '';
		const ath = out.ath_multiple != null ? Number(out.ath_multiple) : null;
		const peak = ath > 0 ? `peaked at ${ath.toFixed(1)}x` : null;
		if (out.graduated) return peak ? `It graduated, ${peak}.` : 'It graduated.';
		if (out.rugged) return peak ? `It ran to ${ath.toFixed(1)}x and then rugged.` : 'It rugged.';
		if (peak) return `It has ${peak} so far.`;
		return '';
	}

	// The dial's two honesty lines, mirroring verdictOddsHtml()/outcomeStripHtml()
	// in api/oracle-share.js. The server renders both for any coin it already had a
	// verdict for; these fill them in for a lazy-scored launch and refresh them
	// once the live read lands.
	function oddsHtml(c) {
		if (!c || c.hit_rate == null || !c.hit_rate_n) return '';
		const rate = Math.round(Number(c.hit_rate) * 100);
		const base = Math.round(Number(c.base_rate || 0) * 100);
		const lift = c.hit_rate_lift != null ? Number(c.hit_rate_lift).toFixed(1) : null;
		const lead = leadTime(c.scored_at, c.coin_first_seen_at);
		return `<p class="oc-odds">
			<b>${rate}%</b> of calls in the ${esc(c.hit_rate_band || '')} band have won<span class="oc-odds-n"> (n=${Number(c.hit_rate_n).toLocaleString('en-US')})</span>${lift ? `, <b>${esc(lift)}x</b> the ${base}% a random launch wins` : ''}.
			<span class="oc-odds-sub">Scored ${lead ? `${lead} after this coin surfaced` : 'at launch'}, from the first ~90s of trading. It ranks the odds of a 3x run or graduation, not the odds of a safe hold.</span>
		</p>`;
	}

	function leadTime(scoredAt, firstSeen) {
		if (!scoredAt || !firstSeen) return null;
		const secs = Math.round((new Date(scoredAt).getTime() - new Date(firstSeen).getTime()) / 1000);
		if (!Number.isFinite(secs) || secs < 0) return null;
		return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
	}

	function sinceHtml(out) {
		if (!out) return '';
		const ath = out.ath_multiple != null ? Number(out.ath_multiple) : null;
		const mc = out.last_market_cap_usd != null ? Number(out.last_market_cap_usd) : null;
		if (!out.graduated && !out.rugged && !(ath > 0)) return '';
		const verdict = out.graduated
			? '<span class="chip sm">graduated ✓</span>'
			: out.rugged ? '<span class="chip flag">rugged ✕</span>' : '<span class="chip">still live</span>';
		return `<div class="oc-since ${out.rugged && !out.graduated ? 'bad' : out.graduated ? 'good' : ''}">
			<span class="oc-since-lbl">Since the call</span>
			${ath > 0 ? `<span class="chip" title="Peak market cap versus its market cap when Oracle scored it">peak <b>${ath.toFixed(1)}x</b></span>` : ''}
			${verdict}
			${mc != null ? `<span class="chip" title="Market cap now">now <b>${fmtUsd(mc)}</b></span>` : ''}
		</div>`;
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

		const nativeNote = p.native_sol ? `<div class="mkt-src">${p.native_sol < 0.0001 ? p.native_sol.toExponential(2) : p.native_sol.toFixed(6)} ◎ native</div>` : '';
		return `<div class="mkt-stats">${tiles}</div>${nativeNote}
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
		const trendColor = trend === 'rising' ? 'var(--cv-green)' : trend === 'falling' ? 'var(--cv-red)' : 'var(--cv-text-3)';
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
				? `<div class="state" style="padding:20px 0">No live market yet — this mint hasn't started trading. Price, liquidity and holders appear the moment it does.</div>`
				: `<div class="state" style="padding:20px 0">Live market data is momentarily unavailable. <button type="button" class="dr-act" id="ocMktRetry">Retry</button></div>`;
			const retry = $('#ocMktRetry');
			if (retry) retry.addEventListener('click', () => { wrap.classList.add('mkt-loading'); wrap.setAttribute('aria-busy', 'true'); loadMarket(mint); });
			return;
		}
		wrap.innerHTML = renderMarket(data);
		fillPriceRow(data);
		fillDescription(data.identity?.description);
	}

	// Fill the header's price row (SSR renders it hidden) the moment a live price
	// exists — the same header treatment /coin/:id gives listed coins.
	function fillPriceRow(m) {
		const rowEl = $('#ocPriceRow');
		const priceEl = $('#ocPrice');
		const chipsEl = $('#ocPriceChips');
		const p = m.price || {};
		if (!rowEl || !priceEl || p.usd == null) return;
		priceEl.textContent = fmtPrice(p.usd);
		const ch = p.change || {};
		if (chipsEl) {
			chipsEl.innerHTML = [['24h', ch.h24], ['7d', ch.d7]]
				.filter(([, v]) => v != null && Number.isFinite(Number(v)))
				.map(([l, v]) => {
					const c = changeStr(v);
					return `<span class="cv-chip ${c.cls === 'up' ? 'up' : c.cls === 'down' ? 'down' : ''}"><span class="win">${l}</span>${c.txt}</span>`;
				}).join('');
		}
		rowEl.hidden = false;
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
		return `${tiles ? `<div class="mkt-stats">${tiles}</div>` : ''}
			${curve}
			${chips ? `<div class="coin-meta" style="margin-top:10px">${chips}</div>` : ''}
			<div class="mkt-src">Live · pumpfun — full metrics populate once it lists on a DEX</div>`;
	}

	// ── launch intelligence (Coin Radar engine) ────────────────────────────────
	// The same first-~90s on-chain read the /radar drawer shows, on the full page:
	// quality score, organic vs bundle, risk flags, the complete signal breakdown,
	// smart-money buyers, news provenance, tags, and the top-trader ledger. Source
	// is /api/pump/coin-intel — every number traces to an observed on-chain trade;
	// a signal the engine did not measure renders as "not measured", never as 0.
	const RADAR_FLAGS = {
		bundle_launch:      { label: 'Bundle launch',      tone: 'danger', tip: 'Many wallets bought in the same block — likely coordinated.' },
		dev_dumped:         { label: 'Dev dumped',         tone: 'danger', tip: 'The creator sold their position.' },
		single_whale:       { label: 'Single whale',       tone: 'danger', tip: 'One wallet holds an outsized share of supply.' },
		low_diversity:      { label: 'Low diversity',      tone: 'danger', tip: 'Few unique buyers — thin, concentrated participation.' },
		fresh_wallet_swarm: { label: 'Fresh-wallet swarm', tone: 'danger', tip: 'A cluster of brand-new wallets bought together.' },
		sell_pressure:      { label: 'Sell pressure',      tone: 'warn',   tip: 'Sells are outpacing buys early.' },
		sniped:             { label: 'Sniped',             tone: 'warn',   tip: 'Snipers grabbed supply in the first moments.' },
	};

	const fmtSolPlain = (v) => {
		if (v == null || Number.isNaN(Number(v))) return null;
		const n = Number(v), abs = Math.abs(n);
		if (abs === 0) return '0';
		if (abs < 0.001) return n.toFixed(5);
		if (abs < 1) return n.toFixed(3);
		if (abs < 1000) return n.toFixed(2);
		return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
	};
	const ratioPct = (v) => (v == null ? 'not measured' : `${Math.round(Number(v) * 100)}%`);

	function qualityMeta(score) {
		if (score == null) return { cls: 'q-none', label: 'Unscored' };
		if (score >= 70) return { cls: 'q-good', label: 'Healthy' };
		if (score >= 40) return { cls: 'q-mixed', label: 'Mixed' };
		return { cls: 'q-risk', label: 'High risk' };
	}

	function intelTile(label, value, tip, cls = '') {
		const measured = value !== 'not measured';
		return `<div class="cv-mini-stat"${tip ? ` title="${esc(tip)}"` : ''}>
			<p class="label">${esc(label)}</p>
			<p class="value cv-mono ${cls}" style="${measured ? '' : 'color:var(--cv-text-3);font-size:0.8125rem'}">${value}</p>
		</div>`;
	}

	async function loadRadarIntel(mint) {
		const sec = $('#ocIntelSec');
		const wrap = $('#ocIntel');
		if (!sec || !wrap) return;
		const { ok, data } = await api(`/api/pump/coin-intel?mint=${encodeURIComponent(mint)}&wallets=1&network=${NETWORK}`, { timeout: 12000 });
		// Coins the radar never observed (pre-engine launches, non-pump mints) simply
		// don't get this section — absence of data is not an error state here.
		if (!ok || !data || !data.mint) return;
		wrap.innerHTML = renderIntel(data);
		sec.hidden = false;
	}

	function renderIntel(c) {
		const q = qualityMeta(c.quality_score);
		const organic = c.organic_score != null ? Math.round(c.organic_score * 100) : null;
		const bundle = c.bundle_score != null ? Math.round(c.bundle_score * 100) : null;

		const head = `<div class="oc-intel-head">
			<div class="oc-iq ${q.cls}"><b>${c.quality_score ?? '—'}</b><div class="oc-iq-lbl">${esc(q.label)}</div></div>
			<div class="oc-ob">
				<div class="oc-ob-row"><span>Organic <b class="og">${organic != null ? `${organic}%` : 'n/m'}</b></span><span>Bundle <b class="bd">${bundle != null ? `${bundle}%` : 'n/m'}</b></span></div>
				<div class="oc-ob-track">
					<span class="oc-ob-organic" style="width:${Math.max(0, Math.min(100, organic || 0))}%"></span>
					<span class="oc-ob-bundle" style="width:${Math.max(0, Math.min(100, bundle || 0))}%"></span>
				</div>
			</div>
			<div class="coin-meta oc-intel-meta">
				${c.observation_seconds != null ? `<span class="chip">observed <b>${fmtInt(c.observation_seconds)}s</b></span>` : ''}
				${c.first_seen_at ? `<span class="chip">first seen <b>${esc(ago(c.first_seen_at))} ago</b></span>` : ''}
				${c.category ? `<span class="chip cat">${esc(c.category)}</span>` : ''}
				${c.classify_source ? `<span class="chip">classified by <b>${esc(c.classify_source)}</b>${c.classify_confidence != null ? ` · ${Math.round(c.classify_confidence * 100)}%` : ''}</span>` : ''}
				${c.outcome?.outcome ? `<span class="chip ${c.outcome.rugged ? 'flag' : c.outcome.graduated ? 'sm' : ''}">${c.outcome.rugged ? 'rugged ✕' : c.outcome.graduated ? 'graduated ✓' : esc(c.outcome.outcome)}</span>` : ''}
				${c.outcome?.ath_multiple != null ? `<span class="chip">ATH <b>${Number(c.outcome.ath_multiple).toFixed(1)}×</b></span>` : ''}
				${Array.isArray(c.tags) ? c.tags.slice(0, 6).map((t) => `<span class="chip">${esc(t)}</span>`).join('') : ''}
			</div>
		</div>`;

		const news = c.is_news_meme && c.news_headline
			? `<div class="oc-news"><span class="oc-news-glyph" aria-hidden="true">⚡</span><div>
					<p class="oc-news-headline">${esc(c.news_headline)}</p>
					${c.news_url && /^https?:\/\//i.test(c.news_url) ? `<a href="${esc(c.news_url)}" target="_blank" rel="noopener noreferrer">Read source →</a>` : ''}
				</div></div>`
			: '';

		const flags = Array.isArray(c.risk_flags) ? c.risk_flags : [];
		const flagsHtml = `<div class="dr-sec">Risk flags</div>
			<div class="oc-flags">${flags.length
				? flags.map((f) => {
					const meta = RADAR_FLAGS[f] || { label: f.replace(/_/g, ' '), tone: 'warn', tip: '' };
					return `<div class="oc-flag oc-flag--${meta.tone}"><span class="oc-flag-name">${esc(meta.label)}</span>${meta.tip ? `<span class="oc-flag-tip">${esc(meta.tip)}</span>` : ''}</div>`;
				}).join('')
				: '<div class="oc-flag oc-flag--clean"><span class="oc-flag-name">No risk flags</span><span class="oc-flag-tip">Nothing raised during the observation window.</span></div>'}</div>`;

		const notable = Array.isArray(c.smart_money_notable) ? c.smart_money_notable : [];
		const smHtml = (c.smart_money_count > 0 || notable.length)
			? `<div class="dr-sec">Smart money</div>
				<div class="coin-meta" style="margin-bottom:0.625rem">
					<span class="chip sm">${fmtInt(c.smart_money_count)} wallet${c.smart_money_count === 1 ? '' : 's'}</span>
					${c.smart_money_score != null ? `<span class="chip">pedigree <b>${Math.round(c.smart_money_score)}/100</b></span>` : ''}
				</div>
				${notable.slice(0, 5).map((w) => `<div class="nwallet">
					<div class="nw-left">
						<span class="nw-addr"><a class="solscan" href="${solscan(w.wallet)}" target="_blank" rel="noopener">${esc(w.label || shortAddr(w.wallet))}</a></span>
						<span class="nw-sub">${w.win_rate != null ? `${Math.round(w.win_rate * 100)}% win${w.wins != null && w.duds != null ? ` · ${w.wins}W/${w.duds}L` : ''}` : '—'}</span>
					</div>
					${w.smart_money_score != null ? `<span class="nw-buy">${Math.round(w.smart_money_score)}</span>` : ''}
				</div>`).join('')}`
			: '';

		const sig = [
			['Organic score', ratioPct(c.organic_score), null],
			['Bundle score', ratioPct(c.bundle_score), null],
			['Coordination', ratioPct(c.coordination_score), 'Blended bundle + funding-graph coordination signal'],
			['Snipe ratio', ratioPct(c.snipe_ratio), 'Share of early supply taken by snipers'],
			['Top-10 concentration', ratioPct(c.concentration_top10), 'Share of supply held by the top 10 wallets'],
			['Top-5 concentration', ratioPct(c.concentration_top5), 'Share of supply held by the top 5 wallets'],
			['Fresh-wallet ratio', ratioPct(c.fresh_wallet_ratio), 'Share of buyers using brand-new wallets'],
			['Bubblemap connectivity', ratioPct(c.bubblemap_connectivity), 'How interlinked the buyer wallets are by funding'],
			['Funding clusters', c.cluster_count != null ? fmtInt(c.cluster_count) : '—', 'Distinct funding clusters among buyers'],
			['Mkt cap (first seen)', c.market_cap_sol != null ? `${fmtSolPlain(c.market_cap_sol)} ◎` : 'not measured', 'Market cap in SOL when the engine began observing'],
			['Unique buyers', fmtInt(c.unique_buyers), null],
			['Unique sellers', fmtInt(c.unique_sellers), null],
			['Buys / sells', `${fmtInt(c.buy_count)} / ${fmtInt(c.sell_count)}`, null],
			['Buy/sell ratio', c.buy_sell_ratio != null ? `${Number(c.buy_sell_ratio).toFixed(2)}×` : '—', 'Buy volume divided by sell volume'],
			['Buy volume', c.buy_volume_sol != null ? `${fmtSolPlain(c.buy_volume_sol)} ◎` : '—', null],
			['Sell volume', c.sell_volume_sol != null ? `${fmtSolPlain(c.sell_volume_sol)} ◎` : '—', null],
			['Net flow', c.net_volume_sol != null ? `${c.net_volume_sol > 0 ? '+' : ''}${fmtSolPlain(c.net_volume_sol)} ◎` : '—', 'Buy volume minus sell volume', c.net_volume_sol > 0 ? 'green' : c.net_volume_sol < 0 ? 'red' : ''],
			['Dev buy', c.dev_buy_sol != null ? `${fmtSolPlain(c.dev_buy_sol)} ◎` : '—', null],
			['Dev sold', c.dev_sold ? 'Yes' : 'No', null, c.dev_sold ? 'red' : ''],
			['Largest buy', c.largest_buy_sol != null ? `${fmtSolPlain(c.largest_buy_sol)} ◎` : '—', null],
		];
		const sigHtml = `<div class="dr-sec">Signal breakdown</div>
			<div class="oc-sig-grid">${sig.map(([l, v, tip, cls]) => intelTile(l, v, tip, cls || '')).join('')}</div>`;

		const wallets = Array.isArray(c.wallets) ? c.wallets : [];
		const ledgerHtml = wallets.length
			? `<div class="dr-sec">Top trader ledger</div>
				<div class="oc-ledger"><div class="cv-table-wrap"><table class="cv-table">
					<thead><tr><th scope="col">Wallet</th><th scope="col">Buy ◎</th><th scope="col">Sell ◎</th><th scope="col">Net ◎</th></tr></thead>
					<tbody>${wallets.map((w) => `<tr>
						<td><a class="solscan" href="${solscan(w.wallet)}" target="_blank" rel="noopener" title="${esc(w.wallet)}">${esc(shortAddr(w.wallet))}</a>${w.is_creator ? '<span class="oc-wtag">creator</span>' : ''}</td>
						<td class="cv-mono" style="text-align:right">${w.buy_sol != null ? fmtSolPlain(w.buy_sol) : '—'}</td>
						<td class="cv-mono" style="text-align:right">${w.sell_sol != null ? fmtSolPlain(w.sell_sol) : '—'}</td>
						<td class="cv-mono ${w.net_sol > 0 ? 'mkt-up' : w.net_sol < 0 ? 'mkt-down' : ''}" style="text-align:right">${w.net_sol != null ? `${w.net_sol > 0 ? '+' : ''}${fmtSolPlain(w.net_sol)}` : '—'}</td>
					</tr>`).join('')}</tbody>
				</table></div></div>`
			: '';

		const narrative = c.narrative ? `<p class="oc-intel-note" style="margin:0 0 1rem;font-size:0.9375rem;color:var(--cv-text-2)">${esc(c.narrative)}</p>` : '';

		return `${head}${narrative}${news}${flagsHtml}${smHtml}${sigHtml}${ledgerHtml}
			<p class="oc-intel-note">Every number traces to an observed on-chain trade in the coin's first moments — nothing is synthesized. <a class="dr-act" href="/radar">Open Coin Radar →</a></p>`;
	}

	// ── price chart ────────────────────────────────────────────────────────────
	// A TradingView-grade candlestick view via the DexScreener embed (keyed by the
	// mint, resolves the most-liquid pair itself), a native SVG line chart from
	// /api/pump/price-history for coins still on the bonding curve with no DEX pair,
	// and an "Agent trades" view that overlays every three.ws agent's buys and sells
	// as bubbles on that native series, each plotted at the candle close nearest its
	// on-chain timestamp (the same at-or-before-the-event technique the tweet-price
	// chart uses), so you can see exactly where the machine economy moved this coin.
	const CHART_KEY = 'oc_chart_view';

	// Agent transactions for this coin (from /api/pulse?mint=…). Fetched once per
	// mint, shared by the chart-marker overlay and the "Agent transactions" list.
	let AGENT_TRADES = [];

	function dexEmbedUrl(mint) {
		const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
		const p = new URLSearchParams({ embed: '1', loadChartSettings: '0', theme, chartTheme: theme, chartType: 'usd', interval: '15', info: '0' });
		return `https://dexscreener.com/solana/${encodeURIComponent(mint)}?${p}`;
	}

	// Every three.ws agent transaction in one coin, newest first. Normalised for
	// both the marker overlay (needs tSec + side) and the list (needs labels). Never
	// throws: a failure just yields an empty overlay and an empty list.
	async function fetchAgentTrades(mint) {
		try {
			const { ok, data } = await api(`/api/pulse?type=trades&mint=${encodeURIComponent(mint)}&network=${NETWORK}&limit=50`, { timeout: 10000 });
			const body = data && data.data; // /api/pulse wraps its payload as { data: { events } }
			if (!ok || !body || !Array.isArray(body.events)) { AGENT_TRADES = []; return AGENT_TRADES; }
			AGENT_TRADES = body.events.map((e) => {
				const ms = new Date(e.ts).getTime();
				return {
					tSec: Math.floor(ms / 1000),
					tsMs: ms,
					side: e.side === 'sell' ? 'sell' : 'buy',
					sol: e.sol != null ? Number(e.sol) : null,
					usd: e.usd != null ? Number(e.usd) : null,
					agent_name: e.agent?.name || 'Agent',
					agent_url: e.agent?.url || null,
					explorer: e.explorer || null,
				};
			}).filter((t) => Number.isFinite(t.tSec));
			return AGENT_TRADES;
		} catch { AGENT_TRADES = []; return AGENT_TRADES; }
	}

	// Price at (or just before) an epoch-seconds instant: the candle close at or
	// immediately preceding it, so a marker sits on the line the way the trade saw
	// the market. `pts` is ascending by `t`.
	function priceAt(pts, tSec) {
		let lo = 0, hi = pts.length - 1, ans = 0;
		while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid].t <= tSec) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
		return pts[ans]?.c ?? pts[0]?.c ?? 0;
	}

	function areaChartSvg(points, markers = []) {
		const w = 720, h = 240, volH = 38, priceH = h - volH, pad = { t: 12, r: 8, b: 4, l: 8 };
		const closes = points.map((p) => p.c), vols = points.map((p) => p.v || 0);
		const min = Math.min(...closes), max = Math.max(...closes), span = (max - min) || max || 1, maxVol = Math.max(...vols) || 1;
		const innerW = w - pad.l - pad.r, innerH = priceH - pad.t - pad.b;
		// Time-based x so on-chain trade timestamps land on the right spot, not on an
		// evenly-spaced index. Falls back to index spacing if the series has no time.
		const t0 = points[0].t, t1 = points[points.length - 1].t, tspan = (t1 - t0) || 1;
		const hasTime = Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0;
		const xt = (tSec) => pad.l + ((Math.max(t0, Math.min(t1, tSec)) - t0) / tspan) * innerW;
		const x = hasTime ? ((i) => xt(points[i].t)) : ((i) => pad.l + (i / Math.max(1, points.length - 1)) * innerW);
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
		// Agent-trade bubbles. Cluster markers that collapse to the same ~9px column +
		// side so a busy window reads as a few labelled dots, not a smear; a cluster of
		// N shows a count. Buys sit just under the price line, sells just over it.
		let markSvg = '';
		if (hasTime && markers.length) {
			const buckets = new Map();
			for (const m of markers) {
				if (m.tSec < t0 - tspan * 0.02) continue; // far left of window → skip
				const px = xt(m.tSec), py = y(priceAt(points, m.tSec));
				const key = `${Math.round(px / 9)}:${m.side}`;
				const b = buckets.get(key);
				if (b) { b.n++; b.usd += m.usd || 0; }
				else buckets.set(key, { px, py, side: m.side, n: 1, usd: m.usd || 0, name: m.agent_name });
			}
			markSvg = [...buckets.values()].map((b) => {
				const buy = b.side === 'buy';
				const mc = buy ? 'var(--up)' : 'var(--down)';
				const cy = b.py + (buy ? 8 : -8);
				const label = b.n > 1
					? `${b.n} agent ${buy ? 'buys' : 'sells'} · $${b.usd.toFixed(2)} total`
					: `${b.name} ${buy ? 'bought' : 'sold'}${b.usd ? ` · $${b.usd.toFixed(2)}` : ''}`;
				const badge = b.n > 1
					? `<text x="${b.px.toFixed(1)}" y="${(cy + 2.6).toFixed(1)}" text-anchor="middle" font-size="6.5" font-weight="700" fill="#0b0f14">${b.n > 9 ? '9+' : b.n}</text>`
					: '';
				return `<g class="oc-mk"><title>${esc(label)}</title>`
					+ `<line x1="${b.px.toFixed(1)}" y1="${b.py.toFixed(1)}" x2="${b.px.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${mc}" stroke-width="1" opacity="0.5"/>`
					+ `<circle cx="${b.px.toFixed(1)}" cy="${cy.toFixed(1)}" r="${b.n > 1 ? 5.4 : 4}" fill="${mc}" stroke="var(--bg,#0b0f14)" stroke-width="1.4"/>`
					+ badge + `</g>`;
			}).join('');
		}
		return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="oc-chart-svg" role="img" aria-label="Price history with agent trades" style="color:${col}">
			<defs><linearGradient id="ocgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="0.25"/><stop offset="100%" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
			${bars}
			<line x1="${pad.l}" y1="${priceH}" x2="${w - pad.r}" y2="${priceH}" stroke="var(--line)" stroke-width="1"/>
			<path d="${area}" fill="url(#ocgrad)" stroke="none"/>
			<path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
			${markSvg}
		</svg>`;
	}

	// Choose an OHLC window + interval wide enough to contain the agent trades we
	// want to plot, so markers never pile up against the right edge. Without markers
	// it stays the tight 36h live view.
	function chartWindow(markers) {
		const now = Math.floor(Date.now() / 1000);
		let from = now - 36 * 3600;
		if (markers.length) {
			const earliest = Math.min(...markers.map((m) => m.tSec));
			from = Math.min(from, earliest - 3600); // one candle of lead-in
		}
		const span = now - from, DAY = 86400;
		const cap = 30 * DAY;
		if (span > cap) from = now - cap;
		const s = now - from;
		const interval = s <= 2 * DAY ? '15m' : s <= 7 * DAY ? '1h' : s <= 21 * DAY ? '4h' : '1D';
		const label = s <= 2 * DAY ? `${Math.round(s / 3600)}h` : `${Math.round(s / DAY)}d`;
		return { from, to: now, interval, label };
	}

	async function loadNativeChart(canvas, mint, opts = {}) {
		const markers = opts.markers || [];
		canvas.innerHTML = '<div class="oc-chart-skel"></div>';
		const { from, to, interval, label } = chartWindow(markers);
		const { ok, data } = await api(`/api/pump/price-history?mint=${encodeURIComponent(mint)}&interval=${interval}&from=${from}&to=${to}`, { timeout: 12000 });
		const pts = ((data && data.data) || []).filter((p) => Number.isFinite(p.c));
		if (!ok || pts.length < 2) { canvas.innerHTML = '<div class="state" style="padding:34px 0">Chart appears once this coin has trade history.</div>'; return; }
		const first = pts[0].c, last = pts[pts.length - 1].c;
		const chg = changeStr(first ? ((last - first) / first) * 100 : 0);
		const plotted = markers.filter((m) => m.tSec >= pts[0].t).length;
		const legend = markers.length
			? `<div class="oc-chart-legend"><span class="oc-lg buy"></span>agent buy<span class="oc-lg sell"></span>agent sell<span class="oc-lg-ct">${plotted} plotted</span></div>`
			: '';
		canvas.innerHTML = `<div class="oc-chart-readout"><span class="oc-chart-price">${fmtPrice(last)}</span><span class="mkt-${chg.cls}">${chg.txt} · ${label}</span></div>${areaChartSvg(pts, markers)}${legend}`;
	}

	function mountChart(container, mint) {
		let stored = null; try { stored = localStorage.getItem(CHART_KEY); } catch {}
		const hasTrades = AGENT_TRADES.length > 0;
		const preCurve = BOOT.pump && !BOOT.pump.complete; // no DEX pair yet → native by default
		// When agents have traded this coin, lead with the annotated view so their
		// moves are on the chart the instant the page opens; otherwise honour the last
		// choice, then default to candles (or native pre-DEX).
		let view = stored || (hasTrades ? 'trades' : preCurve ? 'line' : 'candles');
		if (view === 'trades' && !hasTrades) view = preCurve ? 'line' : 'candles';
		const tradesBtn = hasTrades ? `<button type="button" class="oc-seg-btn${view === 'trades' ? ' on' : ''}" data-view="trades">Agent trades</button>` : '';
		container.innerHTML = `<div class="oc-chart-controls">
				<span class="oc-chart-title">Price chart <span class="oc-h2-note">live</span></span>
				<div class="oc-seg" role="group" aria-label="Chart view">
					<button type="button" class="oc-seg-btn${view === 'candles' ? ' on' : ''}" data-view="candles">Candles</button>
					<button type="button" class="oc-seg-btn${view === 'line' ? ' on' : ''}" data-view="line">Line</button>
					${tradesBtn}
				</div>
				<a class="dr-act" href="https://dexscreener.com/solana/${encodeURIComponent(mint)}" target="_blank" rel="noopener">DexScreener ↗</a>
			</div>
			<div class="oc-chart-canvas" id="ocChartCanvas"></div>
			<p class="oc-chart-credit"><a href="https://dexscreener.com/solana/${encodeURIComponent(mint)}" target="_blank" rel="noopener nofollow noreferrer">Candles chart by DexScreener · TradingView ↗</a></p>`;
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
		function render(v) {
			clearTimeout(watchdog);
			if (v === 'candles') renderCandles();
			else if (v === 'trades') loadNativeChart(canvas, mint, { markers: AGENT_TRADES });
			else loadNativeChart(canvas, mint);
		}
		function apply(v) {
			try { localStorage.setItem(CHART_KEY, v); } catch {}
			container.querySelectorAll('.oc-seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
			render(v);
		}
		container.querySelectorAll('.oc-seg-btn').forEach((b) => b.addEventListener('click', () => apply(b.dataset.view)));
		render(view);
	}

	// ── agent transactions list ─────────────────────────────────────────────────
	// The same events the chart plots, as a scannable ledger: who traded, which way,
	// how much, when, and a link out to the on-chain proof and the agent's profile.
	function renderAgentTx(mint) {
		const wrap = $('#ocAgentTx');
		if (!wrap) return;
		const trades = AGENT_TRADES;
		if (!trades.length) { wrap.innerHTML = ''; return; }
		const buys = trades.filter((t) => t.side === 'buy').length;
		const rows = trades.slice(0, 12).map((t) => {
			const buy = t.side === 'buy';
			const amt = t.sol != null ? fmtSol(t.sol) : '';
			const usd = t.usd != null ? `$${t.usd.toFixed(2)}` : '';
			const name = esc(t.agent_name);
			const nameEl = t.agent_url ? `<a class="oc-atx-agent" href="${esc(t.agent_url)}">${name}</a>` : `<span class="oc-atx-agent">${name}</span>`;
			const tx = t.explorer ? `<a class="oc-atx-tx" href="${esc(t.explorer)}" target="_blank" rel="noopener">tx ↗</a>` : '';
			return `<div class="oc-atx-row">
				<span class="oc-atx-side ${buy ? 'buy' : 'sell'}">${buy ? '▲ BUY' : '▼ SELL'}</span>
				${nameEl}
				<span class="oc-atx-amt">${esc(amt)}${usd ? ` <span class="oc-atx-usd">${esc(usd)}</span>` : ''}</span>
				<span class="oc-atx-time">${esc(ago(t.tsMs))}</span>
				${tx}
			</div>`;
		}).join('');
		wrap.innerHTML = `<h2 class="cv-h2">Agent transactions <span class="oc-h2-note">${trades.length} on three.ws · ${buys} buys / ${trades.length - buys} sells</span></h2>
			<div class="oc-atx-list">${rows}</div>
			${trades.length > 12 ? `<a class="dr-act oc-atx-more" href="/pulse?mint=${encodeURIComponent(mint)}">Every agent transaction in this coin →</a>` : ''}`;
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
		wrap.innerHTML = `<h2 class="cv-h2">Related <span class="oc-h2-note">${esc(category)} · Oracle score ≥ 60</span></h2>
			<div style="display:flex;flex-direction:column;gap:6px">
				${related.map((r) => {
					const imgEl = r.image_uri
						? `<img src="${esc(imgProxy(r.image_uri, r.mint))}" alt="" style="width:28px;height:28px;border-radius:7px;object-fit:cover;flex:none;border:1px solid var(--line)" loading="lazy">`
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
	function updateHero(c, outcome) {
		const dial = $('#ocDial');
		if (dial && c.score != null) {
			dial.className = `dial t-${c.tier || 'watch'}`;
			dial.innerHTML = `<b>${c.score}</b><div class="tierpill tp-${esc(c.tier || 'watch')}">${esc(c.tier || 'watch')} conviction</div>`;
		}
		const odds = $('#ocOdds');
		if (odds) { const h = oddsHtml(c); if (h) odds.innerHTML = h; }
		const since = $('#ocSince');
		if (since) { const h = sinceHtml(outcome); if (h) since.innerHTML = h; }
		const p = c.pillars || {};
		const set = (kind, val) => {
			const el = $(`#ocPillars .pil.${kind}`);
			if (!el || val == null) return;
			const b = el.querySelector('.lab b'); if (b) b.textContent = Math.round(val);
			const fill = el.querySelector('.fill'); if (fill) fill.style.width = `${Math.max(0, Math.min(100, val))}%`;
		};
		set('ped', p.pedigree); set('str', p.structure); set('nar', p.narrative); set('mom', p.momentum);
	}

	// The conviction-independent scaffold: identity is already in the SSR header,
	// so chart + market + launch intel + live trades render immediately for ANY
	// mint. The conviction section fills in (or shows an "observing" state) once
	// /api/oracle/coin resolves. Sections follow the markets-hub (/coin/:id)
	// stacked layout: full-width cv-sections with editorial headings.
	async function buildScaffold(mint) {
		const deep = $('#ocDeep');
		if (!deep) return;
		deep.innerHTML = `
			<div id="ocTake"></div>
			<section class="cv-section" aria-label="Price chart">
				<div id="ocChart" class="oc-chart"></div>
			</section>
			<section class="cv-section" aria-label="Market">
				<h2 class="cv-h2">Market <span class="oc-h2-note">live</span></h2>
				<div id="ocMarket" class="mkt-loading" aria-busy="true">
					<div class="mkt-skel"><span></span><span></span><span></span><span></span><span></span><span></span></div>
				</div>
			</section>
			<section class="cv-section" id="ocIntelSec" aria-label="Launch intelligence" hidden>
				<h2 class="cv-h2">Launch intelligence <span class="oc-h2-note">Coin Radar · first ~90s of trading</span></h2>
				<div id="ocIntel"></div>
			</section>
			<section class="cv-section" aria-label="Conviction">
				<h2 class="cv-h2">Conviction <span class="oc-h2-note">who's buying · how · what · move</span></h2>
				<div id="ocHistory"></div>
				<div id="ocConviction" class="oc-two">
					<div class="oc-spinner" aria-label="Reading conviction"></div>
				</div>
			</section>
			<section class="cv-section oc-agent-tx" id="ocAgentTx" aria-label="Agent transactions"></section>
			<section class="cv-section" aria-label="Live trades">
				<h2 class="cv-h2">Live trades <span class="oc-h2-note">PumpPortal stream</span></h2>
				<div id="ocTape" class="trade-tape"></div>
			</section>
			<div id="ocRelated" class="cv-section"></div>`;
		// Load this coin's agent transactions before the chart mounts so the annotated
		// "Agent trades" view can lead by default and the list renders together. The
		// fetch is fast and never throws; on failure both simply stay empty.
		await fetchAgentTrades(mint);
		renderAgentTx(mint);
		const chartEl = $('#ocChart');
		if (chartEl) mountChart(chartEl, mint);
		loadMarket(mint);
		loadRadarIntel(mint);
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
		updateHero(c, data.outcome);
		const reasons = (data.reasons || []).map((r) => `<div class="reason"><span class="rdot ${esc(r.pillar)}"></span><span>${esc(r.text)}</span></div>`).join('') || '<div class="state" style="padding:20px 0">No breakdown available.</div>';
		const narr = data.narrative;
		const whos = (data.whos_in || []).map(whoRow).join('') || '<div class="state" style="padding:20px 0">No wallet footprint recorded yet.</div>';
		const out = data.outcome;
		const comp = data.components || {};
		col.innerHTML = `
			<div class="oc-col">
				<div class="dr-sec">Why this score</div>${reasons}
				${narr ? `<div class="dr-sec">Narrative</div><div style="font-size:13.5px;color:var(--ink)">${esc(narr.narrative || '')}</div>
					<div class="coin-meta" style="margin-top:8px"><span class="chip cat">${esc(narr.category)}</span><span class="chip">virality <b>${narr.virality ?? '—'}</b></span><span class="chip">${esc(narr.source || '')}</span></div>` : ''}
				<div id="ocPulse"></div>
			</div>
			<div class="oc-col">
				${structurePanel(comp.structure)}
				${out ? `<div class="dr-sec">Outcome</div><div class="coin-meta">
					<span class="chip ${out.graduated ? 'sm' : out.rugged ? 'flag' : ''}">${out.graduated ? 'graduated ✓' : out.rugged ? 'rugged ✕' : 'live'}</span>
					${out.ath_multiple ? `<span class="chip">ATH <b>${Number(out.ath_multiple).toFixed(1)}×</b></span>` : ''}</div>` : ''}
				<div class="dr-sec">Who's in <span style="color:var(--faint)">(${(data.whos_in || []).length})</span></div>${whos}
				<div id="ocProof"></div>
			</div>`;
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
		col.innerHTML = `<div class="state" style="padding:28px 20px;grid-column:1/-1">
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
