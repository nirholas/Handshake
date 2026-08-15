// @three-ws/vanity — mine Solana vanity addresses (custom prefix/suffix) LOCALLY.
//
// The headline path, `grind()`, never touches the network: it generates Ed25519
// keypairs on your machine, Base58-encodes each public key, and loops until the
// address matches your pattern. Keys are produced with the platform crypto
// primitive — Node's `crypto.generateKeyPairSync('ed25519')`, the browser's
// `crypto.subtle.generateKey('Ed25519')` — and never leave the process. There is
// no telemetry and no API call on this path; that is the entire security posture.
//
// A paid lane, `grindViaApi()`, wraps the hosted x402 endpoint (GET
// /api/x402/vanity) for environments that can't grind locally — short patterns
// only, settled in USDC. See README.md for the full reference.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// ---------------------------------------------------------------------------
// Base58 (Bitcoin/Solana alphabet — drops the confusable 0 O I l).
// ---------------------------------------------------------------------------

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_CHARS = new Set(BASE58_ALPHABET);

// Per-character guidance for the four confusable symbols excluded from Base58.
const CONFUSED = {
	'0': '0 (zero) — use 1-9',
	O: 'O (uppercase o) — use other uppercase letters',
	I: 'I (uppercase i) — use other uppercase letters',
	l: 'l (lowercase L) — use other lowercase letters',
};

/** Hard ceiling per pattern — past this, grinding is unrealistic on one machine. */
export const MAX_PATTERN_LENGTH = 6;

/**
 * Encode a byte array as a Base58 string (Solana address form). Pure, no deps:
 * big-integer base conversion via repeated division over the byte array, with a
 * leading-zero pass so 0x00 bytes render as the alphabet's first character.
 * @param {Uint8Array | number[]} bytes
 * @returns {string}
 */
export function base58Encode(bytes) {
	const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
	if (input.length === 0) return '';

	// Count leading zero bytes — each maps to one leading '1'.
	let zeros = 0;
	while (zeros < input.length && input[zeros] === 0) zeros++;

	// Convert the remaining bytes (base 256) into base 58 digits, big-endian.
	// Starts empty so an all-zero input contributes no digits — its value is 0,
	// already accounted for by the leading '1's.
	const digits = [];
	for (let i = zeros; i < input.length; i++) {
		let carry = input[i];
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}

	let out = '1'.repeat(zeros);
	for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
	return out;
}

// ---------------------------------------------------------------------------
// Validation + difficulty (ported from src/solana/vanity/validation.js).
// ---------------------------------------------------------------------------

/**
 * Validate a single vanity pattern (a prefix or a suffix) against the Base58
 * alphabet and the length ceiling. Returns specific, user-facing error strings.
 * @param {string} pattern
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePattern(pattern) {
	const errors = [];
	if (typeof pattern !== 'string' || pattern.length === 0) {
		return { valid: false, errors: ['pattern is empty'] };
	}
	if (pattern !== pattern.trim()) {
		errors.push('pattern has leading or trailing whitespace');
	}
	if (pattern.length > MAX_PATTERN_LENGTH) {
		errors.push(`length ${pattern.length} exceeds maximum of ${MAX_PATTERN_LENGTH}`);
	}
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (!BASE58_CHARS.has(c)) {
			const hint = CONFUSED[c];
			errors.push(`invalid character '${c}' at position ${i + 1}${hint ? ` — ${hint}` : ''}`);
		}
	}
	return { valid: errors.length === 0, errors };
}

// How many of the 58 Base58 characters satisfy a single requested character.
// Case-sensitive: exactly one. Case-insensitive: two when the other case is also
// a valid Base58 symbol (the alphabet drops 0 O I l, so o/i/L have only one case).
function matchesPerChar(ch, ignoreCase) {
	if (!ignoreCase) return 1;
	const lower = ch.toLowerCase();
	const upper = ch.toUpperCase();
	if (lower !== upper && BASE58_CHARS.has(lower) && BASE58_CHARS.has(upper)) return 2;
	return 1;
}

/**
 * Expected attempts to grind an address starting with `prefix` and ending with
 * `suffix` — the mean of the geometric distribution, `58^n` adjusted for
 * case-insensitivity per character.
 * @param {{ prefix?: string, suffix?: string, ignoreCase?: boolean }} [pattern]
 * @returns {number}
 */
export function expectedAttempts({ prefix = '', suffix = '', ignoreCase = false } = {}) {
	let attempts = 1;
	for (const ch of String(prefix || '') + String(suffix || '')) {
		attempts *= 58 / matchesPerChar(ch, ignoreCase);
	}
	return attempts;
}

/** Format remaining-time seconds as a human string for the onProgress ETA. */
function formatTimeEstimate(remainingAttempts, ratePerSecond) {
	if (!ratePerSecond || ratePerSecond <= 0) return 'unknown';
	const seconds = remainingAttempts / ratePerSecond;
	if (seconds < 1) return 'less than a second';
	if (seconds < 60) return `~${Math.round(seconds)} seconds`;
	if (seconds < 3600) return `~${Math.round(seconds / 60)} minutes`;
	if (seconds < 86400) return `~${Math.round(seconds / 3600)} hours`;
	if (seconds < 31536000) return `~${Math.round(seconds / 86400)} days`;
	return `~${Math.round(seconds / 31536000)} years`;
}

// ---------------------------------------------------------------------------
// Keypair generation — platform crypto, zero dependencies, keys stay local.
// ---------------------------------------------------------------------------

// A keypair generator returns { publicKey: string (Base58), secretKey: Uint8Array(64) }.
// The 64-byte secret is Solana's standard layout: [32-byte seed][32-byte pubkey],
// directly compatible with `Keypair.fromSecretKey()`.

let cachedGenerator = null;

// Resolve the keygen backend once. Node path uses `generateKeyPairSync`; the
// browser path uses WebCrypto's async Ed25519. We probe lazily so the module
// imports cleanly in either environment.
async function resolveGenerator() {
	if (cachedGenerator) return cachedGenerator;

	// Node: synchronous, fastest. JWK export hands us the raw 32-byte seed (`d`)
	// and raw 32-byte public key (`x`) with no extra parsing or dependencies.
	const nodeCrypto = await tryImportNodeCrypto();
	if (nodeCrypto && typeof nodeCrypto.generateKeyPairSync === 'function') {
		cachedGenerator = () => {
			const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
			const pub = base64UrlToBytes(publicKey.export({ format: 'jwk' }).x);
			const seed = base64UrlToBytes(privateKey.export({ format: 'jwk' }).d);
			return { publicKey: base58Encode(pub), secretKey: joinKeypair(seed, pub) };
		};
		return cachedGenerator;
	}

	// Browser / Deno / workers: WebCrypto. Ed25519 support is required.
	const subtle = globalThis.crypto?.subtle;
	if (subtle && typeof subtle.generateKey === 'function') {
		const probe = await subtle
			.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
			.catch(() => null);
		if (probe) {
			cachedGenerator = async () => {
				const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
				const pubJwk = await subtle.exportKey('jwk', pair.publicKey);
				const privJwk = await subtle.exportKey('jwk', pair.privateKey);
				const pub = base64UrlToBytes(pubJwk.x);
				const seed = base64UrlToBytes(privJwk.d);
				return { publicKey: base58Encode(pub), secretKey: joinKeypair(seed, pub) };
			};
			return cachedGenerator;
		}
	}

	throw new ThreeWsError(
		'No Ed25519 keypair generator available in this environment. Run in Node 18+ ' +
			'(crypto.generateKeyPairSync) or a browser/runtime with WebCrypto Ed25519 ' +
			'(crypto.subtle.generateKey).',
		{ code: 'no_ed25519' },
	);
}

async function tryImportNodeCrypto() {
	// Only Node exposes process.versions.node; skip the dynamic import in browsers
	// so bundlers don't try to resolve 'node:crypto'.
	if (typeof process === 'undefined' || !process.versions?.node) return null;
	try {
		return await import('node:crypto');
	} catch {
		return null;
	}
}

// Decode a Base64url string (JWK `x`/`d`) to a 32-byte Uint8Array without deps.
function base64UrlToBytes(b64url) {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
	const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// Solana's 64-byte secret key layout: [32-byte seed || 32-byte public key].
function joinKeypair(seed, pub) {
	const out = new Uint8Array(64);
	out.set(seed.subarray(0, 32), 0);
	out.set(pub.subarray(0, 32), 32);
	return out;
}

// ---------------------------------------------------------------------------
// grind() — the local hot loop.
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL_MS = 250;
// Keypairs checked between abort/progress yields. Small enough to honour an
// abort promptly, large enough that the per-batch bookkeeping is negligible.
const YIELD_EVERY = 2_000;

function abortError() {
	if (typeof DOMException === 'function') return new DOMException('vanity grind aborted', 'AbortError');
	const e = new Error('The operation was aborted.');
	e.name = 'AbortError';
	return e;
}

// Compile a matcher closure for the requested pattern. Case-insensitive folds
// both sides to lower-case before comparing.
function buildMatcher({ prefix, suffix, ignoreCase }) {
	const pre = ignoreCase ? prefix.toLowerCase() : prefix;
	const suf = ignoreCase ? suffix.toLowerCase() : suffix;
	return (address) => {
		const candidate = ignoreCase ? address.toLowerCase() : address;
		if (pre && !candidate.startsWith(pre)) return false;
		if (suf && !candidate.endsWith(suf)) return false;
		return true;
	};
}

/**
 * Grind for a vanity Solana address — entirely on the local machine.
 *
 * Resolves with a keypair whose Base58 public key starts with `prefix` and/or
 * ends with `suffix`. Keys are generated with platform crypto and never leave
 * the process. Rejects with `AbortError` if `signal` aborts, or a typed
 * `ThreeWsError` on invalid input / a runtime without Ed25519.
 *
 * @param {GrindOptions} [opts]
 * @returns {Promise<GrindResult>}
 */
export async function grind(opts = {}) {
	const prefix = typeof opts.prefix === 'string' ? opts.prefix : '';
	const suffix = typeof opts.suffix === 'string' ? opts.suffix : '';
	const ignoreCase = !!(opts.ignoreCase ?? opts.caseInsensitive);
	const { signal, onProgress } = opts;

	if (!prefix && !suffix) {
		throw new ThreeWsError('prefix or suffix is required', { code: 'invalid_input' });
	}
	if (prefix) {
		const v = validatePattern(prefix);
		if (!v.valid) throw new ThreeWsError(`invalid prefix: ${v.errors.join('; ')}`, { code: 'invalid_input' });
	}
	if (suffix) {
		const v = validatePattern(suffix);
		if (!v.valid) throw new ThreeWsError(`invalid suffix: ${v.errors.join('; ')}`, { code: 'invalid_input' });
	}

	if (signal?.aborted) throw abortError();

	const generate = await resolveGenerator();
	const matches = buildMatcher({ prefix, suffix, ignoreCase });
	const expected = expectedAttempts({ prefix, suffix, ignoreCase });
	const startedAt = now();

	let attempts = 0;
	let lastProgressAt = startedAt;

	// Yield control to the event loop between batches so an abort lands promptly
	// and onProgress can fire on a wall-clock cadence rather than per-attempt.
	while (true) {
		if (signal?.aborted) throw abortError();

		for (let i = 0; i < YIELD_EVERY; i++) {
			const { publicKey, secretKey } = await generate();
			attempts++;
			if (matches(publicKey)) {
				const durationMs = now() - startedAt;
				onProgress?.(buildProgress(attempts, durationMs, expected));
				return { publicKey, secretKey, attempts, durationMs, workers: 1 };
			}
		}

		const tickAt = now();
		if (onProgress && tickAt - lastProgressAt >= PROGRESS_INTERVAL_MS) {
			lastProgressAt = tickAt;
			onProgress(buildProgress(attempts, tickAt - startedAt, expected));
		}
		// Hand the loop back so abort/timers run; setTimeout(0) keeps Node and the
		// browser responsive without pinning the event loop.
		await yieldToLoop();
	}
}

function buildProgress(attempts, durationMs, expected) {
	const rate = durationMs > 0 ? (attempts / durationMs) * 1000 : 0;
	// The geometric distribution is memoryless: past attempts don't bring the
	// next hit closer, so the honest expected-remaining is always the full
	// expectation. Counting down (expected - attempts) would read "any second
	// now" for minutes on an unlucky grind.
	return {
		attempts,
		rate,
		eta: formatTimeEstimate(expected, rate),
	};
}

function yieldToLoop() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function now() {
	if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
	return Date.now();
}

// ---------------------------------------------------------------------------
// grindViaApi() — the paid x402 lane (GET /api/x402/vanity).
// ---------------------------------------------------------------------------

const API_FORMATS = ['keypair', 'mnemonic'];
const API_STRENGTHS = [128, 256];
// Server cap on the combined prefix+suffix length for the keypair format
// (mnemonic is capped at 2 by the server; both are enforced server-side too).
const API_MAX_COMBINED = 3;

/**
 * Create a Vanity API client bound to a base URL + fetch (+ optional auth).
 * Only the hosted paid lane is HTTP; local `grind()` needs no client. Pass a
 * payment-aware `fetch` (e.g. @three-ws/x402-fetch) to auto-settle the 402.
 * @param {VanityClientOptions} [options]
 * @returns {VanityClient}
 */
export function createVanity(options = {}) {
	const request = createHttp(options);

	async function grindViaApi(params = {}) {
		const prefix = typeof params.prefix === 'string' ? params.prefix.trim() : '';
		const suffix = typeof params.suffix === 'string' ? params.suffix.trim() : '';
		const ignoreCase = !!(params.ignoreCase ?? params.caseInsensitive);
		const format = params.format ?? 'keypair';

		if (!prefix && !suffix) {
			throw new ThreeWsError('prefix or suffix is required', { code: 'invalid_input' });
		}
		if (!API_FORMATS.includes(format)) {
			throw new ThreeWsError(`Invalid format "${format}". Expected one of: ${API_FORMATS.join(', ')}.`, { code: 'invalid_input' });
		}
		for (const [label, pattern] of [['prefix', prefix], ['suffix', suffix]]) {
			if (!pattern) continue;
			const v = validatePattern(pattern);
			if (!v.valid) throw new ThreeWsError(`invalid ${label}: ${v.errors.join('; ')}`, { code: 'invalid_input' });
		}
		if (params.strength != null && !API_STRENGTHS.includes(Number(params.strength))) {
			throw new ThreeWsError(`Invalid strength "${params.strength}". Expected 128 or 256.`, { code: 'invalid_input' });
		}
		const combined = prefix.length + suffix.length;
		if (combined > API_MAX_COMBINED) {
			throw new ThreeWsError(
				`combined pattern length ${combined} exceeds the hosted limit of ${API_MAX_COMBINED} — grind longer patterns locally with grind().`,
				{ code: 'invalid_input' },
			);
		}

		const query = {
			prefix: prefix || undefined,
			suffix: suffix || undefined,
			ignoreCase: ignoreCase ? '1' : undefined,
			format: format === 'keypair' ? undefined : format,
			strength: params.strength != null ? String(params.strength) : undefined,
			sealTo: params.sealTo || undefined,
		};

		const res = await request('/api/x402/vanity', {
			query,
			headers: params.headers,
			signal: params.signal,
		});
		return shapeApiResult(res);
	}

	return { grindViaApi };
}

// Lazily-created shared client for the zero-config default `grindViaApi()`.
let sharedClient = null;
function defaultClient() {
	return (sharedClient ||= createVanity());
}

// Client-level knobs the standalone `grindViaApi()` accepts inline, so a caller
// who only needs one call does not have to build a client first. The paid lane
// is unusable without a payment-aware `fetch`, so silently ignoring one passed
// here would send the call out on the bare global fetch and 402.
const CLIENT_OPTION_KEYS = ['fetch', 'baseUrl', 'apiKey'];

/**
 * Grind a short pattern over the hosted paid x402 endpoint instead of locally.
 *
 * Uses the shared zero-config client unless the call carries client options
 * (`fetch`, `baseUrl`, `apiKey`), in which case a client bound to those is
 * built for this call. Pass an x402-wrapped `fetch` to settle the 402.
 *
 * @param {GrindViaApiOptions} params
 * @returns {Promise<ApiResult>}
 */
export function grindViaApi(params = {}) {
	const overrides = {};
	for (const key of CLIENT_OPTION_KEYS) {
		if (params[key] !== undefined) overrides[key] = params[key];
	}
	const client = Object.keys(overrides).length > 0 ? createVanity(overrides) : defaultClient();
	return client.grindViaApi(params);
}

function shapeApiResult(res) {
	if (!res || typeof res !== 'object') {
		throw new ThreeWsError('Unexpected empty response from /api/x402/vanity.', { code: 'bad_response' });
	}
	return {
		address: res.address ?? null,
		prefix: res.prefix ?? null,
		suffix: res.suffix ?? null,
		ignoreCase: !!res.ignoreCase,
		format: res.format ?? null,
		secretKeyBase58: res.secretKeyBase58 ?? null,
		secretKey: Array.isArray(res.secretKey) ? Uint8Array.from(res.secretKey) : null,
		mnemonic: res.mnemonic ?? null,
		wordCount: res.wordCount ?? null,
		derivationPath: res.derivationPath ?? null,
		sealed: !!res.sealed,
		sealedSecret: res.sealedSecret ?? null,
		attempts: res.attempts ?? null,
		durationMs: res.durationMs ?? null,
		expectedAttempts: res.expectedAttempts ?? null,
		network: res.network ?? null,
		explorerUrl: res.explorerUrl ?? null,
		raw: res,
	};
}
