/**
 * Mission Control — focus / detail pane.
 *
 * The center cockpit. When a coin is selected anywhere (feed row, position, or
 * keyboard), this pane fuses everything three.ws knows about it:
 *   • identity + market stats (GET /api/pump/coin)
 *   • a real candlestick chart (price-history OHLCV + the live trade firehose,
 *     folded into the forming candle — never fabricated; see ./chart.js)
 *   • a live trades tape (SSE + dex-trades polling; newest buys/sells in a
 *     scrolling table like GMGN's Trades tab — see ./trades-tape.js)
 *   • a token security grid: top-10 concentration, sniper %, bundler %, risk
 *     flags, safety checks (NoMint, NoFreeze, LP Burnt) — all real on-chain
 *   • the intel breakdown (organic vs bundle, risk flags, verdict)
 *   • the firewall safety verdict (reused createSafetyPanel → /api/pump/safety)
 *   • smart-money flow (GET /api/intel/smart-money)
 *   • a buy/sell desk with size presets, a live quote, and real guarded execution
 *
 * The shell mounts ONCE per selection; enrichment patches update individual
 * sections in place so the safety panel and live quote never thrash. Buy is
 * disabled on a firewall `block`; the server enforces it regardless.
 */

import { createSafetyPanel } from '../shared/safety-panel.js';
import { proxiedImageURL } from '../ipfs.js';
import { mountPriceChart } from './chart.js';
import { mountTradesTape } from './trades-tape.js';
import { buy, sell, quote } from './trade.js';
import {
	escapeHtml,
	shortAddress,
	copyToClipboard,
	formatCompactUsd,
	formatCompact,
	ageFrom,
	explorerAddressUrl,
	formatSol,
} from './format.js';

const TABS = ['trades', 'security', 'smart'];
const TAB_LABELS = { trades: 'Trades', security: 'Security', smart: 'Smart Money' };

export function createFocusPane({ store, bus, enrich, mount }) {
	mount.classList.add('mc-pane', 'mc-pane--focus');
	mount.setAttribute('role', 'region');
	mount.setAttribute('aria-label', 'Coin detail');
	mount.innerHTML = `
		<div class="mc-pane-head">
			<span class="mc-pane-title">Focus</span>
			<span class="mc-pane-head-spacer"></span>
			<span class="mc-pane-count" data-host="net"></span>
		</div>
		<div class="mc-pane-body" data-host="body"></div>
	`;
	const body = mount.querySelector('[data-host="body"]');
	const netEl = mount.querySelector('[data-host="net"]');
	netEl.textContent = store.getNetwork();

	let currentMint = null;
	let seq = 0;
	let safety = null;
	let chart = null;
	let tape = null;
	let buyDisabled = false;
	let coinDetail = null;
	let quoteTimer = null;
	let activeTab = 'trades';

	const $ = (sel) => body.querySelector(sel);

	function showIdle() {
		currentMint = null;
		teardownSafety();
		teardownChart();
		teardownTape();
		body.innerHTML = `
			<div class="mc-empty">
				<div class="mc-empty-ico" aria-hidden="true">⌖</div>
				<h3>Select a coin</h3>
				<p>Click a launch in the feed, or use <kbd style="font-family:var(--font-mono)">j</kbd> / <kbd style="font-family:var(--font-mono)">k</kbd> to move and watch it light up here — intel, safety, smart-money, and one-keystroke trading.</p>
			</div>`;
	}

	function teardownSafety() {
		if (safety) { safety.destroy(); safety = null; }
	}
	function teardownChart() {
		if (chart) { chart.destroy(); chart = null; }
	}
	function teardownTape() {
		if (tape) { tape.destroy(); tape = null; }
	}

	function load(mint) {
		if (!mint) { showIdle(); return; }
		const fresh = mint !== currentMint;
		currentMint = mint;
		const mySeq = ++seq;
		const row = store.getRow(mint) || { mint };
		coinDetail = null;
		if (fresh) renderShell(row);
		else { updateHead(row); updateSecurity(row); updateSmart(row); }

		enrich.ensureIntel(mint);
		enrich.ensureSmart(mint);
		enrich.ensureSafety(mint, store.getActiveSize());

		fetchCoin(mint).then((coin) => {
			if (mySeq !== seq) return;
			coinDetail = coin;
			updateHead(store.getRow(mint) || row);
		});
	}

	// A seconds-old launch can be missing from pump.fun for a moment, in which
	// case the server answers 5xx with a Retry-After. The head already renders
	// from the feed row, so the detail is retried once when upstream says to,
	// and only if this coin is still the one in focus.
	let coinRetryTimer = null;
	async function fetchCoin(mint, { retry = true } = {}) {
		clearTimeout(coinRetryTimer);
		try {
			const r = await fetch(`/api/pump/coin?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
			if (r.ok) return await r.json();
			if (retry && r.status >= 500) {
				const after = Math.min(60, Math.max(5, Number(r.headers.get('retry-after')) || 15)) * 1000;
				const mySeq = seq;
				coinRetryTimer = setTimeout(() => {
					if (mySeq !== seq || currentMint !== mint) return;
					fetchCoin(mint, { retry: false }).then((coin) => {
						if (mySeq !== seq || !coin) return;
						coinDetail = coin;
						updateHead(store.getRow(mint) || { mint });
					});
				}, after);
			}
			return null;
		} catch { return null; }
	}

	// ── shell (built once per selection) ────────────────────────────────────────
	function renderShell(row) {
		const mint = row.mint;
		body.innerHTML = `
			<div class="mc-focus">
				<div class="mc-focus-head" data-host="head"></div>
				<div class="mc-stats" data-host="stats"></div>
				<div class="mc-chart-wrap" data-host="chart"></div>
				<div class="mc-focus-tabs" role="tablist" data-host="tabs">
					${TABS.map((t) => `<button class="mc-focus-tab" role="tab" data-tab="${t}" aria-selected="${t === activeTab}">${TAB_LABELS[t]}</button>`).join('')}
				</div>
				<div data-host="panel-trades" ${activeTab !== 'trades' ? 'hidden' : ''}></div>
				<div data-host="panel-security" ${activeTab !== 'security' ? 'hidden' : ''}></div>
				<div data-host="panel-smart" ${activeTab !== 'smart' ? 'hidden' : ''}></div>
				<div class="mc-trade" data-host="trade"></div>
			</div>`;

		// Wire tab clicks
		$('[data-host="tabs"]').addEventListener('click', (e) => {
			const btn = e.target.closest('[data-tab]');
			if (!btn) return;
			switchTab(btn.dataset.tab);
		});

		updateHead(row);
		updateSecurity(row);
		updateSmart(row);
		mountChart(mint);
		mountSafety(mint);
		mountTape(mint);
		mountTrade();
	}

	function switchTab(tab) {
		if (!TABS.includes(tab)) return;
		activeTab = tab;
		for (const btn of body.querySelectorAll('[data-tab]')) {
			btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
		}
		for (const t of TABS) {
			const panel = $(`[data-host="panel-${t}"]`);
			if (panel) panel.hidden = t !== tab;
		}
	}

	function mountChart(mint) {
		teardownChart();
		const host = $('[data-host="chart"]');
		if (!host) return;
		chart = mountPriceChart({ host, mint });
	}

	function mountTape(mint) {
		teardownTape();
		const host = $('[data-host="panel-trades"]');
		if (!host) return;
		tape = mountTradesTape({ host, mint, network: store.getNetwork() });
	}

	function updateHead(row) {
		const head = $('[data-host="head"]');
		const stats = $('[data-host="stats"]');
		if (!head || !stats) return;
		const coin = coinDetail || {};
		const mint = row.mint;
		const sym = escapeHtml(row.symbol || coin.symbol || mint.slice(0, 4));
		const name = escapeHtml(row.name || coin.name || '');
		// Token art lives on public IPFS gateways that refuse browser image
		// requests (ipfs.io answers 403 with a same-origin resource policy), so
		// it is served through the same-origin /api/img proxy, which always
		// returns a valid image and never logs a blocked request.
		const img = proxiedImageURL(row.image_uri || coin.image_uri || coin.image || '', mint);
		const mcUsd = coin.usd_market_cap ?? coin.market_cap ?? row.market_cap_usd ?? null;
		const created = coin.created_timestamp ? Math.floor(coin.created_timestamp / 1000) : row.created_at;
		const intel = row.intel && !row.intel._none ? row.intel : null;
		const smart = row.smart;
		const socials = [
			(row.twitter || coin.twitter) && { href: row.twitter || coin.twitter, label: 'X' },
			(row.telegram || coin.telegram) && { href: row.telegram || coin.telegram, label: 'TG' },
			(row.website || coin.website) && { href: row.website || coin.website, label: 'Web' },
		].filter(Boolean);

		head.innerHTML = `
			${img ? `<img class="mc-focus-img" src="${escapeHtml(img)}" alt="" loading="lazy" decoding="async" />` : '<div class="mc-focus-img" aria-hidden="true"></div>'}
			<div class="mc-focus-id">
				<h2>${sym} <span class="mc-focus-name">${name}</span></h2>
				<div class="mc-focus-addr">
					<span class="mc-mono" title="${escapeHtml(mint)}">${escapeHtml(shortAddress(mint, 6, 6))}</span>
					<button class="mc-iconbtn" data-act="copy" title="Copy mint" style="min-width:24px;height:22px;padding:0 6px;font-size:.7rem">⧉</button>
					<a href="${escapeHtml(explorerAddressUrl(mint, store.getNetwork()))}" target="_blank" rel="noopener">Explorer ↗</a>
				</div>
				${socials.length ? `<div class="mc-focus-socials">${socials.map((s) => `<a href="${escapeHtml(s.href)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>`).join('')}</div>` : ''}
			</div>`;
		head.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
			const ok = await copyToClipboard(mint);
			const b = head.querySelector('[data-act="copy"]');
			if (b) { b.textContent = ok ? '✓' : '⧉'; setTimeout(() => { if (b) b.textContent = '⧉'; }, 1100); }
		});

		stats.innerHTML = `
			<div class="mc-stat"><span>Market cap</span><b>${formatCompactUsd(mcUsd)}</b></div>
			<div class="mc-stat"><span>Age</span><b>${created ? ageFrom(created) : '—'}</b></div>
			<div class="mc-stat"><span>Intel</span><b>${intel?.quality_score != null ? Math.round(intel.quality_score) : '—'}</b></div>
			<div class="mc-stat"><span>Smart $</span><b>${smart?.computed ? Math.round(smart.smart_money_score || 0) : '—'}</b></div>
			<div class="mc-stat"><span>Buyers</span><b>${intel?.unique_buyers != null ? formatCompact(intel.unique_buyers) : '—'}</b></div>
			<div class="mc-stat"><span>B/S ratio</span><b>${intel?.buy_sell_ratio != null ? Number(intel.buy_sell_ratio).toFixed(2) : '—'}</b></div>`;
	}

	// ── Security tab: GMGN-style stats grid + intel flags + safety checks ──────
	function updateSecurity(row) {
		const host = $('[data-host="panel-security"]');
		if (!host) return;
		const intel = row.intel && !row.intel._none ? row.intel : (row.intel === undefined ? undefined : null);
		const safetyData = row.safety;

		// Loading skeleton while intel is in-flight
		if (intel === undefined) {
			host.innerHTML = `
				<div class="mc-sec-grid">
					${Array.from({ length: 8 }, () => '<div class="mc-sec-cell"><span class="mc-chip-skel" style="width:60%"></span><div class="mc-chip-skel" style="width:50%;margin-top:4px"></div></div>').join('')}
				</div>`;
			return;
		}

		// Stats grid cells
		const pct = (v) => v != null ? `${Math.round(Number(v) * 100)}%` : '—';
		const score = (v) => v != null ? Math.round(Number(v)) : '—';

		const top10 = intel?.concentration_top10;
		const snipe = intel?.snipe_ratio;
		const bundle = intel?.bundle_score;
		const organic = intel?.organic_score;
		const buyers = intel?.unique_buyers;
		const buySellRatio = intel?.buy_sell_ratio;

		// Color class helpers
		const top10Class = top10 == null ? '' : top10 > 0.6 ? 'danger' : top10 > 0.4 ? 'warn' : 'ok';
		const snipeClass = snipe == null ? '' : snipe > 0.3 ? 'danger' : snipe > 0.15 ? 'warn' : 'ok';
		const bundleClass = bundle == null ? '' : bundle > 60 ? 'danger' : bundle > 30 ? 'warn' : 'ok';
		const organicClass = organic == null ? '' : organic > 65 ? 'ok' : organic > 40 ? 'warn' : 'danger';

		// Safety check pills from the safety verdict
		const CHECK_NAMES = {
			mint_authority: 'Mint & Freeze',
			venue: 'Tradable',
			round_trip: 'Buy→Sell',
			concentration: 'Concentration',
			price_impact: 'Price Impact',
		};
		const rawChecks = Array.isArray(safetyData?.checks) ? safetyData.checks.filter((c) => c && c.name !== 'input') : [];
		const checkPills = rawChecks.slice(0, 5).map((c) => {
			const st = c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'fail' : c.status === 'warn' ? 'warn' : 'dim';
			const icon = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '~';
			const label = CHECK_NAMES[c.name] || c.name;
			return `<span class="mc-sec-check mc-sec-check--${st}">${icon} ${escapeHtml(label)}</span>`;
		});

		// Risk flags
		const flags = Array.isArray(intel?.risk_flags) ? intel.risk_flags : [];
		const verdict = intel?.verdict;
		const tone = verdict?.tone === 'success' ? 'allow' : verdict?.tone === 'danger' ? 'block' : verdict?.tone === 'warn' ? 'warn' : 'unknown';

		host.innerHTML = `
			<div class="mc-sec-grid">
				<div class="mc-sec-cell"><span>Top 10</span><b class="${top10Class}">${pct(top10)}</b></div>
				<div class="mc-sec-cell"><span>Snipers</span><b class="${snipeClass}">${pct(snipe)}</b></div>
				<div class="mc-sec-cell"><span>Bundle</span><b class="${bundleClass}">${score(bundle)}</b></div>
				<div class="mc-sec-cell"><span>Organic</span><b class="${organicClass}">${score(organic)}</b></div>
				<div class="mc-sec-cell"><span>Buyers</span><b>${buyers != null ? formatCompact(buyers) : '—'}</b></div>
				<div class="mc-sec-cell"><span>B/S Ratio</span><b>${buySellRatio != null ? Number(buySellRatio).toFixed(2) : '—'}</b></div>
				<div class="mc-sec-cell" style="grid-column:span 2"><span>Verdict</span><b class="${tone === 'allow' ? 'ok' : tone === 'block' ? 'danger' : tone === 'warn' ? 'warn' : ''}">${verdict?.label || (intel ? 'Unscored' : '—')}</b></div>
			</div>
			${checkPills.length ? `<div class="mc-sec-checks">${checkPills.join('')}</div>` : safetyData === undefined ? `<div class="mc-sec-checks"><span class="mc-sec-check mc-sec-check--dim">Safety checks loading…</span></div>` : ''}
			${flags.length ? `<ul class="mc-sec-flags">${flags.slice(0, 6).map((f) => `<li>⚠ ${escapeHtml(String(f).replace(/_/g, ' '))}</li>`).join('')}</ul>` : ''}
			${!intel ? `<p style="color:var(--ink-faint,#666);font-size:.75rem;margin:8px 0 0">Structural intel is still being gathered for this launch.</p>` : ''}`;
	}

	function updateSmart(row) {
		const host = $('[data-host="panel-smart"]');
		if (!host) return;
		const smart = row.smart;
		if (smart === undefined) { host.innerHTML = `<div class="mc-section-h">Smart money</div><div class="mc-chip-skel" style="width:100%"></div>`; return; }
		if (!smart || smart.computed === false) {
			host.innerHTML = `<div class="mc-section-h">Smart money</div><p style="color:var(--ink-faint,#666);font-size:.75rem;margin:0">Not enough on-chain history yet to score who's buying this coin.</p>`;
			return;
		}
		const score = Math.round(smart.smart_money_score || 0);
		const wallets = Array.isArray(smart.wallets) ? smart.wallets.slice(0, 5) : [];
		host.innerHTML = `
			<div class="mc-section-h">Smart money <span class="mc-num" style="margin-left:auto;color:var(--accent,#7dd3fc)">${score}/100${smart.count ? ` · ${smart.count} wallets` : ''}</span></div>
			<div class="mc-smart-bar"><i style="width:${Math.max(2, score)}%"></i></div>
			${smart.sybil_flag ? `<p style="color:var(--warn,#fbbf24);font-size:.72rem;margin:8px 0 0">⚠ One funder cluster dominates the buyers (${Math.round((smart.sybil_share || 0) * 100)}%) — possible sybil.</p>` : ''}
			${wallets.length ? `<ul class="mc-smart-wallets">${wallets.map((w) => `<li><span class="mc-mono">${escapeHtml(shortAddress(w.address))}</span> <b>${Math.round(w.realized_score || 0)}</b> score${w.win_rate != null ? ` · ${Math.round(w.win_rate * 100)}% win` : ''}${w.buy_sol ? ` · ${formatSol(w.buy_sol)}◎` : ''}</li>`).join('')}</ul>` : ''}`;
	}

	function mountSafety(mint) {
		teardownSafety();
		// Safety panel is used for buy-gate enforcement but we surface its checks
		// inside the Security tab via row.safety (populated by enrich.ensureSafety).
		// We still need the panel instance for the verdict → buyDisabled gate.
		safety = createSafetyPanel({
			onVerdict: (v) => { buyDisabled = v?.verdict === 'block'; updateTradeButtons(); },
		});
		// Mount it hidden — we only care about its verdict callback, not its UI.
		const hidden = document.createElement('div');
		hidden.style.display = 'none';
		hidden.appendChild(safety.el);
		mount.appendChild(hidden);
		safety.loadForMint({ mint, network: store.getNetwork(), amountSol: store.getActiveSize() });
	}

	function mountTrade() {
		const host = $('[data-host="trade"]');
		if (!host) return;
		if (!store.getAgent()) {
			// No wallet to trade from: say exactly what unlocks the desk instead of
			// rendering buy/sell buttons that can only refuse.
			const cta = store.isSignedIn()
				? { href: '/create-agent', label: 'Create an agent wallet', body: 'Trades are signed by an agent wallet you own. Create one and it appears in the top bar.' }
				: { href: '/login?next=%2Fterminal', label: 'Sign in to trade', body: 'Sign in to buy and sell from your agent wallet, firewall and MEV gated on every order.' };
			host.innerHTML = `
				<div class="mc-section-h">Trade</div>
				<div class="mc-trade-cta">
					<p>${cta.body}</p>
					<a class="mc-btn mc-btn--buy" href="${cta.href}">${cta.label}</a>
				</div>`;
			return;
		}
		const presets = store.getPresets();
		const active = store.getActiveSize();
		host.innerHTML = `
			<div class="mc-section-h">Trade · from ${escapeHtml(store.getAgent()?.name || 'agent')}</div>
			<div class="mc-sizes" role="group" aria-label="Buy size (SOL)">
				${presets.map((p, i) => `<button class="mc-size" data-size="${p}" aria-pressed="${p === active}">${p}<span class="mc-size-kbd">${i + 1}</span></button>`).join('')}
				<span style="color:var(--ink-faint,#666);font-size:.72rem">SOL</span>
			</div>
			<div class="mc-trade-actions">
				<button class="mc-btn mc-btn--buy" data-act="buy"><kbd>b</kbd> Buy</button>
				<button class="mc-btn mc-btn--sell" data-act="sell"><kbd>s</kbd> Sell all</button>
			</div>
			<div class="mc-trade-note is-dim" data-host="note" role="status" aria-live="polite">Pick a size — a live quote appears here.</div>`;
		host.querySelectorAll('[data-size]').forEach((b) => {
			b.addEventListener('click', () => store.setActiveSize(Number(b.dataset.size)));
		});
		host.querySelector('[data-act="buy"]').addEventListener('click', () => doBuy());
		host.querySelector('[data-act="sell"]').addEventListener('click', () => doSell());
		updateTradeButtons();
		refreshQuote();
	}

	function updateTradeButtons() {
		const buyBtn = $('[data-act="buy"]');
		if (!buyBtn) return;
		const noAgent = !store.getAgent();
		buyBtn.disabled = buyDisabled || noAgent;
		buyBtn.title = buyDisabled ? 'Firewall blocked — buying disabled' : noAgent ? 'Select an agent first' : '';
		body.querySelectorAll('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === store.getActiveSize())));
	}

	function refreshQuote() {
		const note = $('[data-host="note"]');
		if (!note || !currentMint) return;
		clearTimeout(quoteTimer);
		const size = store.getActiveSize();
		note.className = 'mc-trade-note is-dim';
		note.textContent = 'Pricing…';
		const mySeq = seq;
		const mint = currentMint;
		quoteTimer = setTimeout(async () => {
			try {
				const q = await quote({ store, side: 'buy', mint, solAmount: size });
				if (mySeq !== seq || !$('[data-host="note"]')) return;
				const n = $('[data-host="note"]');
				const out = q?.out;
				const impact = q?.price_impact_pct;
				const guard = q?.guard;
				if (guard) { n.className = 'mc-trade-note is-err'; n.textContent = `⚠ ${guard.message}`; return; }
				n.className = impact >= 8 ? 'mc-trade-note is-warn' : 'mc-trade-note is-dim';
				n.innerHTML = `${size} SOL → <b style="color:var(--ink-bright,#fff)">${formatCompact(out?.amount)}</b> tokens · impact ${impact != null ? Number(impact).toFixed(1) + '%' : '—'}${impact >= 8 ? ' ⚠' : ''}`;
			} catch (e) {
				if (mySeq !== seq || !$('[data-host="note"]')) return;
				const n = $('[data-host="note"]');
				n.className = 'mc-trade-note is-dim';
				n.textContent = e?.code === 'no_agent' ? 'Select a trading agent to quote.' : 'Quote unavailable right now.';
			}
		}, 350);
	}

	async function doBuy() {
		if (!currentMint) { return; }
		await buy({ store, bus, mint: currentMint, solAmount: store.getActiveSize() });
	}
	async function doSell() {
		if (!currentMint) { return; }
		await sell({ store, bus, mint: currentMint });
	}

	const unsubs = [
		bus.on('select', (mint) => load(mint)),
		bus.on('size', () => {
			updateTradeButtons(); refreshQuote();
			if (safety && currentMint) safety.loadForMint({ mint: currentMint, network: store.getNetwork(), amountSol: store.getActiveSize() });
		}),
		bus.on('presets', () => { if (currentMint) mountTrade(); }),
		bus.on('agent', () => { if (currentMint) mountTrade(); }),
		bus.on('network', () => { netEl.textContent = store.getNetwork(); if (currentMint) load(currentMint); }),
		bus.on('feed:update', (row) => {
			if (row.mint === currentMint) {
				updateHead(row);
				updateSecurity(row);
				updateSmart(row);
			}
		}),
		bus.on('action:buy', () => doBuy()),
		bus.on('action:sell', () => doSell()),
	];

	showIdle();

	return {
		destroy() {
			teardownSafety();
			teardownChart();
			teardownTape();
			clearTimeout(quoteTimer);
			clearTimeout(coinRetryTimer);
			unsubs.forEach((u) => u());
		},
	};
}
