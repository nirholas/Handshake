// x402.js — drop-in payment modal for any x402 paid endpoint.
//
// Merchants add one line to their site:
//
//   <script type="module" src="https://three.ws/x402.js"></script>
//
// Then any element with `data-x402-endpoint` opens a payment modal on click:
//
//   <button
//     data-x402-endpoint="https://example.com/api/paid/summarize"
//     data-x402-method="POST"
//     data-x402-body='{"text":"hello"}'
//     data-x402-merchant="Acme"
//     data-x402-action="Summarize"
//   >Pay & Run</button>
//
// On completion the element receives an `x402:result` CustomEvent whose detail
// is { ok, result, payment, response }. On error: `x402:error` with { error }.
//
// You can also call programmatically:
//
//   const out = await window.X402.pay({
//     endpoint: '/api/paid/summarize',
//     body: { text: 'hello' },
//     merchant: 'Acme',
//     action: 'Summarize',
//     networks: ['solana'], // optional allowlist — force a Solana-only checkout
//   });
//
// The modal handles wallet connect (Phantom for Solana, window.ethereum for
// Base USDC via EIP-3009), drives the 402 → sign → retry flow, and shows the
// result. Vanilla JS, no bundler required.
//
// Signed-in three.ws users additionally see their AGENTS' own custodial wallets
// as payment methods: picking one settles the payment entirely server-side via
// POST /api/x402-pay (owner-authenticated, CSRF-gated, per-agent spend caps),
// with no browser wallet popup. On third-party merchant embeds the session cookie
// never travels cross-origin, so that option simply doesn't render.

const VERSION = '0.2.0';

// Real-funds gate: before the first payment, the user must accept the three.ws
// Risk Disclosure (three.ws/legal/risk). Loaded lazily and failure-tolerant on
// purpose — this modal is a drop-in embed on merchant sites, and a payment
// must never brick because the gate module 404'd or was blocked. If risk-ack.js
// can't load, degrade to a native confirm() with the same core wording,
// remembered for the page session.
let _riskAckSessionOk = false;

async function ensureRiskAckSafe(context) {
	try {
		// Resolved relative to this module's URL, so merchant-site embeds load it
		// from the three.ws origin, not the host page's.
		const m = await import(new URL('./risk-ack.js', import.meta.url).href);
		return await m.ensureRiskAck({ context });
	} catch (err) {
		console.error('[x402] risk-ack unavailable, degrading to confirm()', err);
		if (_riskAckSessionOk) return true;
		try {
			_riskAckSessionOk = globalThis.confirm?.(
				'Real funds — risk acknowledgment\n\n' +
				'three.ws is experimental software. Losses can be total, fast, and irreversible; ' +
				'nothing here is financial advice; and three.ws is not responsible for any losses. ' +
				'Full text: three.ws/legal/risk\n\n' +
				'Press OK to accept that you use real funds entirely at your own risk, or Cancel to stop.',
			) === true;
		} catch {
			_riskAckSessionOk = false;
		}
		return _riskAckSessionOk;
	}
}

// SIWX ("Sign-In-With-X" / CAIP-122) lets a wallet that has already paid for
// an endpoint re-enter it by signing a challenge instead of paying again. The
// server advertises support by including `extensions['sign-in-with-x']` in the
// 402 body; clients submit signed proofs via the `SIGN-IN-WITH-X` header. The
// architecture came from the siwx campaign plan, retired from prompts/ once
// shipped; see git history for the original.
const SIWX_HEADER = 'SIGN-IN-WITH-X';
const SIWX_EXTENSION_KEY = 'sign-in-with-x';

const ORIGIN = (() => {
	// Resolve the origin that hosts this script — used as the API origin for
	// the prepare/encode helpers. Falls back to the merchant origin in same-
	// origin mode.
	try {
		const script = document.currentScript;
		if (script?.src) return new URL(script.src).origin;
		const found = document.querySelector('script[src*="/x402.js"]');
		if (found?.src) return new URL(found.src).origin;
	} catch (_) {}
	return location.origin;
})();

// USDC EIP-3009 typed-data sig works against Base USDC at this address. The
// domain `version` must match the on-chain `EIP712_DOMAIN_SEPARATOR_VERSION`
// of the deployed USDC implementation — Base USDC is at version "2".
const EVM_NETWORKS = {
	'eip155:8453': { chainId: 8453, name: 'Base', explorer: 'https://basescan.org/tx/' },
	'eip155:84532': { chainId: 84532, name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org/tx/' },
	'eip155:42161': { chainId: 42161, name: 'Arbitrum', explorer: 'https://arbiscan.io/tx/' },
	'eip155:10': { chainId: 10, name: 'Optimism', explorer: 'https://optimistic.etherscan.io/tx/' },
};

// Normalize a single 402 `accept` entry to the shape the modal speaks
// internally. The x402 spec's canonical atomic-price field is
// `maxAmountRequired`; some merchants (and our own server) emit `amount`. We
// read `amount` everywhere downstream (price display, cap check, prepare/encode
// POST body, EIP-3009 signing), so coerce here once at ingestion. Without this,
// a spec-compliant merchant yields `accept.amount === undefined` → "NaN USDC"
// in the modal and an `accept.amount: Required` 400 from /api/x402-checkout.
function normalizeAccept(accept) {
	if (!accept || typeof accept !== 'object') return accept;
	const amount = accept.amount ?? accept.maxAmountRequired;
	return amount != null && accept.amount == null ? { ...accept, amount: String(amount) } : accept;
}

function isSolanaNetwork(net) {
	return typeof net === 'string' && (net === 'solana' || net.startsWith('solana:'));
}
function isEvmNetwork(net) {
	return typeof net === 'string' && net.startsWith('eip155:');
}

// Resolve the active injected Solana wallet provider. Priority mirrors
// src/onchain/adapters/solana.js so the drop-in modal recognizes the SAME
// wallets the rest of three.ws does — most importantly the platform's own
// embedded wallet (the Seeker/Saga MWA bridge), which injects with
// isThreeWs=true / isPhantom=false. An isPhantom-only check left those users
// staring at a disabled "Phantom (not detected)" button: the modal opened but
// there was no way to pay (e.g. tipping a club dancer).
export function detectSolanaProvider() {
	if (typeof window === 'undefined') return null;
	if (window.threeWsWallet?.isThreeWs) return window.threeWsWallet;
	if (window.solana?.isThreeWs) return window.solana;
	if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
	if (window.solana?.isPhantom) return window.solana;
	if (window.backpack?.solana) return window.backpack.solana;
	if (window.solflare?.isSolflare) return window.solflare;
	return null;
}

// Human-readable name for whichever Solana provider is connected, so progress
// copy and the wallet button say "three.ws Wallet" / "Backpack" instead of
// always claiming "Phantom".
export function solanaWalletLabel(provider) {
	if (provider?.isThreeWs) return 'three.ws Wallet';
	if (provider?.isPhantom) return 'Phantom';
	if (provider?.isBackpack) return 'Backpack';
	if (provider?.isSolflare) return 'Solflare';
	return 'Solana wallet';
}

// ── Agent-wallet payment method ──────────────────────────────────────────────
// A signed-in user's agents each hold a custodial Solana wallet server-side
// (agent_identities.meta), and POST /api/x402-pay pays an x402 endpoint from
// that wallet with ownership auth, a single-use CSRF token, and the per-agent
// spend policy enforced before any funds move. The picker lists those agents
// next to the injected browser wallets so an agent holding USDC can buy
// without Phantom ever opening.

let _agentWalletsCache = null; // { at: epoch-ms, list }; invalidated after a payment
const AGENT_WALLETS_TTL_MS = 30_000;

async function fetchAgentWallets() {
	if (_agentWalletsCache && Date.now() - _agentWalletsCache.at < AGENT_WALLETS_TTL_MS) {
		return _agentWalletsCache.list;
	}
	try {
		const res = await fetch(`${ORIGIN}/api/x402-pay?agents=1`, { credentials: 'include' });
		if (!res.ok) return null; // signed out (401) or unavailable: option not offered
		const data = await res.json();
		const list = (Array.isArray(data?.agents) ? data.agents : [])
			.filter((a) => a && a.solana_address)
			.sort((a, b) => (Number(b.usdc) || 0) - (Number(a.usdc) || 0));
		_agentWalletsCache = { at: Date.now(), list };
		return list;
	} catch (_) {
		return null;
	}
}

// Single-use CSRF token for the settle call (api/_lib/csrf.js burns tokens on
// first use, so one is fetched per payment, never cached).
async function fetchCsrfToken() {
	try {
		const res = await fetch(`${ORIGIN}/api/csrf-token`, { credentials: 'include' });
		if (!res.ok) return null;
		const j = await res.json().catch(() => null);
		return j?.data?.token || null;
	} catch (_) {
		return null;
	}
}

// POST /api/x402-pay as SSE and pump lifecycle events ('challenge' | 'built' |
// 'settled' | 'result' | 'error') to onEvent. Resolves the final result
// envelope; throws an Error carrying `.code` / `.envelope` on failure. Mirrors
// src/agent-x402-pay.js payX402Stream, inlined because this drop-in script
// cannot import bundled app modules.
async function payFromAgentWallet({ agentId, url, method, body, serviceLabel, csrfToken }, onEvent = () => {}) {
	const res = await fetch(`${ORIGIN}/api/x402-pay`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'content-type': 'application/json',
			accept: 'text/event-stream',
			...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
		},
		body: JSON.stringify({ agentId, url, method, body, service_label: serviceLabel, stream: true }),
	});
	// A non-stream error (auth, rate limit, validation) comes back as JSON, not SSE.
	const ctype = res.headers.get('content-type') || '';
	if (!res.ok && !ctype.includes('text/event-stream')) {
		const data = await res.json().catch(() => ({}));
		const err = new Error(data?.error_description || data?.error || `payment failed (${res.status})`);
		err.code = data?.code || data?.error;
		err.status = res.status;
		throw err;
	}
	if (!res.body) throw new Error('payment stream unavailable');

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let result = null;
	let failure = null;
	const dispatchEvent = (event, raw) => {
		let data = null;
		try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
		if (event === 'result') result = data;
		if (event === 'error') failure = data;
		try { onEvent(event, data); } catch (_) { /* a UI handler throwing must not break the pump */ }
	};
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let sep;
		while ((sep = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			let event = 'message';
			let data = '';
			for (const line of frame.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data += line.slice(5).trim();
			}
			if (data || event !== 'message') dispatchEvent(event, data);
		}
	}
	if (failure) {
		const err = new Error(failure.error_description || failure.error || 'payment failed');
		err.code = failure.code;
		err.envelope = failure;
		throw err;
	}
	if (!result) throw new Error('payment ended without a result');
	return result;
}

// Compute the buyer-facing donation for a Solana `accept` under a merchant's
// giving config (charity split + round-up). Returns null when nothing applies:
// giving off, cause wallet on a different chain than this checkout, or a zero
// total. The donation settles in the SAME mint + transaction as the payment, so
// the cause wallet must be a Solana address. Pure integer math on atomics.
export function computeGiving(giving, accept) {
	if (!giving || !isSolanaNetwork(accept?.network)) return null;
	if (giving.charity_chain && giving.charity_chain !== 'solana') return null;
	const to = giving.charity_address;
	if (!to || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return null;
	let base;
	try { base = BigInt(accept.amount); } catch { return null; }
	if (base <= 0n) return null;
	let charityCut = 0n;
	if (giving.charity_enabled && Number(giving.charity_bps) > 0) {
		charityCut = (base * BigInt(Math.round(Number(giving.charity_bps)))) / 10000n;
	}
	let roundupCut = 0n;
	if (giving.roundup_enabled && giving.roundup_to_atomics) {
		let nearest = 0n;
		try { nearest = BigInt(giving.roundup_to_atomics); } catch { nearest = 0n; }
		if (nearest > 0n) {
			const rem = base % nearest;
			if (rem > 0n) roundupCut = nearest - rem;
		}
	}
	const total = charityCut + roundupCut;
	if (total <= 0n) return null;
	const decimals = Number(accept.extra?.decimals ?? 6);
	const sym = (accept.extra?.name || 'USDC').replace(/^USD Coin$/, 'USDC');
	return {
		to,
		amount: total.toString(),
		charity: charityCut.toString(),
		roundup: roundupCut.toString(),
		total: (base + total).toString(),
		name: giving.charity_name || 'a good cause',
		decimals,
		sym,
	};
}
// The modal only signs EIP-3009 transferWithAuthorization for EVM. When the
// server publishes both an EIP-3009 entry and a Permit2 sibling (the
// gas-sponsoring path used by @x402/evm SDK clients), we must pick the
// EIP-3009 one — signing typed-data against the Permit2 entry would build a
// payload the facilitator rejects. The sibling carries
// `extra.assetTransferMethod === 'permit2'`; the legacy entry omits it.
function isEip3009Accept(accept) {
	if (!isEvmNetwork(accept?.network)) return false;
	const method = accept?.extra?.assetTransferMethod;
	return !method || method === 'eip3009';
}
// Opt-in allowlist (opts.networks). When a caller restricts which networks the
// modal may offer (e.g. ['solana'] to force a Solana-only checkout), drop every
// accept outside the allowlist before the picker renders. Families: 'solana' /
// 'svm' match any solana:* network, 'evm' matches any eip155:*, or pass an exact
// CAIP id like 'eip155:8453'. If the filter would empty the list we keep the
// original accepts so a misconfigured allowlist never breaks a live checkout.
function filterAcceptsByNetwork(challenge, networks) {
	if (!challenge || !Array.isArray(challenge.accepts) || !Array.isArray(networks) || !networks.length) return challenge;
	const want = networks.map((n) => String(n).toLowerCase());
	const allowed = (net) => want.some((w) => {
		if (w === 'solana' || w === 'svm') return isSolanaNetwork(net);
		if (w === 'evm') return isEvmNetwork(net);
		return typeof net === 'string' && net.toLowerCase() === w;
	});
	const kept = challenge.accepts.filter((a) => a && allowed(a.network));
	return kept.length ? { ...challenge, accepts: kept } : challenge;
}
function networkLabel(net, accept) {
	if (isSolanaNetwork(net)) return 'Solana';
	const meta = EVM_NETWORKS[net];
	return meta?.name || accept?.extra?.name || net;
}
function explorerUrl(net, tx) {
	if (!tx) return null;
	if (isSolanaNetwork(net)) return `https://solscan.io/tx/${tx}`;
	const meta = EVM_NETWORKS[net];
	return meta ? `${meta.explorer}${tx}` : null;
}

function formatAmount(rawAtomics, decimals = 6) {
	const n = Number(rawAtomics) / 10 ** decimals;
	if (n < 0.01) return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	if (n < 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	return n.toFixed(2);
}

// Block-explorer link for a wallet ADDRESS (not a tx) — used by the
// insufficient-funds state so the buyer can inspect/top up their own wallet.
function addressExplorerUrl(net, addr) {
	if (!addr) return null;
	if (isSolanaNetwork(net)) return `https://solscan.io/account/${addr}`;
	const base = EVM_NETWORKS[net]?.explorer; // e.g. https://basescan.org/tx/
	return base ? `${base.replace(/tx\/?$/, '')}address/${addr}` : null;
}

// ── Pre-flight balance guard (UX, not security) ──────────────────────────────
// Spares the buyer from signing a transaction that can only fail at settle.
// Fail-open: a balance that can't be read (flaky RPC / provider quirk) returns
// null and the payment proceeds unchanged — only a POSITIVE shortfall blocks.
function solanaRpcUrl() {
	const meta = typeof document !== 'undefined' && document.querySelector('meta[name="solana-rpc-url"]');
	if (meta?.content) return meta.content;
	if (typeof window !== 'undefined' && window.SOLANA_RPC_URL) return window.SOLANA_RPC_URL;
	// Last resort: the /api/solana-rpc proxy co-deployed with this script, which
	// fails over across Helius → Alchemy → dRPC → five keyless public lanes, so the
	// balance read survives any single provider (an expired Helius plan included)
	// being down. Resolved from this module's own serving origin, NOT a hardcoded
	// host: as a third-party embed the script is loaded from three.ws (resolves to
	// three.ws); as the first-party app on a preview/dev/tunnel origin it resolves
	// same-origin, so the read never trips that origin's CORS allowlist.
	return scriptOrigin() + '/api/solana-rpc';
}

// Origin that served this module — where its same-deployment /api proxy lives.
function scriptOrigin() {
	try {
		const o = new URL(import.meta.url).origin;
		if (o && o !== 'null') return o;
	} catch {}
	if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
		return location.origin;
	}
	return 'https://three.ws';
}
async function readSolanaBalanceAtomic(owner, mint) {
	try {
		const res = await fetch(solanaRpcUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
				params: [owner, { mint }, { encoding: 'jsonParsed' }],
			}),
		});
		if (!res.ok) return null;
		const data = await res.json();
		let total = 0n;
		for (const acc of data?.result?.value || []) {
			const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
			if (amt != null) total += BigInt(amt);
		}
		return total;
	} catch (_) { return null; }
}
async function readEvmBalanceAtomic(provider, token, owner) {
	try {
		const data = '0x70a08231' + String(owner).toLowerCase().replace(/^0x/, '').padStart(64, '0');
		const hex = await provider.request({ method: 'eth_call', params: [{ to: token, data }, 'latest'] });
		if (!hex || hex === '0x') return null;
		return BigInt(hex);
	} catch (_) { return null; }
}
// Throws a structured insufficient-funds error (code + .insufficient) when a
// balance is positively read and short; resolves otherwise.
async function assertBalance({ accept, owner, provider }) {
	const required = BigInt(accept.amount);
	let balance = null;
	if (isSolanaNetwork(accept.network)) balance = await readSolanaBalanceAtomic(owner, accept.asset);
	else if (provider) balance = await readEvmBalanceAtomic(provider, accept.asset, owner);
	if (balance === null || balance >= required) return;
	const decimals = Number(accept.extra?.decimals ?? 6);
	const symbol = accept.extra?.name || 'USDC';
	const shortfall = required - balance;
	const err = new Error(
		`Not enough ${symbol} — you need ${formatAmount(required, decimals)} ${symbol} but your wallet holds ${formatAmount(balance, decimals)} ${symbol}.`,
	);
	err.code = 'insufficient_funds';
	err.insufficient = {
		symbol, network: accept.network, owner,
		required: formatAmount(required, decimals),
		balance: formatAmount(balance, decimals),
		shortfall: formatAmount(shortfall, decimals),
	};
	throw err;
}

function b64encode(obj) {
	const json = JSON.stringify(obj);
	if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64');
	return btoa(unescape(encodeURIComponent(json)));
}
function b64decode(str) {
	if (!str) return null;
	try {
		const bin = typeof Buffer !== 'undefined' ? Buffer.from(str, 'base64').toString('utf8') : decodeURIComponent(escape(atob(str)));
		return JSON.parse(bin);
	} catch (_) {
		return null;
	}
}

// ──────────────────────────────────────────── Spending caps (USE-22) ────────
// Persists per-wallet spend in localStorage so reload-survivable caps work
// in a pure-browser context. Keys are bucketed by UTC hour and UTC day so
// the sliding windows reset cleanly at midnight UTC for the daily case.
// All amounts are stored as base-10 BigInt strings of micro-USD; stablecoin
// payments (USDC, USDT, DAI) flow through as-is since their atomics are
// already 6-decimal USD-pegged.

const SPEND_LS_PREFIX = 'x402.spend.';
const STABLE_NAMES = new Set([
	'usdc', 'usd coin', 'usdt', 'tether', 'binance-peg usd coin', 'dai',
]);

function spendBuckets(timestamp = Date.now()) {
	const hour = Math.floor(timestamp / 3_600_000);
	const day = Math.floor(timestamp / 86_400_000);
	return { hour, day };
}

function spendKey(address, kind, bucket) {
	return `${SPEND_LS_PREFIX}${kind}.${address.toLowerCase()}.${bucket}`;
}

function readSpend(address, kind, bucket) {
	try {
		const raw = localStorage.getItem(spendKey(address, kind, bucket));
		if (!raw) return 0n;
		return BigInt(raw);
	} catch {
		return 0n;
	}
}

function writeSpend(address, kind, bucket, value) {
	try {
		localStorage.setItem(spendKey(address, kind, bucket), value.toString());
	} catch {
		// localStorage full / disabled — caps degrade to per-call only.
	}
}

function toMicroUsdBrowser(amount, accept) {
	const atomic = BigInt(amount);
	const decimals = Number(accept?.extra?.decimals ?? 6);
	const name = String(accept?.extra?.name || '').toLowerCase();
	if (STABLE_NAMES.has(name)) {
		if (decimals === 6) return atomic;
		if (decimals > 6) return atomic / 10n ** BigInt(decimals - 6);
		return atomic * 10n ** BigInt(6 - decimals);
	}
	// Non-stable in the browser modal: we don't fetch live prices to keep the
	// drop-in script dependency-free. Cap enforcement for non-stable assets
	// must be done server-side via x402-spending-cap.js.
	return atomic;
}

// Check the configured caps and, if admitted, reserve the spend in
// localStorage. Returns { abort: boolean, reason?, reservation? }.
// Reservation has { address, microUsd, buckets } so rollback can undo.
function browserEnforceCap({ accept, caps, address }) {
	if (!caps || !address) return { abort: false };
	const microUsd = toMicroUsdBrowser(accept.amount, accept);
	const maxPerCall = caps.maxPerCall != null ? BigInt(caps.maxPerCall) : null;
	const maxPerHour = caps.maxPerHour != null ? BigInt(caps.maxPerHour) : null;
	const maxPerDay = caps.maxPerDay != null ? BigInt(caps.maxPerDay) : null;
	if (maxPerCall != null && microUsd > maxPerCall) {
		return {
			abort: true,
			reason: `Per-call cap exceeded (${microUsd} > ${maxPerCall} µUSD)`,
		};
	}
	const buckets = spendBuckets();
	const hourTotal = readSpend(address, 'hr', buckets.hour) + microUsd;
	const dayTotal = readSpend(address, 'day', buckets.day) + microUsd;
	if (maxPerHour != null && hourTotal > maxPerHour) {
		return { abort: true, reason: `Hourly cap exceeded (${hourTotal} > ${maxPerHour} µUSD)` };
	}
	if (maxPerDay != null && dayTotal > maxPerDay) {
		return { abort: true, reason: `Daily cap exceeded (${dayTotal} > ${maxPerDay} µUSD)` };
	}
	writeSpend(address, 'hr', buckets.hour, hourTotal);
	writeSpend(address, 'day', buckets.day, dayTotal);
	return { abort: false, reservation: { address, microUsd, buckets } };
}

function browserRollbackReservation(reservation) {
	if (!reservation) return;
	const { address, microUsd, buckets } = reservation;
	const hourCurrent = readSpend(address, 'hr', buckets.hour);
	const dayCurrent = readSpend(address, 'day', buckets.day);
	const hourNext = hourCurrent - microUsd;
	const dayNext = dayCurrent - microUsd;
	writeSpend(address, 'hr', buckets.hour, hourNext < 0n ? 0n : hourNext);
	writeSpend(address, 'day', buckets.day, dayNext < 0n ? 0n : dayNext);
}

// ──────────────────────────────────────────── ERC-8021 builder-code echo ────
// The server-side x402-spec.js enforces that any client-echoed builder-code
// `a` matches what the 402 challenge declared (anti-tamper). Builders/wallets
// can append their own service code in `s` and set their wallet code `w`
// — for our own demo modal we self-attribute `w: "3d_agent"` and `s: ["3d_agent_modal"]`.

const BUILDER_CODE_KEY = 'builder-code';
const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
const OUR_WALLET_CODE = '3d_agent';
const OUR_SERVICE_CODE = '3d_agent_modal';

function buildBuilderCodeEcho(challenge) {
	const ext = challenge?.extensions?.[BUILDER_CODE_KEY];
	const declaredA = ext?.info?.a;
	if (!declaredA || !BUILDER_CODE_PATTERN.test(declaredA)) return null;
	const out = { a: declaredA };
	if (BUILDER_CODE_PATTERN.test(OUR_SERVICE_CODE)) out.s = [OUR_SERVICE_CODE];
	if (BUILDER_CODE_PATTERN.test(OUR_WALLET_CODE)) out.w = OUR_WALLET_CODE;
	return out;
}

// ─────────────────────────────────────────────────────────── SIWX helpers ────

function extractSiwxExtension(body) {
	const ext = body?.extensions?.[SIWX_EXTENSION_KEY];
	if (!ext || !ext.info || !Array.isArray(ext.supportedChains) || !ext.supportedChains.length) return null;
	return ext;
}

// Returns { chain, kind: 'evm' | 'solana' } or null. `chain` is the matching
// entry from `ext.supportedChains` whose signature type matches the wallet kind.
function pickSiwxChain(ext, walletKind) {
	for (const chain of ext.supportedChains) {
		if (walletKind === 'evm' && chain.type === 'eip191') return { chain, kind: 'evm' };
		if (walletKind === 'solana' && chain.type === 'ed25519') return { chain, kind: 'solana' };
	}
	return null;
}

// Build the CAIP-122 message string. The server rebuilds the same string from
// payload fields when verifying — any line-by-line drift makes the recovered
// signer mismatch payload.address and the signature is rejected.
//
// EVM path mirrors EIP-4361 / siwe library's prepareMessage (chain ref =
// numeric chainId extracted from "eip155:<n>"). Solana path mirrors SIWS
// (chain ref = genesis hash extracted from "solana:<ref>"). Optional fields
// are omitted entirely when absent from server info.
function buildSiwxMessage(info, chain, address) {
	const isEvm = chain.type === 'eip191';
	const accountHeader = isEvm
		? `${info.domain} wants you to sign in with your Ethereum account:`
		: `${info.domain} wants you to sign in with your Solana account:`;
	const [, chainTail = ''] = String(chain.chainId).split(':');
	const chainRef = isEvm ? String(parseInt(chainTail, 10)) : chainTail;

	const lines = [accountHeader, address, ''];
	if (info.statement) {
		lines.push(info.statement, '');
	} else if (isEvm) {
		// siwe's prepareMessage() reserves the statement block even when the
		// statement is absent, emitting an extra blank line (header, address,
		// "", "", URI). SIWS's formatter does not. The server rebuilds the EVM
		// message via siwe before recovering the signer, so omit-statement EVM
		// must carry the same extra blank or the recovered address mismatches.
		lines.push('');
	}
	lines.push(`URI: ${info.uri}`);
	lines.push(`Version: ${info.version || '1'}`);
	lines.push(`Chain ID: ${chainRef}`);
	lines.push(`Nonce: ${info.nonce}`);
	lines.push(`Issued At: ${info.issuedAt}`);
	if (info.expirationTime) lines.push(`Expiration Time: ${info.expirationTime}`);
	if (info.notBefore) lines.push(`Not Before: ${info.notBefore}`);
	if (info.requestId !== undefined && info.requestId !== null) lines.push(`Request ID: ${info.requestId}`);
	if (Array.isArray(info.resources) && info.resources.length) {
		lines.push('Resources:');
		for (const r of info.resources) lines.push(`- ${r}`);
	}
	return lines.join('\n');
}

// Base64-encoded JSON per x402 v2 spec (CHANGELOG-v2.md line 335). CAIP-122
// fields are all ASCII/Latin-1, so the unescape+encodeURIComponent dance
// matches what btoa expects without garbling unicode (none is sent anyway).
function encodeSiwxHeaderValue(payload) {
	const json = JSON.stringify(payload);
	if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64');
	return btoa(unescape(encodeURIComponent(json)));
}

// Base58 (Bitcoin alphabet) — Solana's encoding for both addresses and
// signatures. Inlined here to avoid pulling in a bundler dependency; this
// matches what `bs58` does on the server side (api/_lib/siws.js).
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58encode(bytes) {
	if (!bytes || bytes.length === 0) return '';
	let leadingZeros = 0;
	while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
	let n = 0n;
	for (let i = 0; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i]);
	let out = '';
	while (n > 0n) {
		out = BASE58_ALPHABET[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (let i = 0; i < leadingZeros; i++) out = BASE58_ALPHABET[0] + out;
	return out;
}

// EIP-55 checksum the address before signing. MetaMask returns addresses in
// lowercase via eth_requestAccounts, but the server rebuilds the SIWE message
// with a checksummed address (siwe library's prepareMessage always upgrades
// case via getAddress). If we sign a lowercase-address message and send the
// lowercase address in the payload, the server's recovered signer (from the
// checksummed-address message it builds) differs from payload.address and
// verification fails. So checksum here, then use the same string everywhere.
//
// Keccak-256 lives in @noble/hashes which the server already uses
// (api/_lib/siws.js -> @noble/curves). Pulled in dynamically only when SIWX EVM
// sign-in is actually attempted, mirroring loadSolanaWeb3.
let _evmChecksum = null;
async function loadEvmChecksum() {
	if (_evmChecksum) return _evmChecksum;
	// Same mirror chain as the Solana loader: sign-in must not hinge on one CDN.
	const { loadModule } = await import('./load-module.js');
	const sha3 = await loadModule('https://esm.sh/@noble/hashes@1.4.0/sha3?bundle');
	const keccak = sha3.keccak_256;
	_evmChecksum = (addr) => {
		const a = String(addr).toLowerCase().replace(/^0x/, '');
		if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`invalid EVM address: ${addr}`);
		const hashBytes = keccak(new TextEncoder().encode(a));
		let hex = '';
		for (let i = 0; i < hashBytes.length; i++) hex += hashBytes[i].toString(16).padStart(2, '0');
		let out = '0x';
		for (let i = 0; i < 40; i++) {
			out += parseInt(hex[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
		}
		return out;
	};
	return _evmChecksum;
}

// ───────────────────────────────────────────────────────────────── styles ────

const STYLE_ID = 'x402-styles';
const STYLES = `
:root {
	--x402-z: 2147483600;
}
.x402-overlay {
	position: fixed; inset: 0;
	background: rgba(8, 10, 18, 0.55);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	display: flex; align-items: center; justify-content: center;
	z-index: var(--x402-z);
	opacity: 0; transition: opacity 0.16s ease-out;
	font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	-webkit-font-smoothing: antialiased;
	color: #0f0f0f;
}
.x402-overlay.x402-open { opacity: 1; }
.x402-overlay * { box-sizing: border-box; }
.x402-modal {
	width: calc(100% - 32px); max-width: 420px;
	background: #ffffff;
	border-radius: 18px;
	box-shadow: 0 24px 80px rgba(8, 10, 18, 0.28), 0 4px 16px rgba(8, 10, 18, 0.12);
	overflow: hidden;
	transform: translateY(8px) scale(0.985);
	transition: transform 0.18s ease-out;
	display: flex; flex-direction: column;
	max-height: calc(100dvh - 32px);
}
.x402-overlay.x402-open .x402-modal { transform: translateY(0) scale(1); }
.x402-head {
	padding: 18px 20px 14px;
	border-bottom: 1px solid #eef0f4;
	display: flex; align-items: center; gap: 12px;
}
.x402-head .x402-merchant {
	flex: 1; min-width: 0;
}
.x402-merchant .x402-name {
	font-size: 12px; color: #5a6378; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;
	margin-bottom: 2px;
}
.x402-merchant .x402-action {
	font-size: 17px; font-weight: 700; color: #0f0f0f;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	letter-spacing: -0.01em;
}
.x402-close {
	width: 32px; height: 32px;
	border-radius: 8px; border: none; background: #f3f4f7;
	font-size: 16px; color: #5a6378; cursor: pointer;
	display: flex; align-items: center; justify-content: center;
	transition: background 0.12s;
}
.x402-close:hover { background: #e7e9ee; color: #0f0f0f; }

.x402-price-row {
	padding: 18px 20px;
	display: flex; align-items: baseline; justify-content: space-between;
	background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%);
	border-bottom: 1px solid #eef0f4;
}
.x402-price {
	font-size: 32px; font-weight: 700; letter-spacing: -0.02em; color: #0f0f0f;
	font-variant-numeric: tabular-nums;
}
.x402-price .x402-currency { font-size: 14px; color: #5a6378; font-weight: 600; margin-left: 6px; letter-spacing: 0; }
.x402-network {
	font-size: 12px; color: #5a6378; font-weight: 500;
	background: #f3f4f7; padding: 5px 10px; border-radius: 99px;
	display: inline-flex; align-items: center; gap: 6px;
}
.x402-network::before {
	content: ''; width: 6px; height: 6px; border-radius: 50%;
	background: #22c55e;
}

.x402-body {
	padding: 16px 20px 18px;
	flex: 1 1 auto; overflow-y: auto;
	display: flex; flex-direction: column; gap: 10px;
}
.x402-step {
	display: flex; gap: 12px; align-items: flex-start;
	padding: 10px 0;
}
.x402-step + .x402-step { border-top: 1px solid #f3f4f7; }
.x402-step-num {
	width: 22px; height: 22px; flex: 0 0 auto;
	border-radius: 50%; border: 1.5px solid #d0d4dd; background: #fff;
	color: #5a6378;
	font-size: 11px; font-weight: 700;
	display: flex; align-items: center; justify-content: center;
}
.x402-step.x402-active .x402-step-num {
	border-color: #0a84ff; background: #0a84ff; color: #fff;
	animation: x402-spin 1.2s linear infinite;
}
.x402-step.x402-done .x402-step-num {
	border-color: #22c55e; background: #22c55e; color: #fff;
}
.x402-step.x402-error .x402-step-num {
	border-color: #ef4444; background: #ef4444; color: #fff;
}
@keyframes x402-spin {
	from { box-shadow: 0 0 0 0 rgba(10, 132, 255, 0.4); }
	to { box-shadow: 0 0 0 8px rgba(10, 132, 255, 0); }
}
.x402-step-body { flex: 1; min-width: 0; }
.x402-step-label { font-size: 14px; font-weight: 600; color: #0f0f0f; line-height: 1.35; }
.x402-step-meta { font-size: 12px; color: #5a6378; margin-top: 2px; font-feature-settings: 'tnum' 1; }
.x402-step.x402-error .x402-step-meta { color: #ef4444; }

.x402-wallet-buttons {
	display: flex; flex-direction: column; gap: 8px;
	margin-top: 4px;
}
.x402-wallet-btn {
	width: 100%; padding: 13px 14px;
	background: #ffffff; border: 1.5px solid #e2e5ec; border-radius: 11px;
	font-size: 14px; font-weight: 600; color: #0f0f0f;
	cursor: pointer; font-family: inherit;
	display: flex; align-items: center; gap: 12px;
	transition: border-color 0.12s, background 0.12s, transform 0.05s;
}
.x402-wallet-btn:hover:not(:disabled) { border-color: #0a84ff; background: #f7faff; }
.x402-wallet-btn:active:not(:disabled) { transform: translateY(1px); }
.x402-wallet-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.x402-wallet-icon {
	width: 28px; height: 28px; flex: 0 0 auto;
	border-radius: 7px;
	display: flex; align-items: center; justify-content: center;
	font-size: 16px;
	background: #f3f4f7;
}
.x402-wallet-icon.x402-phantom { background: linear-gradient(135deg, #ab9ff2, #534bb1); color: #fff; }
.x402-wallet-icon.x402-metamask { background: linear-gradient(135deg, #f6851b, #e2761b); color: #fff; }
.x402-wallet-icon.x402-agent { background: linear-gradient(135deg, #22c55e, #0ea5e9); color: #fff; }
.x402-wallet-name { flex: 1; text-align: left; }
.x402-wallet-sub { display: block; font-size: 11px; color: #8a90a8; font-weight: 500; margin-top: 1px; }
.x402-wallet-meta { font-size: 11px; color: #8a90a8; font-weight: 500; }
.x402-wallet-group-label {
	font-size: 11px; font-weight: 700; color: #8a90a8;
	text-transform: uppercase; letter-spacing: 0.06em;
	margin: 4px 0 0;
}

.x402-pay-btn {
	width: 100%; padding: 14px 16px;
	background: #0f0f0f; color: #fff; border: none;
	border-radius: 12px;
	font-size: 15px; font-weight: 700; font-family: inherit;
	cursor: pointer; letter-spacing: -0.005em;
	transition: background 0.12s, transform 0.05s;
	margin-top: 4px;
	display: flex; align-items: center; justify-content: center; gap: 8px;
}
.x402-pay-btn:hover:not(:disabled) { background: #1d1d1d; }
.x402-pay-btn:active:not(:disabled) { transform: translateY(1px); }
.x402-pay-btn:disabled { background: #c8ccd4; cursor: not-allowed; }

.x402-pay-secondary {
	width: 100%; padding: 12px 14px;
	background: #ffffff; color: #0f0f0f;
	border: 1.5px solid #e2e5ec; border-radius: 11px;
	font-size: 14px; font-weight: 600; font-family: inherit;
	cursor: pointer; letter-spacing: -0.005em;
	margin-top: 6px;
	transition: border-color 0.12s, background 0.12s, transform 0.05s;
}
.x402-pay-secondary:hover:not(:disabled) { border-color: #0a84ff; background: #f7faff; }
.x402-pay-secondary:active:not(:disabled) { transform: translateY(1px); }

.x402-siwx-hint {
	font-size: 11px; color: #5a6378; text-align: center;
	margin-top: 8px; line-height: 1.4;
}

.x402-insuff-title { font-size: 16px; font-weight: 700; color: #0f0f0f; letter-spacing: -0.01em; }
.x402-insuff-sub { font-size: 13px; color: #5a6378; margin-top: 4px; line-height: 1.45; }
.x402-insuff-actions { display: flex; gap: 8px; margin-top: 12px; }
.x402-insuff-actions > * { flex: 1; }
.x402-mini-btn {
	padding: 9px 12px; background: #ffffff; color: #0f0f0f;
	border: 1.5px solid #e2e5ec; border-radius: 10px;
	font-size: 13px; font-weight: 600; font-family: inherit;
	cursor: pointer; text-align: center; text-decoration: none;
	display: inline-flex; align-items: center; justify-content: center;
	transition: border-color 0.12s, background 0.12s;
}
.x402-mini-btn:hover { border-color: #0a84ff; background: #f7faff; text-decoration: none; }
.x402-mini-btn:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }

.x402-payee { font-size: 12px; color: #8a90a8; text-align: center; margin: 0 0 10px; }
.x402-payee-addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #0a84ff; text-decoration: none; border-bottom: 1px dotted rgba(10,132,255,0.4); }
.x402-payee-addr:hover { border-bottom-style: solid; text-decoration: none; }
.x402-payee-addr:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; border-radius: 2px; }
.x402-trust { font-size: 11px; color: #8a90a8; text-align: center; margin-top: 12px; line-height: 1.45; }

/* Keyboard focus indicator on every interactive control in the money modal. */
.x402-overlay button:focus-visible,
.x402-overlay a:focus-visible,
.x402-overlay input:focus-visible,
.x402-overlay [tabindex]:focus-visible {
	outline: 2px solid #0a84ff;
	outline-offset: 2px;
	border-radius: 8px;
}
.x402-modal:focus { outline: none; }
.x402-siwx-fallback {
	font-size: 12px; color: #b45309; line-height: 1.45;
	padding: 8px 10px; border-radius: 8px;
	background: #fffbeb; border: 1px solid #fde68a;
	margin-bottom: 6px;
}

.x402-giving {
	display: flex; align-items: flex-start; gap: 10px;
	padding: 11px 12px; margin-bottom: 10px;
	border-radius: 11px; border: 1px solid #bbf7d0;
	background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%);
	cursor: pointer; user-select: none;
	transition: border-color 0.12s, background 0.12s;
}
.x402-giving:hover { border-color: #86efac; }
.x402-giving input { position: absolute; opacity: 0; width: 0; height: 0; }
.x402-giving-box {
	flex: 0 0 auto; width: 18px; height: 18px; margin-top: 1px;
	border-radius: 5px; border: 1.5px solid #86efac; background: #fff;
	display: flex; align-items: center; justify-content: center;
	color: #fff; font-size: 12px; line-height: 1; transition: background 0.12s, border-color 0.12s;
}
.x402-giving input:checked + .x402-giving-box { background: #16a34a; border-color: #16a34a; }
.x402-giving input:checked + .x402-giving-box::after { content: '✓'; }
.x402-giving input:focus-visible + .x402-giving-box { box-shadow: 0 0 0 3px rgba(22,163,74,0.25); }
.x402-giving-text { flex: 1 1 auto; min-width: 0; }
.x402-giving-title { font-size: 13px; font-weight: 700; color: #15803d; line-height: 1.3; }
.x402-giving-sub { font-size: 11.5px; color: #5a6378; margin-top: 2px; line-height: 1.4; font-feature-settings: 'tnum' 1; }
.x402-giving-amt { font-weight: 700; color: #0f0f0f; }

.x402-error-box {
	padding: 12px 14px; border-radius: 10px;
	background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
	font-size: 13px; line-height: 1.45;
	font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
	word-break: break-word;
}
.x402-error-box strong { font-weight: 700; }

.x402-receipt {
	padding: 14px 16px; border-radius: 12px;
	background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%);
	border: 1px solid #bbf7d0;
}
.x402-receipt-title {
	font-size: 11px; font-weight: 700; color: #15803d;
	text-transform: uppercase; letter-spacing: 0.06em;
	margin-bottom: 8px;
	display: flex; align-items: center; gap: 6px;
}
.x402-receipt-title::before { content: '✓'; font-size: 14px; }
.x402-receipt-row {
	display: flex; justify-content: space-between; gap: 12px;
	font-size: 12px; padding: 2px 0;
	font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
}
.x402-receipt-row .x402-k { color: #5a6378; }
.x402-receipt-row .x402-v { color: #0f0f0f; text-align: right; word-break: break-all; }
.x402-receipt-row a { color: #0a84ff; text-decoration: none; }
.x402-receipt-row a:hover { text-decoration: underline; }

.x402-result {
	padding: 12px 14px; border-radius: 10px;
	background: #fafbfc; border: 1px solid #e2e5ec;
	max-height: 240px; overflow: auto;
	font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
	font-size: 12px; line-height: 1.5; color: #0f0f0f;
	white-space: pre-wrap; word-break: break-word;
}

.x402-foot {
	padding: 10px 20px 14px;
	border-top: 1px solid #eef0f4;
	display: flex; align-items: center; justify-content: space-between;
	font-size: 11px; color: #8a90a8;
}
.x402-foot a { color: #5a6378; text-decoration: none; font-weight: 600; }
.x402-foot a:hover { color: #0f0f0f; }
.x402-foot .x402-secure { display: flex; align-items: center; gap: 5px; }
.x402-foot .x402-secure::before { content: '🔒'; font-size: 10px; }

@media (max-width: 480px) {
	.x402-modal { max-width: none; width: calc(100% - 16px); border-radius: 16px; }
	.x402-price { font-size: 26px; }
}

@media (prefers-color-scheme: dark) {
	.x402-overlay { color: #e6e8f0; }
	.x402-modal { background: #161616; box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6); }
	.x402-head, .x402-price-row, .x402-foot { border-color: #272727; }
	.x402-step + .x402-step { border-top-color: #272727; }
	.x402-merchant .x402-name { color: #8a90a8; }
	.x402-merchant .x402-action, .x402-price, .x402-step-label { color: #e6e8f0; }
	.x402-step-meta { color: #8a90a8; }
	.x402-close { background: #222222; color: #8a90a8; }
	.x402-close:hover { background: #2e2e2e; color: #e6e8f0; }
	.x402-price-row { background: linear-gradient(180deg, #1d1d1d 0%, #161616 100%); }
	.x402-network { background: #222222; color: #b0b6cc; }
	.x402-wallet-btn { background: #1d1d1d; border-color: #2e2e2e; color: #e6e8f0; }
	.x402-wallet-btn:hover:not(:disabled) { background: #252525; border-color: #0a84ff; }
	.x402-wallet-icon { background: #2e2e2e; }
	.x402-wallet-meta { color: #6b7088; }
	.x402-wallet-sub { color: #6b7088; }
	.x402-wallet-group-label { color: #6b7088; }
	.x402-pay-btn { background: #ffffff; color: #0f0f0f; }
	.x402-pay-btn:hover:not(:disabled) { background: #e7e9ee; }
	.x402-pay-btn:disabled { background: #2e2e2e; color: #5a6378; }
	.x402-pay-secondary { background: #1d1d1d; border-color: #2e2e2e; color: #e6e8f0; }
	.x402-pay-secondary:hover:not(:disabled) { background: #252525; border-color: #0a84ff; }
	.x402-siwx-hint { color: #8a90a8; }
	.x402-siwx-fallback { background: #2a1d10; border-color: #78350f; color: #fcd34d; }
	.x402-step-num { background: #161616; border-color: #2e2e2e; color: #8a90a8; }
	.x402-result { background: #1d1d1d; border-color: #2e2e2e; color: #e6e8f0; }
	.x402-receipt { background: linear-gradient(180deg, #0b1f17 0%, #161616 100%); border-color: #14532d; }
	.x402-receipt-title { color: #4ade80; }
	.x402-receipt-row .x402-k { color: #8a90a8; }
	.x402-receipt-row .x402-v { color: #e6e8f0; }
	.x402-receipt-row a { color: #60a5fa; }
	.x402-error-box { background: #1f1416; border-color: #7f1d1d; color: #fca5a5; }
	.x402-foot a { color: #b0b6cc; }
	.x402-foot a:hover { color: #ffffff; }
}
`;

function injectStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

// ───────────────────────────────────────────────────────────── modal class ───

class CheckoutModal {
	constructor(opts) {
		this.opts = opts;
		this.steps = [
			{ id: 'discover', label: 'Confirming price' },
			{ id: 'connect', label: 'Connect wallet' },
			{ id: 'authorize', label: 'Authorize payment' },
			{ id: 'verify', label: 'Verify & complete' },
		];
		this.activeNetwork = null;
		this.payerAddress = null;
		this.accept = null;
		this.challenge = null;
		this.disposed = false;
		// One-shot guard for opts.autoConnect: we only auto-open the wallet on the
		// first connect render, so an error that drops the user back to this step
		// shows the manual picker instead of re-launching the wallet in a loop.
		this.autoConnectTried = false;
	}

	mount() {
		injectStyles();
		const overlay = document.createElement('div');
		overlay.className = 'x402-overlay';
		overlay.innerHTML = `
			<div class="x402-modal" role="dialog" aria-modal="true" aria-label="x402 payment" tabindex="-1">
				<div class="x402-head">
					<div class="x402-merchant">
						<div class="x402-name" data-merchant>${escapeHtml(this.opts.merchant || 'Payment')}</div>
						<div class="x402-action" data-action>${escapeHtml(this.opts.action || 'Pay-per-call')}</div>
					</div>
					<button class="x402-close" data-close aria-label="Close payment">✕</button>
				</div>
				<div class="x402-price-row">
					<div class="x402-price" data-price>—<span class="x402-currency"> USDC</span></div>
					<div class="x402-network" data-network>resolving…</div>
				</div>
				<div class="x402-body" data-body role="status" aria-live="polite"></div>
				<div class="x402-foot">
					<span class="x402-secure">x402 · onchain settled</span>
					<a href="https://three.ws" target="_blank" rel="noopener">Powered by three.ws</a>
				</div>
			</div>
		`;
		// Remember what to restore focus to when the modal closes.
		this.previouslyFocused =
			typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		document.body.appendChild(overlay);
		this.overlay = overlay;
		this.modalEl = overlay.querySelector('.x402-modal');
		this.bodyEl = overlay.querySelector('[data-body]');
		this.priceEl = overlay.querySelector('[data-price]');
		this.networkEl = overlay.querySelector('[data-network]');
		// Make the rest of the page inert to AT + tab order while the money modal is
		// open, so focus can't wander behind it mid-payment. Restored in close().
		this._inerted = [];
		for (const child of Array.from(document.body.children)) {
			if (child !== overlay && !child.hasAttribute('inert')) {
				child.setAttribute('inert', '');
				child.setAttribute('aria-hidden', 'true');
				this._inerted.push(child);
			}
		}
		overlay.querySelector('[data-close]').addEventListener('click', () => this.close('cancelled'));
		overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close('cancelled'); });
		this.onKey = (e) => {
			if (e.key === 'Escape') { this.close('cancelled'); return; }
			if (e.key === 'Tab') this._trapTab(e);
		};
		document.addEventListener('keydown', this.onKey);
		requestAnimationFrame(() => {
			overlay.classList.add('x402-open');
			this._focusFirst();
		});
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	// All tabbable elements currently visible inside the modal.
	_focusable() {
		if (!this.modalEl) return [];
		return Array.from(
			this.modalEl.querySelectorAll(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => el.offsetParent !== null || el === document.activeElement);
	}

	// On open (and after re-renders the caller cares about) land focus on the
	// primary action — wallet/retry/pay button — rather than the ✕, so keyboard
	// users reach the thing they came to do first.
	_focusFirst() {
		if (!this.modalEl) return;
		const primary = this.modalEl.querySelector(
			'[data-agent-wallet]:not([disabled]), [data-wallet]:not([disabled]), [data-retry], .x402-pay-btn:not([disabled])',
		);
		(primary || this._focusable()[0] || this.modalEl).focus();
	}

	// Cycle Tab / Shift+Tab within the modal; pull stray focus back inside.
	_trapTab(e) {
		const f = this._focusable();
		if (!f.length) { e.preventDefault(); this.modalEl.focus(); return; }
		const first = f[0];
		const last = f[f.length - 1];
		const active = document.activeElement;
		const inside = this.modalEl.contains(active);
		if (e.shiftKey) {
			if (active === first || !inside) { e.preventDefault(); last.focus(); }
		} else if (active === last || !inside) {
			e.preventDefault();
			first.focus();
		}
	}

	close(reason) {
		if (this.disposed) return;
		this.disposed = true;
		document.removeEventListener('keydown', this.onKey);
		// Un-inert the rest of the page and restore focus to the trigger.
		if (this._inerted) {
			for (const el of this._inerted) {
				el.removeAttribute('inert');
				el.removeAttribute('aria-hidden');
			}
			this._inerted = null;
		}
		if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
			try { this.previouslyFocused.focus(); } catch (_) { /* element gone — ignore */ }
		}
		this.overlay.classList.remove('x402-open');
		setTimeout(() => this.overlay.remove(), 180);
		if (reason === 'cancelled' && this.reject) {
			const err = new Error('cancelled');
			err.code = 'cancelled';
			this.reject(err);
		}
	}

	renderSteps(activeId, status = {}) {
		const html = this.steps
			.map((s) => {
				const state = status[s.id] || (s.id === activeId ? 'active' : 'idle');
				const cls = state === 'active' ? 'x402-active' : state === 'done' ? 'x402-done' : state === 'error' ? 'x402-error' : '';
				const meta = status[`${s.id}_meta`] || '';
				const sym = state === 'done' ? '✓' : state === 'error' ? '!' : s.id === activeId && state === 'active' ? ' ' : (this.steps.findIndex((x) => x.id === s.id) + 1);
				return `<div class="x402-step ${cls}">
					<div class="x402-step-num">${sym}</div>
					<div class="x402-step-body">
						<div class="x402-step-label">${s.label}</div>
						${meta ? `<div class="x402-step-meta">${escapeHtml(meta)}</div>` : ''}
					</div>
				</div>`;
			})
			.join('');
		return html;
	}

	// Buyer-facing charity / round-up opt-in. Default-checked; toggling updates
	// `this.includeDonation`, which runSolana reads when assembling the tx. The
	// donation rides the same signed transaction, so the buyer pays once.
	renderGivingBox(g) {
		const donation = formatAmount(g.amount, g.decimals);
		const total = formatAmount(g.total, g.decimals);
		const parts = [];
		if (g.charity !== '0') parts.push(`${formatAmount(g.charity, g.decimals)} ${g.sym} donation`);
		if (g.roundup !== '0') parts.push(`${formatAmount(g.roundup, g.decimals)} ${g.sym} round-up`);
		const detail = parts.join(' + ');
		return `
			<label class="x402-giving">
				<input type="checkbox" data-giving ${this.includeDonation ? 'checked' : ''} />
				<span class="x402-giving-box"></span>
				<span class="x402-giving-text">
					<span class="x402-giving-title">Add <span class="x402-giving-amt">${donation} ${g.sym}</span> for ${escapeHtml(g.name)}</span>
					<span class="x402-giving-sub">${detail ? escapeHtml(detail) + ' · ' : ''}you'd pay ${total} ${g.sym} total, settled in one transaction</span>
				</span>
			</label>
		`;
	}

	setPrice(accept) {
		const decimals = accept.extra?.decimals ?? 6;
		const amount = formatAmount(accept.amount, decimals);
		const sym = (accept.extra?.name || 'USDC').replace(/^USD Coin$/, 'USDC');
		this.priceEl.innerHTML = `${amount}<span class="x402-currency"> ${sym}</span>`;
		this.networkEl.textContent = networkLabel(accept.network, accept);
	}

	renderConnect() {
		this.currentView = 'connect';
		const solanaProvider = detectSolanaProvider();
		const phantomDetected = !!solanaProvider;
		const evmDetected = typeof window !== 'undefined' && window.ethereum;
		const solanaAccept = this.challenge?.accepts.find((a) => isSolanaNetwork(a.network));
		const evmAccept = this.challenge?.accepts.find(isEip3009Accept);

		// Charity / round-up giving — only when the merchant configured it and the
		// cause wallet is reachable on this Solana checkout. Default-included, but
		// always rendered with an opt-out so the buyer consents before signing.
		this.solanaGiving = solanaAccept ? computeGiving(this.opts.giving, solanaAccept) : null;
		if (this.includeDonation === undefined) this.includeDonation = true;
		this.givingShown = false;

		// SIWX-first path: when the 402 advertises sign-in-with-x AND we have a
		// compatible wallet, lead with "Sign in with wallet" (primary) and
		// demote pay to a secondary action. payFlowOverride is set true when
		// the user explicitly chooses to pay (either by clicking the secondary
		// button, or after a 401/402 siwx_not_paid retry told us this wallet
		// hasn't actually paid for this resource yet).
		if (this.siwx && !this.payFlowOverride) {
			const siwxSolana = phantomDetected ? pickSiwxChain(this.siwx, 'solana') : null;
			const siwxEvm = evmDetected ? pickSiwxChain(this.siwx, 'evm') : null;
			if (siwxSolana || siwxEvm) {
				this.renderSiwxChoice({ siwxSolana, siwxEvm });
				return;
			}
		}

		// autoConnect (opt-in via opts.autoConnect): when the caller knows the
		// user is wallet-ready and shouldn't have to pick, skip the picker and go
		// straight to the signature — but only when exactly one supported wallet
		// is actually detected. Zero wallets (must install) or two (must choose)
		// still fall through to the picker, as does the SIWX "you haven't paid"
		// fallback, which needs to explain itself. One-shot via autoConnectTried.
		if (this.opts.autoConnect && !this.autoConnectTried && !this.siwxFallbackNotice) {
			this.autoConnectTried = true;
			const solanaViable = !!(solanaAccept && phantomDetected);
			const evmViable = !!(evmAccept && evmDetected);
			if (solanaViable && !evmViable) { this.runSolana(solanaAccept); return; }
			if (evmViable && !solanaViable) { this.runEvm(evmAccept); return; }
		}

		const buttons = [];
		if (solanaAccept) {
			buttons.push(`
				<button class="x402-wallet-btn" data-wallet="phantom" ${phantomDetected ? '' : 'disabled'}>
					<div class="x402-wallet-icon x402-phantom">${solanaProvider?.isThreeWs ? '3' : 'P'}</div>
					<span class="x402-wallet-name">${phantomDetected ? solanaWalletLabel(solanaProvider) : 'No Solana wallet detected'}</span>
					<span class="x402-wallet-meta">${networkLabel(solanaAccept.network, solanaAccept)}</span>
				</button>
			`);
		}

		// Agent custodial wallets: server-signed, no popup. Offered only when the
		// Solana accept charges USDC, matching the server-side mint pin in
		// api/x402-pay (it refuses to sign any other SPL asset from an agent key).
		const agentButtons = [];
		const agentSym = (solanaAccept?.extra?.name || 'USDC').replace(/^USD Coin$/, 'USDC');
		if (solanaAccept && agentSym === 'USDC' && Array.isArray(this.agentWallets) && this.agentWallets.length) {
			const decimals = Number(solanaAccept.extra?.decimals ?? 6);
			const priceUsdc = Number(solanaAccept.amount) / 10 ** decimals;
			for (const agent of this.agentWallets.slice(0, 4)) {
				const known = typeof agent.usdc === 'number';
				const short = known && agent.usdc < priceUsdc;
				agentButtons.push(`
					<button class="x402-wallet-btn" data-agent-wallet="${escapeHtml(agent.id)}" ${short ? 'disabled' : ''}>
						<div class="x402-wallet-icon x402-agent">${escapeHtml((agent.name || 'A').slice(0, 1).toUpperCase())}</div>
						<span class="x402-wallet-name">${escapeHtml(agent.name || 'Agent')}<span class="x402-wallet-sub">agent wallet · pays without a popup</span></span>
						<span class="x402-wallet-meta">${known ? `${agent.usdc.toFixed(2)} USDC${short ? ' · short' : ''}` : 'USDC'}</span>
					</button>
				`);
			}
		}
		if (evmAccept) {
			buttons.push(`
				<button class="x402-wallet-btn" data-wallet="evm" ${evmDetected ? '' : 'disabled'}>
					<div class="x402-wallet-icon x402-metamask">M</div>
					<span class="x402-wallet-name">${evmDetected ? 'Browser wallet' : 'No EVM wallet detected'}</span>
					<span class="x402-wallet-meta">${networkLabel(evmAccept.network, evmAccept)}</span>
				</button>
			`);
		}
		const fallbackBox = this.siwxFallbackNotice
			? `<div class="x402-siwx-fallback">${escapeHtml(this.siwxFallbackNotice)}</div>`
			: '';
		const givingBox = this.solanaGiving ? this.renderGivingBox(this.solanaGiving) : '';
		this.givingShown = !!this.solanaGiving;
		// Trust signal: show WHO the buyer is paying (on-chain recipient) before they
		// pick a wallet. The primary accept's payTo; link to the address explorer.
		const payeeAccept = this.accept || solanaAccept || evmAccept;
		const payTo = payeeAccept?.payTo;
		const payeeUrl = payTo ? addressExplorerUrl(payeeAccept.network, payTo) : null;
		const payeeShort = payTo ? `${payTo.slice(0, 6)}…${payTo.slice(-4)}` : '';
		const payeeBox = payTo
			? `<div class="x402-payee">Pays to ${
					payeeUrl
						? `<a class="x402-payee-addr" href="${payeeUrl}" target="_blank" rel="noopener" title="${escapeHtml(payTo)}">${escapeHtml(payeeShort)} ↗</a>`
						: `<span class="x402-payee-addr">${escapeHtml(payeeShort)}</span>`
				}</div>`
			: '';
		const walletList = agentButtons.length
			? `<div class="x402-wallet-group-label">Your agents</div>${agentButtons.join('')}` +
				(buttons.length ? `<div class="x402-wallet-group-label">Browser wallets</div>${buttons.join('')}` : '')
			: buttons.join('');
		const trustLine = agentButtons.length
			? 'Agent wallets pay from their own balance under your spend limits, with no popup. Browser wallets ask you to approve in the wallet. Settled on-chain either way.'
			: 'You approve the payment in your own wallet — funds move only when the service runs, settled on-chain.';
		this.bodyEl.innerHTML = `
			${this.renderSteps('connect', { discover: 'done' })}
			${payeeBox}
			${fallbackBox}
			${givingBox}
			<div class="x402-wallet-buttons">${walletList}</div>
			<div class="x402-trust">${trustLine}</div>
		`;
		const giveEl = this.bodyEl.querySelector('[data-giving]');
		if (giveEl) giveEl.addEventListener('change', (e) => { this.includeDonation = !!e.target.checked; });
		const onClick = (e) => {
			const btn = e.target.closest('[data-wallet]');
			if (!btn || btn.disabled) return;
			const wallet = btn.dataset.wallet;
			if (wallet === 'phantom') this.runSolana(solanaAccept);
			else if (wallet === 'evm') this.runEvm(evmAccept);
		};
		this.bodyEl.querySelectorAll('[data-wallet]').forEach((b) => b.addEventListener('click', onClick));
		const onAgentClick = (e) => {
			const btn = e.target.closest('[data-agent-wallet]');
			if (!btn || btn.disabled) return;
			const agent = (this.agentWallets || []).find((a) => String(a.id) === btn.dataset.agentWallet);
			if (agent) this.runAgentWallet(solanaAccept, agent);
		};
		this.bodyEl.querySelectorAll('[data-agent-wallet]').forEach((b) => b.addEventListener('click', onAgentClick));
	}

	renderSiwxChoice({ siwxSolana, siwxEvm }) {
		this.currentView = 'siwx';
		const priceText = formatAmount(this.accept.amount, this.accept.extra?.decimals ?? 6);
		// One primary button — internally we pick the wallet kind that matches
		// the supported SIWX chains AND the detected wallets. Phantom wins ties
		// to match the existing modal's default preference.
		const siwxTarget = siwxSolana
			? { kind: 'solana', chain: siwxSolana.chain }
			: { kind: 'evm', chain: siwxEvm.chain };
		const siwxLabel = siwxTarget.kind === 'solana'
			? `Sign in with ${solanaWalletLabel(detectSolanaProvider())}`
			: 'Sign in with wallet';
		this.bodyEl.innerHTML = `
			${this.renderSteps('connect', { discover: 'done' })}
			<button class="x402-pay-btn" data-action="siwx">${siwxLabel}</button>
			<button class="x402-pay-secondary" data-action="pay">Pay ${priceText} USDC instead</button>
			<div class="x402-siwx-hint">Already paid for this once? Sign in to re-enter without paying again.</div>
		`;
		const siwxBtn = this.bodyEl.querySelector('[data-action="siwx"]');
		const payBtn = this.bodyEl.querySelector('[data-action="pay"]');
		siwxBtn.addEventListener('click', () => {
			if (siwxTarget.kind === 'solana') this.runSiwxSolana(siwxTarget.chain);
			else this.runSiwxEvm(siwxTarget.chain);
		});
		payBtn.addEventListener('click', () => {
			this.payFlowOverride = true;
			this.renderConnect();
		});
		// Focus the primary SIWX button for keyboard accessibility.
		requestAnimationFrame(() => siwxBtn.focus());
	}

	renderProgress(activeId, meta = {}) {
		this.currentView = 'progress';
		this.bodyEl.innerHTML = this.renderSteps(activeId, {
			discover: 'done',
			connect: 'done',
			...(activeId === 'verify' ? { authorize: 'done' } : {}),
			[`${activeId}_meta`]: meta.text || '',
			...meta.statuses,
		});
	}

	// `retryable: false` is for failures the same click cannot change, such as a
	// service that refuses browser requests outright. Offering "Try again" there
	// reads as "this nearly worked" and sends the buyer round a loop that has no
	// exit, so the button is left out instead.
	renderError(stepId, message, { retryable = true } = {}) {
		this.currentView = 'error';
		this.bodyEl.innerHTML = `
			${this.renderSteps(stepId, {
				...(stepId !== 'discover' ? { discover: 'done' } : {}),
				...(stepId === 'authorize' || stepId === 'verify' ? { connect: 'done' } : {}),
				...(stepId === 'verify' ? { authorize: 'done' } : {}),
				[stepId]: 'error',
				[`${stepId}_meta`]: 'failed',
			})}
			<div class="x402-error-box"><strong>${escapeHtml(stepId)}:</strong> ${escapeHtml(message)}</div>
			${retryable ? '<button class="x402-pay-btn" data-retry>Try again</button>' : ''}
		`;
		this.bodyEl.querySelector('[data-retry]')?.addEventListener('click', () => this.start());
	}

	// Dedicated, actionable state for the most common payment failure: the wallet
	// can't cover the price. Shows needed / balance / shortfall, the connected
	// wallet (copy + explorer), and a retry that re-runs once the buyer tops up.
	renderInsufficientFunds(info) {
		this.currentView = 'insufficient';
		const addr = info.owner || '';
		const addrShort = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
		const viewUrl = addressExplorerUrl(info.network, addr);
		const netLabel = networkLabel(info.network);
		const sym = escapeHtml(info.symbol);
		this.bodyEl.innerHTML = `
			${this.renderSteps('authorize', {
				discover: 'done',
				connect: 'done',
				authorize: 'error',
				authorize_meta: 'insufficient funds',
			})}
			<div class="x402-insuff-title">Not enough ${sym}</div>
			<div class="x402-insuff-sub">Add ${sym} to your wallet on ${escapeHtml(netLabel)}, then try again — nothing was charged.</div>
			<div class="x402-receipt" style="margin-top:12px">
				<div class="x402-receipt-row"><span class="x402-k">needed</span><span class="x402-v">${escapeHtml(info.required)} ${sym}</span></div>
				<div class="x402-receipt-row"><span class="x402-k">your balance</span><span class="x402-v">${escapeHtml(info.balance)} ${sym}</span></div>
				<div class="x402-receipt-row"><span class="x402-k">short by</span><span class="x402-v" style="color:#e5484d;font-weight:700">${escapeHtml(info.shortfall)} ${sym}</span></div>
				<div class="x402-receipt-row"><span class="x402-k">wallet</span><span class="x402-v">${escapeHtml(addrShort)}</span></div>
			</div>
			<div class="x402-insuff-actions">
				<button class="x402-mini-btn" data-copy type="button" aria-label="Copy wallet address">Copy address</button>
				${viewUrl ? `<a class="x402-mini-btn" href="${viewUrl}" target="_blank" rel="noopener">View wallet ↗</a>` : ''}
			</div>
			<button class="x402-pay-btn" data-retry style="margin-top:10px">I've added funds — try again</button>
		`;
		const copyBtn = this.bodyEl.querySelector('[data-copy]');
		if (copyBtn) {
			copyBtn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(addr);
					copyBtn.textContent = 'Copied ✓';
					setTimeout(() => {
						copyBtn.textContent = 'Copy address';
					}, 1500);
				} catch (_) {
					/* clipboard blocked — non-fatal */
				}
			});
		}
		this.bodyEl.querySelector('[data-retry]').addEventListener('click', () => this.start());
	}

	renderDone({ result, payment, siwx }) {
		this.currentView = 'done';
		const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
		let receiptHtml;
		if (siwx) {
			const addrShort = siwx.address ? `${siwx.address.slice(0, 8)}…${siwx.address.slice(-6)}` : '—';
			receiptHtml = `
				<div class="x402-receipt">
					<div class="x402-receipt-title">Welcome back!</div>
					<div class="x402-receipt-row">
						<span class="x402-k">network</span>
						<span class="x402-v">${escapeHtml(networkLabel(siwx.network) || siwx.network || '—')}</span>
					</div>
					<div class="x402-receipt-row">
						<span class="x402-k">wallet</span>
						<span class="x402-v">${escapeHtml(addrShort)}</span>
					</div>
					<div class="x402-receipt-row">
						<span class="x402-k">paid</span>
						<span class="x402-v">previously · re-entered free</span>
					</div>
				</div>
			`;
		} else {
			const explorer = explorerUrl(payment?.network, payment?.transaction);
			const txShort = payment?.transaction ? `${payment.transaction.slice(0, 8)}…${payment.transaction.slice(-6)}` : '—';
			receiptHtml = `
				<div class="x402-receipt">
					<div class="x402-receipt-title">Payment confirmed!</div>
					<div class="x402-receipt-row">
						<span class="x402-k">network</span>
						<span class="x402-v">${escapeHtml(networkLabel(payment?.network) || '—')}</span>
					</div>
					<div class="x402-receipt-row">
						<span class="x402-k">payer</span>
						<span class="x402-v">${escapeHtml(payment?.payer ? `${payment.payer.slice(0, 8)}…${payment.payer.slice(-6)}` : '—')}</span>
					</div>
					${
						payment?.transaction
							? `<div class="x402-receipt-row"><span class="x402-k">tx</span><span class="x402-v">${
									explorer ? `<a href="${explorer}" target="_blank" rel="noopener">${txShort} ↗</a>` : txShort
								}</span></div>`
							: ''
					}
				</div>
			`;
		}
		this.bodyEl.innerHTML = `
			${receiptHtml}
			<div class="x402-result">${escapeHtml(resultStr).slice(0, 4000)}</div>
			<button class="x402-pay-btn" data-done>Done</button>
		`;
		this.bodyEl.querySelector('[data-done]').addEventListener('click', () => {
			this.disposed = true;
			document.removeEventListener('keydown', this.onKey);
			this.overlay.classList.remove('x402-open');
			setTimeout(() => this.overlay.remove(), 180);
		});
	}

	async start() {
		this.bodyEl.innerHTML = this.renderSteps('discover');
		try {
			const challenge = await discoverChallenge(this.opts);
			this.challenge = filterAcceptsByNetwork(challenge, this.opts.networks);
			this.siwx = extractSiwxExtension(challenge);
			this.payFlowOverride = false;
			this.siwxFallbackNotice = null;
			// Solana-first platform default: select the Solana accept by default
			// whenever one is offered, regardless of which wallet is detected —
			// renderConnect() still shows both wallet buttons (Solana listed
			// first), so EVM users simply click the EVM option. Falls back to the
			// first EIP-3009 EVM entry (skipping Permit2 siblings the modal can't
			// sign for), then the first accept.
			const solana = challenge.accepts.find((a) => isSolanaNetwork(a.network));
			const evm = challenge.accepts.find(isEip3009Accept);
			this.accept = solana || evm || challenge.accepts[0];
			this.setPrice(this.accept);
			// Agent wallets settle Solana USDC only (api/x402-pay pins the mint), so
			// only look them up when this checkout offers that rail. The fetch runs in
			// the background and injects the extra buttons into the picker when it
			// lands; the browser-wallet buttons never wait on it.
			if (solana) {
				if (this.agentWallets === undefined) this.agentWallets = null;
				fetchAgentWallets().then((list) => {
					if (this.disposed) return;
					this.agentWallets = Array.isArray(list) && list.length ? list : null;
					if (this.agentWallets && this.currentView === 'connect') this.renderConnect();
				});
			}
			this.renderConnect();
		} catch (err) {
			this.renderError('discover', err.message || String(err), { retryable: err?.code !== 'cors_blocked' });
		}
	}

	async runSolana(accept) {
		if (!(await ensureRiskAckSafe('x402-pay'))) { this.close('cancelled'); return; }
		this.accept = accept;
		this.setPrice(accept);
		const provider = detectSolanaProvider();
		const walletName = solanaWalletLabel(provider);
		this.renderProgress('connect', { text: `Opening ${walletName}…` });
		try {
			if (!provider) throw new Error('No Solana wallet detected');
			const conn = await provider.connect();
			const payerAddress = (conn?.publicKey || provider.publicKey)?.toString();
			if (!payerAddress) throw new Error(`${walletName} did not return a public key`);
			this.payerAddress = payerAddress;
			const capCheck = browserEnforceCap({
				accept,
				caps: this.opts.caps,
				address: payerAddress,
			});
			if (capCheck.abort) {
				this.renderError('authorize', capCheck.reason);
				return;
			}
			this.spendReservation = capCheck.reservation || null;
			this.renderProgress('authorize', { text: 'Checking your balance…' });
			await assertBalance({ accept, owner: payerAddress });
			this.renderProgress('authorize', { text: `Building Solana payment for ${payerAddress.slice(0, 6)}…${payerAddress.slice(-4)}` });

			// Only attach the donation when the buyer actually saw and kept the
			// opt-in (givingShown) — never silently in autoConnect mode.
			const tips =
				this.givingShown && this.includeDonation && this.solanaGiving
					? [{ to: this.solanaGiving.to, amount: this.solanaGiving.amount }]
					: undefined;
			const prep = await postJson(`${ORIGIN}/api/x402-checkout?action=prepare`, {
				accept,
				buyer: payerAddress,
				...(tips ? { tips } : {}),
			});
			this.renderProgress('authorize', { text: `Confirm in ${walletName}…` });
			const txBytes = base64ToUint8Array(prep.tx_base64);
			// The wallet returns a fully-signed VersionedTransaction with the buyer's
			// signature added. The facilitator's fee-payer signature is added by
			// PayAI during /settle.
			const SolanaWeb3 = await loadSolanaWeb3();
			const tx = SolanaWeb3.VersionedTransaction.deserialize(txBytes);
			// Wallets with auto priority fees or "transaction protection" (Phantom,
			// Solflare) rewrite a transaction before signing. The facilitator settles
			// a rewritten tx fine as long as the rewrite only touches ComputeBudget
			// instructions or the blockhash: it re-validates shape, recipient,
			// amount, and fee caps server-side on every settle. Anything else (guard
			// programs, a changed transfer, a swapped fee payer) it deterministically
			// rejects, so those become an immediate, named explanation here instead
			// of a silent 402-retry loop. Snapshot the message bytes before the
			// wallet touches the object (some wallets mutate in place); the deep
			// classification re-reads the prepared tx from the original bytes.
			const preparedMsg = tx.message.serialize();
			const signed = await provider.signTransaction(tx);
			const signedMsg = signed?.message?.serialize?.();
			if (signedMsg && !bytesEqual(preparedMsg, signedMsg)) {
				const prepared = SolanaWeb3.VersionedTransaction.deserialize(txBytes);
				const veto = classifyWalletTxMutation(prepared, signed);
				if (veto) {
					throw new Error(
						`${walletName} rewrote the payment transaction before signing (${veto}), so it can no longer settle. Nothing was sent or charged. Turn off transaction modification in the wallet settings, or pay with a different Solana wallet.`,
					);
				}
			}
			const signedB64 = uint8ArrayToBase64(signed.serialize());

			const builderCodeBlock = buildBuilderCodeEcho(this.challenge);
			const enc = await postJson(`${ORIGIN}/api/x402-checkout?action=encode`, {
				accept,
				signed_tx_base64: signedB64,
				resource_url: new URL(this.opts.endpoint, location.href).href,
				...(builderCodeBlock ? { builder_code: builderCodeBlock } : {}),
			});

			await this.executePaid(enc.x_payment);
		} catch (err) {
			if (this.spendReservation) {
				browserRollbackReservation(this.spendReservation);
				this.spendReservation = null;
			}
			if (err?.code === 'insufficient_funds') {
				this.renderInsufficientFunds(err.insufficient);
				return;
			}
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	// Pay from an agent's custodial wallet: the whole build/sign/settle happens
	// server-side in /api/x402-pay under the agent's spend policy, streamed back
	// as SSE so the step timeline stays live. No wallet popup at any point.
	async runAgentWallet(accept, agent) {
		if (!(await ensureRiskAckSafe('x402-pay'))) { this.close('cancelled'); return; }
		this.accept = accept;
		this.setPrice(accept);
		this.payerAddress = agent.solana_address;
		const agentName = agent.name || 'agent';
		const decimals = Number(accept.extra?.decimals ?? 6);
		const priceUsdc = Number(accept.amount) / 10 ** decimals;
		try {
			// Pre-flight shortfall guard from the balance the picker already loaded;
			// same UX contract as assertBalance, no extra RPC read. The server
			// re-checks everything authoritatively before signing.
			if (typeof agent.usdc === 'number' && agent.usdc < priceUsdc) {
				const err = new Error('insufficient funds');
				err.code = 'insufficient_funds';
				err.insufficient = {
					symbol: 'USDC',
					network: accept.network,
					owner: agent.solana_address,
					required: formatAmount(accept.amount, decimals),
					balance: agent.usdc.toFixed(2),
					shortfall: (priceUsdc - agent.usdc).toFixed(2),
				};
				throw err;
			}
			this.renderProgress('connect', { text: `Using ${agentName}'s wallet…` });
			const csrfToken = await fetchCsrfToken();
			if (!csrfToken) {
				throw new Error('Your three.ws session has expired. Sign in again to pay from an agent wallet.');
			}
			this.renderProgress('authorize', { text: `Paying ${formatAmount(accept.amount, decimals)} USDC from ${agentName}'s wallet…` });
			const final = await payFromAgentWallet(
				{
					agentId: agent.id,
					url: new URL(this.opts.endpoint, location.href).href,
					method: this.opts.method || 'GET',
					body: this.opts.body,
					serviceLabel: this.opts.merchant || null,
					csrfToken,
				},
				(event, data) => {
					if (this.disposed) return;
					if (event === 'built') {
						this.renderProgress('authorize', { text: 'Payment signed by the agent wallet…' });
					} else if (event === 'settled') {
						this.renderProgress('verify', {
							text: data?.tx ? `Settled on-chain · ${String(data.tx).slice(0, 8)}…` : 'Settling on-chain…',
						});
					}
				},
			);
			_agentWalletsCache = null; // the balance just changed; the next picker rereads it
			const payment = {
				transaction: final?.payment?.tx || null,
				network: final?.payment?.network || accept.network,
				payer: final?.payment?.payer || agent.solana_address,
			};
			this.resolve?.({
				ok: true,
				result: final?.result,
				payment,
				agent: { id: agent.id, name: agent.name || null },
				response: { status: 200, headers: {} },
			});
			if (this.opts.autoClose) this.close('done');
			else this.renderDone({ result: final?.result, payment });
		} catch (err) {
			if (err?.code === 'insufficient_funds') {
				this.renderInsufficientFunds(err.insufficient);
				return;
			}
			// Spend-policy refusals arrive with the server's own explanation
			// (daily cap, per-call cap, frozen wallet): surface them verbatim.
			this.renderError('authorize', friendlyError(err));
		}
	}

	async runEvm(accept) {
		if (!(await ensureRiskAckSafe('x402-pay'))) { this.close('cancelled'); return; }
		this.accept = accept;
		this.setPrice(accept);
		this.renderProgress('connect', { text: 'Opening browser wallet…' });
		try {
			const eth = window.ethereum;
			if (!eth) throw new Error('No EVM wallet detected');
			const accounts = await eth.request({ method: 'eth_requestAccounts' });
			const payerAddress = accounts?.[0];
			if (!payerAddress) throw new Error('Wallet did not return an account');
			this.payerAddress = payerAddress;
			const capCheck = browserEnforceCap({
				accept,
				caps: this.opts.caps,
				address: payerAddress,
			});
			if (capCheck.abort) {
				this.renderError('authorize', capCheck.reason);
				return;
			}
			this.spendReservation = capCheck.reservation || null;

			const meta = EVM_NETWORKS[accept.network];
			if (!meta) throw new Error(`Unknown EVM network ${accept.network}`);
			// Switch chain if needed.
			const currentChainHex = await eth.request({ method: 'eth_chainId' });
			const desiredChainHex = '0x' + meta.chainId.toString(16);
			if (currentChainHex !== desiredChainHex) {
				this.renderProgress('connect', { text: `Switch wallet to ${meta.name}…` });
				try {
					await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: desiredChainHex }] });
				} catch (e) {
					throw new Error(`Wallet is on ${currentChainHex}; please switch to ${meta.name} (${desiredChainHex}) and retry`);
				}
			}

			this.renderProgress('authorize', { text: 'Checking your balance…' });
			await assertBalance({ accept, owner: payerAddress, provider: eth });
			this.renderProgress('authorize', { text: `Authorize ${formatAmount(accept.amount)} USDC…` });

			// EIP-3009 transferWithAuthorization typed-data signature.
			// validAfter / validBefore use unix seconds; nonce is a random 32-byte hex.
			const validAfter = 0;
			const validBefore = Math.floor(Date.now() / 1000) + (accept.maxTimeoutSeconds || 600);
			const nonce = '0x' + randomHex(32);
			const domain = {
				name: accept.extra?.name || 'USD Coin',
				version: accept.extra?.version || '2',
				chainId: meta.chainId,
				verifyingContract: accept.asset,
			};
			const types = {
				EIP712Domain: [
					{ name: 'name', type: 'string' },
					{ name: 'version', type: 'string' },
					{ name: 'chainId', type: 'uint256' },
					{ name: 'verifyingContract', type: 'address' },
				],
				TransferWithAuthorization: [
					{ name: 'from', type: 'address' },
					{ name: 'to', type: 'address' },
					{ name: 'value', type: 'uint256' },
					{ name: 'validAfter', type: 'uint256' },
					{ name: 'validBefore', type: 'uint256' },
					{ name: 'nonce', type: 'bytes32' },
				],
			};
			const message = {
				from: payerAddress,
				to: accept.payTo,
				value: accept.amount,
				validAfter,
				validBefore,
				nonce,
			};
			const typedData = {
				primaryType: 'TransferWithAuthorization',
				types,
				domain,
				message,
			};
			const signature = await eth.request({
				method: 'eth_signTypedData_v4',
				params: [payerAddress, JSON.stringify(typedData)],
			});

			const paymentPayload = {
				x402Version: 2,
				scheme: 'exact',
				network: accept.network,
				resource: { url: this.opts.endpoint, mimeType: 'application/json' },
				accepted: accept,
				payload: {
					signature,
					// CDP facilitator /verify requires the EIP-3009 time bounds as
					// decimal strings, not JSON numbers — a numeric validAfter/
					// validBefore is rejected with "'paymentPayload' is invalid".
					// The signature is unaffected: uint256 0 and "0" encode identically.
					authorization: { from: payerAddress, to: accept.payTo, value: accept.amount, validAfter: String(validAfter), validBefore: String(validBefore), nonce },
				},
			};
			const builderCodeBlock = buildBuilderCodeEcho(this.challenge);
			if (builderCodeBlock) {
				paymentPayload.extensions = { 'builder-code': builderCodeBlock };
			}
			const xPayment = b64encode(paymentPayload);
			await this.executePaid(xPayment);
		} catch (err) {
			if (this.spendReservation) {
				browserRollbackReservation(this.spendReservation);
				this.spendReservation = null;
			}
			if (err?.code === 'insufficient_funds') {
				this.renderInsufficientFunds(err.insufficient);
				return;
			}
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	async executePaid(xPayment, attempt = 0) {
		this.renderProgress('verify', {
			text: attempt ? 'Retrying after upstream throttle…' : 'Calling merchant endpoint…',
		});
		try {
			const res = await fetch(this.opts.endpoint, {
				method: this.opts.method || 'GET',
				headers: {
					...(this.opts.headers || {}),
					...(this.opts.body && !this.opts.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}),
					'X-PAYMENT': xPayment,
				},
				body: this.opts.body ? (typeof this.opts.body === 'string' ? this.opts.body : JSON.stringify(this.opts.body)) : undefined,
			});
			const ct = res.headers.get('content-type') || '';
			const text = await res.text();
			let result;
			if (ct.includes('json')) {
				try {
					result = JSON.parse(text);
				} catch {
					result = text;
				}
			} else {
				result = text;
			}
			if (!res.ok) {
				// A 429 here is a transient upstream throttle (e.g. the generator's
				// create-prediction rate limit). The payment is signed but NOT yet
				// settled — the merchant runs the work before settling — so the same
				// X-PAYMENT can be safely re-sent once the window resets, with no risk
				// of a double charge. Auto-retry a couple of times, respecting the
				// server's Retry-After, before surfacing the manual "Try again".
				if (res.status === 429 && attempt < MAX_THROTTLE_RETRIES) {
					await this.waitForThrottle(retryAfterSeconds(res, result));
					return this.executePaid(xPayment, attempt + 1);
				}
				const msg = (result && typeof result === 'object' && (result.error_description || result.error)) || `HTTP ${res.status}`;
				throw new Error(msg);
			}
			const settleHeader = res.headers.get('x-payment-response');
			const payment = b64decode(settleHeader) || {};
			this.spendReservation = null;
			this.resolve?.({ ok: true, result, payment, response: { status: res.status, headers: headersToObject(res.headers) } });
			// autoClose (opt-in): a programmatic caller (e.g. the club door) renders
			// its own success beat over the unlocked content, so the modal must get
			// out of the way the instant payment settles instead of parking on a
			// manual "Done" screen that would cover what the caller just revealed.
			if (this.opts.autoClose) this.close('done');
			else this.renderDone({ result, payment });
		} catch (err) {
			if (this.spendReservation) {
				browserRollbackReservation(this.spendReservation);
				this.spendReservation = null;
			}
			this.renderError('verify', friendlyError(err));
		}
	}

	// Hold the verify step on a live countdown while an upstream throttle resets,
	// then return so the caller re-sends the same signed payment. The reservation
	// is deliberately left intact — this is the same payment, not a new one — so
	// no rollback runs between attempts.
	async waitForThrottle(seconds) {
		const total = Math.max(1, Math.min(30, Math.round(seconds) || 6));
		for (let left = total; left > 0; left--) {
			this.renderProgress('verify', { text: `Generator is busy — retrying in ${left}s…` });
			await new Promise((r) => setTimeout(r, 1000));
		}
		this.renderProgress('verify', { text: 'Retrying…' });
	}

	async runSiwxEvm(chain) {
		this.renderProgress('connect', { text: 'Opening browser wallet…' });
		try {
			const eth = window.ethereum;
			if (!eth) throw new Error('No EVM wallet detected');
			const accounts = await eth.request({ method: 'eth_requestAccounts' });
			const rawAddress = accounts?.[0];
			if (!rawAddress) throw new Error('Wallet did not return an account');
			const checksum = await loadEvmChecksum();
			const address = checksum(rawAddress);
			this.payerAddress = address;
			this.renderProgress('authorize', { text: `Sign sign-in message as ${address.slice(0, 6)}…${address.slice(-4)}` });

			const message = buildSiwxMessage(this.siwx.info, chain, address);
			const signature = await eth.request({
				method: 'personal_sign',
				params: [message, address],
			});

			const info = this.siwx.info;
			const payload = {
				domain: info.domain,
				address,
				...(info.statement ? { statement: info.statement } : {}),
				uri: info.uri,
				version: info.version || '1',
				chainId: chain.chainId,
				type: 'eip191',
				nonce: info.nonce,
				issuedAt: info.issuedAt,
				...(info.expirationTime ? { expirationTime: info.expirationTime } : {}),
				...(info.notBefore ? { notBefore: info.notBefore } : {}),
				...(info.requestId !== undefined && info.requestId !== null ? { requestId: info.requestId } : {}),
				...(Array.isArray(info.resources) ? { resources: info.resources } : {}),
				signatureScheme: 'eip191',
				signature,
			};
			await this.executeSiwx(payload, chain.chainId);
		} catch (err) {
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	async runSiwxSolana(chain) {
		const provider = detectSolanaProvider();
		const walletName = solanaWalletLabel(provider);
		this.renderProgress('connect', { text: `Opening ${walletName}…` });
		try {
			if (!provider) throw new Error('No Solana wallet detected');
			const conn = await provider.connect();
			const pubkey = conn?.publicKey || provider.publicKey;
			const address = pubkey?.toString();
			if (!address) throw new Error(`${walletName} did not return a public key`);
			this.payerAddress = address;
			this.renderProgress('authorize', { text: `Sign sign-in message as ${address.slice(0, 6)}…${address.slice(-4)}` });

			const message = buildSiwxMessage(this.siwx.info, chain, address);
			const encoded = new TextEncoder().encode(message);
			const signed = await provider.signMessage(encoded, 'utf8');
			const sigBytes = signed?.signature instanceof Uint8Array ? signed.signature : new Uint8Array(signed?.signature || signed);
			if (!sigBytes || !sigBytes.length) throw new Error(`${walletName} did not return a signature`);
			const signature = base58encode(sigBytes);

			const info = this.siwx.info;
			const payload = {
				domain: info.domain,
				address,
				...(info.statement ? { statement: info.statement } : {}),
				uri: info.uri,
				version: info.version || '1',
				chainId: chain.chainId,
				type: 'ed25519',
				nonce: info.nonce,
				issuedAt: info.issuedAt,
				...(info.expirationTime ? { expirationTime: info.expirationTime } : {}),
				...(info.notBefore ? { notBefore: info.notBefore } : {}),
				...(info.requestId !== undefined && info.requestId !== null ? { requestId: info.requestId } : {}),
				...(Array.isArray(info.resources) ? { resources: info.resources } : {}),
				signatureScheme: 'siws',
				signature,
			};
			await this.executeSiwx(payload, chain.chainId);
		} catch (err) {
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	async executeSiwx(payload, chainId) {
		this.renderProgress('verify', { text: 'Verifying sign-in…' });
		const headerValue = encodeSiwxHeaderValue(payload);
		let res;
		try {
			res = await fetch(this.opts.endpoint, {
				method: this.opts.method || 'GET',
				headers: {
					...(this.opts.headers || {}),
					...(this.opts.body && !this.opts.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}),
					[SIWX_HEADER]: headerValue,
				},
				body: this.opts.body ? (typeof this.opts.body === 'string' ? this.opts.body : JSON.stringify(this.opts.body)) : undefined,
			});
		} catch (err) {
			this.renderError('verify', friendlyError(err));
			return;
		}

		if (res.status === 200) {
			const ct = res.headers.get('content-type') || '';
			const text = await res.text();
			let result;
			if (ct.includes('json')) {
				try { result = JSON.parse(text); } catch { result = text; }
			} else {
				result = text;
			}
			const siwx = { address: payload.address, network: chainId };
			this.resolve?.({
				ok: true,
				result,
				siwx,
				response: { status: res.status, headers: headersToObject(res.headers) },
			});
			// See the paid path: a programmatic caller dismisses the modal itself.
			if (this.opts.autoClose) this.close('done');
			else this.renderDone({ result, siwx });
			return;
		}

		if (res.status === 401 || res.status === 402) {
			// Most likely: signature verified but this wallet hasn't actually
			// paid for the resource yet. Drop the SIWX offering and fall back
			// to the normal payment flow with a one-line notice.
			let parsed = null;
			try { parsed = await res.clone().json(); } catch (_) {}
			const code = parsed?.code || parsed?.error;
			this.siwx = null;
			this.payerAddress = null;
			this.payFlowOverride = false;
			this.siwxFallbackNotice = code === 'siwx_not_paid' || res.status === 402
				? "You haven't paid for this yet — pay now to unlock re-entry."
				: 'Sign-in not accepted — please pay to continue.';
			// Re-render the wallet picker. If we had collected the 402 challenge
			// already, this just re-runs renderConnect; otherwise we re-discover.
			if (!this.challenge || !Array.isArray(this.challenge.accepts) || !this.challenge.accepts.length) {
				this.start();
			} else {
				this.renderConnect();
			}
			return;
		}

		const text = await res.text().catch(() => '');
		this.renderError('verify', `SIWX retry failed: HTTP ${res.status}${text ? ` · ${text.slice(0, 120)}` : ''}`);
	}
}

// ───────────────────────────────────────────────────────── helpers ──────────

function escapeHtml(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function headersToObject(headers) {
	const out = {};
	headers.forEach((v, k) => (out[k] = v));
	return out;
}

// How many times executePaid silently re-sends a signed payment after a 429
// throttle before falling back to the manual "Try again". The payment isn't
// settled until the merchant call succeeds, so re-sending can't double-charge.
const MAX_THROTTLE_RETRIES = 2;

// Seconds to wait before re-sending after a 429. Prefers the standard
// Retry-After header, then the body's `retry_after` hint, then a sane default.
function retryAfterSeconds(res, result, fallback = 6) {
	const header = Number.parseInt(res.headers.get('retry-after') || '', 10);
	if (Number.isFinite(header) && header > 0) return header;
	const body = result && typeof result === 'object' ? Number(result.retry_after) : NaN;
	if (Number.isFinite(body) && body > 0) return body;
	return fallback;
}

function friendlyError(err) {
	const msg = err?.shortMessage || err?.message || String(err);
	// Trim ethers/viem long stacks, Phantom's RPC-error verbosity.
	if (/user rejected|user denied|reject/i.test(msg)) return 'cancelled in wallet';
	// Upstream throttles (e.g. a generator's create-prediction rate limit) often
	// arrive as raw provider text that names the merchant's internal billing or
	// credit state. Never relay that to the buyer: the payment isn't settled until
	// the merchant call succeeds, so a clean, retryable message is both safer and
	// more accurate than echoing the upstream's account internals.
	if (/throttl|rate.?limit|too many requests|less than \$|in credit|\b429\b/i.test(msg)) {
		return 'The service is briefly busy and your payment was not taken — retry in a few seconds.';
	}
	// The Solana and EVM-sign-in paths dynamic-import a library from a CDN, now
	// across three mirrors. All three failing means a strict host Content-Security-
	// Policy is blocking them (one unreachable CDN no longer gets this far), and
	// the raw "Failed to fetch dynamically imported module" is opaque. The
	// Base/EIP-3009 payment path has no such dependency, so steer the buyer there.
	if (/dynamically imported module|esm\.sh|jsdelivr|unpkg|module script failed|module_unavailable/i.test(msg)) {
		return 'A component this wallet path needs (loaded from a CDN) was blocked, usually by a strict host security policy. Pay with MetaMask on Base instead; it needs no third-party code.';
	}
	return msg.slice(0, 240);
}

function base64ToUint8Array(b64) {
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}
function uint8ArrayToBase64(arr) {
	if (typeof Buffer !== 'undefined') return Buffer.from(arr).toString('base64');
	let bin = '';
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
	return btoa(bin);
}
function bytesEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// Wallet-rewrite classifier for the Solana checkout. The self-hosted
// facilitator's validateRingTransaction in api/_lib/x402/self-facilitator.js
// accepts any ComputeBudget instruction set within its fee caps and never pins
// the blockhash to what /prepare issued, so a wallet that only injects or
// retunes priority-fee instructions (Phantom and Solflare both do) still
// produces a settleable payment. What it hard-rejects is any other change:
// foreign programs (e.g. wallet-guard instructions), a modified transfer, or a
// swapped fee payer. Mirror exactly that line here.
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

// Resolve a v0 message's instructions to index-independent form so the
// comparison survives the wallet reordering or appending account keys.
function resolveNonBudgetInstructions(message) {
	const keys = message.staticAccountKeys.map((k) => k.toBase58());
	return message.compiledInstructions
		.map((ix) => ({
			program: keys[ix.programIdIndex],
			accounts: ix.accountKeyIndexes.map((i) => keys[i]),
			data: ix.data,
		}))
		.filter((ix) => ix.program !== COMPUTE_BUDGET_PROGRAM);
}

// Decide whether a wallet's pre-signing rewrite of the prepared transaction is
// benign (ComputeBudget/blockhash only → returns null, proceed to settle) or
// blocking (returns a short human-readable reason for the checkout error).
// Never throws on an odd wallet-returned object: unverifiable means blocking,
// since the facilitator would reject what we cannot vouch for.
export function classifyWalletTxMutation(preparedTx, signedTx) {
	try {
		const prepared = preparedTx.message;
		const signed = signedTx.message;
		const preparedFeePayer = prepared.staticAccountKeys[0]?.toBase58();
		const signedFeePayer = signed.staticAccountKeys[0]?.toBase58();
		if (preparedFeePayer !== signedFeePayer) {
			return 'it changed the transaction fee payer';
		}
		const preparedIxs = resolveNonBudgetInstructions(prepared);
		const signedIxs = resolveNonBudgetInstructions(signed);
		if (signedIxs.length !== preparedIxs.length) {
			const preparedPrograms = new Set(preparedIxs.map((ix) => ix.program));
			const added = signedIxs.find((ix) => !preparedPrograms.has(ix.program));
			return added
				? `it injected instructions from program ${added.program}`
				: 'it added or removed payment instructions';
		}
		for (let i = 0; i < preparedIxs.length; i++) {
			const a = preparedIxs[i];
			const b = signedIxs[i];
			if (
				a.program !== b.program ||
				a.accounts.length !== b.accounts.length ||
				a.accounts.some((key, j) => key !== b.accounts[j]) ||
				!bytesEqual(a.data, b.data)
			) {
				return 'it changed the payment instructions';
			}
		}
		return null;
	} catch {
		return 'the rewrite could not be verified';
	}
}
function randomHex(bytes) {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

let _solanaWeb3 = null;
async function loadSolanaWeb3() {
	if (_solanaWeb3) return _solanaWeb3;
	// Dynamic import keeps the drop-in script tiny: Solana web3.js is only
	// fetched when a Solana payment is actually attempted. The shared loader
	// tries esm.sh, then jsdelivr and unpkg for the same version, each under a
	// deadline, so a single blocked CDN can no longer take the paywall down.
	const { loadModule } = await import('./load-module.js');
	try {
		_solanaWeb3 = await loadModule('https://esm.sh/@solana/web3.js@1.95.3?bundle');
	} catch (err) {
		if (err?.code === 'module_unavailable') {
			throw new Error(
				'The Solana wallet component could not be loaded (' + err.hosts.join(', ') + ' unreachable or blocked by this page\'s security policy). Pay with a Base wallet instead; that path needs no third-party code.',
			);
		}
		throw err;
	}
	return _solanaWeb3;
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: 'parse_error', error_description: text.slice(0, 200) };
	}
	if (!res.ok) {
		const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
		err.status = res.status;
		err.data = data;
		throw err;
	}
	return data;
}

// A same-origin endpoint can never be refused by CORS, so a rejected fetch there
// really is a connectivity problem. Anything else is a different host answering.
function isCrossOrigin(endpoint) {
	try {
		return new URL(endpoint, location.href).origin !== location.origin;
	} catch {
		return false;
	}
}

// Probe the merchant endpoint with a benign request to extract the 402 challenge.
// Accepts HTTP 402 (standard x402) or HTTP 401 with a `payment-required` header
// (MCP 2025-06-18 spec, which uses 401 for resource-server authorization challenges).
async function discoverChallenge(opts) {
	const headers = { ...(opts.headers || {}) };
	const init = {
		method: opts.method || 'GET',
		headers,
		body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
	};
	if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
	let res;
	try {
		res = await fetch(opts.endpoint, init);
	} catch (err) {
		// fetch() rejects with a bare "Failed to fetch" for an offline client, a
		// blocked request, and a CORS refusal alike. Say what the buyer can act on
		// rather than surfacing the browser's own wording as the checkout's error.
		// Telling a buyer to check their connection when the service simply does
		// not allow browser calls sends them to retry a button that can never
		// work, so separate the two cases by where the endpoint lives.
		if (isCrossOrigin(opts.endpoint)) {
			throw Object.assign(
				new Error(`${new URL(opts.endpoint, location.href).host} does not allow browser requests (its response carries no CORS headers), so its price cannot be confirmed from this page. Call it from a server, an agent, or the x402 CLI instead.`),
				{ code: 'cors_blocked' },
			);
		}
		throw new Error(`Could not reach the service to confirm its price (${err?.message || 'network error'}). Check your connection and try again.`);
	}

	// MCP 2025-06-18 endpoints return 401 with the full x402 challenge in the
	// `payment-required` header (base64-JSON). Accept that alongside standard 402.
	const prHeader = res.headers.get('payment-required');
	const is401WithChallenge = res.status === 401 && !!prHeader;

	if (res.status !== 402 && !is401WithChallenge) {
		// Endpoint isn't paid (200) or isn't an x402 endpoint at all. In either
		// case, surface a clear error — accidentally pointing the modal at a
		// free endpoint should not silently succeed.
		const txt = await res.text();
		throw new Error(`Endpoint did not return 402 (got ${res.status}). Body: ${txt.slice(0, 120)}`);
	}

	// For 401+header, decode directly — the full envelope is in the header.
	// For 402, read body first and fall back to header if body is minimal.
	let body = is401WithChallenge ? b64decode(prHeader) : await res.json().catch(() => null);
	if (!body || !Array.isArray(body.accepts) || !body.accepts.length) {
		// send402 (api/_lib/x402-spec.js) only emits `{error}` in the body and
		// puts the full v2 PaymentRequired envelope (accepts + extensions) in
		// the base64-JSON PAYMENT-REQUIRED header. b64decode returns already-
		// parsed JSON, so use its result directly.
		const decoded = b64decode(prHeader);
		if (decoded && Array.isArray(decoded.accepts) && decoded.accepts.length) {
			body = decoded;
		}
	}
	if (!body || !Array.isArray(body.accepts) || !body.accepts.length) {
		throw new Error('Endpoint returned 402 but no `accepts` array could be found in body or header');
	}
	return body;
}

// ───────────────────────────────────────────────────────── public api ───────

// A caller that supplies a request body but no method means POST: fetch() throws
// a TypeError ("Request with GET/HEAD method cannot have body") the moment a body
// is paired with the GET default, which kills the flow at the discovery step
// before the endpoint is ever contacted. The data-attribute binding below already
// infers the method this way; pay() has to agree, because a programmatic caller
// passing { endpoint, body } is the most natural way to reach a paid POST route.
function normalizeOpts(opts) {
	if (opts.method) return opts;
	return { ...opts, method: opts.body ? 'POST' : 'GET' };
}

export async function pay(opts) {
	if (!opts?.endpoint) throw new Error('X402.pay: endpoint is required');
	const modal = new CheckoutModal(normalizeOpts(opts));
	const result = modal.mount();
	// kick off the discovery on next tick so the modal animates in first.
	queueMicrotask(() => modal.start());
	return result;
}

function bindElement(el) {
	if (el.dataset.x402Bound === '1') return;
	el.dataset.x402Bound = '1';
	el.addEventListener('click', async (e) => {
		e.preventDefault();
		const opts = readOptsFrom(el);
		try {
			const out = await pay(opts);
			if (out?.siwx) {
				el.dispatchEvent(new CustomEvent('x402:siwx-signed', { detail: out.siwx, bubbles: true }));
			}
			el.dispatchEvent(new CustomEvent('x402:result', { detail: out, bubbles: true }));
		} catch (err) {
			if (err?.code === 'cancelled') return;
			el.dispatchEvent(new CustomEvent('x402:error', { detail: { error: err?.message || String(err) }, bubbles: true }));
		}
	});
}

function readOptsFrom(el) {
	const ds = el.dataset;
	let body = ds.x402Body;
	if (body) {
		try { body = JSON.parse(body); } catch { /* keep as string */ }
	}
	let headers = ds.x402Headers;
	if (headers) {
		try { headers = JSON.parse(headers); } catch { headers = undefined; }
	}
	return {
		endpoint: ds.x402Endpoint,
		method: ds.x402Method || (body ? 'POST' : 'GET'),
		body,
		headers,
		merchant: ds.x402Merchant,
		action: ds.x402Action || el.textContent?.trim().slice(0, 60),
	};
}

export function init() {
	if (typeof document === 'undefined') return;
	document.querySelectorAll('[data-x402-endpoint]').forEach(bindElement);
}

// Auto-init on DOMContentLoaded, plus on demand.
if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
	// Re-scan when merchants dynamically inject buttons.
	const mo = new MutationObserver(() => init());
	mo.observe(document.documentElement, { childList: true, subtree: true });
}

// Expose to merchants' inline scripts.
if (typeof window !== 'undefined') {
	window.X402 = Object.freeze({ pay, init, version: VERSION });
}
