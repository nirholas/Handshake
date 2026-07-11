// Wheel of Fortune server logic (W09/Task 19) — the RNG, level/cooldown/pack
// gates, and payment-settlement wiring in multiplayer/src/spin-wheel.js.
//
// game-token.js's split-payment primitives are mocked here — they make real
// Solana RPC calls and are already the exact code path the $THREE boutique
// exercises in production; this suite's job is to prove spin-wheel.js calls
// them correctly and never grants a prize without either a valid free-spin
// window or a verified on-chain payment.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../multiplayer/src/game-token.js', () => ({
	buildSpinPayment: vi.fn(),
	verifySpinPayment: vi.fn(),
	isWalletAddress: (s) => typeof s === 'string' && s.length >= 32 && s.length <= 44,
	tokenConfigured: vi.fn(() => true),
	TOKEN_DECIMALS: 6,
	TOKEN_SYMBOL: '$THREE',
}));

const gameToken = await import('../multiplayer/src/game-token.js');
const {
	WHEEL_SEGMENTS, FREE_SPIN_COOLDOWN_MS, MIN_AVG_LEVEL, SPIN_COST_USD,
	handleSpinInfo, handleSpinFree, handleSpinPaidPrep, handleSpinPaidSettle, registerSpinHandlers,
} = await import('../multiplayer/src/spin-wheel.js');
const { newProfile, serializeProfile, restoreProfile } = await import('../multiplayer/src/economy.js');
const { WHEEL } = await import('../multiplayer/src/world-features.js');

// A profile at the wheel's exact coordinates, at (or above) the level gate so
// tests can reach the RNG/payment paths without simulating XP grinding.
function eligibleProfile() {
	const p = newProfile('acct-1');
	for (const skill of Object.keys(p.levels)) p.levels[skill] = MIN_AVG_LEVEL;
	return p;
}

function makeRoom({ profile, x = WHEEL[0].x, z = WHEEL[0].z } = {}) {
	const sent = [];
	const room = {
		state: { players: new Map([['s1', { x, z }]]) },
		econ: new Map([['s1', profile || eligibleProfile()]]),
		_spinNonces: new Map(),
		_pruneSpinNonces: vi.fn(),
		_actionOk: () => true,
		_sendInv: vi.fn(),
		_questEvent: vi.fn(),
		_persistEcon: vi.fn(),
	};
	const client = { sessionId: 's1', send: (type, msg) => sent.push({ type, msg }) };
	return { room, client, sent };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('WHEEL_SEGMENTS — the paytable the client\'s fixed-angle wheel must match', () => {
	it('has exactly 20 segments, matching spin-wheel-ui.js\'s fixed wedge count', () => {
		expect(WHEEL_SEGMENTS.length).toBe(20);
	});
	it('is uniform-odds — every segment 5%, summing to exactly 100%', () => {
		expect(WHEEL_SEGMENTS.every((s) => s.oddsPct === 5)).toBe(true);
		expect(WHEEL_SEGMENTS.reduce((n, s) => n + s.oddsPct, 0)).toBe(100);
	});
	it('every segment has a positive amount and a label', () => {
		for (const s of WHEEL_SEGMENTS) {
			expect(s.label).toBeTruthy();
			expect(s.kind === 'gold' ? s.gold : s.qty).toBeGreaterThan(0);
		}
	});
});

describe('handleSpinInfo', () => {
	it('reports position/level/cooldown truthfully', () => {
		const { room, client, sent } = makeRoom();
		handleSpinInfo(room, client);
		const info = sent[0].msg;
		expect(sent[0].type).toBe('spinInfo');
		expect(info.atWheel).toBe(true);
		expect(info.eligible).toBe(true);
		expect(info.segments.length).toBe(20);
		expect(info.minLevel).toBe(MIN_AVG_LEVEL);
		expect(info.costUsd).toBe(SPIN_COST_USD);
	});
	it('reports not eligible and not at the wheel away from it, below level', () => {
		const { room, client, sent } = makeRoom({ profile: newProfile('acct-2'), x: 0, z: 0 });
		handleSpinInfo(room, client);
		const info = sent[0].msg;
		expect(info.atWheel).toBe(false);
		expect(info.eligible).toBe(false);
	});
});

describe('handleSpinFree — gates, in priority order', () => {
	it('denies not_at_wheel when away from the wheel, even if eligible', () => {
		const { room, client, sent } = makeRoom({ x: 0, z: 0 });
		handleSpinFree(room, client);
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'not_at_wheel' } });
	});
	it('denies level when at the wheel but under the average-level floor', () => {
		const { room, client, sent } = makeRoom({ profile: newProfile('acct-3') });
		handleSpinFree(room, client);
		expect(sent[0].type).toBe('spinDenied');
		expect(sent[0].msg.reason).toBe('level');
		expect(sent[0].msg.avgLevel).toBe(1);
		expect(sent[0].msg.minLevel).toBe(MIN_AVG_LEVEL);
	});
	it('denies cooldown when a free spin was already used', () => {
		const profile = eligibleProfile();
		profile.nextFreeSpinAt = Date.now() + 60_000;
		const { room, client, sent } = makeRoom({ profile });
		handleSpinFree(room, client);
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'cooldown', nextFreeSpinAt: profile.nextFreeSpinAt } });
	});
	it('denies pack_full when the pack has no room for wood, stone, or coal', () => {
		const profile = eligibleProfile();
		// Fill every slot with a non-stackable, unrelated item so nothing further fits.
		for (const s of profile.inv) { s.item = 'rod'; s.qty = 1; }
		const { room, client, sent } = makeRoom({ profile });
		handleSpinFree(room, client);
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'pack_full' } });
	});
	it('grants a real prize, sets the 12h cooldown, and persists — the success path', () => {
		const profile = eligibleProfile();
		const { room, client, sent } = makeRoom({ profile });
		const before = Date.now();
		handleSpinFree(room, client);
		expect(sent[0].type).toBe('spinResult');
		expect(sent[0].msg.mode).toBe('free');
		expect(sent[0].msg.index).toBeGreaterThanOrEqual(0);
		expect(sent[0].msg.index).toBeLessThan(20);
		expect(sent[0].msg.got).toBeGreaterThan(0);
		expect(profile.nextFreeSpinAt).toBeGreaterThanOrEqual(before + FREE_SPIN_COOLDOWN_MS);
		expect(room._sendInv).toHaveBeenCalledWith(client, profile);
		expect(room._persistEcon).toHaveBeenCalledWith('s1');
	});
	it('a second free spin immediately after denies on cooldown (no double-grant)', () => {
		const profile = eligibleProfile();
		const { room, client, sent } = makeRoom({ profile });
		handleSpinFree(room, client);
		expect(sent[0].type).toBe('spinResult');
		handleSpinFree(room, client);
		expect(sent[1].type).toBe('spinDenied');
		expect(sent[1].msg.reason).toBe('cooldown');
	});
});

describe('roll fairness — many spins land roughly uniformly across all 20 indices', () => {
	it('every index is reachable and no index dominates over a large sample', () => {
		const counts = new Array(20).fill(0);
		const N = 4000;
		for (let i = 0; i < N; i++) {
			const profile = eligibleProfile();
			const { room, client, sent } = makeRoom({ profile });
			handleSpinFree(room, client);
			counts[sent[0].msg.index]++;
		}
		expect(counts.every((c) => c > 0)).toBe(true);
		// Expected ~200/segment; a generous band catches a real bias without being flaky.
		const expected = N / 20;
		for (const c of counts) {
			expect(c).toBeGreaterThan(expected * 0.5);
			expect(c).toBeLessThan(expected * 1.5);
		}
	});
});

describe('handleSpinPaidPrep', () => {
	it('denies not_at_wheel / level / pack_full before ever touching payment', async () => {
		const away = makeRoom({ x: 0, z: 0 });
		await handleSpinPaidPrep(away.room, away.client, { wallet: '1'.repeat(32) });
		expect(away.sent[0].msg.reason).toBe('not_at_wheel');
		expect(gameToken.buildSpinPayment).not.toHaveBeenCalled();

		const underLevel = makeRoom({ profile: newProfile('acct-4') });
		await handleSpinPaidPrep(underLevel.room, underLevel.client, { wallet: '1'.repeat(32) });
		expect(underLevel.sent[0].msg.reason).toBe('level');
		expect(gameToken.buildSpinPayment).not.toHaveBeenCalled();
	});
	it('denies no_wallet when the payload carries no valid Solana address', async () => {
		const { room, client, sent } = makeRoom();
		await handleSpinPaidPrep(room, client, {});
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'no_wallet' } });
		expect(gameToken.buildSpinPayment).not.toHaveBeenCalled();
	});
	it('denies token_unavailable when the platform has no treasury configured', async () => {
		gameToken.tokenConfigured.mockReturnValueOnce(false);
		const { room, client, sent } = makeRoom();
		await handleSpinPaidPrep(room, client, { wallet: '1'.repeat(32) });
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'token_unavailable' } });
	});
	it('denies price_unavailable when buildSpinPayment cannot price the spin', async () => {
		gameToken.buildSpinPayment.mockResolvedValueOnce(null);
		const { room, client, sent } = makeRoom();
		await handleSpinPaidPrep(room, client, { wallet: '1'.repeat(32) });
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'price_unavailable' } });
	});
	it('sends the built quote/tx untouched to the client on success', async () => {
		gameToken.buildSpinPayment.mockResolvedValueOnce({
			txBase64: 'BASE64TX', quoteToken: 'QUOTE.SIG', quote: { total: '3000000' },
		});
		const wallet = '1'.repeat(32);
		const { room, client, sent } = makeRoom();
		await handleSpinPaidPrep(room, client, { wallet });
		expect(gameToken.buildSpinPayment).toHaveBeenCalledWith({ buyerWallet: wallet, usd: SPIN_COST_USD });
		expect(sent[0]).toEqual({
			type: 'spinPrep',
			msg: { tx: 'BASE64TX', tokenAmount: '3000000', symbol: '$THREE', costUsd: SPIN_COST_USD, quote: 'QUOTE.SIG' },
		});
	});
});

describe('handleSpinPaidSettle', () => {
	it('denies no_signature when the quote or signature is missing', async () => {
		const { room, client, sent } = makeRoom();
		await handleSpinPaidSettle(room, client, {});
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'no_signature' } });
		expect(gameToken.verifySpinPayment).not.toHaveBeenCalled();
	});
	it('relays the verifier\'s refusal reason verbatim on a bad/underpaid/unfound payment', async () => {
		gameToken.verifySpinPayment.mockResolvedValueOnce({ ok: false, reason: 'treasury_underpaid' });
		const { room, client, sent } = makeRoom();
		await handleSpinPaidSettle(room, client, { quote: 'q', txSig: 'sig'.repeat(12) });
		expect(sent[0]).toEqual({ type: 'spinDenied', msg: { reason: 'treasury_underpaid' } });
	});
	it('grants a real prize once verified — the paid success path', async () => {
		gameToken.verifySpinPayment.mockResolvedValueOnce({ ok: true, nonce: 'nonce-1' });
		const profile = eligibleProfile();
		const { room, client, sent } = makeRoom({ profile });
		await handleSpinPaidSettle(room, client, { quote: 'q', txSig: 'sig'.repeat(12) });
		expect(sent[0].type).toBe('spinResult');
		expect(sent[0].msg.mode).toBe('paid');
		expect(room._persistEcon).toHaveBeenCalledWith('s1');
		// A paid spin does NOT touch the free-spin cooldown.
		expect(profile.nextFreeSpinAt).toBe(0);
	});
	it('refuses to grant a second prize for an already-settled nonce (replay protection)', async () => {
		gameToken.verifySpinPayment.mockResolvedValue({ ok: true, nonce: 'nonce-replay' });
		const profile = eligibleProfile();
		const { room, client, sent } = makeRoom({ profile });
		await handleSpinPaidSettle(room, client, { quote: 'q', txSig: 'sig'.repeat(12) });
		expect(sent[0].type).toBe('spinResult');
		await handleSpinPaidSettle(room, client, { quote: 'q', txSig: 'sig'.repeat(12) });
		expect(sent[1]).toEqual({ type: 'spinDenied', msg: { reason: 'already_settled' } });
	});
});

describe('registerSpinHandlers', () => {
	it('registers exactly the four message types spin-wheel-ui.js sends', () => {
		const handlers = new Map();
		const room = { onMessage: (type, fn) => handlers.set(type, fn) };
		registerSpinHandlers(room);
		expect([...handlers.keys()].sort()).toEqual(['spinFree', 'spinInfo', 'spinPaidPrep', 'spinPaidSettle']);
	});
});

describe('nextFreeSpinAt persistence — must survive a reconnect (unlike the ephemeral cd map)', () => {
	it('round-trips through serializeProfile/restoreProfile', () => {
		const profile = newProfile('acct-persist');
		profile.nextFreeSpinAt = 1234567890;
		const restored = restoreProfile(serializeProfile(profile), 'acct-persist');
		expect(restored.nextFreeSpinAt).toBe(1234567890);
	});
	it('a fresh profile starts with no cooldown', () => {
		expect(newProfile('x').nextFreeSpinAt).toBe(0);
	});
	it('restoreProfile clamps a corrupt negative value to 0', () => {
		const restored = restoreProfile({ nextFreeSpinAt: -999 }, 'x');
		expect(restored.nextFreeSpinAt).toBe(0);
	});
});
