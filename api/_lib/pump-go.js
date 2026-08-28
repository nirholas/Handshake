// pump.fun GO — read-only client for the public bounties API.
//
// GO (pump.fun/go/bounties) is two layers (mapped from mainnet observation):
//   • on-chain  — the `pump_bounties` Anchor program (goGz…KiV) holding reward
//     escrow in PDA vaults and running the bounty/dispute/award lifecycle.
//   • off-chain — a PUBLIC read REST API at livestream-api.pump.fun serving the
//     bounty content (title/body/criteria/rewards/attachments), bridged back to
//     chain by `onChainBountyId`.
//
// Reads require NO auth — these are public endpoints. (Likes/submissions/deletes
// need a pump.fun SIWS JWT; out of scope for the read-only board.) We fetch with
// a browser-like UA + a hard timeout, and normalize the verbose upstream Task
// into a lean, UI-friendly shape. The normalizers are pure so they unit-test
// without the network.

import { clampInt } from './http-params.js';
import { fetchUpstream } from './upstream-fetch.js';

const REST_BASE = 'https://livestream-api.pump.fun';
const PROGRAM_ID = 'goGzNYTYkSEe4hUqz6dPmY5uf3CTt36AQAoujXDrKiV';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TIMEOUT_MS = 10_000;
const MAX_LIMIT = 50;

// Upstream error with an HTTP status, so handlers surface a real envelope rather
// than a misleading empty list when pump.fun is down. The code travels with the
// status: a bounty that does not exist is a client-side 404 (`not_found`), not
// an upstream fault, and callers branch on the code rather than the prose.
export class PumpGoError extends Error {
	constructor(message, status = 502, code = 'pump_go_upstream') {
		super(message);
		this.name = 'PumpGoError';
		this.status = status;
		this.code = code;
	}
}

async function pumpGoGet(path) {
	// Retried on the transient statuses only. A 404 is a real answer about this
	// bounty and must not be retried, and neither should a 4xx: repeating either
	// just spends the caller's budget to be told the same thing again.
	let res;
	try {
		res = await fetchUpstream(`${REST_BASE}${path}`, {
			headers: {
				accept: 'application/json',
				'user-agent': 'Mozilla/5.0 (compatible; three.ws/1.0; +https://three.ws)',
				origin: 'https://pump.fun',
				referer: 'https://pump.fun/',
			},
		}, { name: 'pumpfun:go', timeoutMs: TIMEOUT_MS, attempts: 2, okWhen: () => true });
	} catch (e) {
		throw new PumpGoError(`pump.fun GO unreachable: ${e.message}`, 504);
	}
	if (res.status === 404) throw new PumpGoError('bounty not found', 404, 'not_found');
	if (!res.ok) throw new PumpGoError(`pump.fun GO upstream ${res.status}`, 502);
	try {
		return await res.json();
	} catch {
		throw new PumpGoError('pump.fun GO returned non-JSON', 502);
	}
}

function clampLimit(limit, fallback = 30) {
	return clampInt(limit, { max: MAX_LIMIT, fallback });
}

// USD for a reward leg from the parallel rewardLegsUsd array (only when priced).
function legUsd(legsUsd, mint) {
	const m = (legsUsd || []).find((x) => x.mintAddress === mint);
	return m && m.priced ? (m.usdValue ?? null) : null;
}

// atomic string → human float by decimals. Display only — never on-chain math.
function fromAtomic(atomic, decimals) {
	const n = Number(atomic);
	if (!Number.isFinite(n)) return null;
	return n / 10 ** (decimals || 0);
}

export function normalizeTask(t) {
	if (!t || typeof t !== 'object') return null;
	const legsUsd = t.rewardLegsUsd || [];
	const legs = (t.rewardLegs || []).map((l) => ({
		mint: l.mintAddress,
		tokenProgram: l.tokenProgramId,
		decimals: l.decimalsSnapshot,
		amount: fromAtomic(l.amountAtomic, l.decimalsSnapshot),
		remaining: fromAtomic(l.remainingAmountAtomic, l.decimalsSnapshot),
		amountAtomic: l.amountAtomic,
		isSol: l.mintAddress === WSOL_MINT,
		vault: l.rewardVaultAddress,
		usd: legUsd(legsUsd, l.mintAddress),
	}));
	const solLeg = legs.find((l) => l.isSol);
	return {
		taskId: t.taskId,
		title: t.title || '',
		bodyMarkdown: t.bodyMarkdown || '',
		status: t.status || null,
		submissionVisibility: t.submissionVisibility || null,
		coinAddress: t.coinAddress || null,
		creator: {
			address: t.creatorAddress || null,
			xFollowers: t.creatorXFollowerCount ?? null,
			xVerified: !!t.creatorXVerified,
		},
		criteria: Array.isArray(t.criteria)
			? t.criteria.map((c) => ({
					id: c.id,
					text: c.text,
					required: !!c.required,
					order: c.order ?? 0,
				}))
			: [],
		createdAt: t.createdAt || null,
		publishedAt: t.publishedAt || null,
		fundedAt: t.fundedAt || null,
		expiresAt: t.expiresAt || null,
		counts: {
			submissions: t.counts?.submissionCount ?? 0,
			disputes: t.counts?.disputeCount ?? 0,
		},
		likeCount: t.likeCount ?? 0,
		reward: {
			totalUsd: t.rewardTotalUsd ?? null,
			pricedAt: t.rewardPricedAt || null,
			sol: solLeg ? solLeg.amount : null,
			legs,
		},
		attachments: (t.attachments || []).map((a) => ({
			filename: a.filename,
			kind: a.kind,
			contentType: a.contentType,
			size: a.size,
			url: a.url,
		})),
		onChain: {
			programId: t.pumpBountiesProgramId || PROGRAM_ID,
			bountyId: t.onChainBountyId || null,
			config: t.chainConfigSnapshot || null,
		},
		// Present only on the detail endpoint.
		rewardDistribution: t.rewardDistribution ?? null,
	};
}

export function normalizeSubmission(s) {
	if (!s || typeof s !== 'object') return null;
	return {
		submissionId: s.submissionId,
		taskId: s.taskId,
		body: s.bodyMarkdown || '',
		requester: s.requesterAddress || null,
		likeCount: s.likeCount ?? 0,
		createdAt: s.createdAt || null,
		publishedAt: s.publishedAt || null,
		updatedAt: s.updatedAt || null,
		attachments: (s.attachments || []).map((a) => ({
			filename: a.filename,
			kind: a.kind,
			contentType: a.contentType,
			size: a.size,
			url: a.url,
		})),
	};
}

export async function listBounties({ limit = 30, cursor = null, status = null } = {}) {
	const qs = new URLSearchParams();
	qs.set('limit', String(clampLimit(limit)));
	if (cursor) qs.set('cursor', cursor);
	if (status) qs.set('status', status);
	const data = await pumpGoGet(`/bounties/tasks?${qs}`);
	const items = (data.items || []).map(normalizeTask).filter(Boolean);
	return { items, nextCursor: data.nextCursor || null };
}

export async function getBounty(taskId) {
	const data = await pumpGoGet(`/bounties/tasks/${encodeURIComponent(taskId)}`);
	return normalizeTask(data);
}

export async function getSubmissions(taskId, { limit = 30 } = {}) {
	const qs = new URLSearchParams();
	qs.set('limit', String(clampLimit(limit)));
	const data = await pumpGoGet(`/bounties/tasks/${encodeURIComponent(taskId)}/submissions?${qs}`);
	const raw = data.items || (Array.isArray(data) ? data : []);
	return {
		items: raw.map(normalizeSubmission).filter(Boolean),
		nextCursor: data.nextCursor || null,
	};
}
export { REST_BASE, PROGRAM_ID, WSOL_MINT };
