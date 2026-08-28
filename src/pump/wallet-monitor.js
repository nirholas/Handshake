// Real-time Solana wallet monitor for pump.fun trades.
// Uses Solana WebSocket logsSubscribe to detect buys/sells from a target wallet
// with ~100ms latency instead of the 5s poll used by pumpfun-copy-trade.
//
// Emits a 'trade' event on every confirmed pump.fun instruction:
//   { side: 'buy'|'sell', mint: string, solAmount: number, signature: string }
//
// Auto-reconnects with exponential backoff on disconnect.

import { log } from '../shared/log.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Ordered free WS endpoints per network. A connection that dies before its
// logsSubscribe is confirmed rotates to the next endpoint, so one blocked or
// rate-limited host can't take the monitor down.
const WS_URLS = {
	mainnet: [
		'wss://api.mainnet-beta.solana.com',
		'wss://solana-rpc.publicnode.com',
		'wss://solana.drpc.org',
	],
	devnet: [
		'wss://api.devnet.solana.com',
		'wss://solana-devnet-rpc.publicnode.com',
	],
};

// How long an endpoint gets to open its socket AND confirm the logsSubscribe.
// Rotation used to be driven entirely by onclose, so a host that accepted the
// TCP connection and then never answered the subscribe (a captive portal, a
// rate-limited node holding the connection open, a stalled proxy) left the
// monitor connected, silent, and permanently blind: no error, no rotation, no
// trades. The deadline force-closes that socket, which routes it through the
// existing unsubscribed-rotation path.
const SUBSCRIBE_TIMEOUT_MS = 12_000;

// Parse pump.fun structured log line: "Program log: {...json...}"
function extractLogJson(log) {
	if (!log.startsWith('Program log: {')) return null;
	try { return JSON.parse(log.slice('Program log: '.length)); } catch { return null; }
}

// Returns { side, mint, solAmount } or null if not a pump.fun trade.
function parseTradeFromLogs(logs) {
	const isPump = logs.some((l) => l.includes(PUMP_PROGRAM) || l.includes(PUMP_AMM_PROGRAM));
	if (!isPump) return null;

	const isBuy = logs.some((l) => l.includes('Instruction: Buy'));
	const isSell = logs.some((l) => l.includes('Instruction: Sell'));
	if (!isBuy && !isSell) return null;

	let mint = null;
	let solAmount = 0;

	for (const log of logs) {
		const data = extractLogJson(log);
		if (!data) continue;
		if (data.mint) mint = data.mint;
		// quote_amount is lamports on the bonding curve; sol_amount on some AMM paths
		const raw = data.quote_amount ?? data.sol_amount;
		if (raw != null) solAmount = Number(raw) / 1e9;
	}

	if (!mint) return null;
	return { side: isBuy ? 'buy' : 'sell', mint, solAmount };
}

export class WalletMonitor extends EventTarget {
	/**
	 * @param {string} wallet  — base58 Solana address to watch
	 * @param {{ network?: 'mainnet'|'devnet', wsUrl?: string }} opts
	 */
	constructor(wallet, { network = 'mainnet', wsUrl } = {}) {
		super();
		this.wallet = wallet;
		// An explicit wsUrl pins to that single endpoint; otherwise rotate the free list.
		this._wsUrls = wsUrl ? [wsUrl] : (WS_URLS[network] ?? WS_URLS.mainnet);
		this._urlIdx = 0;
		this._ws = null;
		this._subId = null;
		this._msgId = 0;
		this._closed = false;
		this._reconnectMs = 1000;
	}

	start() {
		this._closed = false;
		this._connect();
	}

	stop() {
		this._closed = true;
		try { this._ws?.close(); } catch { /* already closing */ }
		this._ws = null;
	}

	_connect() {
		if (this._closed) return;

		const url = this._wsUrls[this._urlIdx % this._wsUrls.length];
		const ws = new WebSocket(url);
		this._ws = ws;
		let subscribed = false;

		const subscribeDeadline = setTimeout(() => {
			if (subscribed || this._closed) return;
			log.warn('[wallet-monitor] no subscription confirmation from', url, `within ${SUBSCRIBE_TIMEOUT_MS}ms; rotating endpoint`);
			// close() fires onclose, which rotates and reconnects. Guard against a
			// socket wedged in CONNECTING that never emits either event.
			try { ws.close(); } catch { /* already closing */ }
			if (this._ws === ws) {
				this._ws = null;
				this._urlIdx++;
				setTimeout(() => this._connect(), 0);
			}
		}, SUBSCRIBE_TIMEOUT_MS);

		ws.onopen = () => {
			this._reconnectMs = 1000;
			ws.send(JSON.stringify({
				jsonrpc: '2.0',
				id: ++this._msgId,
				method: 'logsSubscribe',
				params: [
					{ mentions: [this.wallet] },
					{ commitment: 'confirmed' },
				],
			}));
		};

		ws.onmessage = ({ data }) => {
			let msg;
			try { msg = JSON.parse(data); } catch { return; }

			// Subscription confirmation
			if (msg.id != null && typeof msg.result === 'number') {
				this._subId = msg.result;
				subscribed = true;
				clearTimeout(subscribeDeadline);
				return;
			}

			// Log notification
			const value = msg?.params?.result?.value;
			if (!value) return;
			const { logs, signature, err } = value;
			if (err || !Array.isArray(logs) || logs.length === 0) return;

			const trade = parseTradeFromLogs(logs);
			if (!trade) return;

			const evt = new Event('trade');
			Object.assign(evt, { ...trade, signature });
			this.dispatchEvent(evt);
		};

		ws.onerror = () => {
			// The paired onclose handler owns reconnection/rotation; this is
			// diagnostics only, so a dead endpoint is visible instead of silent.
			log.warn(
				'[wallet-monitor] websocket error on',
				url,
				subscribed ? '(subscribed; will back off and reconnect)' : '(unsubscribed; rotating endpoint)',
			);
		};

		ws.onclose = () => {
			clearTimeout(subscribeDeadline);
			if (this._ws !== ws) return; // the deadline already rotated past this socket
			this._ws = null;
			// Never got a confirmed subscription on this endpoint — try the next
			// one immediately rather than backing off against a dead host.
			if (!subscribed) this._urlIdx++;
			if (!this._closed) {
				const delay = subscribed ? this._reconnectMs : Math.min(this._reconnectMs, 1000);
				setTimeout(() => this._connect(), delay);
				this._reconnectMs = Math.min(this._reconnectMs * 2, 30_000);
			}
		};
	}
}
