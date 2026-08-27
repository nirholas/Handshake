// Read-only Farcaster reader with a two-rung failover chain.
//
//   1. Neynar (@neynar/nodejs-sdk, MIT) when NEYNAR_API_KEY is configured.
//      Indexed data: follower counts and per-cast reaction counts, which is what
//      makes engagement ranking possible.
//   2. A public Farcaster hub over its documented HTTP API, keyless. Default
//      https://hub.pinata.cloud, override with FARCASTER_HUB_URL. Serves the raw
//      protocol messages, so it has no reaction counts but needs no vendor key
//      and never goes dark because a billing plan lapsed.
//
// Every call here is a public read. No signer is requested, nothing is written
// back to Farcaster, and no private endpoint is touched: the wallet proof in
// api/agents/[id]/memory-seed-farcaster.js is what establishes that the caller
// owns the fid, not an access token.

import { env } from './env.js';
import {
	normalizeHubCasts,
	normalizeHubUserData,
	normalizeNeynarCasts,
	normalizeNeynarUser,
	normalizeVerifications,
} from './farcaster-seed.js';

const HUB_TIMEOUT_MS = 15_000;
const HUB_PAGE_SIZE = 100;

export class FarcasterError extends Error {
	constructor(message, { status = 502, code = 'farcaster_upstream' } = {}) {
		super(message);
		this.name = 'FarcasterError';
		this.status = status;
		this.code = code;
	}
}

// The Neynar SDK is loaded lazily and only when a key is configured. The keyless
// hub lane is the one that must never fail to boot, so it carries no dependency
// on a vendor package being present or importable.
let _neynar;
async function neynar() {
	if (!env.NEYNAR_API_KEY) return null;
	if (_neynar !== undefined) return _neynar;
	try {
		const { NeynarAPIClient, Configuration } = await import('@neynar/nodejs-sdk');
		_neynar = new NeynarAPIClient(new Configuration({ apiKey: env.NEYNAR_API_KEY }));
	} catch (err) {
		console.warn('[farcaster-client] neynar sdk unavailable, using hub lane only', err?.message || err);
		_neynar = null;
	}
	return _neynar;
}

export function hubUrl() {
	return hubUrls()[0];
}

// Farcaster hubs are interchangeable: every one of them serves the same
// replicated set, which is the whole point of the protocol. Pinning a single
// host therefore bought nothing and cost everything, since one unreachable hub
// took the entire Farcaster lane down with it. An operator can still pin or
// reorder the list through FARCASTER_HUB_URLS (comma-separated), and
// FARCASTER_HUB_URL stays honoured as the first rung so existing deploys keep
// their preferred host.
const DEFAULT_HUBS = [
	'https://hub.pinata.cloud',
	'https://hub.farcaster.standardcrypto.vc:2281',
	'https://nemes.farcaster.xyz:2281',
];

export function hubUrls() {
	const configured = [
		...(env.FARCASTER_HUB_URL ? [env.FARCASTER_HUB_URL] : []),
		...String(env.FARCASTER_HUB_URLS || '').split(',').map((u) => u.trim()).filter(Boolean),
	];
	const seen = new Set();
	const out = [];
	for (const u of [...configured, ...DEFAULT_HUBS]) {
		const clean = u.replace(/\/+$/, '');
		if (clean && !seen.has(clean)) {
			seen.add(clean);
			out.push(clean);
		}
	}
	return out;
}

async function hubGet(path) {
	const hubs = hubUrls();
	let lastErr;
	for (const base of hubs) {
		let resp;
		try {
			resp = await fetch(`${base}${path}`, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
			});
		} catch (err) {
			// Unreachable host: try the next hub rather than failing the read.
			lastErr = new FarcasterError(`Farcaster hub unreachable: ${err?.message || err}`);
			continue;
		}
		// "No such user" is the network's answer, not this hub's opinion, so it
		// ends the walk immediately. Only infrastructure failures fail over.
		if (resp.status === 404) throw new FarcasterError('Farcaster user not found', { status: 404, code: 'farcaster_user_not_found' });
		if (!resp.ok) {
			// A hub answers "no such fname" with 400 + a NotFound detail, not 404.
			// Without this the caller cannot tell a typo'd handle from an outage.
			const body = await resp.text().catch(() => '');
			if (resp.status === 400 && /not\s*found/i.test(body)) {
				throw new FarcasterError('Farcaster user not found', {
					status: 404,
					code: 'farcaster_user_not_found',
				});
			}
			lastErr = new FarcasterError(`Farcaster hub ${resp.status}`);
			continue;
		}
		return resp.json();
	}
	throw lastErr || new FarcasterError('no Farcaster hub answered');
}

/** Page through a hub message endpoint until `limit` messages or the pages run out. */
async function hubMessages(path, limit) {
	const messages = [];
	let pageToken = '';
	while (messages.length < limit) {
		const sep = path.includes('?') ? '&' : '?';
		const page = await hubGet(
			`${path}${sep}pageSize=${HUB_PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
		);
		const batch = page?.messages || [];
		messages.push(...batch);
		pageToken = page?.nextPageToken || '';
		if (!pageToken || batch.length === 0) break;
	}
	return messages.slice(0, limit);
}

// ── Resolve a user ──────────────────────────────────────────────────────────

/**
 * Resolve `{ fid }` or `{ fname }` to a profile. Returns the lane that answered
 * so callers can report which data source the seed came from.
 */
export async function resolveFarcasterUser({ fid = null, fname = null }) {
	if (!fid && !fname) throw new FarcasterError('fid or fname required', { status: 400, code: 'validation_error' });

	const client = await neynar();
	if (client) {
		try {
			const user = fid
				? (await client.fetchBulkUsers({ fids: [Number(fid)] }))?.users?.[0]
				: (await client.lookupUserByUsername({ username: String(fname).replace(/^@/, '') }))?.user;
			if (user?.fid) return { ...normalizeNeynarUser(user), lane: 'neynar' };
		} catch (err) {
			if (err?.response?.status === 404) {
				throw new FarcasterError('Farcaster user not found', { status: 404, code: 'farcaster_user_not_found' });
			}
			console.warn('[farcaster-client] neynar user lookup failed, falling back to hub', err?.message || err);
		}
	}

	let resolvedFid = fid ? Number(fid) : null;
	if (!resolvedFid) {
		const proof = await hubGet(`/v1/userNameProofByName?name=${encodeURIComponent(String(fname).replace(/^@/, ''))}`);
		resolvedFid = Number(proof?.fid);
		if (!Number.isInteger(resolvedFid) || resolvedFid <= 0) {
			throw new FarcasterError('Farcaster user not found', { status: 404, code: 'farcaster_user_not_found' });
		}
	}

	const data = await hubGet(`/v1/userDataByFid?fid=${resolvedFid}`);
	const messages = data?.messages || [];
	if (messages.length === 0 && !fid) {
		throw new FarcasterError('Farcaster user not found', { status: 404, code: 'farcaster_user_not_found' });
	}
	const profile = normalizeHubUserData(messages);
	return {
		fid: resolvedFid,
		fname: profile.fname || (fname ? String(fname).replace(/^@/, '') : null),
		displayName: profile.displayName,
		bio: profile.bio,
		pfpUrl: profile.pfpUrl,
		url: profile.url,
		followerCount: null,
		followingCount: null,
		lane: 'hub',
	};
}

// ── Verified addresses ──────────────────────────────────────────────────────

/**
 * The wallets this fid has publicly proved control of, by protocol. This is the
 * allowlist for the consent signature: only an address in here can grant a seed
 * for this fid, which is what stops one user from seeding another user's casts.
 */
export async function fetchVerifiedAddresses(fid) {
	const client = await neynar();
	if (client) {
		try {
			const user = (await client.fetchBulkUsers({ fids: [Number(fid)] }))?.users?.[0];
			const verified = user?.verified_addresses;
			if (verified) {
				return {
					solana: [...new Set(verified.sol_addresses || [])],
					ethereum: [...new Set((verified.eth_addresses || []).map((a) => String(a).toLowerCase()))],
					lane: 'neynar',
				};
			}
		} catch (err) {
			console.warn('[farcaster-client] neynar verifications failed, falling back to hub', err?.message || err);
		}
	}

	const messages = await hubMessages(`/v1/verificationsByFid?fid=${Number(fid)}`, HUB_PAGE_SIZE);
	return { ...normalizeVerifications(messages), lane: 'hub' };
}

// ── Casts ───────────────────────────────────────────────────────────────────

/** Recent casts for a fid, newest first, normalized across both lanes. */
export async function fetchRecentCasts(fid, limit = 100) {
	const bounded = Math.min(Math.max(1, Number(limit) || 100), 200);
	const client = await neynar();
	if (client) {
		try {
			const resp = await client.fetchCastsForUser({ fid: Number(fid), limit: bounded, includeReplies: false });
			const casts = normalizeNeynarCasts(resp?.casts || []);
			if (casts.length > 0) return { casts, lane: 'neynar' };
		} catch (err) {
			console.warn('[farcaster-client] neynar casts failed, falling back to hub', err?.message || err);
		}
	}

	const messages = await hubMessages(`/v1/castsByFid?fid=${Number(fid)}&reverse=true`, bounded);
	return { casts: normalizeHubCasts(messages), lane: 'hub' };
}
