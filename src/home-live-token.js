/**
 * Live token card (homepage) — real pump.fun token + live buy/sell flow.
 *
 * Features a real trending pump.fun coin in the token card, then polls its
 * recent on-chain trades (/api/pump/coin-trades, proxied from pump.fun's swap
 * API) and renders them as a live feed: buys green, sells red. No sample data —
 * every row is a real trade. Loading, empty, and error states are all designed.
 *
 * Polling (not SSE) because pump.fun's per-mint trade websocket no longer
 * delivers reliably; the REST trades endpoint covers both bonding-curve and
 * migrated (AMM) trades and is rock-solid.
 */

const TRENDING_URL = '/api/pump/trending?limit=24';
const TRADES_URL = (mint, limit = 30) =>
	`/api/pump/coin-trades?mint=${encodeURIComponent(mint)}&limit=${limit}`;
const MAX_ROWS = 6;
const POLL_MS = 4000;

function esc(s) {
	return String(s ?? '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
	);
}

function shortAddr(a) {
	const s = String(a || '');
	return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s || 'unknown';
}

function cleanText(s, max) {
	const t = String(s ?? '').trim().replace(/\s+/g, ' ');
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function solFmt(n) {
	const v = Number(n);
	if (!isFinite(v) || v === 0) return '0 SOL';
	if (v < 0.01) return `${v.toFixed(4)} SOL`;
	if (v < 1) return `${v.toFixed(3)} SOL`;
	return `${v.toFixed(2)} SOL`;
}

function usdFmt(n) {
	const v = Number(n);
	if (!isFinite(v) || v <= 0) return null;
	if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
	if (v >= 1) return `$${v.toFixed(0)}`;
	return `$${v.toFixed(2)}`;
}

function relTime(tsMs) {
	const secs = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
	if (secs < 5) return 'just now';
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.round(hrs / 24)}d ago`;
}

class HomeLiveToken {
	constructor(root) {
		this.root = root;
		// The label sits just outside the card container; resolve by id so it
		// updates too. The rest live inside the card.
		const q = (id) => root.querySelector(`#${id}`) || document.getElementById(id);
		this.el = {
			label: q('hlt-label'),
			avatar: q('hlt-avatar'),
			name: q('hlt-name'),
			ticker: q('hlt-ticker'),
			price: q('hlt-price'),
			rows: q('hlt-rows'),
			link: q('hlt-pump-link'),
		};
		this.coin = null;
		this.trades = []; // { isBuy, sol, usd, price, trader, ts, tx }
		this.seen = new Set();
		this.pollTimer = null;
		this.tickTimer = null;
		this.failCount = 0;
		this.visible = false;
		this.destroyed = false;
		this.started = false;
	}

	async start() {
		if (this.started || this.destroyed) return;
		this.started = true;
		this._renderSkeleton();
		try {
			const coin = await this._pickCoin();
			if (this.destroyed) return;
			if (!coin) {
				this._renderError('Live feed unavailable right now.');
				return;
			}
			this.coin = coin;
			this._renderHeader(coin);
			this._armIdleState();
			this._poll();
			this.tickTimer = setInterval(() => this._refreshTimes(), 4000);
		} catch {
			if (!this.destroyed) this._renderError('Could not reach the live feed.');
		}
	}

	async _pickCoin() {
		let r;
		try {
			r = await fetch(TRENDING_URL, { headers: { accept: 'application/json' } });
		} catch {
			return null;
		}
		if (!r.ok) return null;
		const data = await r.json();
		const list = Array.isArray(data) ? data : data?.coins || [];
		// Prefer a coin with an image and a real market cap; fall back to any with
		// a mint + symbol so the card is never empty.
		const usable = list.filter((c) => c && c.mint && c.symbol);
		const withImg = usable.filter((c) => c.image_uri);
		return withImg[0] || usable[0] || null;
	}

	// ── Polling ─────────────────────────────────────────────────────────────────

	_poll() {
		if (this.destroyed || !this.coin) return;
		clearTimeout(this.pollTimer);
		this._fetchTrades().finally(() => {
			if (this.destroyed || !this.visible) return;
			this.pollTimer = setTimeout(() => this._poll(), POLL_MS);
		});
	}

	async _fetchTrades() {
		let resp;
		try {
			resp = await fetch(TRADES_URL(this.coin.mint), { headers: { accept: 'application/json' } });
		} catch {
			this._onPollFail();
			return;
		}
		if (!resp.ok) {
			this._onPollFail();
			return;
		}
		let data;
		try {
			data = await resp.json();
		} catch {
			this._onPollFail();
			return;
		}
		const incoming = Array.isArray(data?.trades) ? data.trades : [];
		this.failCount = 0;
		this._ingest(incoming);
	}

	_onPollFail() {
		this.failCount += 1;
		// Only surface an error once we've truly failed repeatedly and have nothing
		// to show — a single blip shouldn't wipe a populated feed.
		if (this.failCount >= 3 && !this.trades.length) {
			this._renderError('Live trades are momentarily unavailable.');
		}
	}

	_ingest(incoming) {
		// Upstream returns newest-first. Add any unseen trades, keep newest MAX_ROWS.
		const fresh = [];
		for (const t of incoming) {
			if (!t.tx || this.seen.has(t.tx)) continue;
			this.seen.add(t.tx);
			fresh.push({
				isBuy: t.is_buy === true,
				sol: Number(t.sol_amount) || 0,
				usd: t.usd_amount != null ? Number(t.usd_amount) : null,
				price: t.price_usd != null ? Number(t.price_usd) : null,
				trader: t.user || '',
				ts: t.timestamp ? Date.parse(t.timestamp) : Date.now(),
				tx: t.tx,
			});
		}
		if (!fresh.length && this.trades.length) return;
		// Merge, sort newest-first, cap.
		this.trades = [...fresh, ...this.trades]
			.sort((a, b) => b.ts - a.ts)
			.slice(0, MAX_ROWS);
		// Keep the seen-set from growing unbounded.
		if (this.seen.size > 400) this.seen = new Set(this.trades.map((t) => t.tx));
		this._renderRows();
		this._renderPrice();
	}

	// ── Rendering ───────────────────────────────────────────────────────────────

	_renderSkeleton() {
		if (!this.el.rows) return;
		this.el.rows.innerHTML = Array.from({ length: 4 })
			.map(
				() =>
					`<div class="earn-row hlt-skel">
						<div class="earn-row-left">
							<div class="hlt-skel-bar" style="width:120px"></div>
							<div class="hlt-skel-bar" style="width:54px;height:9px"></div>
						</div>
						<div class="hlt-skel-bar" style="width:64px"></div>
					</div>`,
			)
			.join('');
	}

	_renderHeader(coin) {
		const name = cleanText(coin.name || coin.symbol, 28);
		const sym = cleanText(coin.symbol, 10).replace(/^\$/, '');
		if (this.el.label) this.el.label.textContent = `Live token · $${sym} / SOL`;
		if (this.el.name) this.el.name.textContent = name;
		const mc = usdFmt(coin.usd_market_cap);
		if (this.el.ticker)
			this.el.ticker.textContent = mc
				? `$${sym} · ${mc} MC · Pump.fun`
				: `$${sym} · Pump.fun`;
		if (this.el.avatar) {
			const img = coin.image_uri;
			if (img) {
				this.el.avatar.textContent = '';
				const im = new Image();
				im.src = img;
				im.alt = name;
				im.loading = 'lazy';
				im.decoding = 'async';
				im.referrerPolicy = 'no-referrer';
				im.onerror = () => {
					this.el.avatar.textContent = sym.slice(0, 4);
				};
				this.el.avatar.appendChild(im);
			} else {
				this.el.avatar.textContent = sym.slice(0, 4);
			}
		}
		if (this.el.link) {
			this.el.link.href = `https://pump.fun/coin/${coin.mint}`;
			this.el.link.title = `View $${sym} on pump.fun`;
		}
		this._renderPrice();
	}

	_renderPrice() {
		const p = this.el.price;
		if (!p) return;
		// Recent price change from the trades we're showing (newest vs oldest in
		// the live window). Real, derived from on-chain prices.
		const priced = this.trades.filter((t) => t.price > 0);
		if (priced.length >= 2) {
			const newest = priced[0].price;
			const oldest = priced[priced.length - 1].price;
			if (oldest > 0) {
				const pct = ((newest - oldest) / oldest) * 100;
				const up = pct >= 0;
				p.textContent = `${up ? '+' : ''}${pct.toFixed(1)}%`;
				p.className = `token-price ${up ? 'up' : 'down'}`;
				p.title = 'Price change across the latest trades';
				return;
			}
		}
		const mc = usdFmt(this.coin?.usd_market_cap);
		p.textContent = mc ? `${mc} MC` : 'Live';
		p.className = 'token-price';
	}

	_renderRows() {
		if (!this.el.rows) return;
		if (!this.trades.length) {
			this._armIdleState();
			return;
		}
		this.el.rows.innerHTML = this.trades
			.map((t) => {
				const sign = t.isBuy ? '+' : '−';
				const amt = `${sign}${solFmt(t.sol)}`;
				const usd = usdFmt(t.usd);
				return `<div class="earn-row hlt-row">
					<div class="earn-row-left">
						<div class="earn-row-name">
							<span class="hlt-side ${t.isBuy ? 'buy' : 'sell'}">${t.isBuy ? 'Buy' : 'Sell'}</span>
							· ${esc(shortAddr(t.trader))}
						</div>
						<div class="earn-row-time">${esc(relTime(t.ts))}</div>
					</div>
					<div class="earn-row-amount ${t.isBuy ? 'buy' : 'sell'}">${esc(amt)}${
						usd ? `<span class="hlt-usd">${esc(usd)}</span>` : ''
					}</div>
				</div>`;
			})
			.join('');
	}

	_armIdleState() {
		if (!this.el.rows || this.trades.length) return;
		const sym = cleanText(this.coin?.symbol || '', 10).replace(/^\$/, '');
		this.el.rows.innerHTML = `<div class="earn-row hlt-idle">
			<div class="earn-row-left">
				<div class="earn-row-name"><span class="hlt-live-dot"></span>Listening for live trades${
					sym ? ` on $${esc(sym)}` : ''
				}…</div>
				<div class="earn-row-time">streaming from pump.fun</div>
			</div>
		</div>`;
	}

	_renderError(msg) {
		if (this.el.rows)
			this.el.rows.innerHTML = `<div class="earn-row hlt-idle">
				<div class="earn-row-left">
					<div class="earn-row-name">${esc(msg)}</div>
					<div class="earn-row-time">Trending tokens are still one click away below.</div>
				</div>
			</div>`;
	}

	_refreshTimes() {
		if (!this.el.rows || !this.trades.length) return;
		this.el.rows.querySelectorAll('.hlt-row .earn-row-time').forEach((el, i) => {
			if (this.trades[i]) el.textContent = relTime(this.trades[i].ts);
		});
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────────

	setVisible(v) {
		if (v === this.visible) return;
		this.visible = v;
		if (v) {
			if (!this.started) this.start();
			else this._poll();
		} else {
			clearTimeout(this.pollTimer);
		}
	}

	destroy() {
		this.destroyed = true;
		clearTimeout(this.pollTimer);
		clearInterval(this.tickTimer);
	}
}

export function initHomeLiveToken(root) {
	if (!root) return null;
	const card = new HomeLiveToken(root);
	const io = new IntersectionObserver(
		(entries) => card.setVisible(entries[0]?.isIntersecting === true),
		{ rootMargin: '120px' },
	);
	io.observe(root);
	window.addEventListener('pagehide', () => card.destroy(), { once: true });
	return card;
}
