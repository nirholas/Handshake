/**
 * Live token card (homepage) — real pump.fun token + live buy/sell flow.
 *
 * Picks an actively-trading bonding-curve coin from pump.fun's trending feed,
 * renders it in the token card, then streams its real trades over SSE
 * (/api/pump/trades-stream). Buys render green, sells red. No sample data:
 * every row is a real on-chain trade. Loading, empty, and error states are all
 * designed.
 *
 * Graduated coins trade on Raydium, not the bonding curve, so PumpPortal emits
 * no trade events for them — we filter them out and pick a live curve coin.
 */

const TRENDING_URL =
	'/api/pump/trending?sort=last_trade_timestamp&order=DESC&limit=40';
const TRENDING_FALLBACK_URL = '/api/pump/trending?limit=40';
const STREAM_URL = (mint) =>
	`/api/pump/trades-stream?mint=${encodeURIComponent(mint)}`;
const MAX_ROWS = 6;
const RECONNECT_DELAY_MS = 2500;

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
	return `$${v.toFixed(0)}`;
}

function relTime(tsMs) {
	const secs = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
	if (secs < 5) return 'just now';
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.round(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	return `${Math.round(mins / 60)}h ago`;
}

class HomeLiveToken {
	constructor(root) {
		this.root = root;
		this.el = {
			label: root.querySelector('#hlt-label'),
			avatar: root.querySelector('#hlt-avatar'),
			name: root.querySelector('#hlt-name'),
			ticker: root.querySelector('#hlt-ticker'),
			price: root.querySelector('#hlt-price'),
			rows: root.querySelector('#hlt-rows'),
			link: root.querySelector('#hlt-pump-link'),
		};
		this.coin = null;
		this.es = null;
		this.trades = []; // { isBuy, sol, usd, trader, ts, sig }
		this.firstMc = null;
		this.lastMc = null;
		this.reconnectTimer = null;
		this.tickTimer = null;
		this.visible = false;
		this.destroyed = false;
		this.started = false;
		this.idleTimer = null;
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
			this._connect();
			this.tickTimer = setInterval(() => this._refreshTimes(), 4000);
		} catch {
			if (!this.destroyed) this._renderError('Could not reach the live feed.');
		}
	}

	async _pickCoin() {
		const pick = (arr) => {
			const list = Array.isArray(arr) ? arr : arr?.coins || [];
			const live = list.filter(
				(c) => c && c.mint && c.symbol && !c.complete && !c.raydium_pool,
			);
			live.sort(
				(a, b) =>
					(b.last_trade_timestamp || 0) - (a.last_trade_timestamp || 0),
			);
			return live[0] || list.find((c) => c && c.mint && c.symbol) || null;
		};
		const r1 = await fetch(TRENDING_URL, { headers: { accept: 'application/json' } });
		if (r1.ok) {
			const got = pick(await r1.json());
			if (got && !got.complete) return got;
			// Older proxy ignores the sort param and returns graduated whales.
			// Retry the plain list and keep whichever has a live bonding curve.
			const r2 = await fetch(TRENDING_FALLBACK_URL, {
				headers: { accept: 'application/json' },
			});
			if (r2.ok) {
				const alt = pick(await r2.json());
				if (alt) return alt;
			}
			return got;
		}
		return null;
	}

	// ── Connection ────────────────────────────────────────────────────────────

	_connect() {
		if (this.destroyed || !this.coin || !this.visible) return;
		this._teardownStream();
		const es = new EventSource(STREAM_URL(this.coin.mint));
		this.es = es;
		es.addEventListener('trade', (e) => {
			try {
				this._onTrade(JSON.parse(e.data));
			} catch {
				/* malformed frame — skip */
			}
		});
		es.addEventListener('close', () => this._scheduleReconnect());
		es.onerror = () => {
			// EventSource auto-retries, but the server caps stream duration; force a
			// clean reconnect so we don't sit on a dead socket.
			this._scheduleReconnect();
		};
	}

	_scheduleReconnect() {
		this._teardownStream();
		if (this.destroyed || !this.visible) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
	}

	_teardownStream() {
		if (this.es) {
			try {
				this.es.close();
			} catch {
				/* already closed */
			}
			this.es = null;
		}
		clearTimeout(this.reconnectTimer);
	}

	_onTrade(d) {
		if (this.destroyed) return;
		const sol =
			typeof d.sol_amount === 'number'
				? d.sol_amount
				: typeof d.solAmount === 'number'
					? d.solAmount
					: 0;
		if (sol <= 0) return;
		const isBuy = d.is_buy === true || d.txType === 'buy' || d.tx_type === 'buy';
		const mc = typeof d.market_cap_usd === 'number' ? d.market_cap_usd : null;
		if (mc) {
			if (this.firstMc == null) this.firstMc = mc;
			this.lastMc = mc;
		}
		this.trades.unshift({
			isBuy,
			sol,
			usd: typeof d.sol_value_usd === 'number' ? d.sol_value_usd : null,
			trader: d.trader || d.traderPublicKey || '',
			ts: Date.now(),
			sig: d.signature || d.tx_signature || '',
		});
		if (this.trades.length > MAX_ROWS) this.trades.length = MAX_ROWS;
		clearTimeout(this.idleTimer);
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
				this.el.avatar.innerHTML = '';
				this.el.avatar.style.background = '#111';
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
		if (this.firstMc != null && this.lastMc != null && this.firstMc > 0) {
			const pct = ((this.lastMc - this.firstMc) / this.firstMc) * 100;
			const up = pct >= 0;
			p.textContent = `${up ? '+' : ''}${pct.toFixed(1)}%`;
			p.className = `token-price ${up ? 'up' : 'down'}`;
			p.title = 'Change since this card started streaming';
		} else {
			const mc = usdFmt(this.coin?.usd_market_cap);
			p.textContent = mc ? `${mc} MC` : 'Live';
			p.className = 'token-price';
		}
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
			else if (!this.es) this._connect();
		} else {
			this._teardownStream();
		}
	}

	destroy() {
		this.destroyed = true;
		this._teardownStream();
		clearInterval(this.tickTimer);
		clearTimeout(this.idleTimer);
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
