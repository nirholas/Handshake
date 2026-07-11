// SSRF-hardened model fetcher.
//
// Arbitrary URL fetching from a server reachable by the internet is a classic
// SSRF vector: an attacker can point "url" at internal metadata endpoints
// (169.254.169.254 on AWS/GCP), private RFC1918 ranges, or loopback and we'd
// happily proxy the response back to them. The SSRF policy (scheme allowlist,
// our-side DNS resolution + IP blocklist, connection pinning, per-hop redirect
// re-validation) lives in api/_lib/ssrf.js and is shared with the x402 monetize
// proxy. This fetcher adds the model-specific concerns on top: a byte size cap
// and a total request/streaming timeout.

import { SsrfError, pinnedAgent, resolvePublicHost, validatePublicUrl } from './ssrf.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

export class FetchModelError extends Error {
	constructor(message, code = 'fetch_failed') {
		super(message);
		this.code = code;
	}
}

// Map a shared SsrfError to the FetchModelError shape callers already expect, so
// existing { code: 'private_address' } / 'scheme_not_allowed' assertions hold.
function asFetchModelError(err) {
	if (err instanceof SsrfError) return new FetchModelError(err.message, err.code);
	return err;
}

function validateUrl(rawUrl) {
	try {
		return validatePublicUrl(rawUrl);
	} catch (err) {
		throw asFetchModelError(err);
	}
}

/**
 * Fetch bytes from an untrusted URL with SSRF protection.
 *
 * @param {string} rawUrl
 * @param {{ maxBytes?: number, timeoutMs?: number, headers?: object }} opts
 *   opts.headers merges over the defaults — callers fetching non-model content
 *   (the news og:image resolver pulls publisher HTML) present their own
 *   user-agent/accept instead of the model ones.
 * @returns {Promise<{ bytes: Uint8Array, url: string, contentType: string, filename: string }>}
 */
export async function fetchModel(rawUrl, opts = {}) {
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let currentUrl = validateUrl(rawUrl);
	let redirects = 0;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let agent = null;
	try {
		while (true) {
			// Resolve + validate on THIS hop, then pin the connection to exactly
			// those addresses. Re-done every redirect so a redirect target that
			// rebinds to a private IP is caught and refused.
			const addrs = await resolvePublicHost(currentUrl.hostname);
			if (agent) await agent.close().catch(() => {});
			agent = pinnedAgent(currentUrl.hostname, addrs);

			const res = await fetch(currentUrl, {
				method: 'GET',
				redirect: 'manual',
				signal: controller.signal,
				dispatcher: agent,
				headers: {
					'user-agent': '3d-agent-mcp/1.0 (+https://three.ws/)',
					accept: 'model/gltf-binary, model/gltf+json, application/octet-stream, */*;q=0.5',
					...(opts.headers || {}),
				},
			});

			if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
				if (++redirects > MAX_REDIRECTS) {
					throw new FetchModelError('too many redirects', 'too_many_redirects');
				}
				const next = new URL(res.headers.get('location'), currentUrl);
				currentUrl = validateUrl(next.toString());
				continue;
			}

			if (!res.ok) {
				throw new FetchModelError(`upstream returned ${res.status}`, 'upstream_error');
			}

			const lenHeader = res.headers.get('content-length');
			if (lenHeader && Number(lenHeader) > maxBytes) {
				throw new FetchModelError(
					`file too large (${lenHeader} > ${maxBytes} bytes)`,
					'file_too_large',
				);
			}

			const reader = res.body?.getReader();
			if (!reader) throw new FetchModelError('no response body', 'no_body');

			const chunks = [];
			let received = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					try {
						reader.cancel();
					} catch {}
					throw new FetchModelError(
						`file exceeded ${maxBytes} bytes during download`,
						'file_too_large',
					);
				}
				chunks.push(value);
			}

			const bytes = new Uint8Array(received);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}

			const contentType = res.headers.get('content-type') || 'application/octet-stream';
			const filename = currentUrl.pathname.split('/').pop() || 'model';

			return {
				bytes,
				url: currentUrl.toString(),
				contentType,
				filename,
			};
		}
	} finally {
		clearTimeout(timer);
		if (agent) await agent.close().catch(() => {});
	}
}
