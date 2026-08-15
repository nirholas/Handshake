// PumpPortal websocket connection helpers, shared by every surface that opens
// wss://pumpportal.fun/api/data (the sniper intel watcher, the serverless
// observer cron, the live trade SSE streams, and the shared mint feed).
//
// PumpPortal gated `subscribeTokenTrade` / `subscribeAccountTrade` behind an
// API key funded with at least 0.02 SOL. Anonymous connections still receive
// `subscribeNewToken` and `subscribeMigration`, but every per-token trade
// subscribe is refused with an `{ message: ... }` ack that the old handlers
// dropped as a routine acknowledgement. The silent refusal starved the whole
// intel -> smart-money -> conviction pipeline: every coin finalized with only
// its seeded dev buy, so no coin could ever score past the no-data plateau.
// Connect with PUMPPORTAL_API_KEY when set, and log refusals loudly.

const PUMPPORTAL_WS_BASE = 'wss://pumpportal.fun/api/data';

/** Websocket URL, authenticated when PUMPPORTAL_API_KEY is configured. */
export function pumpPortalWsUrl() {
	const key = (process.env.PUMPPORTAL_API_KEY || '').trim();
	return key ? `${PUMPPORTAL_WS_BASE}?api-key=${encodeURIComponent(key)}` : PUMPPORTAL_WS_BASE;
}

// A refusal is a standing condition of the connection (missing/unfunded key,
// exceeded limits), not a per-message event -- one line per interval per
// process is signal; one line per subscribe attempt is log spam.
const REFUSAL_RE = /api key|only available|not authorized|unauthorized|exceed/i;
const REFUSAL_LOG_INTERVAL_MS = 5 * 60_000;
let _lastRefusalLogAt = 0;

/**
 * True when a parsed frame is a subscription refusal rather than data or a
 * routine ack. Callers that serve a live stream use this to tell their own
 * clients the feed is degraded, instead of holding a socket open that will
 * never deliver an event.
 *
 * @param {object} msg parsed frame
 * @returns {boolean}
 */
export function isPumpPortalRefusal(msg) {
	const text = typeof msg?.message === 'string' ? msg.message : null;
	return text != null && REFUSAL_RE.test(text);
}

/**
 * Handle a parsed PumpPortal frame if it is an ack/notice (`{ message }`).
 * Returns true when the frame was an ack (caller should skip it), false when
 * it is a data frame. Subscription refusals are logged through `warn` at most
 * once per 5 minutes so a degraded trade stream can never be silent again.
 *
 * @param {object} msg parsed frame
 * @param {(line: string) => void} [warn]
 * @returns {boolean}
 */
export function handlePumpPortalAck(msg, warn = console.warn) {
	const text = typeof msg?.message === 'string' ? msg.message : null;
	if (text == null) return false;
	if (isPumpPortalRefusal(msg)) {
		const now = Date.now();
		if (now - _lastRefusalLogAt > REFUSAL_LOG_INTERVAL_MS) {
			_lastRefusalLogAt = now;
			const hint = process.env.PUMPPORTAL_API_KEY
				? 'PUMPPORTAL_API_KEY is set but was refused - check the key and its SOL balance'
				: 'set PUMPPORTAL_API_KEY (a PumpPortal key funded with >= 0.02 SOL) to restore trade streams';
			try { warn(`[pumpportal] subscription refused: ${text} - ${hint}`); } catch {}
		}
	}
	return true;
}
