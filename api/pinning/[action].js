import { sql } from '../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const MAX_R2_BYTES = 50 * 1024 * 1024;
const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
const CID_RE = /^[a-zA-Z0-9]+$/;

function isOwnedR2Url(url) {
	const domain = process.env.S3_PUBLIC_DOMAIN;
	if (!domain) return false;
	try {
		const trimmed = domain.replace(/\/$/, '');
		return url.startsWith(trimmed + '/');
	} catch {
		return false;
	}
}

async function pinViaPinata(buf, filename) {
	const form = new FormData();
	form.append('file', new Blob([buf]), filename);
	const resp = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
		method: 'POST',
		headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
		body: form,
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`Pinata error ${resp.status}`), { status: 502, detail });
	}
	const data = await resp.json();
	return { cid: data.IpfsHash, provider: 'pinata' };
}

async function pinViaWeb3Storage(buf, filename) {
	const resp = await fetch('https://api.web3.storage/upload', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.WEB3_STORAGE_TOKEN}`,
			'X-NAME': filename,
		},
		body: buf,
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => '');
		throw Object.assign(new Error(`Web3.Storage error ${resp.status}`), {
			status: 502,
			detail,
		});
	}
	const data = await resp.json();
	return { cid: data.cid, provider: 'web3.storage' };
}

async function ensurePinsTable() {
	await sql`
		create table if not exists pins (
			id         bigserial    primary key,
			user_id    text         not null,
			source_url text         not null,
			cid        text         not null,
			provider   text         not null,
			kind       text         not null,
			created_at timestamptz  not null default now()
		)
	`;
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
		if (!rl.success) return error(res, 429, 'rate_limited', 'pinning rate exceeded (30/hour)');

		const body = await readJson(req);
		const { sourceUrl, kind } = body || {};

		if (!sourceUrl || typeof sourceUrl !== 'string') {
			return error(res, 400, 'validation_error', 'sourceUrl is required');
		}
		if (kind !== 'manifest' && kind !== 'glb') {
			return error(res, 400, 'validation_error', 'kind must be "manifest" or "glb"');
		}

		const pinataJwt = process.env.PINATA_JWT;
		const w3sToken = process.env.WEB3_STORAGE_TOKEN;
		if (!pinataJwt && !w3sToken) {
			return error(
				res,
				503,
				'pinning_unconfigured',
				'no pinning provider configured; set PINATA_JWT or WEB3_STORAGE_TOKEN',
			);
		}

		let buf;
		let filename = kind === 'glb' ? 'avatar.glb' : 'manifest.json';

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
			const head = await fetch(sourceUrl, { method: 'HEAD' });
			if (!head.ok) return error(res, 400, 'validation_error', 'source URL is not accessible');
			const contentLength = parseInt(head.headers.get('content-length') || '0', 10);
			if (contentLength > MAX_R2_BYTES) {
				return error(res, 413, 'payload_too_large', 'source exceeds 50 MB limit');
			}
			const fetched = await fetch(sourceUrl);
			if (!fetched.ok) return error(res, 502, 'fetch_failed', 'failed to fetch source URL');
			buf = Buffer.from(await fetched.arrayBuffer());
			const urlPath = new URL(sourceUrl).pathname;
			filename = urlPath.split('/').pop() || filename;
		}

		const { cid, provider } = pinataJwt
			? await pinViaPinata(buf, filename)
			: await pinViaWeb3Storage(buf, filename);

		await ensurePinsTable();
		await sql`
			insert into pins (user_id, source_url, cid, provider, kind)
			values (${userId}, ${sourceUrl}, ${cid}, ${provider}, ${kind})
		`;

		return json(res, 200, {
			ok: true,
			cid,
			gatewayUrl: `https://ipfs.io/ipfs/${cid}`,
			provider,
		});
	}

	if (action === 'status') {
		if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
		if (!method(req, res, ['GET'])) return;

		const ip = clientIp(req);
		const rl = await limits.pinStatusIp(ip);
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

		const cid = req.query?.cid || new URL(req.url, 'http://x').searchParams.get('cid');
		if (!cid || !CID_RE.test(cid)) {
			return error(
				res,
				400,
				'validation_error',
				'cid query parameter is required and must be alphanumeric',
			);
		}

		const pinataJwt = process.env.PINATA_JWT;
		const w3sToken = process.env.WEB3_STORAGE_TOKEN;
		const checks = [];

		if (pinataJwt) {
			checks.push(
				fetch(
					`https://api.pinata.cloud/data/pinList?hashContains=${encodeURIComponent(cid)}&status=pinned`,
					{ headers: { Authorization: `Bearer ${pinataJwt}` } },
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
				})
					.then(async (r) => {
						if (!r.ok) return null;
						const data = await r.json();
						return data.cid === cid ? 'web3.storage' : null;
					})
					.catch(() => null),
			);
		}

		const providerResults = await Promise.all(checks);
		const activeProviders = providerResults.filter(Boolean);
		const pinned = activeProviders.length > 0;

		return json(res, 200, {
			cid,
			pinned,
			provider: activeProviders[0] || null,
			gatewayUrls: [
				`https://ipfs.io/ipfs/${cid}`,
				`https://flk-ipfs.xyz/ipfs/${cid}`,
				`https://dweb.link/ipfs/${cid}`,
			],
		});
	}

	return error(res, 404, 'not_found', 'unknown pinning action');
});
