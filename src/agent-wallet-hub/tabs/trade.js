/**
 * Agent Wallet hub — Trade tab (epic task 04).
 *
 * Discretionary pump.fun buy/sell FROM the agent's own funded custodial wallet.
 * The owner picks a coin (paste a mint or tap a holding), sizes the trade in SOL
 * (buy) or tokens (sell), sees a live quote — expected output, price impact,
 * minimum received, slippage, fees — then confirms. Execution is real and
 * on-chain via POST /api/agents/:id/solana/trade (server-signed; the browser
 * never holds or sends a key). Balances and holdings update only after the tx
 * confirms.
 *
 * Owner sees the full trade controls; visitors get a read-only holdings + history
 * view. Every state is designed: wallet-preparing, idle, resolving-coin, quoting,
 * confirming, submitting, success, and every guard/error (over budget, price
 * impact too high, insufficient SOL → routes to the Deposit tab).
 *
 * Coin-agnostic: trades whatever mint the owner supplies at runtime. $THREE is the
 * only coin three.ws promotes — nothing here names or recommends any other token;
 * the placeholder is a synthetic example, not a real mint.
 */

import { registerWalletTab } from '../registry.js';
import {
	previewAgentTrade, executeAgentTrade, fetchAgentHoldings, fetchAgentTradeHistory, TradeError,
} from '../../agent-solana-wallet.js';
import { createSafetyPanel } from '../../shared/safety-panel.js';
import { ensureRiskAck } from '../../shared/risk-ack.js';
import { solToUsd } from '../../shared/usd-price.js';
import { formatSol, timeAgo, explorerTxUrl } from '../util.js';

const QUOTE_DEBOUNCE_MS = 450;
const BUY_HEADROOM_SOL = 0.003; // keep fee+rent headroom out of "Max"
const SLIPPAGE_PRESETS = [100, 300, 500]; // 1% / 3% / 5%
const IMPACT_WARN = 5; // amber
const IMPACT_DANGER = 15; // red
// A clearly-synthetic placeholder mint — never a real coin (CLAUDE.md: $THREE is
// the only coin three.ws references; this is illustrative input only).
const MINT_PLACEHOLDER = 'Paste a coin mint address…';
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Derive a Safety-panel-shaped verdict from a trade preview payload. The preview
// embeds `firewall` (warn/allow) directly; a hard block arrives as a guard with
// code 'firewall_blocked' carrying the same detail. Returns null when the buy
// side carries no firewall signal (e.g. a sell, which the firewall doesn't gate).
function verdictFromPreview(q) {
	if (!q) return null;
	if (q.guard && q.guard.code === 'firewall_blocked') {
		const d = q.guard.detail || {};
		return { verdict: 'block', score: d.score, simulated: d.simulated, reasons: d.reasons || [q.guard.message], checks: d.checks || [] };
	}
	if (q.firewall && typeof q.firewall.verdict === 'string') return q.firewall;
	return null;
}

const STYLE_ID = 'awh-trade-style';
const STYLE = `
.awh-tr { display: flex; flex-direction: column; gap: var(--awh-gap, 16px); }
.awh-tr-banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius-md,10px); font-size: var(--text-sm,.764rem); line-height: 1.45; border: 1px solid transparent; }
.awh-tr-banner--info { color: var(--ink-dim,#888); background: var(--surface-1, rgba(255,255,255,.03)); border-color: var(--stroke, rgba(255,255,255,.08)); }
.awh-tr-banner--warn { color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 10%, transparent); border-color: color-mix(in srgb, var(--warn,#fbbf24) 30%, transparent); }

.awh-tr-side { display: inline-flex; padding: 3px; gap: 3px; background: var(--surface-2, rgba(255,255,255,.05)); border-radius: var(--radius-md,10px); border: 1px solid var(--stroke, rgba(255,255,255,.08)); }
.awh-tr-side button { appearance: none; font: inherit; font-size: var(--text-md,.8125rem); font-weight: 600; color: var(--ink-dim,#888); background: transparent; border: none; padding: 7px 18px; border-radius: var(--radius-sm,6px); cursor: pointer; transition: color var(--duration-fast,140ms), background var(--duration-fast,140ms); }
.awh-tr-side button:hover:not([aria-pressed="true"]) { color: var(--ink,#e8e8e8); }
.awh-tr-side button[aria-pressed="true"][data-side="buy"] { color: #0a0a0a; background: var(--success,#4ade80); }
.awh-tr-side button[aria-pressed="true"][data-side="sell"] { color: #0a0a0a; background: var(--danger,#f87171); }
.awh-tr-side button:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }

.awh-tr-field { display: flex; flex-direction: column; gap: 7px; }
.awh-tr-label { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim,#888); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.awh-tr-label a, .awh-tr-label button.awh-tr-link { color: var(--accent,#fff); background: none; border: none; font: inherit; cursor: pointer; padding: 0; text-decoration: none; }
.awh-tr-label button.awh-tr-link:hover { text-decoration: underline; }

.awh-tr-mintrow { display: flex; gap: 8px; align-items: stretch; }
.awh-tr-input { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--text-md,.8125rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding: 9px 12px; transition: border-color var(--duration-fast,140ms); }
.awh-tr-input::placeholder { color: var(--ink-faint, #666); }
.awh-tr-input:focus-visible { outline: none; border-color: var(--accent,#fff); }
.awh-tr-input.is-mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.764rem); }

.awh-tr-coin { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-tr-coin img, .awh-tr-coin .awh-tr-coin-ph { width: 30px; height: 30px; border-radius: 50%; flex: none; object-fit: cover; background: var(--surface-3, rgba(255,255,255,.08)); }
.awh-tr-coin-name { font-weight: 600; color: var(--ink-bright,#fff); font-size: var(--text-md,.8125rem); }
.awh-tr-coin-sym { color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); }
.awh-tr-badge { font-size: var(--text-2xs,.6875rem); font-weight: 600; padding: 2px 7px; border-radius: var(--radius-pill,999px); border: 1px solid var(--stroke,rgba(255,255,255,.12)); color: var(--ink-dim,#888); margin-left: auto; }

.awh-tr-amt { position: relative; }
.awh-tr-amt .awh-tr-input { padding-right: 64px; font-size: var(--text-lg,1.236rem); font-weight: 600; }
.awh-tr-denom { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); font-weight: 600; pointer-events: none; }
.awh-tr-amt-usd { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); min-height: 1em; }
.awh-tr-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.awh-tr-chip { appearance: none; font: inherit; font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-pill,999px); padding: 4px 12px; cursor: pointer; transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms); }
.awh-tr-chip:hover:not(:disabled) { background: var(--surface-3, rgba(255,255,255,.08)); border-color: var(--stroke-strong, rgba(255,255,255,.14)); }
.awh-tr-chip:disabled { opacity: .4; cursor: not-allowed; }
.awh-tr-chip:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }

.awh-tr-slip { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.awh-tr-slip .awh-tr-chip[aria-pressed="true"] { background: var(--accent,#fff); color: #0a0a0a; border-color: var(--accent,#fff); }
.awh-tr-slip input { width: 64px; }

.awh-tr-quote { border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.awh-tr-qrow { display: flex; justify-content: space-between; gap: 12px; font-size: var(--text-sm,.764rem); }
.awh-tr-qrow dt { color: var(--ink-dim,#888); margin: 0; }
.awh-tr-qrow dd { margin: 0; color: var(--ink,#e8e8e8); font-variant-numeric: tabular-nums; text-align: right; }
.awh-tr-qrow dd.is-strong { color: var(--ink-bright,#fff); font-weight: 600; }
.awh-tr-qrow dd.impact-warn { color: var(--warn,#fbbf24); }
.awh-tr-qrow dd.impact-danger { color: var(--danger,#f87171); }
.awh-tr-quote-skel { height: 14px; border-radius: 5px; background: var(--surface-2, rgba(255,255,255,.05)); animation: awh-skel 1.4s ease-in-out infinite; }
.awh-tr-quote-skel:nth-child(2) { width: 70%; } .awh-tr-quote-skel:nth-child(3) { width: 85%; }
.awh-tr-quote-note { font-size: var(--text-sm,.764rem); }
.awh-tr-quote-note.is-err { color: var(--danger,#f87171); }
.awh-tr-quote-note.is-warn { color: var(--warn,#fbbf24); }

.awh-tr-actions { display: flex; flex-direction: column; gap: 8px; }
.awh-tr-submit { width: 100%; justify-content: center; padding: 11px 16px; font-size: var(--text-md,.8125rem); font-weight: 600; }
.awh-tr-submit[data-side="buy"]:not(:disabled) { background: var(--success,#4ade80); color: #0a0a0a; border-color: var(--success,#4ade80); }
.awh-tr-submit[data-side="sell"]:not(:disabled) { background: var(--danger,#f87171); color: #0a0a0a; border-color: var(--danger,#f87171); }
.awh-tr-submit[data-side="buy"]:hover:not(:disabled) { background: color-mix(in srgb, var(--success,#4ade80) 88%, #000); }
.awh-tr-submit[data-side="sell"]:hover:not(:disabled) { background: color-mix(in srgb, var(--danger,#f87171) 88%, #000); }
.awh-tr-deposit-cta { width: 100%; justify-content: center; }

.awh-tr-confirm { border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); border-radius: var(--radius-md,10px); background: var(--surface-2, rgba(255,255,255,.05)); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; animation: awh-fade var(--duration-base,220ms) var(--ease-out,ease); }
.awh-tr-confirm-h { font-size: var(--text-md,.8125rem); font-weight: 600; color: var(--ink-bright,#fff); }
.awh-tr-confirm-actions { display: flex; gap: 8px; }
.awh-tr-confirm-actions .awh-btn { flex: 1; justify-content: center; }

.awh-tr-result { display: flex; gap: 10px; align-items: flex-start; padding: 11px 13px; border-radius: var(--radius-md,10px); font-size: var(--text-sm,.764rem); line-height: 1.5; }
.awh-tr-result--ok { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 10%, transparent); border: 1px solid color-mix(in srgb, var(--success,#4ade80) 30%, transparent); }
.awh-tr-result--err { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger,#f87171) 30%, transparent); }
.awh-tr-result a { color: inherit; font-weight: 600; }

.awh-tr-hold-list, .awh-tr-hist-list { list-style: none; margin: 0; padding: 0; }
.awh-tr-hold { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 6px; border: none; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); background: none; cursor: pointer; font: inherit; border-radius: 6px; transition: background var(--duration-fast,140ms); }
.awh-tr-hold:last-child { border-bottom: none; }
.awh-tr-hold:hover { background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-tr-hold:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: -2px; }
.awh-tr-hold[disabled] { cursor: default; }
.awh-tr-hold-sym { font-weight: 600; color: var(--ink-bright,#fff); font-size: var(--text-md,.8125rem); }
.awh-tr-hold-mint { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }
.awh-tr-hold-amt { margin-left: auto; text-align: right; font-variant-numeric: tabular-nums; color: var(--ink,#e8e8e8); font-size: var(--text-sm,.764rem); }
.awh-tr-hold-cta { margin-left: 8px; flex: none; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }

.awh-tr-hist { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awh-tr-hist:last-child { border-bottom: none; }
.awh-tr-hist-side { font-size: var(--text-2xs,.6875rem); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: var(--radius-pill,999px); flex: none; }
.awh-tr-hist-side.is-buy { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 14%, transparent); }
.awh-tr-hist-side.is-sell { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 14%, transparent); }
.awh-tr-hist-side.is-snipe { color: var(--accent,#9b8cff); background: color-mix(in srgb, var(--accent,#9b8cff) 16%, transparent); }
.awh-tr-hist-main { flex: 1 1 auto; min-width: 0; overflow: hidden; }
.awh-tr-hist-mint { font-family: var(--font-mono, ui-monospace, monospace); color: var(--ink,#e8e8e8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awh-tr-hist-sub { color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); }
.awh-tr-hist-val { flex: none; text-align: right; font-variant-numeric: tabular-nums; }
.awh-tr-hist-val a { color: var(--ink,#e8e8e8); text-decoration: none; }
.awh-tr-hist-val a:hover { text-decoration: underline; }
.awh-tr-pnl-pos { color: var(--success,#4ade80); } .awh-tr-pnl-neg { color: var(--danger,#f87171); }

.awh-tr-skel-row { height: 16px; border-radius: 5px; background: var(--surface-2, rgba(255,255,255,.05)); animation: awh-skel 1.4s ease-in-out infinite; margin: 8px 0; }
@keyframes awh-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .awh-tr-quote-skel, .awh-tr-skel-row, .awh-tr-confirm { animation: none; } }
@media (max-width: 520px) { .awh-tr-side button { padding: 7px 14px; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

// ── small formatting helpers ──────────────────────────────────────────────────
function fmtUsd(n) {
	if (n == null || !Number.isFinite(n)) return '';
	if (n === 0) return '$0.00';
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1000) return `$${n.toFixed(2)}`;
	return `$${Math.round(n).toLocaleString('en-US')}`;
}
function fmtTokens(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
	if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
	return n.toPrecision(4).replace(/\.?0+$/, '');
}
function short(s, h = 4, t = 4) {
	return !s || s.length <= h + t + 1 ? s || '' : `${s.slice(0, h)}…${s.slice(-t)}`;
}
function rawToUi(rawStr, decimals) {
	try { return Number(BigInt(rawStr)) / 10 ** decimals; } catch { return 0; }
}
function pctOfRaw(rawStr, pct) {
	try { return ((BigInt(rawStr) * BigInt(Math.round(pct))) / 100n).toString(); } catch { return '0'; }
}
function uiToRaw(ui, decimals) {
	if (!(Number(ui) > 0)) return '0';
	// Avoid float drift for the integer base-unit amount.
	const [whole, frac = ''] = String(ui).split('.');
	const fracPad = (frac + '0'.repeat(decimals)).slice(0, decimals);
	try { return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPad || '0')).toString(); }
	catch { return '0'; }
}

let _uid = 0;
const newIdempotencyKey = () => {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	_uid += 1;
	return `trade-${Date.now()}-${_uid}-${Math.floor(Math.random() * 1e9)}`;
};

registerWalletTab({
	id: 'trade',
	label: 'Trade',
	order: 30,
	ownerOnly: false, // visitors get a read-only holdings + history view
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml, toast } = ctx;
		const esc = escapeHtml;
		let destroyed = false;
		let detachNet = null;
		let quoteTimer = null;
		let quoteSeq = 0;
		const safety = createSafetyPanel({ startExpanded: false });

		const state = {
			isOwner: ctx.isOwner,
			walletReady: !!(ctx.agent.walletReady ?? ctx.agent.wallet_ready),
			side: 'buy',
			mintInput: '',
			coin: null, // { mint, name, symbol, image, graduated, loading, error }
			slippageBps: 300,
			buySol: '', // string in the SOL field
			sellRaw: '0', // base units (source of truth for sell)
			sellDecimals: 6,
			quote: null, // last successful preview payload
			quoting: false,
			quoteError: null, // TradeError
			confirming: false,
			submitting: false,
			result: null, // { ok, message, explorer } | { ok:false, ... }
			solBalance: null,
			holdings: null, // [{ mint, ui_amount, amount_raw, decimals, ... }]
			holdingsError: null,
			holdingsLoaded: false,
			history: null,
			historyError: null,
			historyLoaded: false,
			solPrice: null,
		};

		// ── data loads ────────────────────────────────────────────────────────
		async function loadHoldings() {
			try {
				const data = await fetchAgentHoldings(ctx.agentId, ctx.getNetwork());
				state.solBalance = data?.sol ?? null;
				state.holdings = (data?.tokens || []).filter((t) => !t.is_usdc);
				state.holdingsError = null;
			} catch (e) {
				state.holdingsError = e?.message || 'holdings_error';
			} finally {
				state.holdingsLoaded = true;
			}
		}

		async function loadHistory() {
			if (!state.isOwner) { state.historyLoaded = true; return; }
			try {
				const data = await fetchAgentTradeHistory(ctx.agentId, ctx.getNetwork(), 40);
				state.history = data?.items || [];
				state.historyError = null;
			} catch (e) {
				state.historyError = e?.message || 'history_error';
			} finally {
				state.historyLoaded = true;
			}
		}

		async function loadSolPrice() {
			try { state.solPrice = await solToUsd(1); } catch { state.solPrice = null; }
		}

		async function resolveCoin(mint) {
			state.coin = { mint, loading: true, error: null, name: null, symbol: null, image: null, graduated: null };
			renderAll();
			let meta = null;
			try {
				const r = await fetch(`/api/pump/coin?mint=${encodeURIComponent(mint)}`, { headers: { accept: 'application/json' } });
				if (r.ok) meta = await r.json();
			} catch { /* metadata is best-effort — the mint still trades */ }
			if (destroyed || state.coin?.mint !== mint) return;
			state.coin = {
				mint,
				loading: false,
				error: null,
				name: meta?.name || null,
				symbol: meta?.symbol || null,
				image: meta?.image_uri || meta?.image || null,
				graduated: meta?.complete ?? null,
			};
			// Pre-fill sell decimals/amount from a matching holding when selling.
			syncSellDecimals();
			renderAll();
			scheduleQuote();
		}

		function syncSellDecimals() {
			const h = (state.holdings || []).find((t) => t.mint === state.coin?.mint);
			if (h) state.sellDecimals = h.decimals ?? 6;
		}

		// ── quote (debounced) ───────────────────────────────────────────────────
		function tradeArgs() {
			const mint = state.coin?.mint;
			if (!mint) return null;
			if (state.side === 'buy') {
				const sol = Number(state.buySol);
				if (!(sol > 0)) return null;
				return { agentId: ctx.agentId, side: 'buy', mint, solAmount: sol, slippageBps: state.slippageBps, network: ctx.getNetwork() };
			}
			if (!(BigInt(state.sellRaw || '0') > 0n)) return null;
			return { agentId: ctx.agentId, side: 'sell', mint, tokenAmountRaw: state.sellRaw, slippageBps: state.slippageBps, network: ctx.getNetwork() };
		}

		function scheduleQuote() {
			clearTimeout(quoteTimer);
			state.result = null;
			const args = tradeArgs();
			if (!args) {
				state.quote = null;
				state.quoteError = null;
				state.quoting = false;
				renderQuote();
				renderActions();
				renderSafety();
				return;
			}
			state.quoting = true;
			state.quoteError = null;
			renderQuote();
			renderActions();
			renderSafety();
			const seq = ++quoteSeq;
			quoteTimer = setTimeout(async () => {
				try {
					const data = await previewAgentTrade(args);
					if (destroyed || seq !== quoteSeq) return;
					state.quote = data;
					state.quoteError = null;
				} catch (e) {
					if (destroyed || seq !== quoteSeq) return;
					state.quote = null;
					state.quoteError = e instanceof TradeError ? e : new TradeError(e?.message || 'Could not price this trade.');
				} finally {
					if (!destroyed && seq === quoteSeq) {
						state.quoting = false;
						renderQuote();
						renderActions();
						renderSafety();
					}
				}
			}, QUOTE_DEBOUNCE_MS);
		}

		// ── execute ─────────────────────────────────────────────────────────────
		async function submit() {
			const args = tradeArgs();
			if (!args || state.submitting) return;
			if (ctx.getNetwork() !== 'devnet' && !(await ensureRiskAck({ context: 'trade' }))) return;
			state.submitting = true;
			state.confirming = false;
			state.result = null;
			renderActions();
			try {
				const data = await executeAgentTrade({ ...args, idempotencyKey: newIdempotencyKey() });
				if (destroyed) return;
				const net = ctx.getNetwork();
				const outAsset = state.side === 'buy' ? (state.coin?.symbol || 'tokens') : 'SOL';
				const outAmt = state.side === 'buy'
					? fmtTokens(data?.out?.amount)
					: `◎${formatSol(data?.out?.amount)}`;
				state.result = {
					ok: true,
					message: data?.replayed
						? `Already executed — ${state.side === 'buy' ? 'bought' : 'sold'} ${esc(outAmt)} ${esc(outAsset)}.`
						: `${state.side === 'buy' ? 'Bought' : 'Sold'} ${esc(outAmt)} ${esc(outAsset)}.`,
					explorer: data?.explorer || (data?.signature ? explorerTxUrl(data.signature, net) : null),
				};
				toast(state.side === 'buy' ? 'Buy confirmed' : 'Sell confirmed');
				// Reset the amount; refresh real on-chain balances + history.
				if (state.side === 'buy') state.buySol = '';
				else state.sellRaw = '0';
				state.quote = null;
				await Promise.all([loadHoldings(), loadHistory(), refreshBalanceCacheBust()]);
			} catch (e) {
				if (destroyed) return;
				state.result = buildErrorResult(e);
			} finally {
				if (!destroyed) {
					state.submitting = false;
					renderAll();
				}
			}
		}

		async function refreshBalanceCacheBust() {
			// Holdings already re-read SOL; nothing else to bust client-side.
		}

		function buildErrorResult(e) {
			const code = e instanceof TradeError ? e.code : 'error';
			const msg = e?.message || 'The trade could not be completed.';
			// Insufficient funds → offer the deposit route.
			const insufficient = code === 'insufficient_sol' || code === 'insufficient_sol_for_fees';
			return { ok: false, code, message: msg, insufficient, explorer: e?.detail?.explorer || null };
		}

		// ── renderers ───────────────────────────────────────────────────────────
		// Re-attach the persistent Safety panel into its host after a full re-render
		// (renderAll wipes innerHTML) and apply the current verdict. Hidden on the
		// sell side — the firewall guards the buy direction.
		function renderSafety() {
			const host = panel.querySelector('[data-host="safety"]');
			if (!host) return;
			if (state.side !== 'buy' || !state.coin) { host.hidden = true; return; }
			host.hidden = false;
			if (safety.el.parentNode !== host) { host.innerHTML = ''; host.appendChild(safety.el); }
			if (state.quoting) { safety.setState('loading'); return; }
			const v = verdictFromPreview(state.quote);
			if (v) safety.applyVerdict(v);
			else safety.setState('idle');
		}

		function renderAll() {
			if (destroyed) return;
			if (!state.walletReady) {
				panel.innerHTML = `
					<div class="awh-card">
						<div class="awh-tr-banner awh-tr-banner--warn" role="status">
							<span aria-hidden="true">⏳</span>
							<span>This agent’s wallet is still being prepared. Trading opens automatically the moment it’s ready — refresh in a few seconds.</span>
						</div>
					</div>`;
				return;
			}
			panel.innerHTML = `
				<div class="awh-tr">
					${state.isOwner ? tradeCardHtml() : visitorBannerHtml()}
					${holdingsCardHtml()}
					${historyCardHtml()}
				</div>`;
			wireEvents();
			renderSafety();
		}

		function visitorBannerHtml() {
			return `<div class="awh-card">
				<div class="awh-tr-banner awh-tr-banner--info" role="note">
					<span aria-hidden="true">👁️</span>
					<span>You’re viewing <strong>${esc(ctx.agent.name || 'this agent')}</strong>’s wallet. Its holdings are public; only the owner can trade from it or see its trade history.</span>
				</div>
			</div>`;
		}

		function tradeCardHtml() {
			return `
			<div class="awh-card">
				<div class="awh-tr">
					<div class="awh-tr-field">
						<div class="awh-tr-label" id="awh-tr-coin-l">Coin</div>
						<div class="awh-tr-mintrow">
							<input class="awh-tr-input is-mono" data-tr="mint" type="text" inputmode="text" spellcheck="false"
								autocomplete="off" aria-labelledby="awh-tr-coin-l"
								placeholder="${esc(MINT_PLACEHOLDER)}" value="${esc(state.mintInput)}" />
						</div>
						${coinPreviewHtml()}
					</div>

					<div class="awh-tr-side" role="group" aria-label="Trade side">
						<button type="button" data-side="buy" aria-pressed="${state.side === 'buy'}">Buy</button>
						<button type="button" data-side="sell" aria-pressed="${state.side === 'sell'}">Sell</button>
					</div>

					${amountFieldHtml()}
					${slippageHtml()}

					<div class="awh-tr-field">
						<div class="awh-tr-label">Quote</div>
						<div data-host="quote" aria-live="polite" aria-atomic="true">${quoteInnerHtml()}</div>
					</div>

					<div data-host="safety" class="awh-tr-safety-host"></div>

					<div class="awh-tr-actions" data-host="actions">${actionsInnerHtml()}</div>
					<div data-host="result">${resultInnerHtml()}</div>
				</div>
			</div>`;
		}

		function coinPreviewHtml() {
			const c = state.coin;
			if (!c) return '';
			if (c.loading) return `<div class="awh-tr-coin"><div class="awh-tr-coin-ph" aria-hidden="true"></div><span class="awh-tr-coin-sym">Resolving coin…</span></div>`;
			const sym = c.symbol ? esc(c.symbol) : short(c.mint, 4, 4);
			const name = c.name ? esc(c.name) : 'Unknown coin';
			const badge = c.graduated === true ? 'Graduated · AMM' : c.graduated === false ? 'Bonding curve' : '';
			return `<div class="awh-tr-coin">
				${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy" data-fallback="element" data-fallback-class="awh-tr-coin-ph" />` : '<div class="awh-tr-coin-ph" aria-hidden="true"></div>'}
				<div>
					<div class="awh-tr-coin-name">${name}</div>
					<div class="awh-tr-coin-sym">${sym} · <span class="awh-mono">${short(c.mint, 4, 4)}</span></div>
				</div>
				${badge ? `<span class="awh-tr-badge">${badge}</span>` : ''}
			</div>`;
		}

		function amountFieldHtml() {
			if (state.side === 'buy') {
				const usd = state.solPrice && Number(state.buySol) > 0 ? fmtUsd(Number(state.buySol) * state.solPrice) : '';
				return `<div class="awh-tr-field">
					<div class="awh-tr-label"><span>You pay</span><span>${state.solBalance != null ? `Balance: ◎${formatSol(state.solBalance)}` : ''}</span></div>
					<div class="awh-tr-amt">
						<input class="awh-tr-input" data-tr="buySol" type="text" inputmode="decimal" autocomplete="off"
							placeholder="0.0" value="${esc(state.buySol)}" aria-label="SOL amount to spend" />
						<span class="awh-tr-denom">SOL</span>
					</div>
					<div class="awh-tr-amt-usd">${usd ? `≈ ${usd}` : ''}</div>
					<div class="awh-tr-chips" data-host="chips">${buyChipsHtml()}</div>
				</div>`;
			}
			const h = (state.holdings || []).find((t) => t.mint === state.coin?.mint);
			const ui = rawToUi(state.sellRaw, state.sellDecimals);
			const sym = state.coin?.symbol || 'tokens';
			const held = h ? `Holding: ${fmtTokens(Number(h.ui_amount))}` : 'Not held';
			return `<div class="awh-tr-field">
				<div class="awh-tr-label"><span>You sell</span><span>${esc(held)}</span></div>
				<div class="awh-tr-amt">
					<input class="awh-tr-input" data-tr="sellUi" type="text" inputmode="decimal" autocomplete="off"
						placeholder="0.0" value="${ui > 0 ? esc(fmtTokens(ui)) : ''}" aria-label="Token amount to sell" />
					<span class="awh-tr-denom">${esc(sym).slice(0, 6)}</span>
				</div>
				<div class="awh-tr-amt-usd"></div>
				<div class="awh-tr-chips" data-host="chips">${sellChipsHtml()}</div>
			</div>`;
		}

		function buyChipsHtml() {
			const bal = Number(state.solBalance);
			const ok = Number.isFinite(bal) && bal > BUY_HEADROOM_SOL;
			const maxSpendable = ok ? Math.max(0, bal - BUY_HEADROOM_SOL) : 0;
			return [25, 50, 75, 100].map((p) => {
				const v = (maxSpendable * p) / 100;
				const label = p === 100 ? 'Max' : `${p}%`;
				return `<button type="button" class="awh-tr-chip" data-buychip="${v.toFixed(6)}" ${ok ? '' : 'disabled'}>${label}</button>`;
			}).join('');
		}

		function sellChipsHtml() {
			const h = (state.holdings || []).find((t) => t.mint === state.coin?.mint);
			const ok = !!h && BigInt(h.amount_raw || '0') > 0n;
			return [25, 50, 75, 100].map((p) => {
				const label = p === 100 ? 'Max' : `${p}%`;
				return `<button type="button" class="awh-tr-chip" data-sellchip="${p}" ${ok ? '' : 'disabled'}>${label}</button>`;
			}).join('');
		}

		function slippageHtml() {
			const isPreset = SLIPPAGE_PRESETS.includes(state.slippageBps);
			return `<div class="awh-tr-field">
				<div class="awh-tr-label">Max slippage</div>
				<div class="awh-tr-slip" role="group" aria-label="Max slippage">
					${SLIPPAGE_PRESETS.map((b) => `<button type="button" class="awh-tr-chip" data-slip="${b}" aria-pressed="${state.slippageBps === b}">${(b / 100).toFixed(b % 100 ? 1 : 0)}%</button>`).join('')}
					<input class="awh-tr-input awh-tr-chip" data-tr="slipBps" type="number" min="0" max="5000" step="10"
						value="${isPreset ? '' : state.slippageBps}" placeholder="bps" aria-label="Custom slippage in basis points" style="padding:4px 10px" />
				</div>
			</div>`;
		}

		function quoteInnerHtml() { return quoteBodyHtml(); }
		function renderQuote() {
			const host = panel.querySelector('[data-host="quote"]');
			if (host) host.innerHTML = quoteBodyHtml();
		}
		function quoteBodyHtml() {
			if (!state.coin) return `<div class="awh-tr-quote-note" style="color:var(--ink-dim,#888)">Enter a coin and amount to see a live quote.</div>`;
			if (state.quoting) {
				return `<div class="awh-tr-quote" aria-busy="true" aria-label="Fetching quote"><div class="awh-tr-quote-skel"></div><div class="awh-tr-quote-skel"></div><div class="awh-tr-quote-skel"></div></div>`;
			}
			if (state.quoteError) {
				const code = state.quoteError.code;
				const friendly = code === 'no_market'
					? 'No bonding curve or pool found for this mint on this network. Double-check the address.'
					: code === 'amount_too_small'
						? 'That amount is too small to trade. Try a larger size.'
						: state.quoteError.message;
				return `<div class="awh-tr-quote"><div class="awh-tr-quote-note is-err">${esc(friendly)}</div></div>`;
			}
			const q = state.quote;
			if (!q) return `<div class="awh-tr-quote-note" style="color:var(--ink-dim,#888)">Enter an amount to see a live quote.</div>`;
			const impact = Number(q.price_impact_pct) || 0;
			const impactCls = impact >= IMPACT_DANGER ? 'impact-danger' : impact >= IMPACT_WARN ? 'impact-warn' : '';
			const outAsset = q.out?.asset === 'SOL' ? 'SOL' : (state.coin?.symbol || 'tokens');
			const outStr = q.out?.asset === 'SOL' ? `◎${formatSol(q.out?.amount)}` : fmtTokens(q.out?.amount);
			const minStr = q.min_received?.amount != null
				? (q.out?.asset === 'SOL' ? `◎${formatSol(q.min_received.amount)}` : `${fmtTokens(q.min_received.amount)} ${esc(outAsset)}`)
				: '—';
			const feeBps = Number(q.platform_fee_bps) || 0;
			const guard = q.guard;
			const funds = q.funds;
			return `<dl class="awh-tr-quote">
				<div class="awh-tr-qrow"><dt>Expected ${state.side === 'buy' ? 'output' : 'proceeds'}</dt><dd class="is-strong">${esc(outStr)}${q.out?.asset === 'SOL' ? '' : ` ${esc(outAsset)}`}</dd></div>
				<div class="awh-tr-qrow"><dt>Minimum received</dt><dd>${esc(minStr)}</dd></div>
				<div class="awh-tr-qrow"><dt>Price impact</dt><dd class="${impactCls}">${impact.toFixed(2)}%</dd></div>
				<div class="awh-tr-qrow"><dt>Max slippage</dt><dd>${(state.slippageBps / 100).toFixed(state.slippageBps % 100 ? 1 : 0)}%</dd></div>
				<div class="awh-tr-qrow"><dt>Route</dt><dd>${q.venue === 'amm' ? 'AMM pool' : 'Bonding curve'}${feeBps > 0 ? ` · ${(feeBps / 100).toFixed(2)}% fee` : ''}</dd></div>
				${impact >= IMPACT_WARN ? `<div class="awh-tr-quote-note is-warn">⚠ High price impact (${impact.toFixed(1)}%). You may receive significantly less than the market rate.</div>` : ''}
				${guard ? `<div class="awh-tr-quote-note is-err">⚠ ${esc(guard.message)}</div>` : ''}
				${funds ? `<div class="awh-tr-quote-note is-err">⚠ ${esc(funds.message)}</div>` : ''}
			</dl>`;
		}

		function actionsInnerHtml() {
			const args = tradeArgs();
			const q = state.quote;
			const blocked = q && (q.guard || q.funds);
			const fundsInsufficient = q?.funds;
			const ready = !!args && !!q && !state.quoting && !blocked;
			const sym = state.coin?.symbol || 'coin';
			if (state.submitting) {
				return `<button class="awh-btn awh-btn--primary awh-tr-submit" type="button" disabled aria-busy="true" data-side="${state.side}">Submitting…</button>`;
			}
			if (state.confirming && ready) {
				const q2 = state.quote;
				const outAsset = q2.out?.asset === 'SOL' ? 'SOL' : (state.coin?.symbol || 'tokens');
				const outStr = q2.out?.asset === 'SOL' ? `◎${formatSol(q2.out?.amount)}` : `${fmtTokens(q2.out?.amount)} ${esc(outAsset)}`;
				const payStr = state.side === 'buy' ? `◎${formatSol(Number(state.buySol))} SOL` : `${fmtTokens(rawToUi(state.sellRaw, state.sellDecimals))} ${esc(state.coin?.symbol || 'tokens')}`;
				return `<div class="awh-tr-confirm" role="group" aria-label="Confirm trade">
					<div class="awh-tr-confirm-h">Confirm ${state.side === 'buy' ? 'buy' : 'sell'}</div>
					<dl class="awh-tr-quote" style="border:none;padding:0;background:none">
						<div class="awh-tr-qrow"><dt>You ${state.side === 'buy' ? 'pay' : 'sell'}</dt><dd class="is-strong">${esc(payStr)}</dd></div>
						<div class="awh-tr-qrow"><dt>You receive ≈</dt><dd class="is-strong">${esc(outStr)}</dd></div>
						<div class="awh-tr-qrow"><dt>Minimum</dt><dd>${q2.out?.asset === 'SOL' ? `◎${formatSol(q2.min_received?.amount)}` : `${fmtTokens(q2.min_received?.amount)} ${esc(outAsset)}`}</dd></div>
					</dl>
					<div class="awh-tr-confirm-actions">
						<button class="awh-btn" type="button" data-tr="cancel">Cancel</button>
						<button class="awh-btn awh-btn--primary awh-tr-submit" type="button" data-tr="confirm" data-side="${state.side}">Confirm ${state.side}</button>
					</div>
				</div>`;
			}
			if (fundsInsufficient) {
				return `<button class="awh-btn awh-btn--primary awh-tr-deposit-cta" type="button" data-tr="deposit">Add funds to ${esc(ctx.agent.name || 'this wallet')}</button>`;
			}
			return `<button class="awh-btn awh-btn--primary awh-tr-submit" type="button" data-tr="review" data-side="${state.side}" ${ready ? '' : 'disabled'}>
				${state.side === 'buy' ? `Buy ${esc(sym)}` : `Sell ${esc(sym)}`}
			</button>`;
		}
		function renderActions() {
			const host = panel.querySelector('[data-host="actions"]');
			if (host) { host.innerHTML = actionsInnerHtml(); wireActionEvents(); }
		}

		function resultInnerHtml() {
			const r = state.result;
			if (!r) return '';
			if (r.ok) {
				return `<div class="awh-tr-result awh-tr-result--ok" role="status">
					<span aria-hidden="true">✓</span>
					<span>${r.message}${r.explorer ? ` <a href="${esc(r.explorer)}" target="_blank" rel="noopener">View on explorer ↗</a>` : ''}</span>
				</div>`;
			}
			return `<div class="awh-tr-result awh-tr-result--err" role="alert">
				<span aria-hidden="true">⚠</span>
				<span>${esc(r.message)}${r.insufficient ? ` <button class="awh-tr-link" type="button" data-tr="deposit" style="color:inherit;font-weight:600;text-decoration:underline">Add funds →</button>` : ''}${r.explorer ? ` <a href="${esc(r.explorer)}" target="_blank" rel="noopener">Check explorer ↗</a>` : ''}</span>
			</div>`;
		}

		// ── holdings card ────────────────────────────────────────────────────────
		function holdingsCardHtml() {
			let inner;
			if (!state.holdingsLoaded) {
				inner = `<div class="awh-tr-skel-row"></div><div class="awh-tr-skel-row" style="width:70%"></div>`;
			} else if (state.holdingsError) {
				inner = `<div class="awh-empty">Couldn’t load holdings. <button class="awh-btn awh-bal-mini" type="button" data-tr="retry-holdings">Retry</button></div>`;
			} else if (!state.holdings || !state.holdings.length) {
				inner = `<div class="awh-empty">No token holdings yet.${state.isOwner ? ' Buy a coin above and it’ll appear here.' : ''}</div>`;
			} else {
				inner = `<ul class="awh-tr-hold-list">${state.holdings.map(holdingRowHtml).join('')}</ul>`;
			}
			return `<div class="awh-card">
				<h2 class="awh-card-h">Holdings${state.solBalance != null ? ` · ◎${formatSol(state.solBalance)} SOL` : ''}</h2>
				<div data-host="holdings">${inner}</div>
			</div>`;
		}
		function holdingRowHtml(t) {
			const sym = t.mint === state.coin?.mint && state.coin?.symbol ? state.coin.symbol : short(t.mint, 4, 4);
			const sellable = state.isOwner;
			return `<li><button class="awh-tr-hold" type="button" ${sellable ? `data-sell-mint="${esc(t.mint)}" data-sell-dec="${t.decimals ?? 6}"` : 'disabled'}>
				<div>
					<div class="awh-tr-hold-sym">${esc(sym)}</div>
					<div class="awh-tr-hold-mint">${short(t.mint, 6, 6)}</div>
				</div>
				<span class="awh-tr-hold-amt">${fmtTokens(Number(t.ui_amount))}</span>
				${sellable ? '<span class="awh-tr-hold-cta">Sell →</span>' : ''}
			</button></li>`;
		}

		// ── history card ──────────────────────────────────────────────────────────
		function historyCardHtml() {
			if (!state.isOwner) return '';
			let inner;
			if (!state.historyLoaded) {
				inner = `<div class="awh-tr-skel-row"></div><div class="awh-tr-skel-row" style="width:80%"></div><div class="awh-tr-skel-row" style="width:60%"></div>`;
			} else if (state.historyError) {
				inner = `<div class="awh-empty">Couldn’t load trade history. <button class="awh-btn awh-bal-mini" type="button" data-tr="retry-history">Retry</button></div>`;
			} else if (!state.history || !state.history.length) {
				inner = `<div class="awh-empty">No trades yet. Your buys, sells, and sniper exits show up here.</div>`;
			} else {
				inner = `<ul class="awh-tr-hist-list">${state.history.map(historyRowHtml).join('')}</ul>`;
			}
			return `<div class="awh-card">
				<h2 class="awh-card-h">Trade history</h2>
				<div data-host="history">${inner}</div>
			</div>`;
		}
		function historyRowHtml(it) {
			if (it.source === 'sniper') {
				const pnl = it.pnl_sol;
				const cls = pnl == null ? '' : pnl >= 0 ? 'awh-tr-pnl-pos' : 'awh-tr-pnl-neg';
				const pnlStr = pnl == null ? '' : `${pnl >= 0 ? '+' : ''}◎${formatSol(pnl)}${it.pnl_pct != null ? ` (${it.pnl_pct >= 0 ? '+' : ''}${it.pnl_pct.toFixed(1)}%)` : ''}`;
				return `<li class="awh-tr-hist">
					<span class="awh-tr-hist-side is-snipe">Snipe</span>
					<div class="awh-tr-hist-main"><div class="awh-tr-hist-mint">${esc(it.symbol || short(it.mint, 5, 5))}</div><div class="awh-tr-hist-sub">${esc(it.exit_reason || 'closed')} · ${esc(timeAgo(Math.floor(new Date(it.at).getTime() / 1000)))}</div></div>
					<span class="awh-tr-hist-val ${cls}">${it.sell_url ? `<a href="${esc(it.sell_url)}" target="_blank" rel="noopener">${esc(pnlStr)}</a>` : esc(pnlStr)}</span>
				</li>`;
			}
			const isBuy = it.side === 'buy';
			const val = it.sol_amount != null ? `${isBuy ? '−' : '+'}◎${formatSol(it.sol_amount)}` : (it.token_amount_raw ? `${fmtTokens(rawToUi(it.token_amount_raw, 6))}` : '');
			const statusNote = it.status && it.status !== 'confirmed' ? ` · ${esc(it.status)}` : '';
			return `<li class="awh-tr-hist">
				<span class="awh-tr-hist-side ${isBuy ? 'is-buy' : 'is-sell'}">${isBuy ? 'Buy' : 'Sell'}</span>
				<div class="awh-tr-hist-main"><div class="awh-tr-hist-mint">${esc(it.mint ? short(it.mint, 5, 5) : 'trade')}</div><div class="awh-tr-hist-sub">${esc(it.venue === 'amm' ? 'AMM' : 'curve')}${statusNote} · ${esc(timeAgo(Math.floor(new Date(it.at).getTime() / 1000)))}</div></div>
				<span class="awh-tr-hist-val">${it.explorer ? `<a href="${esc(it.explorer)}" target="_blank" rel="noopener">${esc(val)}</a>` : esc(val)}</span>
			</li>`;
		}

		// ── event wiring ──────────────────────────────────────────────────────────
		function wireEvents() {
			const mintEl = panel.querySelector('[data-tr="mint"]');
			if (mintEl) {
				mintEl.addEventListener('input', () => {
					const v = mintEl.value.trim();
					state.mintInput = v;
					if (MINT_RE.test(v)) {
						if (state.coin?.mint !== v) resolveCoin(v);
					} else {
						state.coin = null;
						state.quote = null;
						state.quoteError = null;
						renderQuote();
						renderActions();
						const cp = panel.querySelector('.awh-tr-coin');
						if (cp) cp.remove();
					}
				});
			}
			panel.querySelectorAll('.awh-tr-side [data-side]').forEach((b) => {
				b.addEventListener('click', () => {
					if (state.side === b.dataset.side) return;
					state.side = b.dataset.side;
					if (state.side === 'sell') syncSellDecimals();
					state.confirming = false;
					state.result = null;
					renderAll();
					scheduleQuote();
				});
			});

			const buySolEl = panel.querySelector('[data-tr="buySol"]');
			if (buySolEl) buySolEl.addEventListener('input', () => {
				state.buySol = buySolEl.value.replace(/[^0-9.]/g, '');
				state.confirming = false;
				const usdEl = panel.querySelector('.awh-tr-amt-usd');
				if (usdEl) usdEl.textContent = state.solPrice && Number(state.buySol) > 0 ? `≈ ${fmtUsd(Number(state.buySol) * state.solPrice)}` : '';
				scheduleQuote();
			});
			const sellUiEl = panel.querySelector('[data-tr="sellUi"]');
			if (sellUiEl) sellUiEl.addEventListener('input', () => {
				const v = sellUiEl.value.replace(/[^0-9.]/g, '');
				state.sellRaw = uiToRaw(v, state.sellDecimals);
				state.confirming = false;
				scheduleQuote();
			});

			panel.querySelectorAll('[data-buychip]').forEach((b) => b.addEventListener('click', () => {
				state.buySol = String(Number(b.dataset.buychip));
				state.confirming = false;
				renderAmount();
				scheduleQuote();
			}));
			panel.querySelectorAll('[data-sellchip]').forEach((b) => b.addEventListener('click', () => {
				const h = (state.holdings || []).find((t) => t.mint === state.coin?.mint);
				if (!h) return;
				state.sellRaw = pctOfRaw(h.amount_raw, Number(b.dataset.sellchip));
				state.sellDecimals = h.decimals ?? 6;
				state.confirming = false;
				renderAmount();
				scheduleQuote();
			}));

			panel.querySelectorAll('[data-slip]').forEach((b) => b.addEventListener('click', () => {
				state.slippageBps = Number(b.dataset.slip);
				renderSlippage();
				scheduleQuote();
			}));
			const slipEl = panel.querySelector('[data-tr="slipBps"]');
			if (slipEl) slipEl.addEventListener('input', () => {
				const n = Math.max(0, Math.min(5000, Math.round(Number(slipEl.value) || 0)));
				state.slippageBps = n || 300;
				panel.querySelectorAll('[data-slip]').forEach((x) => x.setAttribute('aria-pressed', String(state.slippageBps === Number(x.dataset.slip))));
				scheduleQuote();
			});

			panel.querySelector('[data-tr="retry-holdings"]')?.addEventListener('click', async () => {
				state.holdingsLoaded = false; renderAll(); await loadHoldings(); renderAll();
			});
			panel.querySelector('[data-tr="retry-history"]')?.addEventListener('click', async () => {
				state.historyLoaded = false; renderAll(); await loadHistory(); renderAll();
			});
			panel.querySelectorAll('[data-sell-mint]').forEach((b) => b.addEventListener('click', () => {
				const mint = b.dataset.sellMint;
				state.side = 'sell';
				state.mintInput = mint;
				state.sellDecimals = Number(b.dataset.sellDec) || 6;
				const h = (state.holdings || []).find((t) => t.mint === mint);
				state.sellRaw = h ? h.amount_raw : '0';
				state.result = null;
				state.confirming = false;
				renderAll();
				resolveCoin(mint);
				panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
			}));

			wireActionEvents();
		}

		function wireActionEvents() {
			panel.querySelector('[data-tr="review"]')?.addEventListener('click', () => {
				state.confirming = true; renderActions();
				// Move focus into the confirm step so keyboard users land on the decision.
				panel.querySelector('[data-tr="confirm"]')?.focus();
			});
			panel.querySelector('[data-tr="cancel"]')?.addEventListener('click', () => {
				state.confirming = false; renderActions();
				panel.querySelector('[data-tr="review"]')?.focus();
			});
			panel.querySelector('[data-tr="confirm"]')?.addEventListener('click', submit);
			// Escape backs out of the confirm step without submitting — never a keyboard trap.
			panel.querySelector('.awh-tr-confirm')?.addEventListener('keydown', (e) => {
				if (e.key !== 'Escape') return;
				e.preventDefault();
				state.confirming = false; renderActions();
				panel.querySelector('[data-tr="review"]')?.focus();
			});
			panel.querySelectorAll('[data-tr="deposit"]').forEach((b) => b.addEventListener('click', () => {
				ctx.openTab?.('deposit');
			}));
		}

		// Partial re-renders to keep focus/caret stable while typing.
		function renderAmount() {
			const host = panel.querySelector('.awh-tr-amt')?.closest('.awh-tr-field');
			if (!host) { renderAll(); return; }
			host.outerHTML = amountFieldHtml();
			// Re-wire just the amount controls.
			const buySolEl = panel.querySelector('[data-tr="buySol"]');
			if (buySolEl) buySolEl.addEventListener('input', () => {
				state.buySol = buySolEl.value.replace(/[^0-9.]/g, '');
				state.confirming = false;
				const usdEl = panel.querySelector('.awh-tr-amt-usd');
				if (usdEl) usdEl.textContent = state.solPrice && Number(state.buySol) > 0 ? `≈ ${fmtUsd(Number(state.buySol) * state.solPrice)}` : '';
				scheduleQuote();
			});
			const sellUiEl = panel.querySelector('[data-tr="sellUi"]');
			if (sellUiEl) sellUiEl.addEventListener('input', () => {
				state.sellRaw = uiToRaw(sellUiEl.value.replace(/[^0-9.]/g, ''), state.sellDecimals);
				state.confirming = false;
				scheduleQuote();
			});
			panel.querySelectorAll('[data-buychip]').forEach((b) => b.addEventListener('click', () => {
				state.buySol = String(Number(b.dataset.buychip)); state.confirming = false; renderAmount(); scheduleQuote();
			}));
			panel.querySelectorAll('[data-sellchip]').forEach((b) => b.addEventListener('click', () => {
				const h = (state.holdings || []).find((t) => t.mint === state.coin?.mint);
				if (!h) return;
				state.sellRaw = pctOfRaw(h.amount_raw, Number(b.dataset.sellchip));
				state.confirming = false; renderAmount(); scheduleQuote();
			}));
		}
		function renderSlippage() {
			const host = panel.querySelector('.awh-tr-slip')?.closest('.awh-tr-field');
			if (!host) return;
			host.outerHTML = slippageHtml();
			panel.querySelectorAll('[data-slip]').forEach((b) => b.addEventListener('click', () => {
				state.slippageBps = Number(b.dataset.slip); renderSlippage(); scheduleQuote();
			}));
			const slipEl = panel.querySelector('[data-tr="slipBps"]');
			if (slipEl) slipEl.addEventListener('input', () => {
				const n = Math.max(0, Math.min(5000, Math.round(Number(slipEl.value) || 0)));
				state.slippageBps = n || 300;
				panel.querySelectorAll('[data-slip]').forEach((x) => x.setAttribute('aria-pressed', String(state.slippageBps === Number(x.dataset.slip))));
				scheduleQuote();
			});
		}

		// ── lifecycle ─────────────────────────────────────────────────────────────
		let firstShow = true;
		detachNet = ctx.onNetworkChange(() => {
			state.holdingsLoaded = false; state.historyLoaded = false;
			state.coin = null; state.quote = null; state.result = null; state.mintInput = '';
			renderAll();
			Promise.all([loadHoldings(), loadHistory()]).then(() => renderAll());
		});

		renderAll();

		return {
			async onShow() {
				if (firstShow) {
					firstShow = false;
					loadSolPrice();
					await Promise.all([loadHoldings(), loadHistory()]);
					if (!destroyed) renderAll();
				}
			},
			onHide() { clearTimeout(quoteTimer); state.confirming = false; },
			destroy() {
				destroyed = true;
				clearTimeout(quoteTimer);
				safety?.destroy();
				detachNet?.();
			},
		};
	},
});
