// @three-ws/x402-payment-modal — drop-in payment modal for any x402 endpoint.
//
// A single, dependency-free ES module. Drop it on any page and any element with
// `data-x402-endpoint` opens a payment modal on click:
//
//   <script type="module" src="https://unpkg.com/@three-ws/x402-payment-modal"></script>
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
//   import { pay, configure } from '@three-ws/x402-payment-modal';
//   const out = await pay({
//     endpoint: '/api/paid/summarize',
//     body: { text: 'hello' },
//     merchant: 'Acme',
//     action: 'Summarize',
//   });
//
// The modal handles wallet connect (Phantom/Solflare/Backpack/… for Solana,
// EIP-6963 browser wallets for Base/EVM USDC via EIP-3009), drives the
// 402 → sign → retry flow, optional
// SIWX (Sign-In-With-X) re-entry, client-side spending caps, and shows the
// result. Vanilla JS, no bundler required.
//
// Everything host-specific (the Solana checkout origin, branding, builder-code
// attribution, and the esm.sh CDN URLs used for the Solana/EVM crypto helpers)
// is configurable via `configure({...})` or `data-*` attributes on the script
// tag — see CONFIG / configure() below and docs/api-reference.md.

const VERSION = '1.2.1';

/** Library version. Kept in lockstep with package.json (see test/client.test.js). */
export const version = VERSION;

// ─────────────────────────────────────────────────────────── configuration ───
// All host-specific knobs live here so the modal runs unchanged on any site.
// Defaults match the three.ws hosted instance; override with configure() or via
// `data-*` attributes on the <script> tag (read once at load by readScriptConfig).
const CONFIG = {
	// Origin that serves the Solana checkout endpoints
	// (`/api/x402-checkout?action=prepare|encode`). `null` → resolve from this
	// script's own src, falling back to the current page origin. EVM payments
	// never touch this — the wallet signs EIP-3009 typed-data locally.
	checkoutOrigin: null,
	// Path of the checkout endpoint on `checkoutOrigin`. Override if you mount
	// the server handler somewhere other than /api/x402-checkout.
	checkoutPath: '/api/x402-checkout',
	// Footer attribution shown in the modal.
	brand: { name: 'three.ws', url: 'https://three.ws' },
	// Small text on the left of the footer.
	footerNote: 'x402 · onchain settled',
	// ERC-8021 builder-code self-attribution echoed back when the 402 challenge
	// declares a builder-code extension. Set either field to '' to disable it.
	builderCode: { wallet: '3d_agent', service: '3d_agent_modal' },
	// Color scheme: 'auto' follows the OS; 'light'/'dark' force it.
	theme: 'auto',
	// Optional flat map of --x402-* design tokens for brand-matching at runtime.
	cssVars: null,
	// Primary CDN URLs for the crypto helpers loaded on demand (only when a Solana
	// or EVM sign-in payment is actually attempted). Each is tried first, then the
	// loader falls back across additional independent CDNs (see ESM_FALLBACKS) so a
	// single CDN outage during a traffic spike can't break payments. Repoint these
	// at a self-hosted mirror to satisfy a strict Content-Security-Policy — your URL
	// is always tried first.
	esm: {
		solanaWeb3: 'https://esm.sh/@solana/web3.js@1.95.3?bundle',
		nobleHashesSha3: 'https://esm.sh/@noble/hashes@1.4.0/sha3?bundle',
	},
};

// Independent CDN fallbacks tried (in order, after the configured primary) if the
// primary is slow or down. Three uncorrelated providers ≈ no single point of
// failure for the dynamic crypto-helper import that the Solana path depends on.
const ESM_FALLBACKS = {
	solanaWeb3: [
		'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/+esm',
		'https://cdn.skypack.dev/@solana/web3.js@1.95.3',
	],
	nobleHashesSha3: [
		'https://cdn.jsdelivr.net/npm/@noble/hashes@1.4.0/sha3/+esm',
		'https://cdn.skypack.dev/@noble/hashes@1.4.0/sha3',
	],
};
const ESM_IMPORT_TIMEOUT_MS = 12_000;

/**
 * Merge caller overrides into CONFIG. Shallow-merges the nested `brand`,
 * `builderCode`, and `esm` objects so you can override a single field. Call
 * before the first `pay()` (or before the auto-bound buttons are clicked).
 * @param {Partial<typeof CONFIG>} opts
 * @returns {typeof CONFIG} the resolved config
 */
export function configure(opts = {}) {
	if (!opts || typeof opts !== 'object') return CONFIG;
	// theme: 'light' | 'dark' | 'auto' — force the modal's color scheme regardless
	// of the OS preference (auto = follow the OS, the default).
	for (const key of ['checkoutOrigin', 'checkoutPath', 'footerNote', 'theme']) {
		if (opts[key] !== undefined) CONFIG[key] = opts[key];
	}
	if (opts.brand && typeof opts.brand === 'object') Object.assign(CONFIG.brand, opts.brand);
	if (opts.builderCode && typeof opts.builderCode === 'object') Object.assign(CONFIG.builderCode, opts.builderCode);
	if (opts.esm && typeof opts.esm === 'object') Object.assign(CONFIG.esm, opts.esm);
	// cssVars: a flat map of x402 design tokens to brand-match without CSS files,
	// e.g. configure({ cssVars: { '--x402-accent': '#ff5c00', '--x402-radius': '8px' } }).
	if (opts.cssVars && typeof opts.cssVars === 'object') {
		CONFIG.cssVars = { ...(CONFIG.cssVars || {}), ...opts.cssVars };
	}
	return CONFIG;
}

// Resolved base URL for the Solana checkout endpoints.
function checkoutBase() {
	return `${CONFIG.checkoutOrigin || ORIGIN}${CONFIG.checkoutPath}`;
}

// SIWX ("Sign-In-With-X" / CAIP-122) lets a wallet that has already paid for
// an endpoint re-enter it by signing a challenge instead of paying again. The
// server advertises support by including `extensions['sign-in-with-x']` in the
// 402 body; clients submit signed proofs via the `SIGN-IN-WITH-X` header. See
// docs/siwx.md for the full architecture.
const SIWX_HEADER = 'SIGN-IN-WITH-X';
const SIWX_EXTENSION_KEY = 'sign-in-with-x';

const ORIGIN = (() => {
	// Resolve the origin that hosts this script, used as the API origin for
	// the prepare/encode helpers. Falls back to the merchant origin in same-
	// origin mode, and to '' off-browser: importing this module during SSR (or
	// in a test runner) must never throw, so every DOM/location read is guarded.
	try {
		const script = document.currentScript;
		if (script?.src) return new URL(script.src).origin;
		const found = document.querySelector('script[src*="/x402.js"]');
		if (found?.src) return new URL(found.src).origin;
	} catch (_) {}
	return typeof location !== 'undefined' ? location.origin : '';
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

// ─────────────────────────────────────────────── Well-known Solana tokens ────
// Mints the modal recognizes on sight, so a 402 `accept` can omit
// `extra.name`/`extra.decimals` and still render with the correct symbol,
// decimals, and branding. Two settlement assets are first-class on Solana:
//   • USDC — the universal dollar-stable rail.
//   • THREE — the three.ws utility token. Holders can pay any x402 endpoint
//     that opts into accepting it, right alongside USDC. See three.ws/three-token.
// A merchant offers THREE simply by adding a Solana `accept` whose `asset` is
// THREE_MINT (the server checkout transfers any SPL mint, so no extra wiring).
export const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

export const KNOWN_SOLANA_TOKENS = Object.freeze({
	[USDC_MINT_SOLANA]: { symbol: 'USDC', name: 'USD Coin', decimals: 6, stable: true },
	[THREE_MINT]: { symbol: 'THREE', name: 'THREE', decimals: 6, accent: '#7aa2ff', glyph: '◆' },
});

// Resolve display metadata for an `accept`. A merchant-supplied `extra.name`/
// `extra.decimals` always wins; otherwise we fall back to the known-token
// registry keyed by mint, then to USDC defaults. Never throws.
function tokenInfo(accept) {
	const known = (accept && accept.asset && KNOWN_SOLANA_TOKENS[accept.asset]) || null;
	const rawName = accept?.extra?.name;
	const symbol = (rawName ? String(rawName).replace(/^USD Coin$/, 'USDC') : known?.symbol) || 'USDC';
	const decimals = Number(accept?.extra?.decimals ?? known?.decimals ?? 6);
	const stable = known?.stable || STABLE_NAMES.has(String(rawName || '').toLowerCase());
	return { symbol, decimals, stable, accent: known?.accent || null, glyph: known?.glyph || null };
}

function isThreeAccept(accept) {
	return accept?.asset === THREE_MINT;
}

// Every Solana `accept` the challenge offers, in challenge order. More than one
// means the merchant accepts multiple tokens (e.g. USDC and THREE) and the buyer
// gets to choose which to pay in.
function listSolanaAccepts(challenge) {
	return (challenge?.accepts || []).filter((a) => isSolanaNetwork(a.network));
}

// Default Solana token to surface first: USDC (stable, predictable price) when
// offered, then any other stable, then the first accept. The buyer can switch.
function pickDefaultSolana(list) {
	return (
		list.find((a) => a.asset === USDC_MINT_SOLANA) ||
		list.find((a) => tokenInfo(a).stable) ||
		list[0] ||
		null
	);
}

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
	const known = (accept && accept.asset && KNOWN_SOLANA_TOKENS[accept.asset]) || null;
	const decimals = Number(accept?.extra?.decimals ?? known?.decimals ?? 6);
	const name = String(accept?.extra?.name || '').toLowerCase();
	if (STABLE_NAMES.has(name) || known?.stable) {
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

function buildBuilderCodeEcho(challenge) {
	const ext = challenge?.extensions?.[BUILDER_CODE_KEY];
	const declaredA = ext?.info?.a;
	if (!declaredA || !BUILDER_CODE_PATTERN.test(declaredA)) return null;
	const out = { a: declaredA };
	const serviceCode = CONFIG.builderCode.service;
	const walletCode = CONFIG.builderCode.wallet;
	if (serviceCode && BUILDER_CODE_PATTERN.test(serviceCode)) out.s = [serviceCode];
	if (walletCode && BUILDER_CODE_PATTERN.test(walletCode)) out.w = walletCode;
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
// (api/_lib/siws.js → @noble/curves). Pulled in dynamically via esm.sh only
// when SIWX EVM sign-in is actually attempted, mirroring loadSolanaWeb3.
let _evmChecksum = null;
async function loadEvmChecksum() {
	if (_evmChecksum) return _evmChecksum;
	const sha3 = await importWithFallback(CONFIG.esm.nobleHashesSha3, ESM_FALLBACKS.nobleHashesSha3, '@noble/hashes/sha3');
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
// Full design-token surface. Hosts brand-match by setting any of these on
// `.x402-overlay` (via configure({ cssVars }) or their own CSS) — no !important,
// no specificity battles. Dark values are applied both by the OS preference and
// by an explicit `.x402-theme-dark` class (configure({ theme })).
const TOKENS_LIGHT = `
	--x402-z: 2147483600;
	--x402-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	--x402-mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace;
	--x402-scrim: rgba(8, 10, 18, 0.55);
	--x402-surface: #ffffff;
	--x402-surface-2: #f7f8fa;
	--x402-fg: #0f1116;
	--x402-muted: #646b7a;
	--x402-faint: #9aa1ad;
	--x402-border: #ecedf1;
	--x402-border-strong: #d8dce4;
	--x402-accent: #635bff;
	--x402-accent-hover: #524bdb;
	--x402-accent-weak: #f2f1ff;
	--x402-accent-fg: #ffffff;
	--x402-success: #16a34a;
	--x402-success-fg: #15803d;
	--x402-success-bg: #f0fdf4;
	--x402-success-border: #bbf7d0;
	--x402-error: #dc2626;
	--x402-error-fg: #b91c1c;
	--x402-error-bg: #fef2f2;
	--x402-error-border: #fecaca;
	--x402-warn-fg: #b45309;
	--x402-warn-bg: #fffbeb;
	--x402-warn-border: #fde68a;
	--x402-link: #524bdb;
	--x402-radius: 18px;
	--x402-radius-md: 12px;
	--x402-radius-sm: 9px;
	--x402-shadow: 0 24px 80px rgba(8, 10, 18, 0.28), 0 4px 16px rgba(8, 10, 18, 0.12);
	--x402-btn-bg: #0f1116;
	--x402-btn-fg: #ffffff;
	--x402-btn-hover: #242833;
	--x402-btn-shadow: 0 1px 2px rgba(8, 10, 18, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.12);
`;
const TOKENS_DARK = `
	--x402-scrim: rgba(0, 0, 0, 0.62);
	--x402-surface: #161616;
	--x402-surface-2: #1d1d1d;
	--x402-fg: #e6e8f0;
	--x402-muted: #9aa1b4;
	--x402-faint: #6b7088;
	--x402-border: #2a2a2a;
	--x402-border-strong: #3a3a40;
	--x402-accent: #8b85ff;
	--x402-accent-hover: #a29cff;
	--x402-accent-weak: #1e1b3a;
	--x402-accent-fg: #ffffff;
	--x402-success: #22c55e;
	--x402-success-fg: #4ade80;
	--x402-success-bg: #0b1f17;
	--x402-success-border: #14532d;
	--x402-error: #ef4444;
	--x402-error-fg: #fca5a5;
	--x402-error-bg: #1f1416;
	--x402-error-border: #7f1d1d;
	--x402-warn-fg: #fcd34d;
	--x402-warn-bg: #2a1d10;
	--x402-warn-border: #78350f;
	--x402-link: #a29cff;
	--x402-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
	--x402-btn-bg: #ffffff;
	--x402-btn-fg: #0f1116;
	--x402-btn-hover: #e7e9ee;
	--x402-btn-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.5);
`;

const STYLES = `
.x402-overlay { ${TOKENS_LIGHT} }
.x402-overlay.x402-theme-dark { ${TOKENS_DARK} }
@media (prefers-color-scheme: dark) {
	.x402-overlay:not(.x402-theme-light) { ${TOKENS_DARK} }
}
.x402-overlay {
	position: fixed; inset: 0;
	background: var(--x402-scrim);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	display: flex; align-items: center; justify-content: center;
	z-index: var(--x402-z);
	opacity: 0; transition: opacity 0.16s ease-out;
	font-family: var(--x402-font);
	-webkit-font-smoothing: antialiased;
	color: var(--x402-fg);
}
.x402-overlay.x402-open { opacity: 1; }
.x402-overlay * { box-sizing: border-box; }
.x402-overlay :focus-visible {
	outline: 2px solid var(--x402-accent);
	outline-offset: 2px;
}
.x402-modal {
	width: calc(100% - 32px); max-width: 420px;
	background: var(--x402-surface);
	border-radius: var(--x402-radius);
	box-shadow: var(--x402-shadow);
	overflow: hidden;
	transform: translateY(8px) scale(0.985);
	transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	display: flex; flex-direction: column;
	max-height: calc(100dvh - 32px);
}
.x402-overlay.x402-open .x402-modal { transform: translateY(0) scale(1); }
.x402-head {
	padding: 18px 20px 14px;
	border-bottom: 1px solid var(--x402-border);
	display: flex; align-items: center; gap: 12px;
}
.x402-head .x402-merchant { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.x402-head .x402-merchant-text { min-width: 0; }
.x402-brand-logo { width: 30px; height: 30px; flex: 0 0 auto; border-radius: 8px; object-fit: cover; }
.x402-merchant .x402-name {
	font-size: 12px; color: var(--x402-muted); font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;
	margin-bottom: 2px;
}
.x402-merchant .x402-action {
	font-size: 17px; font-weight: 700; color: var(--x402-fg);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	letter-spacing: -0.01em;
}
.x402-close {
	width: 32px; height: 32px; flex: 0 0 auto;
	border-radius: 8px; border: none; background: var(--x402-surface-2);
	color: var(--x402-muted); cursor: pointer;
	display: flex; align-items: center; justify-content: center;
	transition: background 0.12s, color 0.12s;
}
.x402-close:hover { background: var(--x402-border-strong); color: var(--x402-fg); }
.x402-close svg { width: 14px; height: 14px; }

.x402-price-row {
	padding: 18px 20px;
	display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
	background: var(--x402-surface-2);
	border-bottom: 1px solid var(--x402-border);
}
.x402-price-main { min-width: 0; }
.x402-price {
	font-size: 32px; font-weight: 700; letter-spacing: -0.02em; color: var(--x402-fg);
	font-variant-numeric: tabular-nums;
}
.x402-price .x402-currency { font-size: 14px; color: var(--x402-muted); font-weight: 600; margin-left: 6px; letter-spacing: 0; }
.x402-price-sub { font-size: 11px; color: var(--x402-muted); margin-top: 3px; font-weight: 500; }
.x402-network {
	font-size: 12px; color: var(--x402-muted); font-weight: 500; flex: 0 0 auto;
	background: var(--x402-surface); border: 1px solid var(--x402-border);
	padding: 5px 10px; border-radius: 99px;
	display: inline-flex; align-items: center; gap: 6px;
}
.x402-network::before {
	content: ''; width: 6px; height: 6px; border-radius: 50%;
	background: var(--x402-success);
	box-shadow: 0 0 0 0 var(--x402-success);
	animation: x402-pulse 2s ease-out infinite;
}
@keyframes x402-pulse {
	0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--x402-success) 55%, transparent); }
	70% { box-shadow: 0 0 0 5px transparent; }
	100% { box-shadow: 0 0 0 0 transparent; }
}

.x402-body {
	padding: 16px 20px max(18px, env(safe-area-inset-bottom));
	flex: 1 1 auto; overflow-y: auto;
	display: flex; flex-direction: column; gap: 10px;
}
.x402-body > * { animation: x402-fade 0.16s ease-out both; }
@keyframes x402-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.x402-step {
	display: flex; gap: 12px; align-items: flex-start;
	padding: 10px 0;
}
.x402-step + .x402-step { border-top: 1px solid var(--x402-border); }
.x402-step-num {
	width: 22px; height: 22px; flex: 0 0 auto;
	border-radius: 50%; border: 1.5px solid var(--x402-border-strong); background: var(--x402-surface);
	color: var(--x402-muted);
	font-size: 11px; font-weight: 700;
	display: flex; align-items: center; justify-content: center;
}
.x402-step.x402-active .x402-step-num {
	border-color: var(--x402-accent); background: var(--x402-accent); color: var(--x402-accent-fg);
	animation: x402-spin 1.2s linear infinite;
}
.x402-step.x402-done .x402-step-num {
	border-color: var(--x402-success); background: var(--x402-success); color: #fff;
}
.x402-step.x402-error .x402-step-num {
	border-color: var(--x402-error); background: var(--x402-error); color: #fff;
}
@keyframes x402-spin {
	from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--x402-accent) 40%, transparent); }
	to { box-shadow: 0 0 0 8px transparent; }
}
.x402-step-body { flex: 1; min-width: 0; }
.x402-step-label { font-size: 14px; font-weight: 600; color: var(--x402-fg); line-height: 1.35; }
.x402-step-meta { font-size: 12px; color: var(--x402-muted); margin-top: 2px; font-feature-settings: 'tnum' 1; }
.x402-step.x402-error .x402-step-meta { color: var(--x402-error-fg); }

.x402-skeleton {
	border-radius: 6px;
	background: linear-gradient(100deg, var(--x402-surface-2) 30%, var(--x402-border) 50%, var(--x402-surface-2) 70%);
	background-size: 200% 100%;
	animation: x402-shimmer 1.3s ease-in-out infinite;
}
@keyframes x402-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.x402-wallet-buttons {
	display: flex; flex-direction: column; gap: 8px;
	margin-top: 4px;
}
.x402-wallet-btn {
	width: 100%; padding: 13px 14px;
	background: var(--x402-surface); border: 1.5px solid var(--x402-border-strong); border-radius: 11px;
	font-size: 14px; font-weight: 600; color: var(--x402-fg);
	cursor: pointer; font-family: inherit;
	display: flex; align-items: center; gap: 12px;
	transition: border-color 0.12s, background 0.12s, transform 0.05s;
}
.x402-wallet-btn:hover:not(:disabled) { border-color: var(--x402-accent); background: var(--x402-accent-weak); }
.x402-wallet-btn:active:not(:disabled) { transform: translateY(1px); }
.x402-wallet-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.x402-wallet-icon {
	width: 28px; height: 28px; flex: 0 0 auto;
	border-radius: 7px;
	display: flex; align-items: center; justify-content: center;
	background: var(--x402-surface-2); overflow: hidden;
}
.x402-wallet-icon svg, .x402-wallet-icon img { width: 18px; height: 18px; }
.x402-wallet-name { flex: 1; text-align: left; }
.x402-wallet-meta { font-size: 11px; color: var(--x402-muted); font-weight: 500; }
.x402-wallet-install {
	font-size: 12px; color: var(--x402-muted); line-height: 1.5; text-align: center;
	padding: 4px 0 2px;
}
.x402-wallet-install a { color: var(--x402-link); text-decoration: none; font-weight: 600; }
.x402-wallet-install a:hover { text-decoration: underline; }

.x402-token-row {
	display: flex; gap: 8px; margin-bottom: 10px;
}
.x402-token-pill {
	flex: 1; min-width: 0; cursor: pointer; font-family: inherit;
	padding: 9px 12px; border-radius: 10px;
	background: var(--x402-surface); border: 1.5px solid var(--x402-border-strong);
	display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
	transition: border-color 0.12s, background 0.12s, transform 0.05s, box-shadow 0.12s;
}
.x402-token-pill:hover { border-color: var(--x402-accent); background: var(--x402-accent-weak); }
.x402-token-pill:active { transform: translateY(1px); }
.x402-token-pill.x402-on {
	border-color: var(--x402-accent); background: var(--x402-accent-weak);
	box-shadow: inset 0 0 0 1px var(--x402-accent);
}
.x402-token-sym { font-size: 13px; font-weight: 700; color: var(--x402-fg); letter-spacing: -0.005em; }
.x402-token-amt { font-size: 11px; color: var(--x402-muted); font-weight: 600; font-variant-numeric: tabular-nums; }

.x402-pay-btn {
	width: 100%; padding: 14px 16px;
	background: var(--x402-btn-bg); color: var(--x402-btn-fg); border: none;
	border-radius: var(--x402-radius-md);
	font-size: 15px; font-weight: 700; font-family: inherit;
	cursor: pointer; letter-spacing: -0.005em;
	box-shadow: var(--x402-btn-shadow);
	transition: background 0.12s, transform 0.1s, box-shadow 0.12s;
	margin-top: 4px;
	display: flex; align-items: center; justify-content: center; gap: 8px;
}
.x402-pay-btn:hover:not(:disabled) { background: var(--x402-btn-hover); transform: translateY(-1px); }
.x402-pay-btn:active:not(:disabled) { transform: translateY(0); }
.x402-pay-btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }

.x402-pay-secondary {
	width: 100%; padding: 12px 14px;
	background: var(--x402-surface); color: var(--x402-fg);
	border: 1.5px solid var(--x402-border-strong); border-radius: 11px;
	font-size: 14px; font-weight: 600; font-family: inherit;
	cursor: pointer; letter-spacing: -0.005em;
	margin-top: 6px;
	transition: border-color 0.12s, background 0.12s, transform 0.05s;
}
.x402-pay-secondary:hover:not(:disabled) { border-color: var(--x402-accent); background: var(--x402-accent-weak); }
.x402-pay-secondary:active:not(:disabled) { transform: translateY(1px); }

.x402-trust {
	font-size: 11.5px; color: var(--x402-muted); text-align: center;
	margin-top: 10px; line-height: 1.45;
	display: flex; align-items: center; justify-content: center; gap: 6px;
}
.x402-trust svg { width: 12px; height: 12px; flex: 0 0 auto; color: var(--x402-success); }

.x402-siwx-hint {
	font-size: 11px; color: var(--x402-muted); text-align: center;
	margin-top: 8px; line-height: 1.4;
}
.x402-siwx-fallback {
	font-size: 12px; color: var(--x402-warn-fg); line-height: 1.45;
	padding: 8px 10px; border-radius: 8px;
	background: var(--x402-warn-bg); border: 1px solid var(--x402-warn-border);
	margin-bottom: 6px;
}

.x402-error-box {
	padding: 12px 14px; border-radius: 10px;
	background: var(--x402-error-bg); border: 1px solid var(--x402-error-border); color: var(--x402-error-fg);
	font-size: 13.5px; line-height: 1.5;
	word-break: break-word;
}
.x402-error-box .x402-error-title { font-weight: 700; margin-bottom: 2px; }
.x402-error-box .x402-error-detail { opacity: 0.85; font-size: 12.5px; }

.x402-receipt {
	padding: 16px; border-radius: var(--x402-radius-md);
	background: var(--x402-success-bg);
	border: 1px solid var(--x402-success-border);
	animation: x402-pop 0.34s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes x402-pop { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
.x402-receipt-check {
	width: 40px; height: 40px; margin: 2px auto 10px;
	border-radius: 50%; background: var(--x402-success);
	display: flex; align-items: center; justify-content: center;
	animation: x402-check-pop 0.4s cubic-bezier(0.16, 1, 0.3, 1) 0.08s both;
}
.x402-receipt-check svg { width: 22px; height: 22px; color: #fff; }
.x402-receipt-check svg path { stroke-dasharray: 24; stroke-dashoffset: 24; animation: x402-draw 0.4s ease-out 0.22s forwards; }
@keyframes x402-check-pop { 0% { transform: scale(0); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }
@keyframes x402-draw { to { stroke-dashoffset: 0; } }
.x402-receipt-title {
	font-size: 15px; font-weight: 700; color: var(--x402-fg);
	text-align: center; margin-bottom: 10px; letter-spacing: -0.01em;
}
.x402-receipt-row {
	display: flex; justify-content: space-between; gap: 12px;
	font-size: 12px; padding: 3px 0;
	font-family: var(--x402-mono);
}
.x402-receipt-row .x402-k { color: var(--x402-muted); }
.x402-receipt-row .x402-v { color: var(--x402-fg); text-align: right; word-break: break-all; }
.x402-receipt-row a { color: var(--x402-link); text-decoration: none; }
.x402-receipt-row a:hover { text-decoration: underline; }

.x402-result {
	padding: 12px 14px; border-radius: 10px;
	background: var(--x402-surface-2); border: 1px solid var(--x402-border);
	max-height: 240px; overflow: auto;
	font-family: var(--x402-mono);
	font-size: 12px; line-height: 1.5; color: var(--x402-fg);
	white-space: pre-wrap; word-break: break-word;
}
.x402-result.x402-prose { font-family: var(--x402-font); font-size: 13.5px; line-height: 1.55; }

.x402-foot {
	padding: 10px 20px max(14px, env(safe-area-inset-bottom));
	border-top: 1px solid var(--x402-border);
	display: flex; align-items: center; justify-content: space-between;
	font-size: 11px; color: var(--x402-muted);
}
.x402-foot a { color: var(--x402-muted); text-decoration: none; font-weight: 600; }
.x402-foot a:hover { color: var(--x402-fg); }
.x402-foot .x402-secure { display: flex; align-items: center; gap: 5px; }
.x402-foot .x402-secure svg { width: 11px; height: 11px; }

.x402-sr-only {
	position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
	overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

@media (max-width: 520px) {
	.x402-overlay { align-items: flex-end; }
	.x402-modal {
		max-width: none; width: 100%;
		border-radius: var(--x402-radius) var(--x402-radius) 0 0;
		max-height: 92dvh;
		transform: translateY(100%);
	}
	.x402-overlay.x402-open .x402-modal { transform: translateY(0); }
	.x402-price { font-size: 28px; }
}

@media (prefers-reduced-motion: reduce) {
	.x402-overlay, .x402-modal, .x402-body > *,
	.x402-receipt, .x402-receipt-check, .x402-receipt-check svg path { animation: none !important; transition: none !important; }
	.x402-step.x402-active .x402-step-num { animation: none; }
	.x402-network::before { animation: none; }
	.x402-receipt-check svg path { stroke-dashoffset: 0; }
}
`;

// Crisp inline SVG iconography — emoji/letter placeholders render differently
// per-OS and read as cheap; these inherit currentColor and stay sharp at any DPI.
const ICONS = {
	close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
	check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>',
	shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.4-7 9-4-1.6-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
	phantom: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#ab9ff2"/><path fill="#fff" d="M19 12.4c0 3.8-3.1 6.8-7 6.8-.6 0-1-.6-.7-1.1.2-.4 0-.9-.4-1.1-.4-.2-1 0-1.3.4-.5.7-1.3 1.1-2.2 1.1H6.7c-1.2 0-2.2-1-2.2-2.2v-1.7c0-4.1 3.4-7.4 7.5-7.4h-.1c3.9 0 7.1 2.6 7.1 5.9z"/><circle cx="9.4" cy="12.4" r="1" fill="#534bb1"/><circle cx="12.6" cy="12.4" r="1" fill="#534bb1"/></svg>',
	wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14" r="1.3" fill="currentColor" stroke="none"/></svg>',
};

// Human-readable headings for the failure step shown in the error box. Never
// surface the internal step id ("authorize", "verify") to a buyer.
const STEP_LABELS = {
	discover: "Couldn't confirm the price",
	connect: "Couldn't connect your wallet",
	authorize: "Payment couldn't be authorized",
	verify: "Payment couldn't be completed",
};

// ──────────────────────────────────────────────────── wallet discovery ────
// Detect every injected Solana wallet, not just Phantom — Solflare/Backpack/Glow
// users were dead-ended before. They share Phantom's connect/signTransaction/
// signMessage shape, so each drops straight into runSolana. Returns
// [{ kind:'solana', name, provider, icon }] in preference order.
function discoverSolanaWallets() {
	if (typeof window === 'undefined') return [];
	const out = [];
	const seen = new Set();
	const add = (name, provider, icon) => {
		if (!provider || typeof provider.signTransaction !== 'function' || seen.has(provider)) return;
		seen.add(provider);
		out.push({ kind: 'solana', name, provider, icon: icon || ICONS.wallet });
	};
	add('Phantom', window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null), ICONS.phantom);
	add('Solflare', window.solflare?.isSolflare ? window.solflare : null, ICONS.wallet);
	add('Backpack', window.backpack?.isBackpack ? window.backpack : null, ICONS.wallet);
	add('Glow', window.glowSolana || window.glow || null, ICONS.wallet);
	add('Coinbase Wallet', window.coinbaseSolana || null, ICONS.wallet);
	// A standards-compliant injected provider that isn't one of the above.
	if (window.solana && !window.solana.isPhantom) add(window.solana.isSolflare ? 'Solflare' : 'Solana wallet', window.solana, ICONS.wallet);
	return out;
}

// EIP-6963 multi-provider discovery so a user with several EVM wallets isn't
// stuck with whoever won the window.ethereum race. Wallets that implement 6963
// re-announce synchronously on request; we fall back to legacy window.ethereum
// (and its .providers[] array) when none do.
function discoverEvmWallets() {
	if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return [];
	const out = [];
	const seen = new Set();
	const add = (name, provider, icon) => {
		if (!provider || seen.has(provider)) return;
		seen.add(provider);
		out.push({ kind: 'evm', name: name || 'Browser wallet', provider, icon: icon || ICONS.wallet });
	};
	const announced = [];
	const onAnnounce = (e) => { if (e?.detail) announced.push(e.detail); };
	window.addEventListener('eip6963:announceProvider', onAnnounce);
	try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* ignore */ }
	window.removeEventListener('eip6963:announceProvider', onAnnounce);
	for (const d of announced) add(d.info?.name, d.provider, d.info?.icon);
	if (!out.length) {
		const eth = window.ethereum;
		const label = (p) => (p?.isMetaMask ? 'MetaMask' : p?.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet');
		if (Array.isArray(eth?.providers)) for (const p of eth.providers) add(label(p), p);
		else if (eth) add(label(eth), eth);
	}
	return out;
}

// A wallet's icon is either an inline SVG string (our ICONS) or a data:/https
// URL (EIP-6963 / Wallet-Standard supply these) — render accordingly.
function walletIconHtml(icon) {
	if (icon && /^(data:|https?:)/.test(icon)) return `<img src="${escapeHtml(icon)}" alt="" />`;
	return icon || ICONS.wallet;
}

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
		// Forced color scheme (configure({ theme })) overrides the OS preference.
		if (CONFIG.theme === 'dark') overlay.classList.add('x402-theme-dark');
		else if (CONFIG.theme === 'light') overlay.classList.add('x402-theme-light');
		// Brand design-token overrides applied inline so they win without !important.
		if (CONFIG.cssVars && typeof CONFIG.cssVars === 'object') {
			for (const [k, v] of Object.entries(CONFIG.cssVars)) {
				if (/^--x402-[a-z0-9-]+$/i.test(k)) overlay.style.setProperty(k, String(v));
			}
		}
		const logo = CONFIG.brand?.logo
			? `<img class="x402-brand-logo" src="${escapeHtml(CONFIG.brand.logo)}" alt="" />`
			: '';
		overlay.innerHTML = `
			<div class="x402-modal" role="dialog" aria-modal="true" aria-labelledby="x402-act" aria-describedby="x402-price">
				<div class="x402-head">
					<div class="x402-merchant">
						${logo}
						<div class="x402-merchant-text">
							<div class="x402-name" data-merchant>${escapeHtml(this.opts.merchant || 'Payment')}</div>
							<div class="x402-action" id="x402-act" data-action>${escapeHtml(this.opts.action || 'Pay-per-call')}</div>
						</div>
					</div>
					<button class="x402-close" data-close aria-label="Close payment">${ICONS.close}</button>
				</div>
				<div class="x402-price-row">
					<div class="x402-price-main">
						<div class="x402-price" id="x402-price" data-price>—<span class="x402-currency"> USDC</span></div>
						<div class="x402-price-sub" data-price-sub></div>
					</div>
					<div class="x402-network" data-network>resolving…</div>
				</div>
				<div class="x402-body" data-body aria-live="polite"></div>
				<div class="x402-foot">
					<span class="x402-secure">${ICONS.lock}${escapeHtml(CONFIG.footerNote)}</span>
					${CONFIG.brand?.name ? `<a href="${escapeHtml(CONFIG.brand.url || '#')}" target="_blank" rel="noopener">Powered by ${escapeHtml(CONFIG.brand.name)}</a>` : ''}
				</div>
			</div>
		`;
		document.body.appendChild(overlay);
		this.overlay = overlay;
		this.bodyEl = overlay.querySelector('[data-body]');
		this.priceEl = overlay.querySelector('[data-price]');
		this.priceSubEl = overlay.querySelector('[data-price-sub]');
		this.networkEl = overlay.querySelector('[data-network]');
		overlay.querySelector('[data-close]').addEventListener('click', () => this.close('cancelled'));
		overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close('cancelled'); });
		// Remember what had focus so we can restore it on close (a11y).
		this.previouslyFocused = typeof document !== 'undefined' ? document.activeElement : null;
		this.onKey = (e) => {
			if (e.key === 'Escape') { this.close('cancelled'); return; }
			if (e.key === 'Tab') this.trapTab(e);
		};
		document.addEventListener('keydown', this.onKey);
		requestAnimationFrame(() => {
			overlay.classList.add('x402-open');
			this.focusFirst();
		});
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	// All visible, enabled, focusable elements inside the modal, in DOM order.
	focusables() {
		if (!this.overlay) return [];
		const sel = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
		return Array.from(this.overlay.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
	}

	focusFirst() {
		const list = this.focusables();
		(list.find((el) => !el.hasAttribute('data-close')) || list[0])?.focus?.();
	}

	// Keep Tab within the dialog — a modal must not leak focus to the page behind.
	trapTab(e) {
		const list = this.focusables();
		if (!list.length) return;
		const first = list[0];
		const last = list[list.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}

	close(reason) {
		if (this.disposed) return;
		this.disposed = true;
		document.removeEventListener('keydown', this.onKey);
		this.overlay.classList.remove('x402-open');
		setTimeout(() => this.overlay.remove(), 180);
		// Restore focus to whatever triggered the modal.
		this.previouslyFocused?.focus?.();
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
		const info = tokenInfo(accept);
		const amount = formatAmount(accept.amount, info.decimals);
		const glyph = info.glyph ? `${info.glyph} ` : '';
		this.priceEl.innerHTML = `${amount}<span class="x402-currency"> ${glyph}${escapeHtml(info.symbol)}</span>`;
		this.networkEl.textContent = networkLabel(accept.network, accept);
	}

	renderConnect() {
		// Detect ALL injected wallets, not just Phantom/window.ethereum.
		const solanaWallets = discoverSolanaWallets();
		const evmWallets = discoverEvmWallets();
		this._solWallets = solanaWallets;
		this._evmWallets = evmWallets;
		const phantomDetected = solanaWallets.length > 0;
		const evmDetected = evmWallets.length > 0;
		const solanaList = listSolanaAccepts(this.challenge);
		// Keep a valid selection: honour the buyer's prior pick if it's still on
		// offer, otherwise fall back to the default (USDC-first).
		let solanaAccept = solanaList.find((a) => a === this.solanaAccept) || pickDefaultSolana(solanaList);
		this.solanaAccept = solanaAccept;
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

		// autoConnect (opt-in via opts.autoConnect): when the caller knows the
		// user is wallet-ready and shouldn't have to pick, skip the picker and go
		// straight to the signature — but only when exactly one supported wallet
		// is actually detected. Zero wallets (must install) or two (must choose)
		// still fall through to the picker, as does the SIWX "you haven't paid"
		// fallback, which needs to explain itself. One-shot via autoConnectTried.
		if (this.opts.autoConnect && !this.autoConnectTried && !this.siwxFallbackNotice) {
			this.autoConnectTried = true;
			// Only auto-connect when there's exactly one wallet to choose — otherwise
			// the buyer must pick which one.
			const solanaViable = solanaAccept && solanaWallets.length === 1;
			const evmViable = evmAccept && evmWallets.length === 1;
			if (solanaViable && !evmViable) { this.runSolana(solanaAccept, solanaWallets[0].provider); return; }
			if (evmViable && !solanaViable) { this.runEvm(evmAccept, evmWallets[0].provider); return; }
		}

		// When the merchant offers more than one Solana token (e.g. USDC and
		// THREE), let the buyer choose which to pay in. The selected token drives
		// the headline price and the transaction the Phantom button builds.
		const tokenChooser = solanaList.length > 1
			? `<div class="x402-token-row" role="group" aria-label="Choose payment token">
					${solanaList.map((a) => {
						const info = tokenInfo(a);
						const on = a === solanaAccept;
						const amt = formatAmount(a.amount, info.decimals);
						return `<button type="button" class="x402-token-pill${on ? ' x402-on' : ''}" data-token-asset="${escapeHtml(a.asset)}" aria-pressed="${on}"${info.accent && on ? ` style="border-color:${escapeHtml(info.accent)}"` : ''}>
							<span class="x402-token-sym">${info.glyph ? escapeHtml(info.glyph) + ' ' : ''}${escapeHtml(info.symbol)}</span>
							<span class="x402-token-amt">${amt}</span>
						</button>`;
					}).join('')}
				</div>`
			: '';

		const buttons = [];
		if (solanaAccept) {
			const solInfo = tokenInfo(solanaAccept);
			const solMeta = solanaList.length > 1
				? `${networkLabel(solanaAccept.network, solanaAccept)} · ${solInfo.symbol}`
				: networkLabel(solanaAccept.network, solanaAccept);
			if (solanaWallets.length) {
				solanaWallets.forEach((w, i) => buttons.push(`
					<button class="x402-wallet-btn" data-wallet-kind="solana" data-wallet-idx="${i}">
						<div class="x402-wallet-icon">${walletIconHtml(w.icon)}</div>
						<span class="x402-wallet-name">${escapeHtml(w.name)}</span>
						<span class="x402-wallet-meta"${i === 0 ? ' data-sol-meta' : ''}>${escapeHtml(solMeta)}</span>
					</button>
				`));
			} else {
				buttons.push(`
					<button class="x402-wallet-btn" disabled>
						<div class="x402-wallet-icon">${ICONS.phantom}</div>
						<span class="x402-wallet-name">No Solana wallet detected</span>
						<span class="x402-wallet-meta">${escapeHtml(solMeta)}</span>
					</button>
				`);
			}
		}
		if (evmAccept) {
			if (evmWallets.length) {
				evmWallets.forEach((w, i) => buttons.push(`
					<button class="x402-wallet-btn" data-wallet-kind="evm" data-wallet-idx="${i}">
						<div class="x402-wallet-icon">${walletIconHtml(w.icon)}</div>
						<span class="x402-wallet-name">${escapeHtml(w.name)}</span>
						<span class="x402-wallet-meta">${escapeHtml(networkLabel(evmAccept.network, evmAccept))}</span>
					</button>
				`));
			} else {
				buttons.push(`
					<button class="x402-wallet-btn" disabled>
						<div class="x402-wallet-icon">${ICONS.wallet}</div>
						<span class="x402-wallet-name">No EVM wallet detected</span>
						<span class="x402-wallet-meta">${escapeHtml(networkLabel(evmAccept.network, evmAccept))}</span>
					</button>
				`);
			}
		}
		// When nothing is installed, don't dead-end — point users to a wallet.
		const installHelp = (!phantomDetected && !evmDetected)
			? `<div class="x402-wallet-install">No wallet detected — install
					${solanaAccept ? `<a href="https://phantom.app/download" target="_blank" rel="noopener">Phantom</a>` : ''}${solanaAccept && evmAccept ? ' or ' : ''}${evmAccept ? `<a href="https://metamask.io/download" target="_blank" rel="noopener">MetaMask</a>` : ''}
					to continue.</div>`
			: '';
		const fallbackBox = this.siwxFallbackNotice
			? `<div class="x402-siwx-fallback">${escapeHtml(this.siwxFallbackNotice)}</div>`
			: '';
		// True for the exact scheme: the signed authorization can only move the
		// stated amount to the stated recipient — a strong, honest trust signal.
		const trustInfo = tokenInfo(this.accept);
		const trustAmt = formatAmount(this.accept.amount, trustInfo.decimals);
		const trustLine = `<div class="x402-trust">${ICONS.shield}<span>You authorize exactly ${escapeHtml(trustAmt)} ${escapeHtml(trustInfo.symbol)} — nothing more can be charged.</span></div>`;
		this.bodyEl.innerHTML = `
			${this.renderSteps('connect', { discover: 'done' })}
			${fallbackBox}
			${tokenChooser}
			<div class="x402-wallet-buttons">${buttons.join('')}</div>
			${installHelp}
			${(phantomDetected || evmDetected) ? trustLine : ''}
		`;
		requestAnimationFrame(() => this.focusFirst());
		const onClick = (e) => {
			const btn = e.target.closest('[data-wallet-kind]');
			if (!btn || btn.disabled) return;
			const kind = btn.dataset.walletKind;
			const idx = Number(btn.dataset.walletIdx);
			if (kind === 'solana') this.runSolana(this.solanaAccept, this._solWallets[idx]?.provider);
			else if (kind === 'evm') this.runEvm(evmAccept, this._evmWallets[idx]?.provider);
		};
		this.bodyEl.querySelectorAll('[data-wallet-kind]').forEach((b) => b.addEventListener('click', onClick));

		// Token chooser — switch the active Solana token in place: update the
		// headline price and the Phantom button's token label without a re-render
		// flash, and mark the new pill pressed.
		this.bodyEl.querySelectorAll('[data-token-asset]').forEach((pill) => {
			pill.addEventListener('click', () => {
				const next = solanaList.find((a) => a.asset === pill.dataset.tokenAsset);
				if (!next || next === this.solanaAccept) return;
				this.solanaAccept = next;
				this.accept = next;
				this.setPrice(next);
				const info = tokenInfo(next);
				const metaEl = this.bodyEl.querySelector('[data-sol-meta]');
				if (metaEl) metaEl.textContent = `${networkLabel(next.network, next)} · ${info.symbol}`;
				this.bodyEl.querySelectorAll('[data-token-asset]').forEach((p) => {
					const on = p === pill;
					p.classList.toggle('x402-on', on);
					p.setAttribute('aria-pressed', String(on));
					p.style.borderColor = on && info.accent ? info.accent : '';
				});
			});
		});
	}

	renderSiwxChoice({ siwxSolana, siwxEvm }) {
		const priceInfo = tokenInfo(this.accept);
		const priceText = formatAmount(this.accept.amount, priceInfo.decimals);
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
			<button class="x402-pay-secondary" data-action="pay">Pay ${priceText} ${escapeHtml(priceInfo.symbol)} instead</button>
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
			<div class="x402-error-box">
				<div class="x402-error-title">${escapeHtml(STEP_LABELS[stepId] || 'Something went wrong')}</div>
				<div class="x402-error-detail">${escapeHtml(message)}</div>
			</div>
			<button class="x402-pay-btn" data-retry>Try again</button>
		`;
		const retry = this.bodyEl.querySelector('[data-retry]');
		retry.addEventListener('click', () => this.start());
		requestAnimationFrame(() => retry.focus());
	}

	renderDone({ result, payment, siwx }) {
		const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
		let receiptHtml;
		if (siwx) {
			const addrShort = siwx.address ? `${siwx.address.slice(0, 8)}…${siwx.address.slice(-6)}` : '—';
			receiptHtml = `
				<div class="x402-receipt">
					<div class="x402-receipt-check">${ICONS.check}</div>
					<div class="x402-receipt-title">Welcome back</div>
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
					<div class="x402-receipt-check">${ICONS.check}</div>
					<div class="x402-receipt-title">Payment confirmed</div>
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
		// A string result is human-readable content (a summary, an answer) — show it
		// as prose, not in a monospace JSON box. Objects stay as formatted JSON.
		const isProse = typeof result === 'string';
		this.bodyEl.innerHTML = `
			${receiptHtml}
			<div class="x402-result${isProse ? ' x402-prose' : ''}">${escapeHtml(resultStr).slice(0, 4000)}</div>
			<button class="x402-pay-btn" data-done>Done</button>
		`;
		const doneBtn = this.bodyEl.querySelector('[data-done]');
		doneBtn.addEventListener('click', () => this.close('done'));
		requestAnimationFrame(() => doneBtn.focus());
	}

	async start() {
		this.bodyEl.innerHTML = this.renderSteps('discover');
		// Shimmer skeletons for the price/network while we fetch the challenge.
		this.priceEl.innerHTML = '<span class="x402-skeleton" style="display:inline-block;width:92px;height:26px;vertical-align:middle"></span>';
		this.networkEl.innerHTML = '<span class="x402-skeleton" style="display:inline-block;width:58px;height:11px;border-radius:99px"></span>';
		// Pre-warm the Solana web3 import now (while the user reads the modal and we
		// fetch the challenge) so a slow CDN doesn't stall at sign time. Best-effort.
		loadSolanaWeb3().catch(() => {});
		try {
			const challenge = await discoverChallenge(this.opts);
			this.challenge = challenge;
			this.siwx = extractSiwxExtension(challenge);
			this.payFlowOverride = false;
			this.siwxFallbackNotice = null;
			// Prefer Solana when Phantom is present, else first EIP-3009 EVM
			// entry (skipping Permit2 siblings the modal can't sign for), else
			// first accept.
			const solanaList = listSolanaAccepts(challenge);
			const solana = pickDefaultSolana(solanaList);
			this.solanaAccept = solana; // buyer-selected Solana token (USDC/THREE/…)
			const evm = challenge.accepts.find(isEip3009Accept);
			const phantomDetected = typeof window !== 'undefined' && (window.solana?.isPhantom || window.phantom?.solana);
			this.accept = (phantomDetected && solana) || evm || challenge.accepts[0];
			this.setPrice(this.accept);
			this.renderConnect();
		} catch (err) {
			this.renderError('discover', err.message || String(err));
		}
	}

	async runSolana(accept, providerArg) {
		this.accept = accept;
		this.setPrice(accept);
		const provider = providerArg || window.phantom?.solana || window.solana;
		const walletName = provider?.isPhantom ? 'Phantom' : (this._solWallets?.find((w) => w.provider === provider)?.name || 'wallet');
		this.renderProgress('connect', { text: `Opening ${walletName}…` });
		try {
			if (!provider) throw new Error('No Solana wallet detected');
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

			const prep = await postJson(`${checkoutBase()}?action=prepare`, {
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
			const enc = await postJson(`${checkoutBase()}?action=encode`, {
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

	async runEvm(accept, providerArg) {
		this.accept = accept;
		this.setPrice(accept);
		this.renderProgress('connect', { text: 'Opening browser wallet…' });
		try {
			const eth = providerArg || window.ethereum;
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
			this.renderError(this.payerAddress ? 'authorize' : 'connect', friendlyError(err));
		}
	}

	async executePaid(xPayment, attempt = 0) {
		this.renderProgress('verify', {
			text: attempt ? 'Retrying after upstream throttle…' : 'Calling merchant endpoint…',
		});
		// One idempotency key for this payment's whole lifetime (all retries and any
		// "Try again") so a re-sent X-PAYMENT settles at most once — no double charge.
		if (!this.idempotencyKey) this.idempotencyKey = `x402-${randomHex(16)}`;
		try {
			const res = await fetch(this.opts.endpoint, {
				method: this.opts.method || 'GET',
				headers: {
					...(this.opts.headers || {}),
					...(this.opts.body && !this.opts.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}),
					'X-PAYMENT': xPayment,
					'Idempotency-Key': this.idempotencyKey,
					'X-Idempotency-Key': this.idempotencyKey,
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
	// The Solana and EVM-sign-in paths dynamic-import a library from esm.sh. A strict
	// host Content-Security-Policy (or esm.sh being unreachable) blocks that import and
	// the raw "Failed to fetch dynamically imported module" is opaque. The Base/EIP-3009
	// payment path has no such dependency, so steer the buyer there.
	if (/dynamically imported module|esm\.sh|module script failed/i.test(msg)) {
		return 'A component this wallet path needs (loaded from esm.sh) was blocked — often by a strict host security policy. Pay with MetaMask on Base instead; it needs no third-party code.';
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
function randomHex(bytes) {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Try the configured primary URL, then each independent CDN fallback, racing
// every attempt against a timeout so a hung CDN doesn't stall the payment — it
// just moves on to the next. Returns the first module that imports; throws only
// if every candidate fails.
async function importWithFallback(primary, fallbacks, label) {
	const seen = new Set();
	const candidates = [primary, ...fallbacks].filter((u) => u && !seen.has(u) && seen.add(u));
	let lastErr;
	for (const url of candidates) {
		try {
			return await Promise.race([
				import(/* @vite-ignore */ url),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error(`timed out loading ${label} from ${url}`)), ESM_IMPORT_TIMEOUT_MS),
				),
			]);
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr || new Error(`could not load ${label} from any CDN`);
}

let _solanaWeb3 = null;
async function loadSolanaWeb3() {
	if (_solanaWeb3) return _solanaWeb3;
	// Loaded on demand (only when a Solana payment is attempted) and cached. The
	// fallback chain means one CDN being down doesn't break Solana checkout.
	_solanaWeb3 = await importWithFallback(CONFIG.esm.solanaWeb3, ESM_FALLBACKS.solanaWeb3, '@solana/web3.js');
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
	const res = await fetch(opts.endpoint, init);

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

// Read host config from `data-*` attributes on the <script> tag that loaded
// this module, so script-tag users can configure without an inline module:
//
//   <script type="module" src=".../x402.js"
//           data-x402-checkout-origin="https://pay.acme.com"
//           data-x402-brand-name="Acme" data-x402-brand-url="https://acme.com"
//           data-x402-footer-note="Acme Pay"
//           data-x402-builder-wallet="acme" data-x402-builder-service="acme_checkout"></script>
function readScriptConfig() {
	try {
		const script =
			document.currentScript ||
			document.querySelector('script[src*="x402"][type="module"]') ||
			document.querySelector('script[data-x402-checkout-origin]');
		const ds = script?.dataset;
		if (!ds) return;
		const next = {};
		if (ds.x402CheckoutOrigin) next.checkoutOrigin = ds.x402CheckoutOrigin;
		if (ds.x402CheckoutPath) next.checkoutPath = ds.x402CheckoutPath;
		if (ds.x402FooterNote) next.footerNote = ds.x402FooterNote;
		if (ds.x402BrandName || ds.x402BrandUrl) {
			next.brand = {};
			if (ds.x402BrandName) next.brand.name = ds.x402BrandName;
			if (ds.x402BrandUrl) next.brand.url = ds.x402BrandUrl;
		}
		if (ds.x402BuilderWallet || ds.x402BuilderService) {
			next.builderCode = {};
			if (ds.x402BuilderWallet) next.builderCode.wallet = ds.x402BuilderWallet;
			if (ds.x402BuilderService) next.builderCode.service = ds.x402BuilderService;
		}
		if (Object.keys(next).length) configure(next);
	} catch (_) {
		// A missing/odd script tag is non-fatal — defaults still work.
	}
}

// Auto-init on DOMContentLoaded, plus on demand.
if (typeof document !== 'undefined') {
	readScriptConfig();
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
	window.X402 = Object.freeze({
		pay, init, configure, version: VERSION,
		// Well-known Solana settlement assets, so merchants building a 402
		// challenge inline can reference them without hardcoding base58 mints.
		tokens: Object.freeze({ USDC_MINT_SOLANA, THREE_MINT, KNOWN_SOLANA_TOKENS }),
	});
}
