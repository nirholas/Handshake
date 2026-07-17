// SSRF guard for fetches that follow a user- or DB-supplied URL.
//
// Two fetch variants:
//   fetchSafePublicUrl        — validates DNS then fetches normally. Tiny TOCTOU
//                               window (DNS could rebind between check and connect),
//                               acceptable for image/GLB rendering where the
//                               response is only displayed, never executed.
//   fetchSafePublicUrlPinned  — validates AND pins the resolved IP via a custom
//                               lookup callback so the TCP connection always goes
//                               to the address we checked. Use for any fetch whose
//                               response is forwarded to another service or executed
//                               (proxy, webhook, script fetch).
//
// Both re-validate every redirect hop before following it.

import { promises as dns } from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';

// Cloud metadata services we never want a server-side fetch to reach.
const METADATA_IPS = new Set([
	'169.254.169.254', // AWS / Azure / GCP / Oracle / Alibaba IMDS
	'fd00:ec2::254',   // AWS IMDSv2 IPv6
	'100.100.100.200', // Alibaba
]);

function isPrivateIPv4(ip) {
	const o = ip.split('.').map(Number);
	if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
	if (o[0] === 10) return true;                                   // 10.0.0.0/8
	if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;      // 172.16.0.0/12
	if (o[0] === 192 && o[1] === 168) return true;                  // 192.168.0.0/16
	if (o[0] === 127) return true;                                  // loopback
	if (o[0] === 169 && o[1] === 254) return true;                  // link-local + metadata
	if (o[0] === 0) return true;                                    // 0.0.0.0/8
	if (o[0] >= 224) return true;                                   // multicast 224/4 + reserved 240/4
	if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;     // CGNAT 100.64/10
	if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true;  // benchmarking 198.18/15
	return false;
}

function isPrivateIPv6(ip) {
	const lower = ip.toLowerCase();
	if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1') return true; // loopback / unspecified
	if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') ||
		lower.startsWith('fea') || lower.startsWith('feb')) return true;               // link-local fe80::/10
	if (lower.startsWith('fc') || lower.startsWith('fd')) return true;                 // unique-local fc00::/7
	if (lower.startsWith('ff')) return true;                                           // multicast ff00::/8
	if (lower.startsWith('::ffff:')) {
		const v4 = lower.slice(7);
		return isPrivateIPv4(v4);
	}
	return false;
}

function isBlockedAddress(ip) {
	if (METADATA_IPS.has(ip.toLowerCase())) return true;
	const fam = net.isIP(ip);
	if (fam === 4) return isPrivateIPv4(ip);
	if (fam === 6) return isPrivateIPv6(ip);
	return true; // unparseable → reject
}

export class SsrfBlockedError extends Error {
	constructor(reason) {
		super(reason);
		this.code = 'ssrf_blocked';
		this.status = 400;
	}
}

// Resolve a hostname, validate all returned addresses, and return the first
// safe address (preferring IPv4 for socket compatibility). Throws SsrfBlockedError
// when any address in the answer is blocked — the entire record set must be clean.
async function resolveAndValidate(host) {
	const literal = net.isIP(host);
	if (literal) {
		if (isBlockedAddress(host)) throw new SsrfBlockedError(`host ${host} is a blocked address`);
		return host;
	}
	let records;
	try {
		records = await dns.lookup(host, { all: true, verbatim: true });
	} catch (err) {
		throw new SsrfBlockedError(`dns lookup failed for ${host}: ${err.code || err.message}`);
	}
	if (!records?.length) throw new SsrfBlockedError(`no addresses for ${host}`);
	for (const r of records) {
		if (isBlockedAddress(r.address)) {
			throw new SsrfBlockedError(`host ${host} resolves to a blocked range`);
		}
	}
	// Prefer IPv4 so the pinned socket address is unambiguous for net.createConnection.
	const ipv4 = records.find((r) => net.isIPv4(r.address));
	return (ipv4 || records[0]).address;
}

// Parse + protocol-check + DNS-resolve + per-address allowlist check. Throws
// `SsrfBlockedError` on any failure. Returns the parsed URL on success.
export async function assertSafePublicUrl(input, { allowHttp = false } = {}) {
	if (!input || typeof input !== 'string') throw new SsrfBlockedError('url must be a string');
	let url;
	try {
		url = new URL(input);
	} catch {
		throw new SsrfBlockedError('url is not a valid URL');
	}
	if (url.protocol === 'http:' && !allowHttp) {
		throw new SsrfBlockedError('http:// not allowed — use https://');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new SsrfBlockedError(`unsupported protocol ${url.protocol}`);
	}
	const host = url.hostname;
	if (!host) throw new SsrfBlockedError('url missing hostname');
	await resolveAndValidate(host);
	return url;
}

// Build the custom `lookup` an IP-pinned Agent installs so every socket connects
// to exactly the pre-validated address (closing the DNS-rebinding window). It
// MUST serve both lookup contracts: Node enables autoSelectFamily (Happy
// Eyeballs) by default and, for a dual-stack host, calls the custom lookup with
// `{ all: true }`, expecting the array form `cb(null, [{ address, family }])`.
// Returning the legacy positional form under `all:true` makes Node read
// `undefined` as the address and throw `Invalid IP address: undefined` before
// any socket opens — which silently broke every pinned fetch to a dual-stack
// host (e.g. storage.googleapis.com) on Node 24. Exported for direct testing.
export function makePinnedLookup(pinnedIp) {
	const family = net.isIPv6(pinnedIp) ? 6 : 4;
	return function lookup(_hostname, options, cb) {
		if (options && options.all) {
			cb(null, [{ address: pinnedIp, family }]);
		} else {
			cb(null, pinnedIp, family);
		}
	};
}

const MAX_REDIRECTS = 5;

// Convenience: assert + fetch. Uses the global fetch. Same options as fetch,
// minus that the URL must pass `assertSafePublicUrl`.
//
// Redirects are followed MANUALLY so each Location hop is re-validated with
// `assertSafePublicUrl` before we connect to it. The default global fetch
// (`redirect: 'follow'`) would only check the first URL, letting an attacker
// host a public endpoint that 302s to 169.254.169.254 / RFC1918 and slip past
// the guard. Hops are bounded by `MAX_REDIRECTS`.
//
// Use this for render-only responses (images, GLBs). For executed/forwarded
// responses use `fetchSafePublicUrlPinned` which closes the DNS rebinding window.
export async function fetchSafePublicUrl(input, init = {}, opts = {}) {
	let url = await assertSafePublicUrl(input, opts);
	let redirects = 0;
	while (true) {
		const res = await fetch(url.toString(), { ...init, redirect: 'manual' });
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			if (++redirects > MAX_REDIRECTS) {
				throw new SsrfBlockedError('too many redirects');
			}
			const next = new URL(res.headers.get('location'), url);
			url = await assertSafePublicUrl(next.toString(), opts);
			continue;
		}
		return res;
	}
}

// IP-pinned fetch: resolves DNS, validates every address, then makes the TCP
// connection directly to the resolved IP via a custom http/https Agent `lookup`
// callback — so a hostile DNS server cannot swap the address between our check
// and the actual connect (DNS rebinding). Use for any fetch whose response is
// forwarded to another service or executed (proxy endpoints, webhook delivery,
// script/wasm fetches). Returns a standard Response.
//
// Limits: only supports http/https; does not follow redirects across protocols.
export async function fetchSafePublicUrlPinned(input, init = {}, opts = {}) {
	let url = await assertSafePublicUrl(input, opts);
	let redirects = 0;

	while (true) {
		const pinnedIp = await resolveAndValidate(url.hostname);

		// Build a one-shot Agent whose `lookup` always returns the pre-validated IP.
		// This closes the TOCTOU window: the TCP socket connects to exactly the address
		// we checked, regardless of any subsequent DNS change. makePinnedLookup honors
		// both the legacy and autoSelectFamily (`all:true`) lookup contracts.
		const AgentClass = url.protocol === 'https:' ? https.Agent : http.Agent;
		const agent = new AgentClass({ lookup: makePinnedLookup(pinnedIp) });

		const res = await new Promise((resolve, reject) => {
			const mod = url.protocol === 'https:' ? https : http;
			const reqOpts = {
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? 443 : 80),
				path: url.pathname + url.search,
				method: (init.method || 'GET').toUpperCase(),
				headers: { host: url.hostname, ...(init.headers || {}) },
				agent,
			};
			const req = mod.request(reqOpts, (nodeRes) => {
				const chunks = [];
				nodeRes.on('data', (c) => chunks.push(c));
				nodeRes.on('end', () => {
					const body = Buffer.concat(chunks);
					// Wrap in a fetch-compatible Response so callers use the same API.
					resolve(new Response(body, {
						status: nodeRes.statusCode,
						headers: nodeRes.headers,
					}));
				});
				nodeRes.on('error', reject);
			});
			req.on('error', reject);
			// Honor an optional AbortSignal (e.g. AbortSignal.timeout) from init so a
			// caller can bound a hung host instead of holding the socket — and the
			// serverless invocation — open for the function's full duration. Purely
			// additive: callers that pass no signal are unaffected.
			const signal = init.signal;
			if (signal) {
				if (signal.aborted) {
					req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
				} else {
					const onAbort = () =>
						req.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
					signal.addEventListener('abort', onAbort, { once: true });
					req.on('close', () => signal.removeEventListener('abort', onAbort));
				}
			}
			if (init.body) req.write(init.body);
			req.end();
		});

		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			if (++redirects > MAX_REDIRECTS) throw new SsrfBlockedError('too many redirects');
			const next = new URL(res.headers.get('location'), url);
			url = await assertSafePublicUrl(next.toString(), opts);
			continue;
		}
		return res;
	}
}
