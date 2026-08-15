// @three-ws/names — ENS + SNS resolution, *.threews.sol subdomain minting, and
// pay-by-name. A thin client over the public /api/sns, /api/sns-subdomain,
// /api/threews/subdomain, /api/x402/pay-by-name, and /api/agents/ens endpoints.
// See README.md for the full reference.

import { createHttp, ThreeWsError } from './http.js';

export { ThreeWsError, PaymentRequiredError, DEFAULT_BASE_URL } from './http.js';

// Matches the platform's name validators. `.eth` routes to the ENS resolver,
// everything else (a `.sol` domain or a bare label) routes to the .sol registry.
const ETH_RE = /^(?:[a-z0-9-]+\.)+eth$/i;
const SOL_NAME_RE = /^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*(?:\.sol)?$/i;
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PAY_MODES = ['prep', 'send'];

/**
 * Create a Names client bound to a base URL, fetch, and optional auth.
 * For most callers the default exports (`resolve()`, `payByName()`, …) are
 * enough; use this to reuse configuration — a payment-aware fetch, a custom
 * origin, or a bearer token — across many calls.
 */
export function createNames(options = {}) {
	const request = createHttp(options);
	const defaultToken = options.apiKey || options.token || null;

	// A per-call bearer token overrides the client default. Both land in the
	// Authorization header the http core already understands.
	function authHeaders(token, extra) {
		const h = { ...(extra || {}) };
		const bearer = token || defaultToken;
		if (bearer) h.authorization = `Bearer ${bearer}`;
		return h;
	}

	/** Resolve a name to an address. `.eth` → ENS, `.sol`/bare label → SNS. */
	async function resolve(name, opts = {}) {
		const trimmed = String(name || '').trim();
		if (!trimmed) {
			throw new ThreeWsError('resolve() needs a non-empty name.', { code: 'invalid_input' });
		}
		if (ETH_RE.test(trimmed)) {
			const res = await request(`/api/agents/ens/${encodeURIComponent(trimmed.toLowerCase())}`, {
				signal: opts.signal,
			});
			return shapeEns(res);
		}
		if (!SOL_NAME_RE.test(trimmed)) {
			throw new ThreeWsError(
				`Invalid name "${trimmed}". Expected a .eth name, a .sol domain, or a bare [a-z0-9-] label.`,
				{ code: 'invalid_input' },
			);
		}
		const res = await request('/api/sns', {
			query: prune({ name: trimmed, domains: domainsFlag(opts) }),
			signal: opts.signal,
		});
		return shapeSns(res);
	}

	/** Find the primary `.sol` for a wallet. Wraps GET /api/sns?address=. */
	async function reverseLookup(address, opts = {}) {
		const addr = String(address || '').trim();
		if (!ADDR_RE.test(addr)) {
			throw new ThreeWsError('reverseLookup() needs a base58 Solana address.', { code: 'invalid_input' });
		}
		const res = await request('/api/sns', {
			query: prune({ address: addr, domains: domainsFlag(opts) }),
			signal: opts.signal,
		});
		return shapeSns(res);
	}

	/** Check whether `<label>.threews.sol` is free. Wraps GET /api/sns-subdomain?label=. */
	async function checkSubdomain(label, opts = {}) {
		const clean = String(label || '').trim();
		if (!clean) {
			throw new ThreeWsError('checkSubdomain() needs a label.', { code: 'invalid_input' });
		}
		const res = await request('/api/sns-subdomain', { query: { label: clean }, signal: opts.signal });
		return shapeAvailability(res);
	}

	/** Mint `<label>.threews.sol` for an agent. Wraps POST /api/sns-subdomain. Requires auth. */
	async function mintSubdomain(input = {}) {
		const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
		if (!agentId) {
			throw new ThreeWsError('mintSubdomain() needs an `agentId`.', { code: 'invalid_input' });
		}
		if (input.ownerAddress != null && !ADDR_RE.test(String(input.ownerAddress).trim())) {
			throw new ThreeWsError('ownerAddress must be a base58 Solana public key.', { code: 'invalid_input' });
		}
		if (input.space != null && !(Number.isInteger(input.space) && input.space >= 1000 && input.space <= 10000)) {
			throw new ThreeWsError('space must be an integer between 1000 and 10000.', { code: 'invalid_input' });
		}
		const body = prune({
			agent_id: agentId,
			label: input.label,
			owner_address: input.ownerAddress,
			space: input.space,
		});
		const res = await request('/api/sns-subdomain', {
			method: 'POST',
			body,
			headers: authHeaders(input.token, input.headers),
			signal: input.signal,
		});
		return shapeMint(res);
	}

	/** Claim `<username>.threews.sol` for the signed-in user. Wraps POST /api/threews/subdomain. */
	async function claimSubdomain(input = {}) {
		const label = typeof input.label === 'string' ? input.label.trim() : '';
		if (!label) {
			throw new ThreeWsError('claimSubdomain() needs a `label` (your username).', { code: 'invalid_input' });
		}
		if (input.ownerWallet != null && !ADDR_RE.test(String(input.ownerWallet).trim())) {
			throw new ThreeWsError('ownerWallet must be a base58 Solana public key.', { code: 'invalid_input' });
		}
		const body = prune({ label, owner_wallet: input.ownerWallet });
		const res = await request('/api/threews/subdomain', {
			method: 'POST',
			body,
			headers: authHeaders(input.token, input.headers),
			signal: input.signal,
		});
		return shapeClaim(res);
	}

	/** Drop the local `<label>.threews.sol` claim. Wraps DELETE /api/threews/subdomain. */
	async function releaseSubdomain(label, opts = {}) {
		const clean = String(label || '').trim();
		if (!clean) {
			throw new ThreeWsError('releaseSubdomain() needs a label.', { code: 'invalid_input' });
		}
		const res = await request('/api/threews/subdomain', {
			method: 'DELETE',
			query: { label: clean },
			headers: authHeaders(opts.token, opts.headers),
			signal: opts.signal,
		});
		return unwrap(res);
	}

	/** Resolve a payee by name (no payment). Wraps GET /api/x402/pay-by-name?name=. */
	async function resolvePayee(name, opts = {}) {
		const clean = String(name || '').trim();
		if (!clean) {
			throw new ThreeWsError('resolvePayee() needs a name.', { code: 'invalid_input' });
		}
		const res = await request('/api/x402/pay-by-name', { query: { name: clean }, signal: opts.signal });
		return shapePayee(unwrap(res));
	}

	/** Pay a recipient by name in USDC. Wraps POST /api/x402/pay-by-name. */
	async function payByName(name, amountUsdc, opts = {}) {
		const clean = String(name || '').trim();
		if (!clean) {
			throw new ThreeWsError('payByName() needs a name.', { code: 'invalid_input' });
		}
		const amount = Number(amountUsdc);
		if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) {
			throw new ThreeWsError('amountUsdc must be a number > 0 and ≤ 10000.', { code: 'invalid_input' });
		}
		const mode = normalizeEnum(opts.mode, PAY_MODES, 'mode') || 'prep';

		if (mode === 'prep') {
			if (!opts.payerWallet || !ADDR_RE.test(String(opts.payerWallet).trim())) {
				throw new ThreeWsError('prep mode needs a base58 `payerWallet`.', { code: 'invalid_input' });
			}
		} else {
			if (!opts.agentId || typeof opts.agentId !== 'string') {
				throw new ThreeWsError('send mode needs an `agentId`.', { code: 'invalid_input' });
			}
		}

		const body = prune({
			name: clean,
			amount_usdc: amountUsdc,
			mode,
			payer_wallet: opts.payerWallet,
			agent_id: opts.agentId,
			expected_address: opts.expectedAddress,
			message: opts.message,
		});
		const res = await request('/api/x402/pay-by-name', {
			method: 'POST',
			body,
			headers: authHeaders(opts.token, opts.headers),
			signal: opts.signal,
		});
		return shapePay(unwrap(res), mode);
	}

	return {
		resolve,
		reverseLookup,
		checkSubdomain,
		mintSubdomain,
		claimSubdomain,
		releaseSubdomain,
		resolvePayee,
		payByName,
	};
}

// A module-level default client for the zero-config path: `import { resolve }`.
let shared = null;
function defaultClient() {
	return (shared ||= createNames());
}

/** Resolve a name to an address. `.eth` → ENS, `.sol`/bare label → SNS. */
export function resolve(name, opts) {
	return defaultClient().resolve(name, opts);
}
/** Find the primary `.sol` for a wallet. */
export function reverseLookup(address, opts) {
	return defaultClient().reverseLookup(address, opts);
}
/** Check whether `<label>.threews.sol` is free. */
export function checkSubdomain(label, opts) {
	return defaultClient().checkSubdomain(label, opts);
}
/** Mint `<label>.threews.sol` for an agent (requires auth). */
export function mintSubdomain(input) {
	return defaultClient().mintSubdomain(input);
}
/** Claim `<username>.threews.sol` for the signed-in user. */
export function claimSubdomain(input) {
	return defaultClient().claimSubdomain(input);
}
/** Drop the local `<label>.threews.sol` claim. */
export function releaseSubdomain(label, opts) {
	return defaultClient().releaseSubdomain(label, opts);
}
/** Resolve a payee by name (no payment). */
export function resolvePayee(name, opts) {
	return defaultClient().resolvePayee(name, opts);
}
/** Pay a recipient by name in USDC. */
export function payByName(name, amountUsdc, opts) {
	return defaultClient().payByName(name, amountUsdc, opts);
}

// ── shapers: snake_case envelopes → camelCase results, with a `.raw` escape hatch ──

// /api/sns answers in a { data: { … } } envelope; some endpoints answer bare.
function unwrap(res) {
	if (res && typeof res === 'object' && 'data' in res && res.data && typeof res.data === 'object') {
		return res.data;
	}
	return res;
}

// `allDomains` / `favoriteDomain` are only populated when the call asked for
// them with `{ domains: true }`; the endpoint omits both otherwise rather than
// paying for the SNS index lookup on every resolve.
function shapeSns(res) {
	const d = unwrap(res) || {};
	return {
		name: d.name ?? null,
		address: d.address ?? null,
		network: d.network || 'solana',
		resolved: Boolean(d.resolved),
		allDomains: Array.isArray(d.all_domains) ? d.all_domains : [],
		favoriteDomain: d.favorite_domain ?? null,
		domainsTruncated: Boolean(d.domains_truncated),
		raw: res,
	};
}

// The endpoint takes `domains=1`; anything falsy is left off the query entirely
// so the default resolve stays a single cache-friendly URL.
function domainsFlag(opts) {
	return opts && opts.domains ? '1' : undefined;
}

function shapeEns(res) {
	const d = res || {};
	const address = d.address ?? null;
	return {
		name: d.name ?? null,
		address,
		network: 'ethereum',
		resolved: Boolean(address),
		allDomains: [],
		favoriteDomain: null,
		domainsTruncated: false,
		agents: Array.isArray(d.agents) ? d.agents : [],
		raw: res,
	};
}

function shapeAvailability(res) {
	const d = unwrap(res) || {};
	return {
		label: d.label ?? null,
		parent: d.parent ?? null,
		fullName: d.full_name ?? d.full ?? null,
		available: Boolean(d.available),
		owner: d.owner ?? null,
		raw: res,
	};
}

function shapeMint(res) {
	const d = unwrap(res) || {};
	return {
		ok: Boolean(d.ok),
		agentId: d.agent_id ?? null,
		fullName: d.full_name ?? null,
		parent: d.parent ?? null,
		owner: d.owner ?? null,
		signature: d.signature ?? null,
		explorer: d.explorer ?? null,
		urlRecord: d.url_record ?? null,
		agentUrl: d.agent_url ?? null,
		raw: res,
	};
}

function shapeClaim(res) {
	const d = unwrap(res) || {};
	return {
		id: d.id ?? null,
		label: d.label ?? null,
		parent: d.parent ?? null,
		ownerWallet: d.owner_wallet ?? null,
		urlRecord: d.url_record ?? null,
		signature: d.signature ?? null,
		fullName: d.full ?? null,
		showcaseUrl: d.showcase_url ?? null,
		explorer: d.explorer ?? null,
		createdAt: d.created_at ?? null,
		raw: res,
	};
}

function shapePayee(d) {
	const v = d || {};
	return {
		name: v.resolved ?? null,
		address: v.address ?? null,
		source: v.source ?? null,
		resolved: v.resolved ?? null,
		claim: v.claim ?? null,
		raw: d,
	};
}

function shapePay(d, mode) {
	const v = d || {};
	if (mode === 'send') {
		return {
			mode: 'send',
			recipient: shapePayee(v.recipient),
			payer: v.payer ?? null,
			amountUsdc: v.amount_usdc ?? null,
			signature: v.signature ?? null,
			raw: d,
		};
	}
	return {
		mode: 'prep',
		recipient: shapePayee(v.recipient),
		amountUsdc: v.amount_usdc ?? null,
		txBase64: v.tx_base64 ?? null,
		blockhash: v.blockhash ?? null,
		lastValidBlockHeight: v.last_valid_block_height ?? null,
		mint: v.mint ?? null,
		raw: d,
	};
}

function normalizeEnum(value, allowed, label) {
	if (value === undefined || value === null) return undefined;
	if (!allowed.includes(value)) {
		throw new ThreeWsError(`Invalid ${label} "${value}". Expected one of: ${allowed.join(', ')}.`, { code: 'invalid_input' });
	}
	return value;
}

function prune(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}
