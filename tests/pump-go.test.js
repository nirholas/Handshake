// Unit tests for the pump.fun GO client's pure normalizers.
//
// The upstream Task shape is verbose and reward amounts arrive as atomic strings
// across multiple legs; the UI relies on normalizeTask flattening that correctly
// (USD joined by mint, SOL leg detected, atomic→human, the on-chain bridge kept).
// Fixture mirrors a real livestream-api.pump.fun/bounties/tasks item.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	normalizeTask,
	normalizeSubmission,
	getBounty,
	getSubmissions,
	listBounties,
	PumpGoError,
	WSOL_MINT,
} from '../api/_lib/pump-go.js';

const TASK = {
	taskId: 'b4a26396-75a7-4bce-a3b5-e3c99aaa73c1',
	creatorAddress: 'Epb1111111111111111111111111111111111111111',
	creatorXFollowerCount: 1200,
	creatorXVerified: true,
	title: 'Tweet about $three',
	bodyMarkdown: 'Make a thread.',
	submissionVisibility: 'PUBLIC',
	status: 'PENDING_RESOLUTION',
	createdAt: '2026-06-07T21:12:25.592Z',
	publishedAt: '2026-06-07T21:13:00.000Z',
	fundedAt: '2026-06-07T21:14:00.000Z',
	expiresAt: '2026-06-14T21:12:25.592Z',
	counts: { disputeCount: 1, submissionCount: 4 },
	likeCount: 9,
	criteria: [
		{ id: 'c1', text: 'Image attached', required: true, order: 0 },
		{ id: 'c2', text: 'Tag the project', required: false, order: 1 },
	],
	pumpBountiesProgramId: 'goGzNYTYkSEe4hUqz6dPmY5uf3CTt36AQAoujXDrKiV',
	onChainBountyId: '7027385768702475239',
	chainConfigSnapshot: { publishFeeLamports: '10000000', disputeWindowSeconds: '28800' },
	rewardLegs: [
		{
			mintAddress: WSOL_MINT,
			tokenProgramId: 'Tokenkeg...',
			amountAtomic: '500000000',
			remainingAmountAtomic: '250000000',
			decimalsSnapshot: 9,
			rewardVaultAddress: 'H8Rt1111111111111111111111111111111111111111',
		},
	],
	rewardLegsUsd: [{ mintAddress: WSOL_MINT, priceUsd: 64.7, priced: true, usdValue: 32.35 }],
	rewardTotalUsd: 32.35,
	rewardPricedAt: '2026-06-07T21:20:00.000Z',
	attachments: [
		{
			filename: 'banner.png',
			kind: 'image',
			contentType: 'image/webp',
			size: 108448,
			url: 'https://s3/x.png',
		},
	],
	coinAddress: '6oEoK1111111111111111111111111111111111111',
};

describe('normalizeTask', () => {
	const n = normalizeTask(TASK);

	it('flattens core fields', () => {
		expect(n.taskId).toBe(TASK.taskId);
		expect(n.title).toBe('Tweet about $three');
		expect(n.status).toBe('PENDING_RESOLUTION');
		expect(n.counts).toEqual({ submissions: 4, disputes: 1 });
		expect(n.likeCount).toBe(9);
		expect(n.criteria).toHaveLength(2);
		expect(n.criteria[0]).toEqual({
			id: 'c1',
			text: 'Image attached',
			required: true,
			order: 0,
		});
	});

	it('detects the SOL leg and converts atomics to human amounts', () => {
		expect(n.reward.totalUsd).toBe(32.35);
		expect(n.reward.sol).toBe(0.5); // 500000000 / 1e9
		const leg = n.reward.legs[0];
		expect(leg.isSol).toBe(true);
		expect(leg.amount).toBe(0.5);
		expect(leg.remaining).toBe(0.25);
		expect(leg.usd).toBe(32.35); // joined from rewardLegsUsd by mint
		expect(leg.vault).toBe('H8Rt1111111111111111111111111111111111111111');
	});

	it('keeps the on-chain bridge + creator + attachments', () => {
		expect(n.onChain.programId).toBe('goGzNYTYkSEe4hUqz6dPmY5uf3CTt36AQAoujXDrKiV');
		expect(n.onChain.bountyId).toBe('7027385768702475239');
		expect(n.creator).toEqual({
			address: TASK.creatorAddress,
			xFollowers: 1200,
			xVerified: true,
		});
		expect(n.attachments[0].url).toBe('https://s3/x.png');
	});

	it('leaves reward.sol null when no leg is wSOL', () => {
		const tokenOnly = normalizeTask({
			...TASK,
			rewardLegs: [
				{ mintAddress: 'TokenMint1111', amountAtomic: '1000000', decimalsSnapshot: 6 },
			],
			rewardLegsUsd: [],
		});
		expect(tokenOnly.reward.sol).toBeNull();
		expect(tokenOnly.reward.legs[0].amount).toBe(1); // 1e6 / 1e6
		expect(tokenOnly.reward.legs[0].usd).toBeNull();
	});

	it('returns null for garbage input', () => {
		expect(normalizeTask(null)).toBeNull();
		expect(normalizeTask('nope')).toBeNull();
	});
});

describe('normalizeSubmission', () => {
	it('flattens a submission', () => {
		const s = normalizeSubmission({
			submissionId: 's1',
			taskId: 't1',
			bodyMarkdown: 'Done it.',
			requesterAddress: 'GXrz11mhPwVNEfERQC7Set4vwKWfGDJotVj9W9F5Y7XV',
			likeCount: 3,
			createdAt: '2026-06-08T07:08:31.689Z',
			attachments: [
				{
					filename: 'p.png',
					kind: 'image',
					contentType: 'image/png',
					size: 1,
					url: 'https://s3/p',
				},
			],
		});
		expect(s.submissionId).toBe('s1');
		expect(s.body).toBe('Done it.');
		expect(s.requester).toBe('GXrz11mhPwVNEfERQC7Set4vwKWfGDJotVj9W9F5Y7XV');
		expect(s.likeCount).toBe(3);
		expect(s.attachments[0].url).toBe('https://s3/p');
	});

	it('returns null for garbage', () => {
		expect(normalizeSubmission(undefined)).toBeNull();
	});
});

// The error code travels to the client as the `error` field of the API envelope
// (api/pump-bounties/[id].js), so a bounty that simply does not exist must not
// be reported as an upstream fault. These pin that mapping.
describe('PumpGoError status/code mapping', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function respond({ status = 200, body = {}, text = null }) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			status,
			ok: status >= 200 && status < 300,
			json: () => (text === null ? Promise.resolve(body) : Promise.reject(new SyntaxError('not json'))),
		});
	}

	it('maps an upstream 404 to a 404 not_found, not an upstream fault', async () => {
		respond({ status: 404 });
		const err = await getBounty('7fcd01f0-a7cc-4c51-9c02-367a17021b77').catch((e) => e);
		expect(err).toBeInstanceOf(PumpGoError);
		expect(err.status).toBe(404);
		expect(err.code).toBe('not_found');
	});

	it('maps any other upstream failure to a 502 pump_go_upstream', async () => {
		respond({ status: 503 });
		const err = await listBounties({ limit: 10 }).catch((e) => e);
		expect(err.status).toBe(502);
		expect(err.code).toBe('pump_go_upstream');
	});

	it('maps an unreachable upstream to a 504', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
		const err = await listBounties({}).catch((e) => e);
		expect(err.status).toBe(504);
		expect(err.code).toBe('pump_go_upstream');
	});

	it('maps a non-JSON 200 to a 502 rather than crashing the handler', async () => {
		respond({ status: 200, text: '<html>maintenance</html>' });
		const err = await getSubmissions('7fcd01f0-a7cc-4c51-9c02-367a17021b77').catch((e) => e);
		expect(err.status).toBe(502);
		expect(err.code).toBe('pump_go_upstream');
	});

	it('returns the normalized bounty on the success path', async () => {
		respond({ status: 200, body: TASK });
		const bounty = await getBounty(TASK.taskId);
		expect(bounty.taskId).toBe(TASK.taskId);
		expect(bounty.reward.sol).toBe(0.5);
	});
});
