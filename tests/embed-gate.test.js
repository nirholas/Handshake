// Unit tests for token-gated 3D embeds (store-submissions campaign, prompt 18;
// retired, see git history).
//
// Covers the two things the store-submission prompt calls out explicitly:
//   - gate pass/fail by balance (getSplTokenBalance + meetsGateThreshold, and
//     the end-to-end decision a real RPC response drives)
//   - access-token expiry (embed-gate-token.js sign/verify round trip)
// plus the config-normalization helpers both api/embed/gate-create.js and the
// create_gated_embed MCP tool depend on.

import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';

// embed-gate-token.js reads env.JWT_SECRET at call time (not import time), so
// setting it before the module is imported is enough — no need to reset a
// per-test module registry.
beforeAll(() => {
	process.env.JWT_SECRET = 'test-jwt-secret-embed-gate-0123456789';
});

import {
	DEFAULT_GATE_MINT,
	normalizeMinAmount,
	normalizeMint,
	meetsGateThreshold,
	getSplTokenBalance,
} from '../api/_lib/embed-gate.js';
import { signEmbedGateToken, verifyEmbedGateToken, EMBED_GATE_TOKEN_TTL_S } from '../api/_lib/embed-gate-token.js';

describe('normalizeMinAmount', () => {
	it('passes through a positive finite number', () => {
		expect(normalizeMinAmount(5000)).toBe(5000);
	});
	it('treats zero, negative, NaN, and non-numeric input as invalid (0)', () => {
		expect(normalizeMinAmount(0)).toBe(0);
		expect(normalizeMinAmount(-10)).toBe(0);
		expect(normalizeMinAmount(NaN)).toBe(0);
		expect(normalizeMinAmount('not a number')).toBe(0);
		expect(normalizeMinAmount(undefined)).toBe(0);
	});
	it('clamps an absurd value to the max ceiling', () => {
		expect(normalizeMinAmount(1e20)).toBe(1e15);
	});
});

describe('normalizeMint', () => {
	it('defaults to $THREE when no mint is supplied', () => {
		expect(normalizeMint()).toBe(DEFAULT_GATE_MINT);
		expect(normalizeMint('')).toBe(DEFAULT_GATE_MINT);
		expect(normalizeMint('   ')).toBe(DEFAULT_GATE_MINT);
	});
	it('passes through a trimmed runtime mint — the coin-agnostic plumbing exception', () => {
		expect(normalizeMint('  SomeOtherMintAddress111111111111111111  ')).toBe(
			'SomeOtherMintAddress111111111111111111',
		);
	});
});

describe('meetsGateThreshold — gate pass/fail by balance', () => {
	it('passes when the balance meets the requirement exactly', () => {
		expect(meetsGateThreshold(5000, 5000)).toBe(true);
	});
	it('passes when the balance exceeds the requirement', () => {
		expect(meetsGateThreshold(5000.5, 5000)).toBe(true);
	});
	it('fails when the balance is below the requirement', () => {
		expect(meetsGateThreshold(4999.99, 5000)).toBe(false);
	});
	it('fails a zero balance against any positive requirement', () => {
		expect(meetsGateThreshold(0, 1)).toBe(false);
	});
});

describe('getSplTokenBalance — real Solana RPC read, gate pass/fail end-to-end', () => {
	const WALLET = 'ThreeWsSyntheticTestWallet1111111111111111';
	const MINT = DEFAULT_GATE_MINT;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const rpcOk = (accounts) => ({
		ok: true,
		status: 200,
		json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: accounts } }),
	});

	function tokenAccount(uiAmount) {
		return { account: { data: { parsed: { info: { tokenAmount: { uiAmount } } } } } };
	}

	it('sums balances across every token account the RPC returns (a real holder — PASS)', async () => {
		const fetchMock = vi.fn(async () => rpcOk([tokenAccount(3000), tokenAccount(2000.5)]));
		vi.stubGlobal('fetch', fetchMock);
		const balance = await getSplTokenBalance(WALLET, MINT);
		expect(balance).toBe(5000.5);
		expect(meetsGateThreshold(balance, 5000)).toBe(true);
	});

	it('returns 0 for a wallet with no token accounts for this mint (a non-holder — FAIL)', async () => {
		const fetchMock = vi.fn(async () => rpcOk([]));
		vi.stubGlobal('fetch', fetchMock);
		const balance = await getSplTokenBalance(WALLET, MINT);
		expect(balance).toBe(0);
		expect(meetsGateThreshold(balance, 1)).toBe(false);
	});

	it('fails over to the next RPC endpoint when the first is down, without losing the result', async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			if (calls === 1) return { ok: false, status: 503 };
			return rpcOk([tokenAccount(9999)]);
		});
		vi.stubGlobal('fetch', fetchMock);
		const balance = await getSplTokenBalance(WALLET, MINT);
		expect(balance).toBe(9999);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it('throws when every endpoint fails, so the caller can render a designed error instead of a wrong balance', async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		await expect(getSplTokenBalance(WALLET, MINT)).rejects.toThrow();
	});
});

describe('embed gate access tokens — sign/verify and expiry', () => {
	const CLAIMS = {
		gateId: 'gate123abc',
		assetId: 'avatar:8e3c9b1a-0000-4000-8000-000000000001',
		wallet: 'ThreeWsSyntheticTestWallet1111111111111111',
		mint: DEFAULT_GATE_MINT,
		minAmount: 5000,
		amount: 7250.25,
	};

	it('mints a token that verifies and round-trips every claim', async () => {
		const token = await signEmbedGateToken(CLAIMS);
		expect(typeof token).toBe('string');
		expect(token.startsWith('eg1.')).toBe(true);

		const claim = await verifyEmbedGateToken(token, { assetId: CLAIMS.assetId, gateId: CLAIMS.gateId });
		expect(claim).not.toBeNull();
		expect(claim.gateId).toBe(CLAIMS.gateId);
		expect(claim.assetId).toBe(CLAIMS.assetId);
		expect(claim.wallet).toBe(CLAIMS.wallet);
		expect(claim.mint).toBe(CLAIMS.mint);
		expect(claim.minAmount).toBe(CLAIMS.minAmount);
		expect(claim.amount).toBe(CLAIMS.amount);
		expect(claim.exp - claim.iat).toBe(EMBED_GATE_TOKEN_TTL_S);
	});

	it('rejects an expired token — the anti-abuse re-verification trigger', async () => {
		const realNow = Date.now;
		let expiredToken;
		try {
			Date.now = () => realNow() - (EMBED_GATE_TOKEN_TTL_S + 60) * 1000;
			expiredToken = await signEmbedGateToken(CLAIMS);
		} finally {
			Date.now = realNow;
		}
		const claim = await verifyEmbedGateToken(expiredToken, { assetId: CLAIMS.assetId });
		expect(claim).toBeNull();
	});

	it('rejects a token whose signature was tampered with', async () => {
		const token = await signEmbedGateToken(CLAIMS);
		const parts = token.split('.');
		const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].slice(-1) === 'a' ? 'b' : 'a'}`;
		expect(await verifyEmbedGateToken(tampered, { assetId: CLAIMS.assetId })).toBeNull();
	});

	it('rejects a token whose payload was tampered with (amount escalation attempt)', async () => {
		const token = await signEmbedGateToken(CLAIMS);
		const [prefix, body, sig] = token.split('.');
		const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		payload.amt = 999999999; // attacker tries to inflate their proven balance
		const forgedBody = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
		const forged = `${prefix}.${forgedBody}.${sig}`;
		expect(await verifyEmbedGateToken(forged, { assetId: CLAIMS.assetId })).toBeNull();
	});

	it('rejects a token issued for a different asset', async () => {
		const token = await signEmbedGateToken(CLAIMS);
		expect(await verifyEmbedGateToken(token, { assetId: 'avatar:different-asset-id-0000000000' })).toBeNull();
	});

	it('rejects a token issued for a since-superseded gate id (creator raised the requirement)', async () => {
		const token = await signEmbedGateToken(CLAIMS);
		expect(await verifyEmbedGateToken(token, { assetId: CLAIMS.assetId, gateId: 'a-newer-gate-id' })).toBeNull();
	});

	it('rejects malformed input without throwing', async () => {
		expect(await verifyEmbedGateToken(null)).toBeNull();
		expect(await verifyEmbedGateToken('')).toBeNull();
		expect(await verifyEmbedGateToken('not-a-real-token')).toBeNull();
		expect(await verifyEmbedGateToken('eg1.onlyonepart')).toBeNull();
	});
});
