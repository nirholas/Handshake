// x402.js — drop-in payment modal for any x402 paid endpoint.
//
// Merchants add one line to their site:
//
//   <script type="module" src="https://3d.irish/x402.js"></script>
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
//   });
//
// The modal handles wallet connect (Phantom for Solana, window.ethereum for
// Base USDC via EIP-3009), drives the 402 → sign → retry flow, and shows the
// result. Vanilla JS, no bundler required.

const VERSION = '0.1.0';

// SIWX ("Sign-In-With-X" / CAIP-122) lets a wallet that has already paid for
// an endpoint re-enter it by signing a challenge instead of paying again. The
// server advertises support by including `extensions['sign-in-with-x']` in the
// 402 body; clients submit signed proofs via the `SIGN-IN-WITH-X` header. See
// prompts/siwx/PLAN.md for the full architecture.
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

function isSolanaNetwork(net) {
	return typeof net === 'string' && (net === 'solana' || net.startsWith('solana:'));
}
function isEvmNetwork(net) {
	return typeof net === 'string' && net.startsWith('eip155:');
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
	if (info.statement) lines.push(info.statement, '');
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
// (api/_lib/siws.js → @noble/curves). Pulled in dynamically via esm.sh only
// when SIWX EVM sign-in is actually attempted, mirroring loadSolanaWeb3.
let _evmChecksum = null;
async function loadEvmChecksum() {
	if (_evmChecksum) return _evmChecksum;
	const sha3 = await import('https://esm.sh/@noble/hashes@1.4.0/sha3?bundle');
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
	color: #0d0f15;
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
	font-size: 17px; font-weight: 700; color: #0d0f15;
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
.x402-close:hover { background: #e7e9ee; color: #0d0f15; }

.x402-price-row {
	padding: 18px 20px;
	display: flex; align-items: baseline; justify-content: space-between;
	background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%);
	border-bottom: 1px solid #eef0f4;
}
.x402-price {
	font-size: 32px; font-weight: 700; letter-spacing: -0.02em; color: #0d0f15;
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
.x402-step-label { font-size: 14px; font-weight: 600; color: #0d0f15; line-height: 1.35; }
.x402-step-meta { font-size: 12px; color: #5a6378; margin-top: 2px; font-feature-settings: 'tnum' 1; }
.x402-step.x402-error .x402-step-meta { color: #ef4444; }

.x402-wallet-buttons {
	display: flex; flex-direction: column; gap: 8px;
	margin-top: 4px;
}
.x402-wallet-btn {
	width: 100%; padding: 13px 14px;
	background: #ffffff; border: 1.5px solid #e2e5ec; border-radius: 11px;
	font-size: 14px; font-weight: 600; color: #0d0f15;
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
.x402-wallet-name { flex: 1; text-align: left; }
.x402-wallet-meta { font-size: 11px; color: #8a90a8; font-weight: 500; }

.x402-pay-btn {
	width: 100%; padding: 14px 16px;
	background: #0d0f15; color: #fff; border: none;
	border-radius: 12px;
	font-size: 15px; font-weight: 700; font-family: inherit;
	cursor: pointer; letter-spacing: -0.005em;
	transition: background 0.12s, transform 0.05s;
	margin-top: 4px;
	display: flex; align-items: center; justify-content: center; gap: 8px;
}
.x402-pay-btn:hover:not(:disabled) { background: #1a1d28; }
.x402-pay-btn:active:not(:disabled) { transform: translateY(1px); }
.x402-pay-btn:disabled { background: #c8ccd4; cursor: not-allowed; }

.x402-pay-secondary {
	width: 100%; padding: 12px 14px;
	background: #ffffff; color: #0d0f15;
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
.x402-siwx-fallback {
	font-size: 12px; color: #b45309; line-height: 1.45;
	padding: 8px 10px; border-radius: 8px;
	background: #fffbeb; border: 1px solid #fde68a;
	margin-bottom: 6px;
}

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
.x402-receipt-row .x402-v { color: #0d0f15; text-align: right; word-break: break-all; }
.x402-receipt-row a { color: #0a84ff; text-decoration: none; }
.x402-receipt-row a:hover { text-decoration: underline; }

.x402-result {
	padding: 12px 14px; border-radius: 10px;
	background: #fafbfc; border: 1px solid #e2e5ec;
	max-height: 240px; overflow: auto;
	font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
	font-size: 12px; line-height: 1.5; color: #0d0f15;
	white-space: pre-wrap; word-break: break-word;
}

.x402-foot {
	padding: 10px 20px 14px;
	border-top: 1px solid #eef0f4;
	display: flex; align-items: center; justify-content: space-between;
	font-size: 11px; color: #8a90a8;
}
.x402-foot a { color: #5a6378; text-decoration: none; font-weight: 600; }
.x402-foot a:hover { color: #0d0f15; }
.x402-foot .x402-secure { display: flex; align-items: center; gap: 5px; }
.x402-foot .x402-secure::before { content: '🔒'; font-size: 10px; }

@media (max-width: 480px) {
	.x402-modal { max-width: none; width: calc(100% - 16px); border-radius: 16px; }
	.x402-price { font-size: 26px; }
}

@media (prefers-color-scheme: dark) {
	.x402-overlay { color: #e6e8f0; }
	.x402-modal { background: #14161f; box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6); }
	.x402-head, .x402-price-row, .x402-foot { border-color: #232636; }
	.x402-step + .x402-step { border-top-color: #232636; }
	.x402-merchant .x402-name { color: #8a90a8; }
	.x402-merchant .x402-action, .x402-price, .x402-step-label { color: #e6e8f0; }
	.x402-step-meta { color: #8a90a8; }
	.x402-close { background: #1f2230; color: #8a90a8; }
	.x402-close:hover { background: #2a2e3d; color: #e6e8f0; }
	.x402-price-row { background: linear-gradient(180deg, #1a1d29 0%, #14161f 100%); }
	.x402-network { background: #1f2230; color: #b0b6cc; }
	.x402-wallet-btn { background: #1a1d29; border-color: #2a2e3d; color: #e6e8f0; }
	.x402-wallet-btn:hover:not(:disabled) { background: #20243a; border-color: #0a84ff; }
	.x402-wallet-icon { background: #2a2e3d; }
	.x402-wallet-meta { color: #6b7088; }
	.x402-pay-btn { background: #ffffff; color: #0d0f15; }
	.x402-pay-btn:hover:not(:disabled) { background: #e7e9ee; }
	.x402-pay-btn:disabled { background: #2a2e3d; color: #5a6378; }
	.x402-pay-secondary { background: #1a1d29; border-color: #2a2e3d; color: #e6e8f0; }
	.x402-pay-secondary:hover:not(:disabled) { background: #20243a; border-color: #0a84ff; }
	.x402-siwx-hint { color: #8a90a8; }
	.x402-siwx-fallback { background: #2a1d10; border-color: #78350f; color: #fcd34d; }
	.x402-step-num { background: #14161f; border-color: #2a2e3d; color: #8a90a8; }
	.x402-result { background: #1a1d29; border-color: #2a2e3d; color: #e6e8f0; }
	.x402-receipt { background: linear-gradient(180deg, #0b1f17 0%, #14161f 100%); border-color: #14532d; }
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
	}

	mount() {
		injectStyles();
		const overlay = document.createElement('div');
		overlay.className = 'x402-overlay';
		overlay.innerHTML = `
			<div class="x402-modal" role="dialog" aria-modal="true" aria-label="x402 payment">
				<div class="x402-head">
					<div class="x402-merchant">
						<div class="x402-name" data-merchant>${escapeHtml(this.opts.merchant || 'Payment')}</div>
						<div class="x402-action" data-action>${escapeHtml(this.opts.action || 'Pay-per-call')}</div>
					</div>
					<button class="x402-close" data-close aria-label="Close">✕</button>
				</div>
				<div class="x402-price-row">
					<div class="x402-price" data-price>—<span class="x402-currency"> USDC</span></div>
					<div class="x402-network" data-network>resolving…</div>
				</div>
				<div class="x402-body" data-body></div>
				<div class="x402-foot">
					<span class="x402-secure">x402 · onchain settled</span>
					<a href="https://3d.irish" target="_blank" rel="noopener">Powered by 3d.irish</a>
				</div>
			</div>
		`;
		document.body.appendChild(overlay);
		this.overlay = overlay;
		this.bodyEl = overlay.querySelector('[data-body]');
		this.priceEl = overlay.querySelector('[data-price]');
		this.networkEl = overlay.querySelector('[data-network]');
		overlay.querySelector('[data-close]').addEventListener('click', () => this.close('cancelled'));
		overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close('cancelled'); });
		this.onKey = (e) => { if (e.key === 'Escape') this.close('cancelled'); };
		document.addEventListener('keydown', this.onKey);
		requestAnimationFrame(() => overlay.classList.add('x402-open'));
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	close(reason) {
		if (this.disposed) return;
		this.disposed = true;
		document.removeEventListener('keydown', this.onKey);
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

	setPrice(accept) {
		const decimals = accept.extra?.decimals ?? 6;
		const amount = formatAmount(accept.amount, decimals);
		const sym = (accept.extra?.name || 'USDC').replace(/^USD Coin$/, 'USDC');
		this.priceEl.innerHTML = `${amount}<span class="x402-currency"> ${sym}</span>`;
		this.networkEl.textContent = networkLabel(accept.network, accept);
	}

	renderConnect() {
		const phantomDetected = typeof window !== 'undefined' && (window.solana?.isPhantom || window.phantom?.solana);
		const evmDetected = typeof window !== 'undefined' && window.ethereum;
		const solanaAccept = this.challenge?.accepts.find((a) => isSolanaNetwork(a.network));
		const evmAccept = this.challenge?.accepts.find(isEip3009Accept);

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

		const buttons = [];
		if (solanaAccept) {
			buttons.push(`
				<button class="x402-wallet-btn" data-wallet="phantom" ${phantomDetected ? '' : 'disabled'}>
					<div class="x402-wallet-icon x402-phantom">P</div>
					<span class="x402-wallet-name">${phantomDetected ? 'Phantom' : 'Phantom (not detected)'}</span>
					<span class="x402-wallet-meta">${networkLabel(solanaAccept.network, solanaAccept)}</span>
				</button>
			`);
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
		this.bodyEl.innerHTML = `
			${this.renderSteps('connect', { discover: 'done' })}
			${fallbackBox}
			<div class="x402-wallet-buttons">${buttons.join('')}</div>
		`;
		const onClick = (e) => {
			const btn = e.target.closest('[data-wallet]');
			if (!btn || btn.disabled) return;
			const wallet = btn.dataset.wallet;
			if (wallet === 'phantom') this.runSolana(solanaAccept);
			else if (wallet === 'evm') this.runEvm(evmAccept);
		};
		this.bodyEl.querySelectorAll('[data-wallet]').forEach((b) => b.addEventListener('click', onClick));
	}

	renderSiwxChoice({ siwxSolana, siwxEvm }) {
		const priceText = formatAmount(this.accept.amount, this.accept.extra?.decimals ?? 6);
		// One primary button — internally we pick the wallet kind that matches
		// the supported SIWX chains AND the detected wallets. Phantom wins ties
		// to match the existing modal's default preference.
		const siwxTarget = siwxSolana
			? { kind: 'solana', chain: siwxSolana.chain }
			: { kind: 'evm', chain: siwxEvm.chain };
		const siwxLabel = siwxTarget.kind === 'solana' ? 'Sign in with Phantom' : 'Sign in with wallet';
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
		this.bodyEl.innerHTML = this.renderSteps(activeId, {
			discover: 'done',
			connect: 'done',
			...(activeId === 'verify' ? { authorize: 'done' } : {}),
			[`${activeId}_meta`]: meta.text || '',
			...meta.statuses,
		});
	}

	renderError(stepId, message) {
		this.bodyEl.innerHTML = `
			${this.renderSteps(stepId, {
				...(stepId !== 'discover' ? { discover: 'done' } : {}),
				...(stepId === 'authorize' || stepId === 'verify' ? { connect: 'done' } : {}),
				...(stepId === 'verify' ? { authorize: 'done' } : {}),
				[stepId]: 'error',
				[`${stepId}_meta`]: 'failed',
			})}
			<div class="x402-error-box"><strong>${escapeHtml(stepId)}:</strong> ${escapeHtml(message)}</div>
			<button class="x402-pay-btn" data-retry>Try again</button>
		`;
		this.bodyEl.querySelector('[data-retry]').addEventListener('click', () => this.start());
	}

	renderDone({ result, payment, siwx }) {
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
			this.challenge = challenge;
			this.siwx = extractSiwxExtension(challenge);
			this.payFlowOverride = false;
			this.siwxFallbackNotice = null;
			// Prefer Solana when Phantom is present, else first EIP-3009 EVM
			// entry (skipping Permit2 siblings the modal can't sign for), else
			// first accept.
			const solana = challenge.accepts.find((a) => isSolanaNetwork(a.network));
			const evm = challenge.accepts.find(isEip3009Accept);
			const phantomDetected = typeof window !== 'undefined' && (window.solana?.isPhantom || window.phantom?.solana);
			this.accept = (phantomDetected && solana) || evm || challenge.accepts[0];
			this.setPrice(this.accept);
			this.renderConnect();
		} catch (err) {
			this.renderError('discover', err.message || String(err));
		}
	}

	async runSolana(accept) {
		this.accept = accept;
		this.setPrice(accept);
		this.renderProgress('connect', { text: 'Opening Phantom…' });
		try {
			const provider = window.phantom?.solana || window.solana;
			if (!provider) throw new Error('Phantom wallet not detected');
			const conn = await provider.connect();
			const payerAddress = (conn?.publicKey || provider.publicKey)?.toString();
			if (!payerAddress) throw new Error('Phantom did not return a public key');
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
			this.renderProgress('authorize', { text: `Building Solana payment for ${payerAddress.slice(0, 6)}…${payerAddress.slice(-4)}` });

			const prep = await postJson(`${ORIGIN}/api/x402-checkout?action=prepare`, {
				accept,
				buyer: payerAddress,
			});
			this.renderProgress('authorize', { text: 'Confirm in Phantom…' });
			const txBytes = base64ToUint8Array(prep.tx_base64);
			// Phantom returns a fully-signed VersionedTransaction with the buyer's
			// signature added. The facilitator's fee-payer signature is added by
			// PayAI during /settle.
			const SolanaWeb3 = await loadSolanaWeb3();
			const tx = SolanaWeb3.VersionedTransaction.deserialize(txBytes);
			const signed = await provider.signTransaction(tx);
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
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	async runEvm(accept) {
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
					authorization: { from: payerAddress, to: accept.payTo, value: accept.amount, validAfter, validBefore, nonce },
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
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	async executePaid(xPayment) {
		this.renderProgress('verify', { text: 'Calling merchant endpoint…' });
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
				const msg = (result && typeof result === 'object' && (result.error_description || result.error)) || `HTTP ${res.status}`;
				throw new Error(msg);
			}
			const settleHeader = res.headers.get('x-payment-response');
			const payment = b64decode(settleHeader) || {};
			this.spendReservation = null;
			this.renderDone({ result, payment });
			this.resolve?.({ ok: true, result, payment, response: { status: res.status, headers: headersToObject(res.headers) } });
		} catch (err) {
			if (this.spendReservation) {
				browserRollbackReservation(this.spendReservation);
				this.spendReservation = null;
			}
			this.renderError('verify', friendlyError(err));
		}
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
		this.renderProgress('connect', { text: 'Opening Phantom…' });
		try {
			const provider = window.phantom?.solana || window.solana;
			if (!provider) throw new Error('Phantom wallet not detected');
			const conn = await provider.connect();
			const pubkey = conn?.publicKey || provider.publicKey;
			const address = pubkey?.toString();
			if (!address) throw new Error('Phantom did not return a public key');
			this.payerAddress = address;
			this.renderProgress('authorize', { text: `Sign sign-in message as ${address.slice(0, 6)}…${address.slice(-4)}` });

			const message = buildSiwxMessage(this.siwx.info, chain, address);
			const encoded = new TextEncoder().encode(message);
			const signed = await provider.signMessage(encoded, 'utf8');
			const sigBytes = signed?.signature instanceof Uint8Array ? signed.signature : new Uint8Array(signed?.signature || signed);
			if (!sigBytes || !sigBytes.length) throw new Error('Phantom did not return a signature');
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
			this.renderDone({ result, siwx });
			this.resolve?.({
				ok: true,
				result,
				siwx,
				response: { status: res.status, headers: headersToObject(res.headers) },
			});
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

function friendlyError(err) {
	const msg = err?.shortMessage || err?.message || String(err);
	// Trim ethers/viem long stacks, Phantom's RPC-error verbosity.
	if (/user rejected|user denied|reject/i.test(msg)) return 'cancelled in wallet';
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
function randomHex(bytes) {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

let _solanaWeb3 = null;
async function loadSolanaWeb3() {
	if (_solanaWeb3) return _solanaWeb3;
	// Dynamic import from esm.sh keeps the drop-in script tiny — Solana web3.js
	// is only fetched when a Solana payment is actually attempted.
	_solanaWeb3 = await import('https://esm.sh/@solana/web3.js@1.95.3?bundle');
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

// Probe the merchant endpoint with a benign request to extract the 402 challenge.
async function discoverChallenge(opts) {
	const headers = { ...(opts.headers || {}) };
	const init = {
		method: opts.method || 'GET',
		headers,
		body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
	};
	if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
	const res = await fetch(opts.endpoint, init);
	if (res.status !== 402) {
		// Endpoint isn't paid (200) or isn't an x402 endpoint at all. In either
		// case, surface a clear error — accidentally pointing the modal at a
		// free endpoint should not silently succeed.
		const txt = await res.text();
		throw new Error(`Endpoint did not return 402 (got ${res.status}). Body: ${txt.slice(0, 120)}`);
	}
	let body = await res.json().catch(() => null);
	if (!body || !Array.isArray(body.accepts) || !body.accepts.length) {
		// send402 (api/_lib/x402-spec.js) only emits `{error}` in the body and
		// puts the full v2 PaymentRequired envelope (accepts + extensions) in
		// the base64-JSON PAYMENT-REQUIRED header. b64decode returns already-
		// parsed JSON, so use its result directly.
		const prHeader = res.headers.get('payment-required');
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

export async function pay(opts) {
	if (!opts?.endpoint) throw new Error('X402.pay: endpoint is required');
	const modal = new CheckoutModal(opts);
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
