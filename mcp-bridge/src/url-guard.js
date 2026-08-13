// SSRF guard + shared spend-limit parsing for the x402 MCP bridge.
//
// THREAT MODEL: this bridge holds live EVM + SVM signers and an auto-pay
// interceptor. A URL supplied by the LLM (call_paid_endpoint) or by an
// untrusted Bazaar listing (dynamic tools) flows into a payment-wrapped axios
// request. Without validation, an attacker can point that request at internal
// infrastructure — cloud metadata (169.254.169.254), localhost admin panels,
// RFC-1918 hosts — and, worse, get the bridge to SIGN a payment to do it.
//
// `assertPayableUrl` is the single chokepoint that every outbound payable
// request must pass through. It enforces:
//   - scheme allowlist (https only; http behind an explicit dev opt-in)
//   - DNS resolution of the hostname and rejection if ANY resolved address is
//     private/loopback/link-local/unspecified/ULA/CGNAT (defeats DNS rebinding
//     at request-build time and literal-IP SSRF)
//   - optional strict host allowlist via MCP_BRIDGE_ALLOWED_HOSTS
//
// No external dependency: the CIDR checks parse octets / IPv6 hextets directly.

import { promises as dns } from 'node:dns';
import net from 'node:net';

const DEFAULT_MAX_PRICE_ATOMIC = 100_000n; // $0.10 USDC

// ---------------------------------------------------------------------------
// Shared spend-limit parsing: the single source of truth for the effective
// per-call cap. The spending-cap hook and Bazaar discovery MUST read the same
// value; when they disagree, discovery registers tools whose every call the
// hook then refuses. The cap always exists (default when unset), because the
// hook enforces the default even when no env var is configured.
// ---------------------------------------------------------------------------
export function maxPriceAtomic() {
	const raw = process.env.MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC;
	if (!raw) return DEFAULT_MAX_PRICE_ATOMIC;
	let v;
	try {
		v = BigInt(raw);
	} catch {
		throw new Error('MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC must be an integer (atomic units)');
	}
	if (v < 0n) throw new Error('MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC must be non-negative');
	return v;
}

export { DEFAULT_MAX_PRICE_ATOMIC };

// ---------------------------------------------------------------------------
// IP range classification
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		n = n * 256 + octet;
	}
	return n >>> 0;
}

function inV4Cidr(intIp, baseStr, prefix) {
	const baseInt = ipv4ToInt(baseStr);
	if (baseInt === null) return false;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (intIp & mask) === (baseInt & mask);
}

// Private / non-routable / sensitive IPv4 ranges that must never be paid-fetched.
function isPrivateIPv4(ip) {
	const n = ipv4ToInt(ip);
	if (n === null) return true; // unparseable → treat as unsafe
	return (
		inV4Cidr(n, '0.0.0.0', 8) || // "this" network / unspecified
		inV4Cidr(n, '10.0.0.0', 8) || // RFC1918
		inV4Cidr(n, '127.0.0.0', 8) || // loopback
		inV4Cidr(n, '169.254.0.0', 16) || // link-local incl. 169.254.169.254 metadata
		inV4Cidr(n, '172.16.0.0', 12) || // RFC1918
		inV4Cidr(n, '192.168.0.0', 16) || // RFC1918
		inV4Cidr(n, '100.64.0.0', 10) // CGNAT (RFC6598)
	);
}

// Expand an IPv6 address (possibly with `::` or an embedded IPv4 tail) to its
// 8 16-bit hextet integers. Returns null if it cannot be parsed.
function expandIPv6(addr) {
	let s = addr.trim();
	// Strip zone id (fe80::1%eth0).
	const pct = s.indexOf('%');
	if (pct !== -1) s = s.slice(0, pct);

	const halves = s.split('::');
	if (halves.length > 2) return null;

	const toHextets = (segment) => {
		if (segment === '') return [];
		const out = [];
		for (const part of segment.split(':')) {
			if (part.includes('.')) {
				// Embedded IPv4 tail (e.g. ::ffff:10.0.0.1) → two hextets.
				const v4 = ipv4ToInt(part);
				if (v4 === null) return null;
				out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
			} else {
				if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
				out.push(parseInt(part, 16));
			}
		}
		return out;
	};

	const head = toHextets(halves[0]);
	if (head === null) return null;
	let tail = [];
	if (halves.length === 2) {
		tail = toHextets(halves[1]);
		if (tail === null) return null;
	} else if (head.length !== 8) {
		return null; // no `::`, so it must be fully specified
	}

	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;
	return [...head, ...new Array(fill).fill(0), ...tail];
}

function isPrivateIPv6(addr) {
	const h = expandIPv6(addr);
	if (h === null) return true; // unparseable → unsafe

	// ::  (unspecified)
	if (h.every((x) => x === 0)) return true;
	// ::1 (loopback)
	if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true;
	// fc00::/7 (ULA)
	if ((h[0] & 0xfe00) === 0xfc00) return true;
	// fe80::/10 (link-local)
	if ((h[0] & 0xffc0) === 0xfe80) return true;

	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — re-check the v4 tail.
	const isV4Mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
	const isV4Compat = h.slice(0, 6).every((x) => x === 0) && (h[6] !== 0 || h[7] > 1);
	if (isV4Mapped || isV4Compat) {
		const v4 = `${h[6] >>> 8}.${h[6] & 0xff}.${h[7] >>> 8}.${h[7] & 0xff}`;
		return isPrivateIPv4(v4);
	}

	return false;
}

// True if `ip` (a literal address string) is in a blocked range.
export function isBlockedAddress(ip) {
	const kind = net.isIP(ip);
	if (kind === 4) return isPrivateIPv4(ip);
	if (kind === 6) return isPrivateIPv6(ip);
	// Not a literal IP — caller must resolve via DNS first.
	return true;
}

// ---------------------------------------------------------------------------
// Allowlists / scheme policy
// ---------------------------------------------------------------------------

function allowedHosts() {
	const raw = process.env.MCP_BRIDGE_ALLOWED_HOSTS;
	if (!raw || !raw.trim()) return null;
	return new Set(
		raw
			.split(',')
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean),
	);
}

function httpAllowed() {
	return process.env.MCP_BRIDGE_ALLOW_HTTP === '1';
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/**
 * Validate that `rawUrl` is safe to issue a payment-wrapped request against.
 * Throws a clear Error on any violation. Returns the (string) validated URL.
 */
export async function assertPayableUrl(rawUrl) {
	let parsed;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error(`refused: not a parseable URL: ${String(rawUrl)}`);
	}

	// Scheme policy: https only, http behind explicit dev opt-in. Everything
	// else (file:, ftp:, data:, gopher:, etc.) is rejected outright.
	if (parsed.protocol === 'http:') {
		if (!httpAllowed()) {
			throw new Error(
				'refused: http:// is disabled (set MCP_BRIDGE_ALLOW_HTTP=1 for local dev only)',
			);
		}
	} else if (parsed.protocol !== 'https:') {
		throw new Error(`refused: unsupported URL scheme "${parsed.protocol}" (only https is allowed)`);
	}

	const host = parsed.hostname.toLowerCase();
	if (!host) throw new Error('refused: URL has no host');

	// Strict host allowlist mode.
	const allow = allowedHosts();
	if (allow && !allow.has(host)) {
		throw new Error(`refused: host "${host}" is not in MCP_BRIDGE_ALLOWED_HOSTS allowlist`);
	}

	// Literal-IP host → check directly, no DNS.
	const literalKind = net.isIP(host) || net.isIP(stripBrackets(host));
	if (literalKind) {
		const ip = stripBrackets(host);
		if (isBlockedAddress(ip)) {
			throw new Error(`refused: host resolves to a private/blocked address (${ip})`);
		}
		return parsed.toString();
	}

	// Hostname → resolve ALL addresses and reject if ANY is internal. Checking
	// every result (not just the first) closes the multi-A-record / partial
	// rebinding gap.
	let records;
	try {
		records = await dns.lookup(host, { all: true });
	} catch (err) {
		throw new Error(`refused: DNS lookup failed for "${host}": ${err?.code || err?.message || 'error'}`);
	}
	if (!records || records.length === 0) {
		throw new Error(`refused: "${host}" did not resolve to any address`);
	}
	for (const { address } of records) {
		if (isBlockedAddress(address)) {
			throw new Error(`refused: "${host}" resolves to a private/blocked address (${address})`);
		}
	}

	return parsed.toString();
}

function stripBrackets(host) {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
