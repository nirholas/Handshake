// POST /api/pay/simulate: dry-run a payment session policy against real prices.
//
// The problem this solves: authorizing an agent budget is a guess. You pick
// $10 and a $0.50 per-transaction cap because those are round numbers, hand the
// token to an agent, and find out which of your assumptions was wrong only when
// the agent is already running and something has already been spent. If the cap
// was too low the agent stalls on its third call. If the allowlist missed a
// host the agent stalls on its first. If the budget was too small it dies
// halfway through the job with money already gone.
//
// So: run the policy first, with no money and no session.
//
// This endpoint takes a proposed policy and the list of endpoints an agent
// intends to call, probes each endpoint for its real x402 price (a live 402
// challenge, not an estimate), and replays the whole sequence through the exact
// predicates the enforcer uses (api/_lib/pay/policy.js). It reports which calls
// would settle, which would be refused and by which rule, where the budget
// runs dry, and the smallest policy that would let every call through.
//
// Nothing is signed. No session is created. No credits are debited. No row is
// written. The only side effect is one unpaid HTTP request per unique endpoint,
// which is exactly what any x402 client does before it decides to pay.

import { cors, error, json, wrap, readJson, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { validatePublicUrl, isPrivateAddress } from '../_lib/ssrf.js';
import { isIP } from 'node:net';
import { probePrice, selectRail } from '../_lib/pay/probe.js';
import {
	SESSION_LIMITS,
	replay,
	usdToAtomics,
	atomicsToUsd,
	canonicalizeAllowlist,
	normalizeHost,
	hostMatches,
} from '../_lib/pay/policy.js';

// A simulation fans out one request per unique endpoint. These bounds keep a
// single call from turning the platform into an amplifier.
const MAX_CALLS = 40;
const MAX_UNIQUE_URLS = 20;
const MAX_REPEAT = 500;
const PROBE_CONCURRENCY = 6;
const PROBE_TIMEOUT_MS = 10_000;

function bad(res, code, message, detail) {
	return error(res, 400, code, message, detail);
}

/**
 * Normalize the `calls` input.
 *
 * Accepts a bare string, `{url}`, or `{url, method, body, times, price_usd}`.
 * `times` models the realistic case the naive version of this tool misses: an
 * agent that polls one endpoint sixty times has a completely different budget
 * profile from one that calls sixty endpoints once.
 */
export function parseCalls(raw) {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw Object.assign(new Error('calls must be a non-empty array of endpoint URLs'), {
			code: 'invalid_calls',
		});
	}
	if (raw.length > MAX_CALLS) {
		throw Object.assign(
			new Error(`calls may contain at most ${MAX_CALLS} entries (received ${raw.length})`),
			{ code: 'too_many_calls' },
		);
	}

	const calls = raw.map((entry, i) => {
		const spec = typeof entry === 'string' ? { url: entry } : (entry ?? {});
		const url = String(spec.url ?? '').trim();
		if (!url) {
			throw Object.assign(new Error(`calls[${i}] has no url`), { code: 'invalid_calls' });
		}
		// `allowHttp: false` is passed explicitly rather than relying on the
		// default, which relaxes to http outside production. This endpoint is
		// unauthenticated and fetches caller-chosen URLs, so it holds the
		// production rule everywhere instead of being laxer on a dev box.
		let parsed;
		try {
			parsed = validatePublicUrl(url, { allowHttp: false });
		} catch {
			throw Object.assign(
				new Error(`calls[${i}] must be a public https URL: ${url}`),
				{ code: 'invalid_url' },
			);
		}
		// A literal private address is refused here, before any DNS work. The
		// probe path re-checks resolved addresses and pins them (api/_lib/ssrf.js),
		// which is what catches a public hostname that resolves inward; this is the
		// cheap first gate for the obvious `https://169.254.169.254/` case.
		const literal = parsed.hostname.replace(/^\[|\]$/g, '');
		const family = isIP(literal);
		if (family && isPrivateAddress(literal, family)) {
			throw Object.assign(
				new Error(`calls[${i}] points at a private address: ${parsed.hostname}`),
				{ code: 'invalid_url' },
			);
		}

		const times = Math.max(1, Math.min(MAX_REPEAT, Math.round(Number(spec.times ?? 1)) || 1));
		// price_usd lets a caller simulate an endpoint that is not live yet, or
		// model a price change, without any network access at all.
		const priceUsd =
			spec.price_usd == null || spec.price_usd === ''
				? null
				: Number(spec.price_usd);
		if (priceUsd !== null && (!Number.isFinite(priceUsd) || priceUsd < 0)) {
			throw Object.assign(new Error(`calls[${i}].price_usd must be a non-negative number`), {
				code: 'invalid_price',
			});
		}

		return {
			url,
			method: String(spec.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
			body: spec.body ?? null,
			times,
			label: spec.label ? String(spec.label).slice(0, 120) : null,
			priceUsd,
		};
	});

	const unique = new Set(calls.filter((c) => c.priceUsd === null).map((c) => `${c.method} ${c.url}`));
	if (unique.size > MAX_UNIQUE_URLS) {
		throw Object.assign(
			new Error(`calls may reference at most ${MAX_UNIQUE_URLS} distinct endpoints to probe`),
			{ code: 'too_many_endpoints' },
		);
	}

	return calls;
}

/** Normalize the proposed policy, clamping to the real session-creation limits. */
export function parsePolicy(raw = {}) {
	const notes = [];
	const { MIN_BUDGET_USD, MAX_BUDGET_USD, MIN_TTL_SECONDS, MAX_TTL_SECONDS, MAX_ALLOWED_HOSTS } =
		SESSION_LIMITS;

	let budgetUsd = Number(raw.budget_usd);
	if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) budgetUsd = 1;
	if (budgetUsd < MIN_BUDGET_USD) {
		notes.push(`budget_usd raised to the $${MIN_BUDGET_USD} minimum a session accepts`);
		budgetUsd = MIN_BUDGET_USD;
	}
	if (budgetUsd > MAX_BUDGET_USD) {
		notes.push(`budget_usd lowered to the $${MAX_BUDGET_USD} maximum a session accepts`);
		budgetUsd = MAX_BUDGET_USD;
	}

	let maxPerTxUsd =
		raw.max_per_tx_usd == null || raw.max_per_tx_usd === '' ? null : Number(raw.max_per_tx_usd);
	if (maxPerTxUsd !== null && (!Number.isFinite(maxPerTxUsd) || maxPerTxUsd <= 0)) {
		maxPerTxUsd = null;
		notes.push('max_per_tx_usd ignored: not a positive number');
	}
	if (maxPerTxUsd !== null && maxPerTxUsd > budgetUsd) {
		notes.push('max_per_tx_usd exceeds the budget, so it can never bind');
	}

	const rawHosts = Array.isArray(raw.allowed_hosts)
		? raw.allowed_hosts
		: String(raw.allowed_hosts ?? '').split(/[\s,]+/);
	let allowedHosts = [...new Set(canonicalizeAllowlist(rawHosts))];
	if (allowedHosts.length > MAX_ALLOWED_HOSTS) {
		notes.push(`allowed_hosts truncated to the ${MAX_ALLOWED_HOSTS}-entry maximum`);
		allowedHosts = allowedHosts.slice(0, MAX_ALLOWED_HOSTS);
	}

	let expirySeconds = Number(raw.expiry_seconds ?? 3600);
	if (!Number.isFinite(expirySeconds)) expirySeconds = 3600;
	expirySeconds = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(expirySeconds)));

	const network = String(raw.network ?? 'solana').toLowerCase() === 'base' ? 'base' : 'solana';

	return {
		budgetUsd,
		maxPerTxUsd,
		allowedHosts,
		expirySeconds,
		network,
		notes,
	};
}

/** Probe the distinct endpoints, at bounded concurrency. */
async function priceEndpoints(calls, network) {
	const keys = [...new Set(calls.filter((c) => c.priceUsd === null).map((c) => `${c.method} ${c.url}`))];
	const byKey = new Map();
	const queue = [...keys];

	async function worker() {
		for (;;) {
			const key = queue.shift();
			if (!key) return;
			const call = calls.find((c) => `${c.method} ${c.url}` === key);
			const probe = await probePrice(call.url, {
				method: call.method,
				body: call.body,
				timeoutMs: PROBE_TIMEOUT_MS,
			});
			byKey.set(key, { probe, rail: probe.kind === 'priced' ? selectRail(probe.rails, network) : null });
		}
	}

	await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, keys.length) }, worker));
	return byKey;
}

/**
 * Expand each call spec into one priced step per repetition.
 *
 * A repeated call is expanded rather than multiplied because the budget check
 * is per payment: 60 calls at $0.02 against a $1 budget is 50 settlements and
 * 10 refusals, not one $1.20 refusal.
 */
export function buildSteps(calls, priced, network) {
	const steps = [];
	const problems = [];

	for (const call of calls) {
		const key = `${call.method} ${call.url}`;
		let amountAtomics = null;
		let pricing;

		if (call.priceUsd !== null) {
			amountAtomics = usdToAtomics(call.priceUsd);
			pricing = { source: 'supplied', amount_usd: call.priceUsd, network: null };
		} else {
			const entry = priced.get(key);
			const probe = entry?.probe;
			if (!probe || probe.kind === 'error') {
				problems.push({
					url: call.url,
					code: probe?.code ?? 'probe_failed',
					message: probe?.message ?? 'Endpoint could not be priced',
				});
				pricing = {
					source: 'unpriced',
					amount_usd: null,
					network: null,
					error: probe?.code ?? 'probe_failed',
					error_message: probe?.message ?? 'Endpoint could not be priced',
				};
			} else if (probe.kind === 'free') {
				// api/pay/execute.js returns the response before touching the session
				// when an endpoint answers without a 402. So a free call is never
				// allowlist-checked, never capped, and never charged. Treating it as a
				// $0 payment here would let the simulator report an allowlist refusal
				// the real enforcer would never raise.
				pricing = { source: 'free', amount_usd: 0, network: null, http_status: probe.status };
			} else if (!entry.rail) {
				const offered = [...new Set(probe.rails.map((r) => r.network).filter(Boolean))];
				problems.push({
					url: call.url,
					code: 'no_rail_for_network',
					message: `Endpoint charges on ${offered.join(', ') || 'an unknown network'} but this session settles on ${network}`,
				});
				pricing = {
					source: 'unpriced',
					amount_usd: null,
					network: null,
					error: 'no_rail_for_network',
					error_message: `No ${network} payment option (offered: ${offered.join(', ') || 'none'})`,
					networks_offered: offered,
				};
			} else if (entry.rail.amount_atomics === null) {
				// describeRail reports a null price rather than guessing zero when a
				// challenge quotes something that is not an integer of atomic units.
				// Coercing that to 0n here would put a "settles for free" row in the
				// timeline for a call the executor refuses outright.
				problems.push({
					url: call.url,
					code: 'unreadable_price',
					message: `Endpoint charges on ${entry.rail.network ?? network} but quoted a price that could not be read`,
				});
				pricing = {
					source: 'unpriced',
					amount_usd: null,
					network: entry.rail.network,
					error: 'unreadable_price',
					error_message: 'Endpoint quoted a price that is not a whole number of atomic units',
				};
			} else {
				amountAtomics = BigInt(entry.rail.amount_atomics);
				pricing = {
					source: 'probed',
					amount_usd: entry.rail.amount_usd,
					network: entry.rail.network,
					pay_to: entry.rail.pay_to,
					asset: entry.rail.asset,
					rails_offered: probe.rails.length,
					description: probe.description,
				};
			}
		}

		for (let i = 0; i < call.times; i++) {
			steps.push({
				url: call.url,
				method: call.method,
				label: call.label,
				repetition: call.times > 1 ? i + 1 : null,
				of: call.times > 1 ? call.times : null,
				pricing,
				// Only priced calls enter the replay. An unpriced call is excluded
				// rather than treated as free, because charging it $0 would quietly
				// inflate how far the budget goes; a free call is excluded because the
				// enforcer never runs governance on it.
				priceable: amountAtomics !== null,
				free: pricing.source === 'free',
				amountAtomics: amountAtomics ?? 0n,
			});
		}
	}

	return { steps, problems };
}

/**
 * Work out the smallest policy that would have let every priceable call settle.
 *
 * This is the part a user cannot compute in their head: it needs the summed
 * cost of the whole sequence, the largest single payment in it, and the exact
 * set of hosts touched.
 */
export function recommend(steps, policy) {
	const priceable = steps.filter((s) => s.priceable);
	const totalAtomics = priceable.reduce((acc, s) => acc + s.amountAtomics, 0n);
	const maxAtomics = priceable.reduce((acc, s) => (s.amountAtomics > acc ? s.amountAtomics : acc), 0n);

	const hosts = [...new Set(priceable.map((s) => normalizeHost(s.url)).filter(Boolean))];
	const covered = (host) =>
		policy.allowedHosts.length === 0 || policy.allowedHosts.some((entry) => hostMatches(host, entry));
	const missingHosts = hosts.filter((h) => !covered(h));

	const { MIN_BUDGET_USD, MAX_BUDGET_USD } = SESSION_LIMITS;
	// Round the recommended budget up to a whole cent: a budget of exactly the
	// summed cost leaves no room for a price that moves between now and the run.
	const exactUsd = atomicsToUsd(totalAtomics);
	const roundedUsd = Math.min(MAX_BUDGET_USD, Math.max(MIN_BUDGET_USD, Math.ceil(exactUsd * 100) / 100));

	return {
		budget_usd: roundedUsd,
		exact_cost_usd: exactUsd,
		max_per_tx_usd: maxAtomics > 0n ? atomicsToUsd(maxAtomics) : null,
		allowed_hosts: hosts,
		missing_hosts: missingHosts,
		network: policy.network,
		expiry_seconds: policy.expirySeconds,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (req.method?.toUpperCase() !== 'POST') {
		return error(res, 405, 'method_not_allowed', 'POST required');
	}

	// Unauthenticated on purpose: evaluating the governance model should not
	// require an account, and the simulation cannot move money. It does make
	// outbound requests, so it is rate limited like any other fan-out endpoint.
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// The second argument is a byte limit, not the response object: passing `res`
	// silently disabled the 1 MB cap, since every `length > [object]` compare is
	// false. Returning without answering on a falsy body would hang the request.
	const body = await readJson(req);
	if (!body || typeof body !== 'object') {
		return bad(res, 'invalid_body', 'a JSON object body is required');
	}

	let calls;
	try {
		calls = parseCalls(body.calls);
	} catch (err) {
		return bad(res, err.code ?? 'invalid_calls', err.message);
	}

	const policy = parsePolicy(body.policy ?? body);
	const t0 = Date.now();

	const priced = await priceEndpoints(calls, policy.network);
	const { steps, problems } = buildSteps(calls, priced, policy.network);

	// Replay only the calls that have a real price. The unpriced ones are
	// reported separately so a probe failure never masquerades as a policy pass.
	const replayInput = steps.filter((s) => s.priceable);
	const expiresAt = new Date(Date.now() + policy.expirySeconds * 1000);
	const { steps: verdicts, spentAtomics, remainingAtomics } = replay(
		replayInput.map((s) => ({ url: s.url, amountAtomics: s.amountAtomics, ref: s })),
		{
			budgetAtomics: usdToAtomics(policy.budgetUsd),
			maxPerTxAtomics: policy.maxPerTxUsd == null ? null : usdToAtomics(policy.maxPerTxUsd),
			allowedHosts: policy.allowedHosts,
			status: 'active',
			expiresAt,
		},
	);

	const verdictByStep = new Map(verdicts.map((v) => [v.call.ref, v]));
	let firstDenialIndex = null;

	const timeline = steps.map((step, index) => {
		const verdict = verdictByStep.get(step);
		const outcome = step.free
			? 'free'
			: !step.priceable
				? 'unpriced'
				: verdict.allowed
					? 'settles'
					: 'refused';
		if (outcome === 'refused' && firstDenialIndex === null) firstDenialIndex = index;
		return {
			index,
			url: step.url,
			host: normalizeHost(step.url),
			method: step.method,
			label: step.label,
			repetition: step.repetition,
			of: step.of,
			outcome,
			amount_usd: step.free ? 0 : step.priceable ? atomicsToUsd(step.amountAtomics) : null,
			pricing: step.pricing,
			rejected_by: verdict?.rejection?.code ?? null,
			reason: verdict?.rejection?.message ?? null,
			detail: verdict?.rejection?.detail ?? null,
			remaining_after_usd: verdict ? atomicsToUsd(verdict.remainingAfterAtomics) : null,
		};
	});

	const settled = timeline.filter((s) => s.outcome === 'settles');
	const refused = timeline.filter((s) => s.outcome === 'refused');
	const free = timeline.filter((s) => s.outcome === 'free');
	const unpriced = timeline.filter((s) => s.outcome === 'unpriced');

	// Group refusals by rule so the caller sees "the allowlist blocked 6 calls",
	// not six near-identical rows they have to read one at a time.
	const byRule = {};
	for (const s of refused) byRule[s.rejected_by] = (byRule[s.rejected_by] ?? 0) + 1;

	const suggestion = recommend(steps, policy);
	const feasible = refused.length === 0 && problems.length === 0;

	return json(res, 200, {
		ok: true,
		simulated: true,
		note: 'Dry run only. Nothing was signed, no session was created, and no credits were spent.',
		policy: {
			budget_usd: policy.budgetUsd,
			max_per_tx_usd: policy.maxPerTxUsd,
			allowed_hosts: policy.allowedHosts,
			expiry_seconds: policy.expirySeconds,
			network: policy.network,
			notes: policy.notes,
		},
		verdict: {
			feasible,
			calls_total: timeline.length,
			calls_settled: settled.length,
			calls_refused: refused.length,
			calls_free: free.length,
			calls_unpriced: unpriced.length,
			refusals_by_rule: byRule,
			first_refusal_index: firstDenialIndex,
			spend_usd: atomicsToUsd(spentAtomics),
			remaining_usd: atomicsToUsd(remainingAtomics),
			budget_used_pct:
				policy.budgetUsd > 0
					? Math.round((atomicsToUsd(spentAtomics) / policy.budgetUsd) * 1000) / 10
					: 0,
		},
		timeline,
		problems,
		recommended_policy: suggestion,
		// Ready to paste: the exact create call that would run this workload.
		create_request: {
			endpoint: 'POST /api/pay/session',
			body: {
				budget_usd: suggestion.budget_usd,
				max_per_tx_usd: suggestion.max_per_tx_usd,
				allowed_hosts: suggestion.allowed_hosts,
				expiry_seconds: suggestion.expiry_seconds,
				network: suggestion.network,
			},
		},
		duration_ms: Date.now() - t0,
	});
});
