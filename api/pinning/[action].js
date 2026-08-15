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

// The inline lane's real ceiling is the request body, not the decoded payload.
//
// `readJson` defaults to a 1,000,000-byte limit, and this handler used to take
// that default while advertising a 10 MB inline cap. The two never met: a
// data: URL carries base64, which inflates raw bytes by 4/3, so the default
// rejected every inline pin above roughly 730 KB with a bare
// `413 bad_request: payload too large` long before the handler's own size check
// could run. avatar-studio's mint flow base64s the whole GLB into this endpoint
// (character-studio/src/library/mint-utils.js), so every realistic avatar hit
// that wall.
//
// So the body limit is stated explicitly, matched to the 8 MB ceiling
// server/index.mjs already enforces (BODY_LIMIT), and the decoded cap is set to
// a size that actually fits inside it: 5 MB of payload is 6.67 MB of base64,
// leaving room for the JSON envelope. Raising the readJson limit costs no extra
// memory, because the Express body parser has already buffered those same bytes
// into req.rawBody before this handler is entered.
const MAX_PIN_BODY_BYTES = 8 * 1024 * 1024;
const MAX_DATA_URL_BYTES = 5 * 1024 * 1024;

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
	// Only a string is a name. The value reaches here straight off the request
	// body, and coercing an object or array would forward the shape of the
	// caller's mistake ("objectObject") to the provider as a filename.
	const cleaned = (typeof name === 'string' ? name : '')
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

/**
 * Ask each configured provider whether it is holding this CID.
 *
 * Every check reports one of three outcomes, and the third is the reason this
 * does not just return a boolean. A provider that answers "I am not holding it"
 * and a provider that never answered at all (expired token, rate limit, network
 * fault) are different facts, and collapsing them into `pinned: false` reports a
 * broken checker as a missing file. A rotated Pinata JWT made this concrete
 * during the audit of this endpoint: every request 401'd upstream and the
 * endpoint kept replying `pinned: false, provider: null`, with a 200.
 *
 * @returns {Promise<{holders: string[], failures: string[], answered: number}>}
 */
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
					if (!r.ok) return { provider: 'pinata', failed: true };
					const data = await r.json();
					const pinned = (data.rows || []).some((row) => row.ipfs_pin_hash === cid);
					return { provider: 'pinata', held: pinned };
				})
				.catch(() => ({ provider: 'pinata', failed: true })),
		);
	}

	if (w3sToken) {
		checks.push(
			fetch(`https://api.web3.storage/status/${encodeURIComponent(cid)}`, {
				headers: { Authorization: `Bearer ${w3sToken}` },
				signal: AbortSignal.timeout(10000),
			})
				.then(async (r) => {
					if (!r.ok) return { provider: 'web3.storage', failed: true };
					const data = await r.json();
					return { provider: 'web3.storage', held: data.cid === cid };
				})
				.catch(() => ({ provider: 'web3.storage', failed: true })),
		);
	}

	const results = await Promise.all(checks);
	return {
		holders: results.filter((r) => r.held).map((r) => r.provider),
		failures: results.filter((r) => r.failed).map((r) => r.provider),
		answered: results.filter((r) => !r.failed).length,
	};
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

		// An oversized body is a size failure, so it answers with this endpoint's
		// own `payload_too_large` code and a message naming the limit, rather than
		// the generic `bad_request` an uncoded 413 collapses into in wrap().
		const body = await readJson(req, MAX_PIN_BODY_BYTES).catch((err) => {
			if (err?.status !== 413) throw err;
			throw Object.assign(
				new Error(
					`request body exceeds ${MAX_PIN_BODY_BYTES / (1024 * 1024)} MB; upload to storage and pin the URL instead`,
				),
				{ status: 413, code: 'payload_too_large' },
			);
		});
		const { sourceUrl, kind, filename: requestedName } = body || {};

		if (!sourceUrl || typeof sourceUrl !== 'string') {
			return error(res, 400, 'validation_error', 'sourceUrl is required');
		}
		if (kind !== 'manifest' && kind !== 'glb') {
			return error(res, 400, 'validation_error', 'kind must be "manifest" or "glb"');
		}

		const defaultName = kind === 'glb' ? 'avatar.glb' : 'manifest.json';
		let buf;
		// Callers already send the file's own name alongside the bytes
		// (character-studio's saveFileToPinata does), and dropping it filed every
		// inline pin at the provider under the same two names, making a user's pin
		// list unreadable. safeFilename is what makes honoring it safe.
		let filename = safeFilename(requestedName, defaultName);

		if (sourceUrl.startsWith('data:')) {
			const commaIdx = sourceUrl.indexOf(',');
			if (commaIdx === -1) return error(res, 400, 'validation_error', 'invalid data: URL');
			const meta = sourceUrl.slice(0, commaIdx);
			const payload = sourceUrl.slice(commaIdx + 1);
			buf = meta.includes('base64')
				? Buffer.from(payload, 'base64')
				: Buffer.from(decodeURIComponent(payload));
			if (buf.byteLength > MAX_DATA_URL_BYTES) {
				return error(
					res,
					413,
					'payload_too_large',
					`data: URL content exceeds ${MAX_DATA_URL_BYTES / (1024 * 1024)} MB`,
				);
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
			// The object's own key names the file when the caller did not.
			if (!requestedName) {
				filename = safeFilename(new URL(sourceUrl).pathname.split('/').pop(), defaultName);
			}
		}

		// Checked here rather than ahead of the validation above, so a caller who
		// sent an oversized payload or a source URL we do not own always learns
		// that from a 4xx. Ordered the other way, a deployment missing its provider
		// answered every malformed request with the same 503, which reads as "the
		// service is down" and hides a request the caller could have fixed.
		if (!ipfsPinningConfigured()) {
			return error(
				res,
				503,
				'pinning_unconfigured',
				'no pinning provider configured; set PINATA_JWT or WEB3_STORAGE_TOKEN',
			);
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

		const { holders, failures, answered } = await checkProviders(cid);

		// No provider managed to answer: same rule as the unconfigured case above.
		// Reporting `pinned: false` here would blame the document for a fault in
		// the checker.
		if (answered === 0) {
			return error(
				res,
				503,
				'pinning_check_failed',
				`could not reach any pinning provider (${failures.join(', ')}); retry shortly`,
			);
		}

		return json(res, 200, {
			cid,
			pinned: holders.length > 0,
			provider: holders[0] || null,
			// A partial answer is still an answer, but the caller has to be able to
			// see that one provider was never asked before treating `pinned: false`
			// as proof the CID is gone.
			unreachableProviders: failures,
			gatewayUrls: gatewayUrlsFor(cid),
		});
	}

	// CORS before the 404 so a browser caller reads the error envelope instead of
	// an opaque network failure, and so a preflight for a mistyped action fails
	// with a message rather than silence.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	return error(res, 404, 'not_found', 'unknown pinning action');
});
