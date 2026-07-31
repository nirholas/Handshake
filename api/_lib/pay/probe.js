// x402 challenge probing, shared by the payment executor and the dry-run simulator.
//
// Both need the identical network behaviour: an SSRF-guarded request that never
// follows a redirect, pins the resolved address against DNS rebinding, and reads
// the 402 challenge from either the JSON body or the `payment-required` header.
// They differ only in what they do with the answer. The executor selects one
// Solana USDC accept and signs it; the simulator reports every rail and signs
// nothing. Keeping the transport in one place means a hardening fix to one path
// cannot leave the other exposed.

import { validatePublicUrl, resolvePublicHost, pinnedAgent, SsrfError } from '../ssrf.js';

/** Canonical USDC mint on Solana mainnet. */
export const USDC_SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const DEFAULT_TIMEOUT_MS = 20_000;

export function safeJson(text) {
	try { return JSON.parse(text); } catch { return null; }
}

export function b64decodeJson(s) {
	if (!s) return null;
	try { return JSON.parse(Buffer.from(String(s), 'base64').toString('utf8')); } catch { return null; }
}

/**
 * Fetch a third-party URL with the full SSRF guard chain.
 *
 * `redirect: 'manual'` matters as much as the address pin: a 302 to
 * 169.254.169.254 would otherwise bypass the check that just passed.
 */
export async function guardedFetch(rawUrl, {
	method = 'GET',
	headers = {},
	body,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	userAgent = 'three.ws-payment-session/1.0 (+https://three.ws/)',
} = {}) {
	const url = validatePublicUrl(rawUrl);
	const addrs = await resolvePublicHost(url.hostname);
	const agent = pinnedAgent(url.hostname, addrs);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method,
			redirect: 'manual',
			signal: controller.signal,
			dispatcher: agent,
			headers: {
				'user-agent': userAgent,
				accept: 'application/json, text/plain;q=0.8, */*;q=0.5',
				...(body != null ? { 'content-type': 'application/json' } : {}),
				...headers,
			},
			...(body != null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
		});
		const text = await res.text();
		return { status: res.status, ok: res.ok, headers: res.headers, text };
	} finally {
		clearTimeout(timer);
		await agent.close().catch(() => {});
	}
}

/** Read the challenge out of a 402 response, wherever the service put it. */
export function readChallenge(res) {
	return safeJson(res.text) || b64decodeJson(res.headers.get('payment-required'));
}

/**
 * Summarize one `accepts` entry into the shape both the simulator UI and the
 * MCP tool render. `amount` is a decimal string of atomic units in the x402
 * spec, so it is parsed as BigInt and never as a float.
 */
export function describeRail(accept) {
	let atomics = null;
	try { atomics = BigInt(accept?.amount); } catch { atomics = null; }
	return {
		network: typeof accept?.network === 'string' ? accept.network : null,
		asset: accept?.asset ?? null,
		pay_to: accept?.payTo ?? null,
		amount_atomics: atomics === null ? null : atomics.toString(),
		// Every asset we transact in uses 6 decimals; a rail that does not is
		// reported with a null price rather than a wrong one.
		amount_usd: atomics === null ? null : Number(atomics) / 1_000_000,
		usdc: accept?.asset === USDC_SOLANA_MINT || /usdc/i.test(String(accept?.extra?.name ?? '')),
	};
}

/**
 * Probe an endpoint and report what it charges, without paying anything.
 *
 * Never throws for an ordinary remote failure: an unreachable host, a blocked
 * URL, or an unreadable challenge are all legitimate outcomes of a dry run and
 * each is returned as a typed result so the caller can show the row instead of
 * failing the whole batch.
 *
 * @returns {Promise<{kind: 'priced'|'free'|'error', ...}>}
 */
export async function probePrice(rawUrl, { method = 'GET', body = null, timeoutMs } = {}) {
	let res;
	try {
		res = await guardedFetch(rawUrl, { method, body, timeoutMs });
	} catch (err) {
		if (err instanceof SsrfError) {
			return {
				kind: 'error',
				code: 'blocked_url',
				message: 'Target URL is not a reachable public endpoint',
			};
		}
		return {
			kind: 'error',
			code: 'endpoint_unreachable',
			message: `Could not reach endpoint: ${err?.message ?? 'network error'}`,
		};
	}

	if (res.status !== 402) {
		return { kind: 'free', status: res.status };
	}

	const challenge = readChallenge(res);
	if (!challenge || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
		return {
			kind: 'error',
			code: 'invalid_challenge',
			message: 'Service returned an unreadable payment challenge',
		};
	}

	const rails = challenge.accepts.map(describeRail);
	return { kind: 'priced', status: 402, rails, description: challenge.description ?? null };
}

/**
 * Pick the rail a payment session would actually settle on.
 *
 * Sessions settle Solana-first (the platform's home chain), so a Solana USDC
 * accept always wins. `base` sessions select the EVM rail. When the requested
 * network is absent the caller is told which networks the service does offer,
 * because "no Solana option" is a useful dry-run finding, not an error to hide.
 */
export function selectRail(rails, network = 'solana') {
	const want = String(network || 'solana').toLowerCase();
	const onNetwork = rails.filter((r) => typeof r.network === 'string' && r.network.toLowerCase().startsWith(want));
	if (onNetwork.length === 0) return null;
	return onNetwork.find((r) => r.usdc) ?? onNetwork[0];
}
