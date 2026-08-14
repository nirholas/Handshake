import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	IPFS_READ_GATEWAYS,
	ipfsGatewayUrl,
	ipfsPinningConfigured,
	pinToIPFS,
} from '../_lib/ipfs-pin.js';

const MAX_R2_BYTES = 50 * 1024 * 1024;
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;

// A CID is base58btc (v0, 46 chars) or base32 (v1, 59+), so the ceiling only has
// to exclude the pathological. Unbounded, a 5000-character "cid" was accepted:
// echoed back inside every gateway URL and forwarded into the provider's API on
// each status call, turning one request into a much larger one for free.
const CID_RE = /^[a-zA-Z0-9]{16,128}$/;

function isOwnedR2Url(url) {
	const domain = process.env.S3_PUBLIC_DOMAIN;
	if (!domain) return false;
	const trimmed = domain.replace(/\/$/, '');
	return url.startsWith(trimmed + '/');
}

/** Every gateway worth handing a caller, from the one tested read list. */
function gatewayUrlsFor(cid) {
	return IPFS_READ_GATEWAYS.map((gateway) => `${gateway}${cid}`);
}

function tooLarge(message) {
	return Object.assign(new Error(message), { status: 413, code: 'payload_too_large' });
}

/**
 * Buffer a response body, refusing to hold more than `maxBytes` at any point.
 *
 * A content-length pre-check alone is not a limit: the header is optional and
 * a source that omits or understates it gets an unbounded read, because the
 * whole body lands in memory before any post-hoc size check can run. Reading
 * incrementally and cancelling the moment the running total crosses the cap
 * keeps peak memory bounded whatever the source sends.
 */
async function readCappedBody(resp, maxBytes) {
	if (Number(resp.headers.get('content-length') || 0) > maxBytes) {
		throw tooLarge(`source exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
	}
	const reader = resp.body?.getReader();
	if (!reader) {
		const buf = Buffer.from(await resp.arrayBuffer());
		if (buf.byteLength > maxBytes) {
			throw tooLarge(`source exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
		}
		return buf;
	}
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw tooLarge(`source exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

/**
 * The name handed to the pinning provider. On the web3.storage lane it rides an
 * HTTP header (`X-NAME`), so anything outside a conservative set is dropped
 * rather than forwarded, and an entirely unusable name falls back to the kind's
 * default instead of reaching the provider empty.
 */
function safeFilename(name, fallback) {
	const cleaned = String(name || '')
		.replace(/[^A-Za-z0-9._-]/g, '')
		.slice(0, 128);
	return cleaned || fallback;
}

/**
 * What gets recorded as the pin's origin.
 *
 * A data: URL carries the entire payload, up to 10 MB of it. Persisting that
 * verbatim would store a second copy of every inline pin in Postgres, in a
 * column whose only job is to say where the bytes came from, and the database
 * is the one resource here with a hard storage cap.
 */
function sourceUrlForRecord(sourceUrl, byteLength) {
	if (!sourceUrl.startsWith('data:')) return sourceUrl;
	const commaIdx = sourceUrl.indexOf(',');
	return `${sourceUrl.slice(0, commaIdx)},<${byteLength} bytes inline>`;
}

let pinsTableReady = null;

/**
 * `create table if not exists` is a no-op after the first call but still costs a
 * round trip, so it ran on the request path of every single pin. Once per
 * process is enough; a failure clears the latch so the next request retries.
 */
function ensurePinsTable() {
	if (!pinsTableReady) {
		pinsTableReady = sql`
			create table if not exists pins (
				id         bigserial    primary key,
				user_id    text         not null,
				source_url text         not null,
				cid        text         not null,
				provider   text         not null,
				kind       text         not null,
				created_at timestamptz  not null default now()
			)
		`.catch((err) => {
			pinsTableReady = null;
			throw err;
		});
	}
	return pinsTableReady;
}

/** Ask each configured provider whether it is holding this CID. */
async function checkProviders(cid) {
	const pinataJwt = process.env.PINATA_JWT;
	const w3sToken = process.env.WEB3_STORAGE_TOKEN;
	const checks = [];

	if (pinataJwt) {
		checks.push(
			fetch(
				`https://api.pinata.cloud/data/pinList?hashContains=${encodeURIComponent(cid)}&status=pinned`,
				{ headers: { Authorization: `Bearer ${pinataJwt}` }, signal: AbortSignal.timeout(10000) },
			)
				.then(async (r) => {
					if (!r.ok) return null;
					const data = await r.json();
					const pinned = (data.rows || []).some((row) => row.ipfs_pin_hash === cid);
					return pinned ? 'pinata' : null;
				})
				.catch(() => null),
		);
	}

	if (w3sToken) {
		checks.push(
			fetch(`https://api.web3.storage/status/${encodeURIComponent(cid)}`, {
				headers: { Authorization: `Bearer ${w3sToken}` },
				signal: AbortSignal.timeout(10000),
			})
				.then(async (r) => {
					if (!r.ok) return null;
					const data = await r.json();
					return data.cid === cid ? 'web3.storage' : null;
				})
				.catch(() => null),
		);
	}

	return (await Promise.all(checks)).filter(Boolean);
}

export default wrap(async (req, res) => {
	const action = req.query?.action;

	if (action === 'pin') {
		if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
		if (!method(req, res, ['POST'])) return;

		const session = await getSessionUser(req);
		const bearer = session ? null : await authenticateBearer(extractBearer(req));
		if (!session && !bearer)
			return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
		const userId = session?.id ?? bearer.userId;

		const rl = await limits.pinUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'pinning rate exceeded (30/hour)');

		const body = await readJson(req);
		const { sourceUrl, kind } = body || {};

		if (!sourceUrl || typeof sourceUrl !== 'string') {
			return error(res, 400, 'validation_error', 'sourceUrl is required');
		}
		if (kind !== 'manifest' && kind !== 'glb') {
			return error(res, 400, 'validation_error', 'kind must be "manifest" or "glb"');
		}

		if (!ipfsPinningConfigured()) {
			return error(
				res,
				503,
				'pinning_unconfigured',
				'no pinning provider configured; set PINATA_JWT or WEB3_STORAGE_TOKEN',
			);
		}

		const defaultName = kind === 'glb' ? 'avatar.glb' : 'manifest.json';
		let buf;
		let filename = defaultName;

		if (sourceUrl.startsWith('data:')) {
			const commaIdx = sourceUrl.indexOf(',');
			if (commaIdx === -1) return error(res, 400, 'validation_error', 'invalid data: URL');
			const meta = sourceUrl.slice(0, commaIdx);
			const payload = sourceUrl.slice(commaIdx + 1);
			buf = meta.includes('base64')
				? Buffer.from(payload, 'base64')
				: Buffer.from(decodeURIComponent(payload));
			if (buf.byteLength > MAX_DATA_URL_BYTES) {
				return error(res, 413, 'payload_too_large', 'data: URL content exceeds 10 MB');
			}
		} else {
			if (!isOwnedR2Url(sourceUrl)) {
				return error(
					res,
					400,
					'validation_error',
					'sourceUrl must be an owned R2 URL or a data: URL',
				);
			}
			const head = await fetch(sourceUrl, {
				method: 'HEAD',
				redirect: 'manual',
				signal: AbortSignal.timeout(8000),
			});
			if (!head.ok) return error(res, 400, 'validation_error', 'source URL is not accessible');
			if (Number(head.headers.get('content-length') || 0) > MAX_R2_BYTES) {
				return error(res, 413, 'payload_too_large', 'source exceeds 50 MB limit');
			}
			// The source is prefix-locked to our own R2 domain and R2 public buckets
			// do not 302, so refusing to follow any redirect keeps a future CDN or
			// front-end change from silently widening the fetch target.
			const fetched = await fetch(sourceUrl, {
				redirect: 'manual',
				signal: AbortSignal.timeout(20000),
			});
			if (fetched.status >= 300 && fetched.status < 400) {
				return error(res, 502, 'fetch_failed', 'source URL returned an unexpected redirect');
			}
			if (!fetched.ok) return error(res, 502, 'fetch_failed', 'failed to fetch source URL');
			buf = await readCappedBody(fetched, MAX_R2_BYTES);
			filename = safeFilename(new URL(sourceUrl).pathname.split('/').pop(), defaultName);
		}

		const pinned = await pinToIPFS(buf, filename);
		const { cid, provider } = pinned;

		await ensurePinsTable();
		await sql`
			insert into pins (user_id, source_url, cid, provider, kind)
			values (${userId}, ${sourceUrlForRecord(sourceUrl, buf.byteLength)}, ${cid}, ${provider}, ${kind})
		`;

		return json(res, 200, {
			ok: true,
			cid,
			gatewayUrl: ipfsGatewayUrl(cid),
			gatewayUrls: gatewayUrlsFor(cid),
			provider,
		});
	}

	if (action === 'status') {
		if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
		if (!method(req, res, ['GET'])) return;

		const ip = clientIp(req);
		const rl = await limits.pinStatusIp(ip);
		if (!rl.success) return rateLimited(res, rl);

		const cid = req.query?.cid || new URL(req.url, 'http://x').searchParams.get('cid');
		if (!cid || !CID_RE.test(cid)) {
			return error(
				res,
				400,
				'validation_error',
				'cid query parameter is required and must be 16 to 128 alphanumeric characters',
			);
		}

		// With no provider configured there is nothing to ask, and answering
		// `pinned: false` would state as fact something this deployment cannot
		// know: an unconfigured checker and a genuinely unpinned CID are not the
		// same answer, and a caller that acts on the second (re-pin, warn the
		// user, fail a manifest attestation) must not be handed the first.
		if (!ipfsPinningConfigured()) {
			return error(
				res,
				503,
				'pinning_unconfigured',
				'no pinning provider configured; set PINATA_JWT or WEB3_STORAGE_TOKEN',
			);
		}

		const activeProviders = await checkProviders(cid);

		return json(res, 200, {
			cid,
			pinned: activeProviders.length > 0,
			provider: activeProviders[0] || null,
			gatewayUrls: gatewayUrlsFor(cid),
		});
	}

	// CORS before the 404 so a browser caller reads the error envelope instead of
	// an opaque network failure, and so a preflight for a mistyped action fails
	// with a message rather than silence.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	return error(res, 404, 'not_found', 'unknown pinning action');
});
