/**
 * Agora — humans as first-class citizens (Task 08) — unit tests for the pure
 * server-side logic the act endpoint depends on: the per-user spend policy +
 * mainnet gate (api/_lib/agora-policy.js) and the citizen helpers
 * (api/_lib/agora-human.js). All pure — no DB, no SDK build, no RPC — so they
 * run in CI regardless of whether @three-ws/solana-agent's dist/ exists or
 * DATABASE_URL is set (db.js is lazy; only the DB-touching daily-window read,
 * which we don't exercise here, would need it).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	resolveCluster, mainnetEnabled, spendCaps, checkPostSpend, reservePostSpend,
} from '../api/_lib/agora-policy.js';
import {
	professionToCapabilityBits, PROFESSION_BITS, rewardLabel, proofHashFor,
	THREE_ATOMICS_PER_TOKEN, explorerTx,
} from '../api/_lib/agora-human.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;

describe('agora-policy: cluster + mainnet gate', () => {
	const saved = process.env.AGORA_MAINNET_ENABLED;
	afterEach(() => { process.env.AGORA_MAINNET_ENABLED = saved; });

	it('defaults to devnet and never silently escalates to mainnet', () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		expect(resolveCluster('mainnet')).toBe('devnet');
		expect(resolveCluster('devnet')).toBe('devnet');
		expect(resolveCluster(undefined)).toBe('devnet');
		expect(mainnetEnabled()).toBe(false);
	});

	it('allows mainnet only when explicitly enabled AND requested', () => {
		process.env.AGORA_MAINNET_ENABLED = '1';
		expect(mainnetEnabled()).toBe(true);
		expect(resolveCluster('mainnet')).toBe('mainnet');
		expect(resolveCluster('devnet')).toBe('devnet'); // requesting devnet stays devnet
	});
});

describe('agora-policy: spend caps + atomic conversion', () => {
	const saved = { ...process.env };
	afterEach(() => {
		process.env.AGORA_DEVNET_MAX_SOL_PER_TASK = saved.AGORA_DEVNET_MAX_SOL_PER_TASK;
		process.env.AGORA_MAX_THREE_PER_TASK = saved.AGORA_MAX_THREE_PER_TASK;
	});

	it('devnet caps are denominated in SOL (lamports)', () => {
		delete process.env.AGORA_DEVNET_MAX_SOL_PER_TASK;
		const caps = spendCaps('devnet');
		expect(caps.asset).toBe('SOL');
		expect(caps.rewardMint).toBeNull(); // native SOL escrow on devnet
		expect(caps.perTaskAtomic).toBe(BigInt(Math.round(0.05 * Number(LAMPORTS_PER_SOL))));
	});

	it('mainnet caps are denominated in $THREE atomics (the only coin)', () => {
		delete process.env.AGORA_MAX_THREE_PER_TASK;
		const caps = spendCaps('mainnet');
		expect(caps.asset).toBe('$THREE');
		expect(caps.rewardMint).toBe('$THREE');
		expect(caps.perTaskAtomic).toBe(50_000n * THREE_ATOMICS_PER_TOKEN);
	});

	it('respects env overrides for the per-task cap', () => {
		process.env.AGORA_DEVNET_MAX_SOL_PER_TASK = '0.1';
		expect(spendCaps('devnet').perTask).toBe(0.1);
	});
});

describe('agora-policy: checkPostSpend boundary rejections (no DB)', () => {
	const saved = process.env.AGORA_MAINNET_ENABLED;
	afterEach(() => { process.env.AGORA_MAINNET_ENABLED = saved; });

	it('rejects mainnet when the server has not opted in', async () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		const r = await checkPostSpend({ citizenId: 'c1', cluster: 'devnet', amountAtomic: 1n, requestedCluster: 'mainnet' });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('mainnet_disabled');
		expect(r.status).toBe(403);
	});

	it('rejects a non-positive reward', async () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		const r = await checkPostSpend({ citizenId: 'c1', cluster: 'devnet', amountAtomic: 0n, requestedCluster: 'devnet' });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('validation_error');
	});

	it('rejects a reward over the per-task cap before touching the DB', async () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		// 1 SOL ≫ the 0.05 SOL default per-task cap → per_task_cap (early return).
		const r = await checkPostSpend({ citizenId: 'c1', cluster: 'devnet', amountAtomic: LAMPORTS_PER_SOL, requestedCluster: 'devnet' });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('per_task_cap');
		expect(r.status).toBe(403);
	});
});

describe('agora-policy: reservePostSpend rejects before it ever holds (no DB)', () => {
	const saved = process.env.AGORA_MAINNET_ENABLED;
	afterEach(() => { process.env.AGORA_MAINNET_ENABLED = saved; });

	// The hold is the thing that makes the daily cap race-proof, so a rejected
	// post must be rejected by the SAME rules as the read-only check and must
	// never reach the insert (these cases return before any DB call, which is
	// exactly what lets them run without DATABASE_URL).
	it('applies the mainnet gate before reserving', async () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		const r = await reservePostSpend({ citizenId: 'c1', cluster: 'devnet', amountAtomic: 1n, requestedCluster: 'mainnet' });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('mainnet_disabled');
	});

	it('applies the per-task cap before reserving', async () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		const r = await reservePostSpend({ citizenId: 'c1', cluster: 'devnet', amountAtomic: LAMPORTS_PER_SOL, requestedCluster: 'devnet' });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('per_task_cap');
	});

	it('rejects a non-positive reward before reserving', async () => {
		delete process.env.AGORA_MAINNET_ENABLED;
		const r = await reservePostSpend({ citizenId: 'c1', cluster: 'devnet', amountAtomic: 0n, requestedCluster: 'devnet' });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('validation_error');
	});
});

describe('agora-human: profession bitmap (open registry, mirrors docs)', () => {
	it('maps each profession to its documented bit', () => {
		expect(professionToCapabilityBits('fetcher')).toBe(1n); // bit 0
		expect(professionToCapabilityBits('scribe')).toBe(4n); // bit 2
		expect(professionToCapabilityBits('verifier')).toBe(64n); // bit 6
		expect(professionToCapabilityBits('namekeeper')).toBe(128n); // bit 7
	});

	it('is case-insensitive and returns 0n for an unknown profession', () => {
		expect(professionToCapabilityBits('SCRIBE')).toBe(4n);
		expect(professionToCapabilityBits('nonesuch')).toBe(0n);
		expect(professionToCapabilityBits(null)).toBe(0n);
	});

	it('keeps the eight canonical professions', () => {
		expect(Object.keys(PROFESSION_BITS)).toHaveLength(8);
	});
});

describe('agora-human: reward labels + proof', () => {
	it('labels devnet rewards as SOL and mainnet as $THREE only', () => {
		expect(rewardLabel(50_000_000n, 'devnet')).toBe('0.05 SOL');
		expect(rewardLabel(25_000n * THREE_ATOMICS_PER_TOKEN, 'mainnet')).toBe('25,000 $THREE');
	});

	it('derives a deterministic 32-byte (64-hex) proof from a deliverable', () => {
		const a = proofHashFor('hello world');
		const b = proofHashFor('hello world');
		const c = proofHashFor('different');
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it('builds cluster-correct explorer URLs', () => {
		expect(explorerTx('SIG', 'devnet')).toContain('cluster=devnet');
		expect(explorerTx('SIG', 'mainnet')).not.toContain('cluster=');
	});
});
