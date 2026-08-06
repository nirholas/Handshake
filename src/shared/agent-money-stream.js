/**
 * Money Streams — pay an agent by the second, settled for real on Solana.
 *
 * A "stream" is an authorized rate + a real periodic micro-settlement, never a
 * fake counter. The streamer connects their own browser wallet (Phantom /
 * Backpack / Solflare — same detection as ./agent-tip.js), authorizes a
 * { rate-per-minute, asset, max-total } session, and from then on their browser:
 *
 *   1. Meters the *active* streaming time (paused when the tab is hidden, so you
 *      never pay while you're not watching).
 *   2. On a fixed cadence (and on stop) builds + signs a transfer of the
 *      accrued-since-last amount to the agent's PUBLIC solana_address, submits it
 *      through the same-origin RPC proxy, and waits for confirmation. Each
 *      settlement is a REAL on-chain transfer — three.ws never custodies the funds.
 *   3. POSTs each confirmed signature to /api/agents/:id/solana/stream, which
 *      re-verifies on-chain that the agent was credited and records a public
 *      custody event grouped by a client-generated stream_id.
 *
 * The live "ticking" number is the *projected* accrual between settlements; after
 * every settle it is reconciled to the server-confirmed on-chain total, so the
 * displayed figure is always backed by real signatures. `maxTotal` is a hard
 * ceiling the streamer signs for — enforced here (the meter can never project past
 * it and a final settle never exceeds it) AND on the server (it refuses any
 * settlement that would push a session over its signed ceiling). Closing the tab,
 * navigating away, or losing the wallet stops the meter to the second: no further
 * signatures means no further charges.
 *
 * Public API:
 *   openStreamPanel(agent, { network })   → modal with the live meter + controls,
 *                                            or the owner's live earnings view.
 *   mountStreamMeter(el, agent, { network, compact }) → embed the meter inline
 *                                            (chat pay-per-minute, club pay-to-watch).
 */

import {
	Connection,
	PublicKey,
	SystemProgram,
	Transaction,
	LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
	getAssociatedTokenAddress,
	getAccount,
	createAssociatedTokenAccountInstruction,
	createTransferCheckedInstruction,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { detectSolanaWallet, SOLANA_RPC, solanaTxExplorerUrl } from '../erc8004/solana-deploy.js';
import { USDC_MINT } from './agent-tip.js';
import { getWalletStatus } from './agent-wallet-chip.js';

const STYLE_ID = 'tws-money-stream-styles';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Settle cadence + batching. We settle every SETTLE_INTERVAL_MS of active time,
// but only when at least MIN_SETTLE of the asset has accrued — so tiny rates batch
// up instead of paying a network fee on dust. A stop always does a final settle of
// whatever is left above true dust.
const SETTLE_INTERVAL_MS = 45_000;
const TICK_MS = 100;
const MIN_SETTLE = { SOL: 0.0005, USDC: 0.01 };
const DUST = { SOL: 0.000001, USDC: 0.000001 };

/** Supported stream assets + per-minute rate presets and sensible budget caps. */
export const STREAM_ASSETS = Object.freeze([
	{ id: 'SOL', label: 'SOL', symbol: '◎', decimals: 9, ratePresets: [0.002, 0.005, 0.01, 0.05] },
	{ id: 'USDC', label: 'USDC', symbol: '$', decimals: 6, ratePresets: [0.1, 0.25, 0.5, 1] },
]);

/** A stream error that carries a machine code so the UI can tailor recovery copy. */
export class StreamError extends Error {
	constructor(message, code = 'stream_failed') {
		super(message);
		this.name = 'StreamError';
		this.code = code;
	}
}

/**
 * Pure accrual math — the amount owed for a given rate over a span of *active*
 * streaming time, hard-capped at the signed ceiling. This is the money-safety
 * invariant: no matter how long a stream runs, the projected/owed amount can never
 * exceed `maxTotal`. Exported so it can be unit-tested in isolation.
 *
 * @param {object} p
 * @param {number} p.ratePerMinute  Asset units charged per minute (> 0).
 * @param {number} p.activeMs       Accumulated active streaming time in ms (>= 0).
 * @param {number} p.maxTotal       Signed spend ceiling in asset units (> 0).
 * @returns {number} owed asset units, never above maxTotal.
 */
export function accruedHuman({ ratePerMinute, activeMs, maxTotal }) {
	const rate = Number(ratePerMinute);
	const ms = Number(activeMs);
	const cap = Number(maxTotal);
	if (!(rate > 0) || !(ms > 0)) return 0;
	const owed = (rate / 60_000) * ms;
	return Number.isFinite(cap) && cap > 0 ? Math.min(cap, owed) : owed;
}

function prefersReducedMotion() {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function uuid() {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
	// RFC4122-ish fallback for older webviews — only used as a grouping id.
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function assetMeta(id) {
	return STREAM_ASSETS.find((a) => a.id === id) || STREAM_ASSETS[0];
}

/** Format an asset amount with enough precision for tiny per-second values. */
function fmtAmount(n, asset) {
	const v = Number(n) || 0;
	if (asset === 'USDC') return v.toFixed(v < 1 ? 4 : 2);
	// SOL — show up to 6 dp but trim trailing zeros past 4.
	return v.toFixed(6).replace(/(\.\d{4}?)0+$/, '$1');
}

function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return null;
	if (v === 0) return '$0.00';
	if (v < 0.01) return `$${v.toFixed(4)}`;
	if (v < 1) return `$${v.toFixed(3)}`;
	return `$${v.toFixed(2)}`;
}

function fmtClock(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (x) => String(x).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// Poll signature status over HTTP (the proxy refuses WebSocket subscriptions).
// Returns 'confirmed' on success, throws StreamError('onchain_error') on tx error,
// throws StreamError('timeout') if it never resolves in the window.
async function confirmSignature(conn, signature, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let value;
		try {
			({ value } = await conn.getSignatureStatuses([signature]));
		} catch {
			value = null;
		}
		const status = value?.[0];
		if (status) {
			if (status.err) throw new StreamError(`Settlement failed on-chain: ${JSON.stringify(status.err)}`, 'onchain_error');
			if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return true;
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	throw new StreamError('Settlement timed out — it may still land; the meter is paused until it confirms.', 'timeout');
}

// ── the stream engine ───────────────────────────────────────────────────────────

class MoneyStreamEngine {
	constructor({ agentId, toAddress, asset, ratePerMinute, maxTotal, network }) {
		this.agentId = agentId || null;
		this.toAddress = toAddress;
		this.asset = asset === 'USDC' ? 'USDC' : 'SOL';
		this.ratePerMinute = Number(ratePerMinute);
		this.maxTotal = Number(maxTotal);
		this.network = network === 'devnet' ? 'devnet' : 'mainnet';
		this.streamId = uuid();

		this.state = 'idle'; // idle | connecting | streaming | paused | settling | stopped | error
		this.error = null;

		this.settledHuman = 0; // reconciled to on-chain confirmations
		this.settledUsd = 0;
		this.receipts = []; // { signature, explorerUrl, amount, usd, at, pending }
		this.usdPerAsset = null; // derived from settle responses for live USD projection

		this._bankedMs = 0; // active streaming ms banked before the current segment
		this._activeSince = null; // timestamp the current active segment started (null when paused)
		this._wallet = null;
		this._from = null;
		this._conn = null;
		this._settleTimer = null;
		this._tickTimer = null;
		this._settleInFlight = false;

		this._listeners = { tick: [], settle: [], state: [], error: [] };
		this._onVisibility = this._handleVisibility.bind(this);
		this._onPageHide = this._handlePageHide.bind(this);
	}

	on(evt, fn) {
		(this._listeners[evt] ||= []).push(fn);
		return () => { this._listeners[evt] = this._listeners[evt].filter((f) => f !== fn); };
	}
	_emit(evt, ...args) {
		for (const fn of this._listeners[evt] || []) {
			try { fn(...args); } catch { /* listener best-effort */ }
		}
	}
	_setState(s, err = null) {
		this.state = s;
		this.error = err;
		this._emit('state', s, err);
	}

	activeMs() {
		return this._bankedMs + (this._activeSince != null ? Date.now() - this._activeSince : 0);
	}

	/** Total owed for the active time so far, hard-capped at the signed ceiling. */
	owedHuman() {
		return accruedHuman({ ratePerMinute: this.ratePerMinute, activeMs: this.activeMs(), maxTotal: this.maxTotal });
	}

	/** Live projected amount the meter shows (settled + unsettled accrual). */
	projectedHuman() {
		return Math.max(this.settledHuman, this.owedHuman());
	}

	projectedUsd() {
		if (this.usdPerAsset == null) return null;
		return this.projectedHuman() * this.usdPerAsset;
	}

	atCeiling() {
		return this.settledHuman >= this.maxTotal - DUST[this.asset];
	}

	async start() {
		if (this.state === 'streaming' || this.state === 'connecting') return;
		if (!this.toAddress || !BASE58_RE.test(String(this.toAddress))) {
			throw new StreamError('This agent has no valid wallet to stream to.', 'no_address');
		}
		if (!(this.ratePerMinute > 0)) throw new StreamError('Set a rate above zero to start streaming.', 'bad_rate');
		if (!(this.maxTotal > 0)) throw new StreamError('Set a spend cap above zero.', 'bad_cap');

		this._setState('connecting');
		const wallet = detectSolanaWallet();
		if (!wallet) {
			this._setState('error', new StreamError('No Solana wallet found. Install Phantom, Backpack, or Solflare to stream.', 'no_wallet'));
			throw this.error;
		}
		let fromPubkey;
		try {
			const conn = await wallet.connect();
			fromPubkey = conn?.publicKey || wallet.publicKey;
		} catch (e) {
			const err = (e?.code === 4001 || /reject|cancel/i.test(e?.message || ''))
				? new StreamError('Wallet connection cancelled.', 'cancelled')
				: new StreamError(e?.message || 'Could not connect your wallet.', 'connect_failed');
			this._setState('error', err);
			throw err;
		}
		if (!fromPubkey) {
			const err = new StreamError('Could not read your wallet address.', 'connect_failed');
			this._setState('error', err);
			throw err;
		}
		this._wallet = wallet;
		this._from = new PublicKey(fromPubkey.toString());
		if (this._from.equals(new PublicKey(String(this.toAddress)))) {
			const err = new StreamError('That wallet is the agent itself — stream from a different wallet.', 'self_stream');
			this._setState('error', err);
			throw err;
		}
		this._conn = new Connection(SOLANA_RPC[this.network] || SOLANA_RPC.mainnet, 'confirmed');

		this._bankedMs = 0;
		this._activeSince = Date.now();
		this._setState('streaming');
		this._startTimers();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this._onVisibility);
			window.addEventListener('pagehide', this._onPageHide);
			window.addEventListener('beforeunload', this._onPageHide);
		}
		this._emit('tick');
		return this.fromAddress();
	}

	fromAddress() {
		return this._from ? this._from.toBase58() : null;
	}

	_startTimers() {
		this._stopTimers();
		// Settle cadence runs on real wall-clock; it no-ops while paused/at ceiling.
		this._settleTimer = setInterval(() => { this._maybeSettle('interval'); }, SETTLE_INTERVAL_MS);
		// Smooth counter — skipped under reduced-motion (the meter then updates on
		// settle only, which the renderer also redraws).
		if (!prefersReducedMotion()) {
			this._tickTimer = setInterval(() => {
				if (this.state === 'streaming') this._emit('tick');
				// Self-stop the instant projection reaches the ceiling.
				if (this.state === 'streaming' && this.owedHuman() >= this.maxTotal - DUST[this.asset]) {
					this._maybeSettle('ceiling');
				}
			}, TICK_MS);
		}
	}
	_stopTimers() {
		if (this._settleTimer) { clearInterval(this._settleTimer); this._settleTimer = null; }
		if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
	}

	_pauseAccrual() {
		if (this._activeSince != null) {
			this._bankedMs += Date.now() - this._activeSince;
			this._activeSince = null;
		}
	}
	_resumeAccrual() {
		if (this._activeSince == null) this._activeSince = Date.now();
	}

	_handleVisibility() {
		if (typeof document === 'undefined') return;
		if (document.visibilityState === 'hidden') {
			// Leaving the tab = no longer present. Freeze the meter immediately so we
			// never accrue charges for time the streamer isn't watching. We do NOT try
			// to settle here: a wallet can't pop a signing prompt for a hidden tab, so
			// the attempt would hang or fail. The accrued-but-unsettled amount simply
			// settles on the next interval once they return, or on an explicit stop —
			// and if they never return, it's never charged (fail-safe toward the user).
			if (this.state === 'streaming') {
				this._pauseAccrual();
				this._setState('paused');
			}
		} else if (document.visibilityState === 'visible' && this.state === 'paused') {
			this._resumeAccrual();
			this._setState('streaming');
			this._emit('tick');
		}
	}

	// On hard unload we cannot reliably pop a signing prompt, so we simply halt
	// accrual. No further signatures can be produced, so no further charges — the
	// safety guarantee holds without any unload-time signing hack.
	_handlePageHide() {
		this._pauseAccrual();
		this._stopTimers();
	}

	/** Amount currently unsettled (owed minus what's been confirmed on-chain). */
	_unsettled() {
		return Math.max(0, this.owedHuman() - this.settledHuman);
	}

	async _maybeSettle(reason) {
		if (this._settleInFlight) return;
		if (!this._conn || !this._wallet || !this._from) return;
		// Never auto-settle while paused (tab hidden) — the wallet can't show a
		// signing prompt. An explicit stop is the one exception (the tab is visible).
		if (this.state === 'paused' && reason !== 'stop') return;
		const unsettled = this._unsettled();
		// Routine interval settles batch until a meaningful amount has accrued (so
		// tiny rates don't pay a network fee on dust); a stop/ceiling settle flushes
		// everything above true dust.
		const min = reason === 'interval' ? MIN_SETTLE[this.asset] : DUST[this.asset];
		if (unsettled < min) {
			if (reason === 'ceiling' || reason === 'stop') this._finishIfCeiling(reason);
			return;
		}
		await this._settle(unsettled, reason);
	}

	async _settle(amountHuman, reason) {
		this._settleInFlight = true;
		const wasState = this.state;
		// Don't flip the visible state to "settling" for routine interval settles —
		// keep the meter live; only a stop/ceiling settle shows the settling state.
		if (reason === 'stop' || reason === 'ceiling') this._setState('settling');
		let result;
		try {
			result = await this._sendSettlement(amountHuman);
		} catch (e) {
			this._settleInFlight = false;
			const err = e instanceof StreamError ? e : new StreamError(e?.message || 'Settlement failed.', 'settle_failed');
			// A rejected/failed settle never increments settled — no double charge.
			// Stop the stream so we don't keep prompting against a broken wallet/RPC.
			this._setState('error', err);
			this._emit('error', err);
			this._teardown();
			return;
		}

		// The transfer confirmed on-chain — count it locally even if the server
		// record (best-effort, idempotent) fails. Funds have moved.
		this.settledHuman += amountHuman;
		const receipt = { signature: result.signature, explorerUrl: result.explorerUrl, amount: amountHuman, usd: null, at: Date.now(), pending: true };
		this.receipts.push(receipt);
		this._settleInFlight = false;

		// Record + reconcile to the server's on-chain-verified total.
		try {
			const rec = await this._record(result.signature);
			if (rec) {
				if (rec.usd != null && Number(rec.amount) > 0) {
					this.usdPerAsset = Number(rec.usd) / Number(rec.amount);
					receipt.usd = Number(rec.usd);
				}
				if (Number.isFinite(rec.settled_so_far)) {
					// Reconcile the display to the on-chain-confirmed cumulative total.
					this.settledHuman = Math.max(this.settledHuman, Number(rec.settled_so_far));
				}
				receipt.pending = false;
			}
		} catch { /* already counted locally; record is a best-effort hint */ }

		if (this.usdPerAsset != null) this.settledUsd = this.settledHuman * this.usdPerAsset;

		this._emit('settle', receipt);
		this._emit('tick');
		// Broadcast so other surfaces (the agent's 3D avatar, money map) can react.
		if (typeof window !== 'undefined') {
			try {
				window.dispatchEvent(new CustomEvent('tws:money-stream-settle', {
					detail: { agentId: this.agentId, amount: amountHuman, asset: this.asset, usd: receipt.usd, signature: result.signature, streamId: this.streamId },
				}));
			} catch { /* no-op */ }
		}

		// Resolve the post-settle state.
		if (this.atCeiling() || reason === 'ceiling') {
			this._finishIfCeiling(reason);
		} else if (reason === 'stop') {
			this._setState('stopped');
			this._teardown();
		} else if (wasState === 'paused') {
			this._setState('paused');
		} else {
			this._setState('streaming');
		}
	}

	_finishIfCeiling(reason) {
		this._setState('stopped', reason === 'ceiling' ? new StreamError('Spend cap reached — the stream stopped automatically.', 'ceiling_reached') : null);
		this._teardown();
	}

	async _sendSettlement(amountHuman) {
		const conn = this._conn;
		const from = this._from;
		const to = new PublicKey(String(this.toAddress));
		const tx = new Transaction();
		if (this.asset === 'USDC') {
			const mint = new PublicKey(USDC_MINT[this.network] || USDC_MINT.mainnet);
			const fromAta = await getAssociatedTokenAddress(mint, from);
			const toAta = await getAssociatedTokenAddress(mint, to);
			try {
				await getAccount(conn, fromAta);
			} catch {
				throw new StreamError('Your wallet has no USDC. Switch to SOL or fund your wallet with USDC.', 'no_usdc');
			}
			let toExists = true;
			try { await getAccount(conn, toAta); } catch { toExists = false; }
			if (!toExists) tx.add(createAssociatedTokenAccountInstruction(from, toAta, to, mint));
			const raw = BigInt(Math.round(amountHuman * 1e6));
			if (raw <= 0n) throw new StreamError('Accrued amount is below one atomic unit.', 'dust');
			tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, from, raw, 6, [], TOKEN_PROGRAM_ID));
		} else {
			const lamports = Math.round(amountHuman * LAMPORTS_PER_SOL);
			if (lamports <= 0) throw new StreamError('Accrued amount is below one lamport.', 'dust');
			tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
		}

		let blockhashCtx;
		try {
			blockhashCtx = await conn.getLatestBlockhash('confirmed');
		} catch {
			throw new StreamError('Network is busy — could not fetch a blockhash. The meter is paused.', 'rpc_error');
		}
		tx.recentBlockhash = blockhashCtx.blockhash;
		tx.lastValidBlockHeight = blockhashCtx.lastValidBlockHeight;
		tx.feePayer = from;

		let signed;
		try {
			signed = await this._wallet.signTransaction(tx);
		} catch (e) {
			if (e?.code === 4001 || /reject|cancel/i.test(e?.message || '')) {
				throw new StreamError('You declined the settlement — the stream stopped.', 'cancelled');
			}
			throw new StreamError(e?.message || 'Signing failed.', 'sign_failed');
		}

		// Submit with a couple of retries for transient RPC throttling. We only ever
		// send THIS blockhash-bound tx — never a second tx for the same accrual — so a
		// retry can't double-charge (a duplicate is the same signature).
		let signature;
		let lastErr;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
				break;
			} catch (e) {
				lastErr = e;
				const msg = e?.message || '';
				if (/insufficient|0x1\b/i.test(msg)) {
					throw new StreamError('Insufficient balance for the next settlement plus fees. Lower the rate or add funds.', 'insufficient');
				}
				if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
			}
		}
		if (!signature) throw new StreamError(lastErr?.message || 'The settlement could not be submitted.', 'send_failed');

		await confirmSignature(conn, signature);
		return { signature, explorerUrl: solanaTxExplorerUrl(this.network, signature) };
	}

	async _record(signature) {
		if (!this.agentId) return null;
		const res = await fetch(`/api/agents/${encodeURIComponent(this.agentId)}/solana/stream`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				signature,
				stream_id: this.streamId,
				asset: this.asset,
				network: this.network,
				rate_per_minute: this.ratePerMinute,
				max_total: this.maxTotal,
				from: this.fromAddress(),
			}),
			keepalive: true,
		});
		if (!res.ok) return null;
		const { data } = await res.json().catch(() => ({}));
		return data || null;
	}

	/** Stop the stream: a final settle of the remaining accrued, then close. */
	async stop() {
		if (this.state === 'stopped' || this.state === 'idle') return;
		this._pauseAccrual();
		this._stopTimers();
		await this._maybeSettle('stop');
		if (this.state !== 'stopped') { this._setState('stopped'); this._teardown(); }
	}

	_teardown() {
		this._stopTimers();
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this._onVisibility);
			window.removeEventListener('pagehide', this._onPageHide);
			window.removeEventListener('beforeunload', this._onPageHide);
		}
	}

	destroy() {
		// Hard teardown without a settle (caller is dismounting). Any accrued-but-
		// unsettled amount is simply never charged — fail-safe toward the streamer.
		this._pauseAccrual();
		this._teardown();
		if (this.state === 'streaming' || this.state === 'paused') this._setState('stopped');
	}
}

// ── styles ───────────────────────────────────────────────────────────────────────

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.tms-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
	padding:16px;background:rgba(8,8,12,.66);backdrop-filter:blur(4px);animation:tms-fade .18s ease;}
.tms{width:100%;max-width:420px;background:var(--bg-1,#16161c);color:var(--ink,#e8e8ea);
	border:1px solid var(--stroke-strong,rgba(255,255,255,.12));border-radius:16px;
	box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden;
	font:14px/1.45 var(--font-body,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif);
	animation:tms-rise .2s cubic-bezier(.2,.8,.2,1);}
.tms-card{background:var(--surface-1,rgba(255,255,255,.03));border:1px solid var(--stroke,rgba(255,255,255,.08));
	border-radius:14px;overflow:hidden;}
.tms-hd{display:flex;align-items:center;gap:11px;padding:15px 18px;border-bottom:1px solid var(--stroke,rgba(255,255,255,.07));}
.tms-av{width:38px;height:38px;border-radius:10px;object-fit:cover;flex:none;
	background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);}
.tms-hd-txt{min-width:0;flex:1;}
.tms-hd-k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--wallet-accent,#c4b5fd);font-weight:700;display:flex;align-items:center;gap:6px;}
.tms-hd-n{font-size:15px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.tms-x{appearance:none;background:none;border:none;color:var(--ink-dim,#888);font-size:22px;line-height:1;
	cursor:pointer;padding:2px 4px;border-radius:6px;flex:none;transition:color .15s,background .15s;}
.tms-x:hover{color:#fff;background:rgba(255,255,255,.06);}
.tms-bd{padding:16px 18px 18px;}
.tms-live-dot{width:7px;height:7px;border-radius:50%;background:var(--success,#4ade80);box-shadow:0 0 0 0 rgba(74,222,128,.6);animation:tms-ping 1.4s ease-out infinite;}
.tms-live-dot[data-paused="1"]{background:var(--warn,#fbbf24);animation:none;}
@keyframes tms-ping{0%{box-shadow:0 0 0 0 rgba(74,222,128,.5)}70%{box-shadow:0 0 0 6px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}

/* meter */
.tms-meter{text-align:center;padding:18px 8px 14px;background:radial-gradient(120% 120% at 50% 0%,rgba(139,92,246,.12),transparent 70%);
	border-radius:12px;border:1px solid var(--wallet-stroke,rgba(139,92,246,.22));margin-bottom:14px;}
.tms-num{font:800 38px/1 var(--font-mono,ui-monospace,"JetBrains Mono",Menlo,monospace);color:#fff;
	letter-spacing:-.02em;font-feature-settings:"tnum";display:inline-flex;align-items:baseline;gap:7px;}
.tms-num .tms-sym{font-size:24px;color:var(--wallet-accent,#c4b5fd);}
.tms-num .tms-unit{font-size:14px;color:var(--ink-dim,#9a9aa2);font-weight:600;}
.tms-usd{margin-top:5px;font:600 13px/1 var(--font-mono,ui-monospace,Menlo,monospace);color:var(--ink-dim,#9a9aa2);}
.tms-sub{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:11px;font-size:11.5px;color:var(--ink-dim,#9a9aa2);}
.tms-sub b{color:var(--ink-bright,#fff);font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-weight:700;}
.tms-bar{height:5px;border-radius:999px;background:rgba(255,255,255,.08);margin-top:12px;overflow:hidden;}
.tms-bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--wallet-accent,#c4b5fd),var(--wallet-accent-strong,#a78bfa));
	width:0;transition:width .2s linear;}
.tms-cap-line{margin-top:6px;font-size:10.5px;color:var(--ink-faint,rgba(255,255,255,.5));text-align:right;}
.tms-meter.tms-pulse{animation:tms-flash .5s ease-out;}
@keyframes tms-flash{0%{box-shadow:0 0 0 0 rgba(139,92,246,.5)}100%{box-shadow:0 0 0 10px rgba(139,92,246,0)}}

/* controls */
.tms-toggle{display:flex;gap:6px;background:rgba(255,255,255,.04);border:1px solid var(--stroke,rgba(255,255,255,.08));
	border-radius:10px;padding:4px;margin-bottom:12px;}
.tms-tok{flex:1;appearance:none;font:inherit;font-weight:600;font-size:13px;color:var(--ink-dim,#9a9aa2);
	background:none;border:none;border-radius:7px;padding:7px 0;cursor:pointer;transition:background .15s,color .15s;}
.tms-tok[aria-pressed="true"]{background:rgba(139,92,246,.22);color:#c4b5fd;}
.tms-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-dim,#888);margin:2px 0 7px;font-weight:600;}
.tms-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:8px;}
.tms-pre{appearance:none;font:inherit;font-size:12.5px;color:var(--ink,#e8e8ea);background:rgba(255,255,255,.04);
	border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:8px;padding:8px 0;cursor:pointer;
	transition:border-color .15s,background .15s,transform .1s;font-family:var(--font-mono,ui-monospace,Menlo,monospace);}
.tms-pre:hover{background:rgba(255,255,255,.07);}
.tms-pre[aria-pressed="true"]{border-color:rgba(139,92,246,.6);background:rgba(139,92,246,.16);color:#c4b5fd;}
.tms-pre:active{transform:translateY(1px);}
.tms-field{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);
	border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:10px;padding:2px 12px;margin-bottom:12px;transition:border-color .15s;}
.tms-field:focus-within{border-color:rgba(139,92,246,.55);}
.tms-field input{flex:1;min-width:0;appearance:none;-moz-appearance:textfield;font:inherit;font-size:16px;font-weight:600;
	color:#fff;background:none;border:none;padding:9px 0;font-family:var(--font-mono,ui-monospace,Menlo,monospace);}
.tms-field input::-webkit-outer-spin-button,.tms-field input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.tms-field input:focus{outline:none;}
.tms-field .tms-unit{font-size:12px;font-weight:600;color:var(--ink-dim,#888);flex:none;font-family:var(--font-mono,ui-monospace,Menlo,monospace);}
.tms-go{width:100%;appearance:none;font:inherit;font-weight:700;font-size:14px;color:#0a0a0a;
	background:linear-gradient(180deg,#c4b5fd,#a78bfa);border:none;border-radius:11px;padding:13px 0;cursor:pointer;
	display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:filter .15s,transform .1s,opacity .15s;}
.tms-go:hover:not(:disabled){filter:brightness(1.08);}
.tms-go:active:not(:disabled){transform:translateY(1px);}
.tms-go:disabled{opacity:.55;cursor:not-allowed;}
.tms-go[data-variant="stop"]{background:linear-gradient(180deg,#fda4af,#f87171);color:#0a0a0a;}
.tms-go[data-variant="ghost"]{background:rgba(255,255,255,.06);color:var(--ink,#e8e8ea);border:1px solid var(--stroke,rgba(255,255,255,.12));}
.tms-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(10,10,10,.35);border-top-color:#0a0a0a;
	animation:tms-spin .7s linear infinite;flex:none;}
.tms-msg{font-size:12.5px;margin-top:11px;line-height:1.45;}
.tms-msg.err{color:#fca5a5;}
.tms-note{font-size:11px;color:var(--ink-dim,#6f6f78);margin-top:12px;text-align:center;line-height:1.4;}
.tms-kbd{font-family:var(--font-mono,ui-monospace,Menlo,monospace);font-size:10px;background:rgba(255,255,255,.07);
	border:1px solid var(--stroke,rgba(255,255,255,.12));border-radius:4px;padding:1px 5px;color:var(--ink-dim,#aaa);}

/* receipts */
.tms-receipts{margin-top:13px;display:flex;flex-direction:column;gap:5px;max-height:132px;overflow-y:auto;}
.tms-receipt{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--ink-dim,#9a9aa2);
	background:rgba(74,222,128,.07);border:1px solid rgba(74,222,128,.16);border-radius:8px;padding:6px 9px;animation:tms-rise .25s ease;}
.tms-receipt .tms-rc-ok{color:var(--success,#4ade80);font-weight:700;}
.tms-receipt[data-pending="1"]{background:rgba(255,255,255,.04);border-color:var(--stroke,rgba(255,255,255,.1));}
.tms-receipt .tms-rc-amt{font-family:var(--font-mono,ui-monospace,Menlo,monospace);color:var(--ink-bright,#fff);font-weight:600;}
.tms-receipt a{margin-left:auto;color:var(--wallet-accent,#c4b5fd);text-decoration:none;font-weight:600;white-space:nowrap;}
.tms-receipt a:hover{text-decoration:underline;}

/* earnings (owner) */
.tms-earn-now{display:flex;align-items:center;gap:12px;background:radial-gradient(120% 120% at 0% 0%,rgba(74,222,128,.14),transparent 70%);
	border:1px solid rgba(74,222,128,.25);border-radius:12px;padding:14px 16px;margin-bottom:14px;}
.tms-earn-big{font:800 26px/1 var(--font-mono,ui-monospace,Menlo,monospace);color:#fff;font-feature-settings:"tnum";}
.tms-earn-k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-dim,#9a9aa2);font-weight:600;}
.tms-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;}
.tms-stat{background:rgba(255,255,255,.04);border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:10px;padding:10px;text-align:center;}
.tms-stat-v{font:700 17px/1 var(--font-mono,ui-monospace,Menlo,monospace);color:#fff;}
.tms-stat-k{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-dim,#888);margin-top:4px;}
.tms-chart{display:flex;align-items:flex-end;gap:3px;height:54px;margin:4px 0 14px;}
.tms-chart-bar{flex:1;min-width:2px;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--wallet-accent,#c4b5fd),rgba(139,92,246,.3));
	transition:height .3s ease;min-height:2px;}
.tms-empty{text-align:center;color:var(--ink-dim,#9a9aa2);font-size:12.5px;padding:22px 10px;line-height:1.5;}
.tms-empty b{color:var(--ink-bright,#fff);}
.tms-skwrap{display:flex;flex-direction:column;gap:8px;padding:8px 0;}
.tms-sk{height:48px;border-radius:10px;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.12),rgba(255,255,255,.05));
	background-size:200% 100%;animation:tms-sk 1.1s ease-in-out infinite;}
@keyframes tms-sk{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* inline / compact */
.tms-inline{border:1px solid var(--wallet-stroke,rgba(139,92,246,.22));border-radius:12px;padding:12px 14px;
	background:var(--surface-1,rgba(255,255,255,.03));}
.tms-inline .tms-meter{padding:10px 4px 8px;margin-bottom:10px;}
.tms-inline .tms-num{font-size:28px;}
.tms-inline-row{display:flex;align-items:center;gap:8px;}
.tms-inline-row .tms-go{flex:1;}

@keyframes tms-fade{from{opacity:0;}to{opacity:1;}}
@keyframes tms-rise{from{opacity:0;transform:translateY(10px) scale(.99);}to{opacity:1;transform:none;}}
@keyframes tms-spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){
	.tms-backdrop,.tms,.tms-spin,.tms-receipt,.tms-live-dot,.tms-meter.tms-pulse{animation:none;}
	.tms-bar-fill,.tms-chart-bar{transition:none;}
}
`;
	(document.head || document.documentElement).appendChild(style);
}

// ── earnings fetch ─────────────────────────────────────────────────────────────

async function fetchEarnings(agentId, network, from) {
	const qs = new URLSearchParams({ network });
	if (from) qs.set('from', from);
	const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/solana/stream?${qs}`, { credentials: 'include' });
	if (!res.ok) throw new StreamError('Could not load streaming earnings.', 'earnings_failed');
	const { data } = await res.json();
	return data;
}

// ── streamer controller (shared by modal + inline) ───────────────────────────────

const WALLET_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';

/**
 * Build a self-contained streamer UI (asset/rate/cap pickers, live meter,
 * Stream⇄Stop, receipts, every state). Returns { el, destroy }. Used by both the
 * modal and the inline mount.
 */
function createStreamerUI(agent, opts = {}) {
	ensureStyles();
	const status = getWalletStatus(agent);
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const compact = !!opts.compact;
	const name = agent?.name || status?.name || 'this agent';
	const agentId = status?.agentId || agent?.id || agent?.agent_id || null;
	const toAddress = status?.address || agent?.solana_address || null;

	// Default asset honors an agent's advertised payment preference (same as tips).
	const accepted = (agent?.meta?.payments?.accepted_tokens || agent?.payments?.accepted_tokens || []).map((t) => String(t).toUpperCase());
	const initialAsset = accepted.includes('USDC') && !accepted.includes('SOL') ? 'USDC' : 'SOL';

	const cfg = {
		asset: initialAsset,
		rate: assetMeta(initialAsset).ratePresets[1],
		// Default cap = ~15 minutes at the chosen rate, the user can change it.
		capMode: 'auto',
		cap: assetMeta(initialAsset).ratePresets[1] * 15,
	};

	let engine = null;
	let pulseTimer = null;
	const root = document.createElement('div');
	root.className = compact ? 'tms-card tms-inline' : 'tms-card';

	function destroy() {
		if (engine) { try { engine.destroy(); } catch { /* idempotent */ } engine = null; }
		if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
	}

	if (!toAddress || !BASE58_RE.test(String(toAddress))) {
		root.innerHTML = `<div class="tms-bd"><div class="tms-empty">${esc(name)} doesn't have a wallet to stream to yet.<br><b>Fork it</b> or check back once its wallet is provisioned.</div></div>`;
		return { el: root, destroy };
	}

	// ── setup view (no active stream) ──
	function renderSetup(errMsg) {
		const am = assetMeta(cfg.asset);
		const capPresets = [
			{ label: '~10 min', mult: 10 }, { label: '~30 min', mult: 30 },
			{ label: '~1 hr', mult: 60 }, { label: 'custom', mult: null },
		];
		root.innerHTML = `
			<div class="tms-bd">
				<div class="tms-toggle" role="group" aria-label="Stream asset">
					${STREAM_ASSETS.map((a) => `<button class="tms-tok" type="button" data-asset="${a.id}" aria-pressed="${cfg.asset === a.id}">${esc(a.label)}</button>`).join('')}
				</div>
				<div class="tms-lbl">Rate · per minute</div>
				<div class="tms-presets">
					${am.ratePresets.map((p) => `<button class="tms-pre" type="button" data-rate="${p}" aria-pressed="${Number(p) === Number(cfg.rate)}">${am.symbol}${fmtAmount(p, cfg.asset)}</button>`).join('')}
				</div>
				<div class="tms-field">
					<input type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" value="${esc(cfg.rate)}" data-rate-input aria-label="Custom rate per minute"/>
					<span class="tms-unit">${esc(am.label)}/min</span>
				</div>
				<div class="tms-lbl">Spend cap · you sign for this ceiling</div>
				<div class="tms-presets">
					${capPresets.map((c) => `<button class="tms-pre" type="button" data-cap-mult="${c.mult ?? ''}" aria-pressed="${(c.mult == null && cfg.capMode === 'custom') || (c.mult != null && cfg.capMode === 'auto' && Math.abs(cfg.cap - cfg.rate * c.mult) < 1e-9)}">${esc(c.label)}</button>`).join('')}
				</div>
				<div class="tms-field">
					<input type="number" inputmode="decimal" min="0" step="any" placeholder="0.00" value="${esc(Number(cfg.cap).toFixed(am.decimals === 6 ? 2 : 4))}" data-cap-input aria-label="Spend cap total"/>
					<span class="tms-unit">${esc(am.label)} max</span>
				</div>
				<button class="tms-go" type="button" data-start ${cfg.rate > 0 && cfg.cap > 0 ? '' : 'disabled'}>
					${WALLET_SVG}<span>Stream ${am.symbol}${fmtAmount(cfg.rate, cfg.asset)}/min</span>
				</button>
				${errMsg ? `<div class="tms-msg err" role="alert">${esc(errMsg)}</div>` : ''}
				<div class="tms-note">Pays ${esc(name)} live from your wallet, settling on-chain every ~45s. Stop anytime — you're charged only for the seconds you stream.${network === 'devnet' ? ' · Devnet' : ''}<br><span class="tms-kbd">S</span> to start/stop</div>
			</div>`;
		wireSetup();
	}

	function syncCap() {
		// Keep the auto cap tied to the rate until the user types a custom cap.
		if (cfg.capMode === 'auto') cfg.cap = cfg.rate * 15;
	}

	function wireSetup() {
		for (const b of root.querySelectorAll('[data-asset]')) {
			b.addEventListener('click', () => {
				cfg.asset = b.dataset.asset === 'USDC' ? 'USDC' : 'SOL';
				cfg.rate = assetMeta(cfg.asset).ratePresets[1];
				cfg.capMode = 'auto'; syncCap();
				renderSetup();
			});
		}
		for (const b of root.querySelectorAll('[data-rate]')) {
			b.addEventListener('click', () => { cfg.rate = Number(b.dataset.rate); syncCap(); renderSetup(); });
		}
		const rateInput = root.querySelector('[data-rate-input]');
		rateInput?.addEventListener('input', () => {
			cfg.rate = Number(rateInput.value) || 0; syncCap();
			const go = root.querySelector('[data-start]');
			if (go) go.disabled = !(cfg.rate > 0 && cfg.cap > 0);
			for (const b of root.querySelectorAll('[data-rate]')) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === Number(cfg.rate)));
		});
		for (const b of root.querySelectorAll('[data-cap-mult]')) {
			b.addEventListener('click', () => {
				const mult = b.dataset.capMult;
				if (mult === '') { cfg.capMode = 'custom'; const ci = root.querySelector('[data-cap-input]'); ci?.focus(); }
				else { cfg.capMode = 'auto'; cfg.cap = cfg.rate * Number(mult); }
				renderSetup();
			});
		}
		const capInput = root.querySelector('[data-cap-input]');
		capInput?.addEventListener('input', () => {
			cfg.capMode = 'custom';
			cfg.cap = Number(capInput.value) || 0;
			const go = root.querySelector('[data-start]');
			if (go) go.disabled = !(cfg.rate > 0 && cfg.cap > 0);
		});
		root.querySelector('[data-start]')?.addEventListener('click', startStream);
	}

	// ── live view (active stream) ──
	function renderLive() {
		const am = assetMeta(cfg.asset);
		const projected = engine.projectedHuman();
		const usd = engine.projectedUsd();
		const pct = Math.min(100, (engine.settledHuman / engine.maxTotal) * 100);
		const paused = engine.state === 'paused';
		const settling = engine.state === 'settling';
		root.innerHTML = `
			<div class="tms-bd">
				<div class="tms-meter" data-meter>
					<div class="tms-num"><span class="tms-sym">${am.symbol}</span><span data-num>${fmtAmount(projected, cfg.asset)}</span><span class="tms-unit">${esc(am.label)}</span></div>
					${usd != null ? `<div class="tms-usd" data-usd>${esc(fmtUsd(usd))}</div>` : '<div class="tms-usd" data-usd></div>'}
					<div class="tms-sub">
						<span>rate <b>${am.symbol}${fmtAmount(cfg.rate, cfg.asset)}/min</b></span>
						<span>elapsed <b data-clock>${fmtClock(engine.activeMs())}</b></span>
						<span data-settled>settled <b>${am.symbol}${fmtAmount(engine.settledHuman, cfg.asset)}</b></span>
					</div>
					<div class="tms-bar"><div class="tms-bar-fill" data-bar style="width:${pct.toFixed(1)}%"></div></div>
					<div class="tms-cap-line">cap ${am.symbol}${fmtAmount(engine.maxTotal, cfg.asset)} · <span data-remain>${fmtAmount(Math.max(0, engine.maxTotal - engine.settledHuman), cfg.asset)}</span> left</div>
				</div>
				<button class="tms-go" type="button" data-variant="stop" data-stop ${settling ? 'disabled' : ''}>
					${settling ? '<span class="tms-spin" aria-hidden="true"></span>Settling final…' : (paused ? '■ Stop (paused — tab hidden)' : '■ Stop streaming')}
				</button>
				<div class="tms-receipts" data-receipts>${renderReceipts()}</div>
				<div class="tms-note"><span class="tms-live-dot" data-dot ${paused ? 'data-paused="1"' : ''} style="display:inline-block;vertical-align:middle;margin-right:5px"></span>${paused ? 'Paused — you left the tab, so the meter is frozen. Come back to resume.' : 'Live — each ~45s a real on-chain settlement is signed from your wallet.'}<br><span class="tms-kbd">S</span> to stop</div>
			</div>`;
		root.querySelector('[data-stop]')?.addEventListener('click', stopStream);
	}

	function renderReceipts() {
		if (!engine || !engine.receipts.length) return '';
		const am = assetMeta(cfg.asset);
		return engine.receipts.slice(-6).reverse().map((r) => `
			<div class="tms-receipt" data-pending="${r.pending ? '1' : '0'}">
				<span class="tms-rc-ok">${r.pending ? '⋯' : '✓'}</span>
				<span>settled</span>
				<span class="tms-rc-amt">${am.symbol}${fmtAmount(r.amount, cfg.asset)}</span>
				${r.usd != null ? `<span>· ${esc(fmtUsd(r.usd))}</span>` : ''}
				<a href="${esc(r.explorerUrl)}" target="_blank" rel="noopener">receipt ↗</a>
			</div>`).join('');
	}

	// Lightweight live updates without a full re-render (keeps focus + scroll).
	function tick() {
		if (!engine) return;
		const am = assetMeta(cfg.asset);
		const numEl = root.querySelector('[data-num]');
		if (numEl) numEl.textContent = fmtAmount(engine.projectedHuman(), cfg.asset);
		const usdEl = root.querySelector('[data-usd]');
		const usd = engine.projectedUsd();
		if (usdEl) usdEl.textContent = usd != null ? fmtUsd(usd) : '';
		const clockEl = root.querySelector('[data-clock]');
		if (clockEl) clockEl.textContent = fmtClock(engine.activeMs());
		const barEl = root.querySelector('[data-bar]');
		if (barEl) barEl.style.width = `${Math.min(100, (engine.settledHuman / engine.maxTotal) * 100).toFixed(1)}%`;
		const remainEl = root.querySelector('[data-remain]');
		if (remainEl) remainEl.textContent = fmtAmount(Math.max(0, engine.maxTotal - engine.settledHuman), cfg.asset);
		const settledEl = root.querySelector('[data-settled]');
		if (settledEl) settledEl.innerHTML = `settled <b>${am.symbol}${fmtAmount(engine.settledHuman, cfg.asset)}</b>`;
	}

	function onSettle() {
		// Refresh receipts + pulse the meter on a confirmed settlement.
		const rcWrap = root.querySelector('[data-receipts]');
		if (rcWrap) rcWrap.innerHTML = renderReceipts();
		const meter = root.querySelector('[data-meter]');
		if (meter && !prefersReducedMotion()) {
			meter.classList.remove('tms-pulse'); void meter.offsetWidth; meter.classList.add('tms-pulse');
		}
		tick();
	}

	function onState(s, err) {
		if (s === 'stopped') { renderSummary(err); return; }
		if (s === 'error') { renderSetup(err?.message || 'Streaming failed.'); return; }
		// streaming / paused / settling / connecting → full live re-render (state copy changes).
		if (engine) renderLive();
		const dot = root.querySelector('[data-dot]');
		if (dot) { if (s === 'paused') dot.setAttribute('data-paused', '1'); else dot.removeAttribute('data-paused'); }
	}

	function renderSummary(err) {
		const am = assetMeta(cfg.asset);
		const total = engine ? engine.settledHuman : 0;
		const usd = engine && engine.usdPerAsset != null ? engine.settledUsd : null;
		const receipts = engine ? engine.receipts : [];
		root.innerHTML = `
			<div class="tms-bd">
				<div class="tms-meter">
					<div class="tms-hd-k" style="justify-content:center;margin-bottom:8px">Stream ended</div>
					<div class="tms-num"><span class="tms-sym">${am.symbol}</span><span>${fmtAmount(total, cfg.asset)}</span><span class="tms-unit">${esc(am.label)}</span></div>
					${usd != null ? `<div class="tms-usd">${esc(fmtUsd(usd))} streamed to ${esc(name)}</div>` : `<div class="tms-usd">streamed to ${esc(name)}</div>`}
					<div class="tms-sub"><span>${receipts.length} settlement${receipts.length === 1 ? '' : 's'}</span><span>elapsed <b>${fmtClock(engine ? engine.activeMs() : 0)}</b></span></div>
				</div>
				${err && err.code !== 'ceiling_reached' ? `<div class="tms-msg err">${esc(err.message)}</div>` : ''}
				${err && err.code === 'ceiling_reached' ? `<div class="tms-msg">${esc(err.message)}</div>` : ''}
				<div class="tms-receipts">${receipts.slice(-6).reverse().map((r) => `
					<div class="tms-receipt" data-pending="${r.pending ? '1' : '0'}"><span class="tms-rc-ok">${r.pending ? '⋯' : '✓'}</span><span>settled</span><span class="tms-rc-amt">${am.symbol}${fmtAmount(r.amount, cfg.asset)}</span><a href="${esc(r.explorerUrl)}" target="_blank" rel="noopener">receipt ↗</a></div>`).join('') || '<div class="tms-empty">No settlements — you stopped before the first one cleared. Nothing was charged.</div>'}
				</div>
				<button class="tms-go" type="button" data-variant="ghost" data-restart style="margin-top:13px">Stream again</button>
			</div>`;
		root.querySelector('[data-restart]')?.addEventListener('click', () => {
			if (engine) { try { engine.destroy(); } catch { /* noop */ } }
			engine = null;
			cfg.capMode = 'auto'; syncCap();
			renderSetup();
		});
		if (typeof opts.onEnded === 'function') { try { opts.onEnded({ total, usd, receipts: receipts.length }); } catch { /* noop */ } }
	}

	async function startStream() {
		if (engine && (engine.state === 'streaming' || engine.state === 'connecting')) return;
		engine = new MoneyStreamEngine({ agentId, toAddress, asset: cfg.asset, ratePerMinute: cfg.rate, maxTotal: cfg.cap, network });
		engine.on('tick', tick);
		engine.on('settle', onSettle);
		engine.on('state', onState);
		engine.on('error', () => { /* surfaced via state */ });
		// Show a connecting state immediately.
		root.querySelector('[data-start]') && (root.querySelector('[data-start]').innerHTML = `<span class="tms-spin" aria-hidden="true"></span>Connecting wallet…`);
		root.querySelector('[data-start]') && (root.querySelector('[data-start]').disabled = true);
		try {
			await engine.start();
		} catch (e) {
			// State listener already rendered the error view for known StreamErrors.
			if (!(e instanceof StreamError)) renderSetup(e?.message || 'Could not start the stream.');
		}
	}

	async function stopStream() {
		if (!engine) return;
		await engine.stop();
	}

	// Keyboard: S toggles start/stop when focus isn't in an input.
	function onKey(e) {
		if (e.defaultPrevented) return;
		const t = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		if (e.key === 's' || e.key === 'S') {
			e.preventDefault();
			if (engine && (engine.state === 'streaming' || engine.state === 'paused')) stopStream();
			else if (!engine || engine.state === 'stopped' || engine.state === 'idle' || engine.state === 'error') {
				if (root.querySelector('[data-start]')) startStream();
			}
		}
	}
	root.addEventListener('keydown', onKey);

	renderSetup();
	return {
		el: root,
		destroy,
		stop: stopStream,
		getEngine: () => engine,
	};
}

// ── owner earnings UI ────────────────────────────────────────────────────────────

function createEarningsUI(agent, opts = {}) {
	ensureStyles();
	const status = getWalletStatus(agent);
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = status?.agentId || agent?.id || agent?.agent_id || null;
	const name = agent?.name || status?.name || 'your agent';
	const root = document.createElement('div');
	root.className = 'tms-card';
	let refreshTimer = null;
	let destroyed = false;

	function destroy() {
		destroyed = true;
		if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
	}

	function renderLoading() {
		root.innerHTML = `<div class="tms-bd"><div class="tms-skwrap"><div class="tms-sk"></div><div class="tms-sk"></div><div class="tms-sk" style="height:54px"></div></div></div>`;
	}

	function renderError() {
		root.innerHTML = `<div class="tms-bd"><div class="tms-empty">Couldn't load streaming earnings right now.<br><button class="tms-go" data-variant="ghost" data-retry style="margin-top:12px;max-width:180px">Try again</button></div></div>`;
		root.querySelector('[data-retry]')?.addEventListener('click', load);
	}

	function renderData(d) {
		const life = d.lifetime || {};
		const now = d.earning_now || {};
		const daily = d.daily || [];
		const hasAny = (life.settlements || 0) > 0;
		if (!hasAny) {
			root.innerHTML = `<div class="tms-bd"><div class="tms-empty">No one has streamed to <b>${esc(name)}</b> yet.<br>Streaming lets visitors pay ${esc(name)} <b>by the second</b> while they watch or talk to it — share its page to start earning.</div></div>`;
			return;
		}
		const maxUsd = Math.max(...daily.map((x) => x.usd), 0.0001);
		const bars = daily.map((x) => `<div class="tms-chart-bar" style="height:${Math.max(2, (x.usd / maxUsd) * 100)}%" title="${esc(x.day)} · ${esc(fmtUsd(x.usd))}"></div>`).join('');
		const activeNow = now.active_streams || 0;
		root.innerHTML = `
			<div class="tms-bd">
				<div class="tms-earn-now">
					<span class="tms-live-dot" ${activeNow ? '' : 'data-paused="1"'} style="flex:none"></span>
					<div style="flex:1;min-width:0">
						<div class="tms-earn-k">Earning now</div>
						<div class="tms-earn-big">${activeNow ? `${esc(fmtUsd(now.usd_per_min))}/min` : '—'}</div>
					</div>
					<div style="text-align:right">
						<div class="tms-earn-k">Live streams</div>
						<div class="tms-earn-big">${activeNow}</div>
					</div>
				</div>
				<div class="tms-stats">
					<div class="tms-stat"><div class="tms-stat-v">${esc(fmtUsd(life.usd) || '$0')}</div><div class="tms-stat-k">Lifetime</div></div>
					<div class="tms-stat"><div class="tms-stat-v">${life.streamers || 0}</div><div class="tms-stat-k">Patrons</div></div>
					<div class="tms-stat"><div class="tms-stat-v">${life.sessions || 0}</div><div class="tms-stat-k">Sessions</div></div>
				</div>
				<div class="tms-lbl">Last 30 days</div>
				<div class="tms-chart">${bars || '<div class="tms-empty" style="padding:8px">No daily history yet.</div>'}</div>
				<div class="tms-receipts">${(d.recent || []).slice(0, 6).map((r) => `
					<div class="tms-receipt"><span class="tms-rc-ok">✓</span><span>${esc((r.from || 'someone').slice(0, 4))}…</span><span class="tms-rc-amt">${r.asset === 'USDC' ? '$' : '◎'}${fmtAmount(r.amount, r.asset === 'USDC' ? 'USDC' : 'SOL')}</span>${r.usd != null ? `<span>· ${esc(fmtUsd(r.usd))}</span>` : ''}<a href="${esc(r.explorer)}" target="_blank" rel="noopener">↗</a></div>`).join('')}</div>
				<div class="tms-note">Streamed income settles to ${esc(name)}'s wallet on-chain. Every figure here is backed by a real signature.</div>
			</div>`;
	}

	async function load() {
		if (!agentId) { renderError(); return; }
		try {
			const d = await fetchEarnings(agentId, network, null);
			if (destroyed) return;
			renderData(d);
		} catch {
			if (!destroyed) renderError();
		}
	}

	renderLoading();
	load();
	// Live-refresh the "earning now" figure every 20s while the panel is open.
	refreshTimer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') load(); }, 20_000);
	return { el: root, destroy };
}

// ── public API ──────────────────────────────────────────────────────────────────

/**
 * Open the Money Stream panel for an agent.
 *
 * @param {object} agent  Any agent record shape (must resolve a public solana_address).
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {boolean} [opts.isOwner]  Force the owner earnings view (auto-detected from
 *   the agent record's ownership flags when omitted).
 * @param {'stream'|'earnings'} [opts.mode]  Explicit view override.
 * @returns {{ close: () => void } | null}  null when the agent has no wallet at all.
 */
export function openStreamPanel(agent, opts = {}) {
	if (typeof document === 'undefined') return null;
	ensureStyles();
	const status = getWalletStatus(agent);
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const name = agent?.name || status?.name || 'this agent';
	const avatar = agent?.avatar_thumbnail_url || agent?.avatar_url || agent?.profile_image_url || status?.avatarUrl || '';
	const isOwner = opts.mode === 'earnings' || (opts.mode !== 'stream' && (opts.isOwner ?? !!(agent?.isOwner || agent?.is_owner)));
	const mode = isOwner ? 'earnings' : 'stream';

	const backdrop = document.createElement('div');
	backdrop.className = 'tms-backdrop';
	backdrop.setAttribute('role', 'dialog');
	backdrop.setAttribute('aria-modal', 'true');
	backdrop.setAttribute('aria-label', mode === 'earnings' ? `${name} streaming earnings` : `Stream to ${name}`);

	const prevActive = document.activeElement;
	let controller = null;

	function close() {
		document.removeEventListener('keydown', onKey, true);
		try { controller?.destroy?.(); } catch { /* idempotent */ }
		backdrop.remove();
		try { prevActive?.focus?.(); } catch { /* noop */ }
	}
	function onKey(e) {
		// Don't let Escape silently kill an active paid stream — confirm via Stop.
		const engine = controller?.getEngine?.();
		if (e.key === 'Escape') {
			if (engine && (engine.state === 'streaming' || engine.state === 'paused' || engine.state === 'settling')) return;
			e.preventDefault(); close();
		}
	}

	const shell = document.createElement('div');
	shell.className = 'tms';
	shell.innerHTML = `
		<div class="tms-hd">
			${avatar ? `<img loading="lazy" decoding="async" class="tms-av" src="${esc(avatar)}" alt="" data-fallback="remove"/>` : '<div class="tms-av"></div>'}
			<div class="tms-hd-txt">
				<div class="tms-hd-k">${mode === 'earnings' ? '◎ Stream earnings' : '◎ Money Stream'}</div>
				<div class="tms-hd-n" title="${esc(name)}">${esc(name)}</div>
			</div>
			<button class="tms-x" type="button" data-x aria-label="Close">×</button>
		</div>`;

	controller = mode === 'earnings'
		? createEarningsUI(agent, { network })
		: createStreamerUI(agent, { network });
	// Unwrap the inner card's body into the modal shell for a seamless look.
	controller.el.classList.remove('tms-card');
	shell.appendChild(controller.el);
	backdrop.appendChild(shell);

	shell.querySelector('[data-x]')?.addEventListener('click', () => {
		const engine = controller?.getEngine?.();
		if (engine && (engine.state === 'streaming' || engine.state === 'paused')) {
			// Stop the stream (final settle) before closing so we never abandon an
			// active paid session silently.
			controller.stop?.().finally(() => close());
		} else { close(); }
	});

	backdrop.addEventListener('click', (e) => {
		if (e.target !== backdrop) return;
		const engine = controller?.getEngine?.();
		if (engine && (engine.state === 'streaming' || engine.state === 'paused' || engine.state === 'settling')) return;
		close();
	});
	document.addEventListener('keydown', onKey, true);
	document.body.appendChild(backdrop);
	shell.querySelector('[data-x]')?.focus();

	return { close };
}

/**
 * Mount a live stream meter inline on a surface (chat pay-per-minute, club
 * pay-to-watch). Returns a handle with destroy(). For the owner's own agent it
 * mounts the earnings view instead — owners don't stream to themselves.
 *
 * @param {HTMLElement} el  Container to render into.
 * @param {object} agent
 * @param {object} [opts]   { network, isOwner, compact, onEnded }
 */
export function mountStreamMeter(el, agent, opts = {}) {
	if (!el || typeof document === 'undefined') return { destroy() {} };
	ensureStyles();
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const isOwner = opts.isOwner ?? !!(agent?.isOwner || agent?.is_owner);
	const controller = isOwner
		? createEarningsUI(agent, { network })
		: createStreamerUI(agent, { network, compact: opts.compact !== false, onEnded: opts.onEnded });
	el.replaceChildren(controller.el);
	return {
		el: controller.el,
		stop: () => controller.stop?.(),
		getEngine: () => controller.getEngine?.(),
		destroy: () => { try { controller.destroy?.(); } catch { /* idempotent */ } },
	};
}

if (typeof window !== 'undefined') {
	window.twsMoneyStream = { openStreamPanel, mountStreamMeter, STREAM_ASSETS };
}
