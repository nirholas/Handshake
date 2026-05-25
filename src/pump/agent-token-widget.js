/**
 * AgentTokenWidget — the $AGENT card on the agent passport.
 *
 * Self-contained: pass a mount node + agentId, it figures out the rest. Reads:
 *   GET /api/pump/by-agent?agent_id=…   (mint + stats + burn history)
 *   GET /api/pump/balances?mint=…        (live vault balances, polled)
 *   GET /api/pump/quote?mint=…           (price + graduation status)
 *   GET /api/pump/payments-list?mint=…   (recent receipts feed)
 *
 * Emits on the protocol bus (when one is passed):
 *   `pump-balance` { paymentDelta, buybackDelta, withdrawDelta }
 *   `pump-graduated` { mint }
 *   `pump-payment` { payer, atomics, skill }
 *
 * Renders four states: not-launched, launching, live (curve), live (AMM).
 * Live state shows: ticker, price, buyback gauge, 3 vault balances, burns,
 * recent payment feed, owner withdraw button, governance explainer.
 */

import { mountBondingCurve } from '../components/bonding-curve.js';
// pump-modals was previously dynamic-imported here, but it's already
// statically imported on /agent (via mountPumpModals) so the dynamic split
// produced no actual code-splitting — just a vite/rollup warning about a
// module being both static and dynamic. A plain static import keeps the
// withdraw path in the same chunk as the widget that calls it.
import { resolveUsdcAta, signAndSendVTx } from './pump-modals.js';

const POLL_MS = 10_000;

function fmtUsdc(atomics) {
	const n = Number(BigInt(atomics || '0')) / 1_000_000;
	if (n === 0) return '$0.00';
	if (n < 0.01) return `<$0.01`;
	return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtSol(lamports) {
	if (!lamports) return '0 SOL';
	const n = Number(lamports) / 1_000_000_000;
	return `${n.toFixed(n < 1 ? 4 : 2)} SOL`;
}

function fmtBps(bps) {
	if (bps == null) return '—';
	return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

function shortAddr(s, n = 4) {
	if (!s) return '';
	return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function timeAgo(iso) {
	if (!iso) return '';
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
	return `${Math.floor(ms / 86_400_000)}d ago`;
}

const STYLES = `
.atok {
	max-width: 520px; margin: 1.5rem auto; padding: 1.25rem 1.4rem;
	border: 1px solid rgba(255,255,255,0.08); border-radius: 14px;
	background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0));
	color: #e5e5e5; font: 14px/1.5 Inter, sans-serif;
}
.atok-head {
	display: flex; align-items: baseline; justify-content: space-between;
	gap: 0.6rem; margin-bottom: 0.25rem;
}
.atok-symbol {
	font-size: 1.05rem; font-weight: 500; letter-spacing: 0.03em;
}
.atok-symbol .atok-sigil { color: rgba(255,255,255,0.45); margin-right: 0.18em; }
.atok-status {
	font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 999px;
	background: rgba(120,200,140,0.12); color: rgba(180,230,200,0.95);
	letter-spacing: 0.03em;
}
.atok-status.curve  { background: rgba(120,160,255,0.12); color: rgba(180,210,255,0.95); }
.atok-status.empty  { background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.45); }
.atok-status.error  { background: rgba(255,140,140,0.1); color: rgba(255,180,180,0.95); }
.atok-price-row {
	display: flex; align-items: baseline; gap: 0.6rem; margin-top: 0.1rem;
}
.atok-price {
	font-size: 1.4rem; font-weight: 300; color: #fff; font-variant-numeric: tabular-nums;
	transition: color 0.4s ease;
}
.atok-price.tick-up   { color: #a4f0bc; }
.atok-price.tick-down { color: #f6b3b3; }
.atok-price-label {
	font-size: 0.72rem; color: rgba(255,255,255,0.4); letter-spacing: 0.05em; text-transform: uppercase;
}

.atok-curve-wrap {
	margin: 0.9rem 0 0;
}
.atok-grad-label {
	font-size: 0.7rem; color: rgba(255,255,255,0.5); display: flex; justify-content: space-between;
}

.atok-buyback {
	margin-top: 1rem; padding: 0.7rem 0.85rem; border-radius: 10px;
	background: rgba(255,255,255,0.025);
	display: flex; align-items: center; gap: 0.7rem;
}
.atok-buyback-gauge {
	flex: 1; height: 6px; background: rgba(255,255,255,0.05); border-radius: 999px; overflow: hidden;
}
.atok-buyback-fill {
	height: 100%; background: linear-gradient(90deg, #f6b3b3, #ffd57a, #a4f0bc);
	transition: width 0.8s cubic-bezier(.2,.8,.2,1);
}
.atok-buyback-label {
	font-size: 0.78rem; white-space: nowrap; color: rgba(255,255,255,0.85);
	font-variant-numeric: tabular-nums;
}
.atok-buyback-explain {
	font-size: 0.7rem; color: rgba(255,255,255,0.45); margin-top: 0.35rem; line-height: 1.45;
}
.atok-buyback-explain b { color: rgba(255,255,255,0.85); font-weight: 500; }

.atok-vaults {
	display: grid; grid-template-columns: repeat(3, 1fr);
	gap: 0.5rem; margin-top: 0.9rem;
}
.atok-vault {
	padding: 0.55rem 0.7rem; border-radius: 8px; background: rgba(255,255,255,0.025);
}
.atok-vault-name {
	font-size: 0.65rem; color: rgba(255,255,255,0.45); letter-spacing: 0.06em; text-transform: uppercase;
}
.atok-vault-val {
	font-size: 0.95rem; margin-top: 0.15rem; font-variant-numeric: tabular-nums;
	transition: color 0.4s ease;
}
.atok-vault-val.tick-up { color: #a4f0bc; }
.atok-vault-payment   .atok-vault-name { color: rgba(180,210,255,0.6); }
.atok-vault-buyback   .atok-vault-name { color: rgba(255,200,140,0.6); }
.atok-vault-withdraw  .atok-vault-name { color: rgba(180,230,200,0.6); }

.atok-burned {
	margin-top: 0.7rem; padding: 0.55rem 0.7rem; border-radius: 8px;
	background: rgba(120,200,140,0.06); color: rgba(200,240,210,0.9);
	font-size: 0.78rem;
}
.atok-burned b { color: #d8f5e2; font-weight: 500; }

.atok-feed {
	margin-top: 1rem; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 0.7rem;
}
.atok-feed-title {
	font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase;
	color: rgba(255,255,255,0.45); margin-bottom: 0.4rem;
}
.atok-feed-row {
	display: flex; justify-content: space-between; gap: 0.6rem;
	padding: 0.3rem 0; font-size: 0.8rem; color: rgba(255,255,255,0.78);
}
.atok-feed-row + .atok-feed-row { border-top: 1px solid rgba(255,255,255,0.03); }
.atok-feed-row code { font-family: ui-monospace, monospace; color: rgba(255,255,255,0.5); font-size: 0.75rem; }
.atok-feed-row .atok-buyback-pill {
	font-size: 0.65rem; padding: 0.05rem 0.4rem; border-radius: 999px;
	background: rgba(255,200,140,0.08); color: rgba(255,210,160,0.85); white-space: nowrap;
}

.atok-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
.atok-btn {
	flex: 1; padding: 0.55rem 0.8rem; border-radius: 8px; cursor: pointer;
	background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
	color: rgba(255,255,255,0.85); font-size: 0.82rem; transition: 0.15s;
}
.atok-btn:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.14); }
.atok-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.atok-btn-primary {
	background: rgba(120,200,140,0.16); border-color: rgba(120,200,140,0.3); color: #d8f5e2;
}
.atok-btn-primary:hover { background: rgba(120,200,140,0.22); }

.atok-empty {
	text-align: center; padding: 1rem 0.5rem; color: rgba(255,255,255,0.6);
}
.atok-empty-title { font-weight: 500; color: rgba(255,255,255,0.85); margin-bottom: 0.3rem; }
.atok-empty-sub   { font-size: 0.82rem; color: rgba(255,255,255,0.5); line-height: 1.5; }

.atok-gov {
	margin-top: 0.8rem; font-size: 0.72rem; color: rgba(255,255,255,0.45);
	border-left: 2px solid rgba(255,200,140,0.2); padding: 0.3rem 0.6rem;
}
.atok-gov b { color: rgba(255,200,140,0.85); font-weight: 500; }

.atok-rep {
	margin-top: 0.7rem; padding: 0.45rem 0.7rem; border-radius: 8px;
	background: rgba(255,200,140,0.05); display: flex; align-items: center; gap: 0.5rem;
	font-size: 0.82rem; color: rgba(255,220,180,0.95);
}
.atok-rep-stars { letter-spacing: 0.04em; color: #ffd57a; }
.atok-rep-num   { font-variant-numeric: tabular-nums; color: #fff; }
.atok-rep-meta  { color: rgba(255,255,255,0.5); font-size: 0.75rem; }

.atok-mobile-strip {
	display: none;
}

@media (max-width: 640px) {
	.atok { margin: 0.6rem; padding: 1rem; }
	.atok-vaults { grid-template-columns: 1fr 1fr 1fr; gap: 0.35rem; }
	.atok-vault { padding: 0.45rem 0.5rem; }
	.atok-vault-val { font-size: 0.85rem; }
	.atok-mobile-strip {
		display: flex; position: fixed; bottom: 0; left: 0; right: 0;
		padding: 0.7rem 1rem env(safe-area-inset-bottom, 0.7rem);
		background: rgba(8,8,10,0.92); backdrop-filter: blur(12px);
		border-top: 1px solid rgba(255,255,255,0.06); gap: 0.6rem; align-items: center;
		z-index: 50;
	}
	.atok-mobile-price { flex: 1; font-variant-numeric: tabular-nums; }
	.atok-mobile-price small { display: block; font-size: 0.65rem; color: rgba(255,255,255,0.5); }
	.atok-mobile-pay {
		padding: 0.55rem 1rem; border-radius: 8px; cursor: pointer;
		background: rgba(120,200,140,0.18); border: 1px solid rgba(120,200,140,0.3);
		color: #d8f5e2; font-size: 0.85rem;
	}
}
`;

let stylesInjected = false;
function injectStyles() {
	if (stylesInjected) return;
	const tag = document.createElement('style');
	tag.textContent = STYLES;
	document.head.appendChild(tag);
	stylesInjected = true;
}

export class AgentTokenWidget {
	/**
	 * @param {object} opts
	 * @param {HTMLElement} opts.mount
	 * @param {string} opts.agentId
	 * @param {boolean} [opts.isOwner]
	 * @param {EventTarget} [opts.protocol]
	 * @param {object} [opts.identity]
	 */
	constructor({ mount, agentId, isOwner = false, protocol = null, identity = null }) {
		this.mount = mount;
		this.agentId = agentId;
		this.isOwner = isOwner;
		this.protocol = protocol;
		this.identity = identity;
		this.token = null;          // /api/pump/by-agent payload
		this.balances = null;
		this.quote = null;
		this.feed = [];
		this.reputation = null;     // /api/agents/solana-reputation snapshot
		this.lastPrice = null;
		this.lastVaults = null;
		this.lastFeedTop = null;
		this._curve = null;
		this._mobileStrip = null;
		this._poll = null;
		this._destroyed = false;
		this._wsUnsubs = [];        // realtime onAccountChange subscriptions
		this._wsConn = null;
		injectStyles();
	}

	async render() {
		this.mount.classList.add('atok-mount');
		this.mount.innerHTML = `<div class="atok"><div class="atok-empty">Loading $AGENT…</div></div>`;
		await this._refresh();
		if (this.token) {
			// Polling is the fallback. Real-time vault subscription kicks in via
			// _ensureRealtime() and shrinks the polling interval to a long beat
			// (60s) used only for stats/feed/quote that lack account-subscriptions.
			this._poll = setInterval(() => this._refresh().catch(() => {}), 60_000);
			this._ensureRealtime().catch(() => {});
		}
	}

	destroy() {
		this._destroyed = true;
		if (this._poll) clearInterval(this._poll);
		this._teardownRealtime();
		if (this._curve) { this._curve.destroy(); this._curve = null; }
		if (this._mobileStrip?.parentNode) this._mobileStrip.parentNode.removeChild(this._mobileStrip);
	}

	async _ensureRealtime() {
		if (!this.token || !this.balances) return;
		if (this._wsUnsubs.length) return; // already subscribed
		try {
			const [{ Connection, PublicKey }] = await Promise.all([import('@solana/web3.js')]);
			// Route through our same-origin proxy. Public mainnet RPC 403s most
			// browser origins. NOTE: WS subscriptions still go direct to the
			// derived ws:// URL; proxying WS is a separate concern.
			const rpcOrigin = window.location?.origin || 'https://three.ws';
			const url =
				this.token.network === 'devnet'
					? `${rpcOrigin}/api/solana-rpc?net=devnet`
					: `${rpcOrigin}/api/solana-rpc`;
			const conn = new Connection(url, 'confirmed');
			this._wsConn = conn;
			const subscribe = (addr, name) => {
				if (!addr) return;
				try {
					const id = conn.onAccountChange(
						new PublicKey(addr),
						() => this._refreshBalancesOnly().catch(() => {}),
						'confirmed',
					);
					this._wsUnsubs.push({ id, conn });
				} catch {
					/* ignore subscription failures, polling fallback covers it */
				}
			};
			subscribe(this.balances.payment?.address, 'payment');
			subscribe(this.balances.buyback?.address, 'buyback');
			subscribe(this.balances.withdraw?.address, 'withdraw');
		} catch {
			/* RPC may not support websocket; polling continues */
		}
	}

	_teardownRealtime() {
		for (const sub of this._wsUnsubs) {
			try {
				sub.conn.removeAccountChangeListener(sub.id);
			} catch {
				/* swallow */
			}
		}
		this._wsUnsubs = [];
		this._wsConn = null;
	}

	async _refreshBalancesOnly() {
		if (this._destroyed || !this.token) return;
		try {
			const balRes = await fetch(
				`/api/pump/balances?mint=${this.token.mint}&network=${this.token.network}`,
			).then((r) => r.json());
			if (balRes.balances) {
				this._compareAndEmit(balRes.balances, this.feed);
				this.balances = balRes.balances;
				this._renderLive();
			}
		} catch {
			/* silent */
		}
	}

	async _refresh() {
		if (this._destroyed) return;
		try {
			const tokenResp = await fetch(`/api/pump/by-agent?agent_id=${this.agentId}`).then((r) =>
				r.json(),
			);
			this.token = tokenResp.data;
		} catch (e) {
			this._renderError(e.message);
			return;
		}

		if (!this.token) {
			this._renderEmpty();
			return;
		}

		// Live state: parallel fetch balances, quote, feed, and reputation
		// overlay. Reputation lookup keys off the agent's metaplex-core asset
		// pubkey from the parent identity (passed in via the `identity` prop).
		try {
			const repAsset = this.identity?.meta?.sol_mint_address || this.identity?.meta?.onchain?.onchain_id || null;
			const [balRes, quoteRes, feedRes, repRes] = await Promise.all([
				fetch(
					`/api/pump/balances?mint=${this.token.mint}&network=${this.token.network}`,
				).then((r) => r.json()),
				fetch(
					`/api/pump/quote?mint=${this.token.mint}&network=${this.token.network}&direction=buy&sol=1`,
				).then((r) => r.json()),
				fetch(
					`/api/pump/payments-list?mint=${this.token.mint}&network=${this.token.network}&limit=8`,
				).then((r) => r.json()),
				repAsset
					? fetch(
							`/api/agents/solana-reputation?asset=${repAsset}&network=${this.token.network}`,
						)
							.then((r) => r.json())
							.catch(() => null)
					: Promise.resolve(null),
			]);
			this._compareAndEmit(balRes.balances, feedRes.data);
			this.balances = balRes.balances || null;
			this.quote = quoteRes || null;
			this.feed = feedRes.data || [];
			this.reputation = repRes || null;
			this._renderLive();
			this._ensureRealtime().catch(() => {});
		} catch (e) {
			this._renderError(e.message);
		}
	}

	_compareAndEmit(newBal, newFeed) {
		// Vault deltas → emit pump-balance event so other modules (avatar, etc.)
		// can react to live revenue.
		if (this.lastVaults && newBal && this.protocol?.emit) {
			const dPay = this._delta(newBal.payment, this.lastVaults.payment);
			const dBuy = this._delta(newBal.buyback, this.lastVaults.buyback);
			const dWdr = this._delta(newBal.withdraw, this.lastVaults.withdraw);
			if (dPay || dBuy || dWdr) {
				this.protocol.emit('pump-balance', {
					paymentDelta: dPay,
					buybackDelta: dBuy,
					withdrawDelta: dWdr,
				});
			}
		}
		this.lastVaults = newBal;

		// New top-of-feed → emit pump-payment so avatar can celebrate.
		if (newFeed && newFeed.length) {
			const top = newFeed[0];
			if (this.lastFeedTop && this.lastFeedTop !== top.id) {
				this.protocol?.emit?.('pump-payment', {
					payer: top.payer_wallet,
					atomics: top.amount_atomics,
					skill: top.skill_id,
					tool: top.tool_name,
				});
			}
			this.lastFeedTop = top.id;
		}

		// Graduation transition → one-time celebration.
		if (
			this.quote &&
			this.lastQuoteGraduated === false &&
			this.quote.graduated === true
		) {
			this.protocol?.emit?.('pump-graduated', { mint: this.token.mint });
		}
		if (this.quote) this.lastQuoteGraduated = this.quote.graduated;
	}

	_delta(a, b) {
		try {
			return Number(BigInt(a?.balance ?? '0') - BigInt(b?.balance ?? '0'));
		} catch {
			return 0;
		}
	}

	_renderEmpty() {
		const ownerCta = this.isOwner
			? `<div style="margin-top:0.7rem"><a href="/dashboard/pump-launch?agent=${this.agentId}" class="atok-btn atok-btn-primary" style="text-decoration:none;display:inline-block">Launch $AGENT →</a></div>`
			: '';
		this.mount.innerHTML = `
			<div class="atok">
				<div class="atok-head">
					<div class="atok-symbol"><span class="atok-sigil">$</span>AGENT</div>
					<div class="atok-status empty">not launched</div>
				</div>
				<div class="atok-empty">
					<div class="atok-empty-title">No agent token yet</div>
					<div class="atok-empty-sub">
						When this agent launches a pump.fun token, every paid call funds
						an on-chain receipt that splits revenue between an automatic
						buyback and the owner. ${this.isOwner ? 'Configure once, accrue forever.' : 'Be the first to fund it.'}
					</div>
					${ownerCta}
				</div>
			</div>`;
	}

	_renderError(msg) {
		this.mount.innerHTML = `
			<div class="atok">
				<div class="atok-head">
					<div class="atok-symbol"><span class="atok-sigil">$</span>AGENT</div>
					<div class="atok-status error">offline</div>
				</div>
				<div class="atok-empty"><div class="atok-empty-sub">${msg || 'Could not load token state.'}</div></div>
			</div>`;
	}

	_renderLive() {
		const t = this.token;
		const b = this.balances || {};
		const q = this.quote || {};
		const symbol = t.symbol || 'AGENT';
		const graduated = q.graduated === true;
		const buybackBps = t.buyback_bps || 0;
		const buybackPct = buybackBps / 100;

		// Curve progress
		let progressPct = null;
		if (!graduated && q.bonding_curve) {
			const real = Number(q.bonding_curve.real_token_reserves || 0);
			const virt = Number(q.bonding_curve.virtual_token_reserves || 0);
			if (virt > 0) progressPct = Math.max(0, Math.min(100, (1 - real / virt) * 100));
		}

		// Live price expressed as USDC of 1 SOL → tokens out (curve) or null (AMM).
		const priceText =
			q.quote && q.quote.tokens_out
				? `${Number(q.quote.tokens_out).toLocaleString()} ${symbol}`
				: graduated
					? 'graduated'
					: '—';

		const tickClass =
			this.lastPrice != null && q.quote?.tokens_out
				? Number(q.quote.tokens_out) > Number(this.lastPrice)
					? 'tick-up'
					: Number(q.quote.tokens_out) < Number(this.lastPrice)
						? 'tick-down'
						: ''
				: '';
		this.lastPrice = q.quote?.tokens_out;

		const stats = t.stats || {};
		const burns = t.burns || { runs: 0, total_burned: '0' };
		const totalBurned = burns.total_burned && burns.total_burned !== '0'
			? `<div class="atok-burned">🔥 <b>${fmtUsdc(burns.total_burned)}</b> burned across ${burns.runs} buyback${burns.runs === 1 ? '' : 's'}.</div>`
			: '';

		const projection =
			stats.confirmed_payments > 0
				? `${fmtUsdc((BigInt(stats.total_atomics || '0') * BigInt(buybackBps)) / 10_000n)} routed to buyback so far across <b>${stats.unique_payers}</b> unique payer${stats.unique_payers === 1 ? '' : 's'}.`
				: `If this agent earns <b>$10/mo</b>, buyback burns <b>${fmtUsdc((10_000_000n * BigInt(buybackBps)) / 10_000n)}/mo</b> of $${symbol}.`;

		const solscanCluster = this.token.network === 'devnet' ? '?cluster=devnet' : '';
		const feedRows = (this.feed || [])
			.slice(0, 5)
			.map((p) => {
				const why = p.tool_name
					? `<code>${p.tool_name}</code>`
					: p.skill_id
						? `<code>${p.skill_id}</code>`
						: 'paid call';
				const buybackShare = (BigInt(p.amount_atomics || '0') * BigInt(buybackBps)) / 10_000n;
				const pdaLink = p.invoice_pda
					? `<a href="https://solscan.io/account/${p.invoice_pda}${solscanCluster}" target="_blank" rel="noopener" title="Open on-chain invoice receipt" style="color:rgba(180,210,255,0.7);text-decoration:none;font-size:0.7rem;">PDA↗</a>`
					: '';
				const txLink = p.tx_signature
					? `<a href="https://solscan.io/tx/${p.tx_signature}${solscanCluster}" target="_blank" rel="noopener" title="Open settlement tx" style="color:rgba(180,210,255,0.7);text-decoration:none;font-size:0.7rem;">tx↗</a>`
					: '';
				return `
					<div class="atok-feed-row">
						<div>${shortAddr(p.payer_wallet, 4)} · ${why}</div>
						<div style="display:flex;gap:0.5rem;align-items:center;">
							<span>${fmtUsdc(p.amount_atomics)}</span>
							${buybackBps > 0 ? `<span class="atok-buyback-pill">+${fmtUsdc(buybackShare)} 🔥</span>` : ''}
							${pdaLink}
							${txLink}
							<span style="color:rgba(255,255,255,0.35);font-size:0.7rem;">${timeAgo(p.confirmed_at || p.created_at)}</span>
						</div>
					</div>`;
			})
			.join('');

		// Burns feed (separate from payments)
		const burnsFeedRows = (t.burns_feed || [])
			.slice(0, 5)
			.map((b) => `
				<div class="atok-feed-row">
					<div>🔥 burn</div>
					<div style="display:flex;gap:0.5rem;align-items:center;">
						<span>${fmtUsdc(b.burn_amount || '0')}</span>
						${b.tx_signature ? `<a href="https://solscan.io/tx/${b.tx_signature}${solscanCluster}" target="_blank" rel="noopener" style="color:rgba(180,210,255,0.7);text-decoration:none;font-size:0.7rem;">tx↗</a>` : ''}
						<span style="color:rgba(255,255,255,0.35);font-size:0.7rem;">${timeAgo(b.created_at)}</span>
					</div>
				</div>`)
			.join('');
		const burnsBlock = burnsFeedRows
			? `<div class="atok-feed">
					<div class="atok-feed-title">Buybacks</div>
					${burnsFeedRows}
				</div>`
			: '';

		// Reputation overlay
		const rep = this.reputation;
		const repBlock = rep && rep.feedback?.total > 0
			? `<div class="atok-rep" title="Reputation drives auto-governance of buyback share.">
					<span class="atok-rep-stars">${'★'.repeat(Math.round(rep.feedback.score_avg_weighted || rep.feedback.score_avg || 0))}${'☆'.repeat(5 - Math.round(rep.feedback.score_avg_weighted || rep.feedback.score_avg || 0))}</span>
					<span class="atok-rep-num">${(rep.feedback.score_avg_weighted || rep.feedback.score_avg || 0).toFixed(2)}</span>
					<span class="atok-rep-meta">· ${rep.feedback.total} review${rep.feedback.total === 1 ? '' : 's'}${rep.feedback.unique_attesters ? ` · ${rep.feedback.unique_attesters} unique` : ''}</span>
				</div>`
			: '';

		const feedBlock = feedRows
			? `<div class="atok-feed">
					<div class="atok-feed-title">Recent payments</div>
					${feedRows}
				</div>`
			: stats.confirmed_payments === 0
				? `<div class="atok-feed">
						<div class="atok-feed-title">Recent payments</div>
						<div class="atok-empty-sub">First payment will fund: <b>${buybackPct}%</b> buyback, <b>${100 - buybackPct}%</b> to owner.</div>
					</div>`
				: '';

		const ownerActions = this.isOwner
			? `<div class="atok-actions">
					<button class="atok-btn atok-withdraw" ${
						BigInt(b.withdraw?.balance || '0') === 0n ? 'disabled' : ''
					}>
						Withdraw ${fmtUsdc(b.withdraw?.balance || '0')}
					</button>
					<button class="atok-btn atok-governance">Buyback ${fmtBps(buybackBps)} ⚙</button>
				</div>`
			: `<div class="atok-actions">
					<button class="atok-btn atok-btn-primary atok-pay">Pay this agent</button>
				</div>`;

		const govExplain =
			buybackBps > 0
				? `<div class="atok-gov">
						<b>Buyback ${fmtBps(buybackBps)}</b> of every paid call burns $${symbol}.
						If this agent's reputation drops below <b>3.5★</b> for 7 days, buyback auto-lowers.
					</div>`
				: '';

		this.mount.innerHTML = `
			<div class="atok">
				<div class="atok-head">
					<div class="atok-symbol"><span class="atok-sigil">$</span>${symbol}</div>
					<div class="atok-status ${graduated ? 'live' : 'curve'}">
						${graduated ? 'graduated' : 'bonding curve'}
					</div>
				</div>

				<div class="atok-price-row">
					<div class="atok-price ${tickClass}">${priceText}</div>
					<div class="atok-price-label">${q.quote ? 'per 1 SOL' : ''}</div>
				</div>

				${
					progressPct != null
						? `<div class="atok-curve-wrap"></div>
							<div class="atok-grad-label"><span>${progressPct.toFixed(1)}% to graduation</span><span>curve</span></div>`
						: graduated
							? `<div class="atok-grad-label" style="margin-top:0.6rem"><span>🎓 Graduated to AMM</span><span></span></div>`
							: ''
				}

				<div class="atok-buyback">
					<div class="atok-buyback-gauge"><div class="atok-buyback-fill" style="width:${buybackPct}%"></div></div>
					<div class="atok-buyback-label">${fmtBps(buybackBps)} buyback</div>
				</div>
				<div class="atok-buyback-explain">${projection}</div>

				<div class="atok-vaults">
					<div class="atok-vault atok-vault-payment">
						<div class="atok-vault-name">Pending</div>
						<div class="atok-vault-val ${this._tickClassFor('payment', b.payment?.balance)}">${fmtUsdc(b.payment?.balance || '0')}</div>
					</div>
					<div class="atok-vault atok-vault-buyback">
						<div class="atok-vault-name">Buyback</div>
						<div class="atok-vault-val ${this._tickClassFor('buyback', b.buyback?.balance)}">${fmtUsdc(b.buyback?.balance || '0')}</div>
					</div>
					<div class="atok-vault atok-vault-withdraw">
						<div class="atok-vault-name">Owner</div>
						<div class="atok-vault-val ${this._tickClassFor('withdraw', b.withdraw?.balance)}">${fmtUsdc(b.withdraw?.balance || '0')}</div>
					</div>
				</div>

				${totalBurned}
				${repBlock}
				${govExplain}
				${feedBlock}
				${burnsBlock}
				${ownerActions}
			</div>
		`;

		this._wireActions();
		this._updateMobileStrip(symbol, priceText);

		// Mount bonding curve SVG into the wrapper (replaces old progress bar).
		if (this._curve) { this._curve.destroy(); this._curve = null; }
		const curveWrap = this.mount.querySelector('.atok-curve-wrap');
		if (curveWrap && progressPct != null) {
			this._curve = mountBondingCurve(curveWrap, {
				progressPct,
				marketCapUsd: q.bonding_curve?.market_cap_usd ?? 0,
				graduationCapUsd: 69_000,
			});
		}
	}

	_tickClassFor(name, newBal) {
		const last = this._lastVaultBalances || {};
		const cls =
			last[name] != null && newBal != null
				? BigInt(newBal) > BigInt(last[name])
					? 'tick-up'
					: ''
				: '';
		this._lastVaultBalances = { ...last, [name]: newBal };
		return cls;
	}

	_wireActions() {
		const wd = this.mount.querySelector('.atok-withdraw');
		if (wd) wd.addEventListener('click', () => this._onWithdraw());
		const gv = this.mount.querySelector('.atok-governance');
		if (gv) gv.addEventListener('click', () => this._onGovernance());
		const pay = this.mount.querySelector('.atok-pay');
		if (pay) pay.addEventListener('click', () => this._onPay());
	}

	async _onWithdraw() {
		const wd = this.mount.querySelector('.atok-withdraw');
		const orig = wd.textContent;
		wd.disabled = true;
		wd.textContent = 'Preparing…';
		try {
			const wallet =
				typeof window !== 'undefined' &&
				(window.solana || window.phantom?.solana || window.backpack || window.solflare);
			if (!wallet) throw new Error('No Solana wallet detected. Install Phantom.');
			if (!wallet.isConnected) await wallet.connect?.();
			const authority =
				wallet.publicKey?.toBase58?.() || wallet.publicKey?.toString();
			if (authority !== this.token.agent_authority) {
				throw new Error('Connected wallet is not the agent authority.');
			}
			wd.textContent = 'Resolving ATA…';
			const { ata, existing, connection } = await resolveUsdcAta({
				owner: authority,
				network: this.token.network,
			});
			// If owner has no USDC ATA yet, prepend a creation ix; the offline SDK
			// withdraw ix expects the receiver ATA to exist.
			let createAtaPrep = null;
			if (!existing) {
				const { createAssociatedTokenAccountInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } =
					await import('@solana/spl-token');
				const { PublicKey } = await import('@solana/web3.js');
				createAtaPrep = createAssociatedTokenAccountInstruction(
					new PublicKey(authority),
					ata,
					new PublicKey(authority),
					new PublicKey(
						this.token.network === 'devnet'
							? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
							: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
					),
				);
			}
			wd.textContent = 'Building tx…';
			const prep = await fetch('/api/pump/withdraw-prep', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					mint: this.token.mint,
					authority_wallet: authority,
					receiver_ata: ata.toBase58(),
					network: this.token.network,
				}),
			}).then((r) => r.json());
			if (prep.error) throw new Error(prep.error_description || prep.error);
			wd.textContent = 'Sign in wallet…';
			const sig = await signAndSendVTx(prep.tx_base64, {
				network: this.token.network,
				prependIxs: createAtaPrep ? [createAtaPrep] : [],
				wallet,
				connection,
			});
			wd.textContent = 'Confirming…';
			const conf = await fetch('/api/pump/withdraw-confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({
					mint: this.token.mint,
					authority_wallet: authority,
					tx_signature: sig,
					network: this.token.network,
				}),
			}).then((r) => r.json());
			if (conf.error) throw new Error(conf.error_description || conf.error);
			wd.textContent = 'Done 🎉';
			setTimeout(() => this._refresh().catch(() => {}), 1200);
		} catch (e) {
			wd.textContent = `Failed: ${(e.message || String(e)).slice(0, 32)}`;
			setTimeout(() => {
				wd.textContent = orig;
				wd.disabled = false;
			}, 3000);
		}
	}

	_onGovernance() {
		window.dispatchEvent(
			new CustomEvent('pump-governance-open', {
				detail: { mint: this.token.mint, currentBps: this.token.buyback_bps },
			}),
		);
	}

	_onPay() {
		window.dispatchEvent(
			new CustomEvent('pump-pay-open', {
				detail: { mint: this.token.mint, network: this.token.network },
			}),
		);
	}

	_updateMobileStrip(symbol, priceText) {
		if (window.innerWidth > 640) return;
		if (!this._mobileStrip) {
			const el = document.createElement('div');
			el.className = 'atok-mobile-strip';
			document.body.appendChild(el);
			this._mobileStrip = el;
		}
		this._mobileStrip.innerHTML = `
			<div class="atok-mobile-price">
				<div>$${symbol}</div>
				<small>${priceText}</small>
			</div>
			<button class="atok-mobile-pay">Pay</button>`;
		const pay = this._mobileStrip.querySelector('.atok-mobile-pay');
		if (pay) pay.addEventListener('click', () => this._onPay());
	}
}
