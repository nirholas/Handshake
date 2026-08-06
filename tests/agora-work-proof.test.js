/**
 * Agora profession WORK modules — the proof contract (Task 04).
 *
 * The verifiable supply chain rests on one invariant: a producer's proofHash is
 * sha256 of the EXACT bytes served at its deliverable URL, so any Verifier can
 * re-download and re-derive the identical 32-byte hash. These tests pin that
 * invariant hermetically — no network — by:
 *   1. exercising the shared proof helpers (sha256, canonical JSON, resultData,
 *      the standard result builder), and
 *   2. driving the real runVerifier against `data:` deliverables whose bytes we
 *      control, asserting it re-derives a match and rejects a tampered proof.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import {
	sha256Hex,
	canonicalJsonBytes,
	packResultData,
	proofBytesFromHex,
	buildWorkResult,
} from '../workers/agora-citizens/work/_skills.js';
import { runVerifier } from '../workers/agora-citizens/work/verifier.js';
import { ACTIVE_PROFESSIONS, hasRunner, runProfession } from '../workers/agora-citizens/work/index.js';
import { buildRoster, primaryProfession, professionForAgent } from '../workers/agora-citizens/roster.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const dataUrl = (bytes, mime = 'application/octet-stream') =>
	`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

describe('proof helpers', () => {
	it('sha256Hex matches node crypto and is 64 hex chars', () => {
		const bytes = Buffer.from('hello agora', 'utf8');
		expect(sha256Hex(bytes)).toBe(sha(bytes));
		expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('canonical JSON is key-order independent', () => {
		const a = canonicalJsonBytes({ b: 1, a: { y: 2, x: 1 } });
		const b = canonicalJsonBytes({ a: { x: 1, y: 2 }, b: 1 });
		expect(a.equals(b)).toBe(true);
	});

	it('packResultData zero-pads to exactly 64 bytes and rejects overflow', () => {
		// The real builder emits "agora:<profession>:cid:sha256:<32-hex>" (≤64 B).
		const rd = packResultData('agora:sculptor:cid:sha256:' + 'f'.repeat(32));
		expect(rd).toBeInstanceOf(Uint8Array);
		expect(rd.length).toBe(64);
		// The on-chain slot is exactly [u8;64]; silently truncating a content-
		// addressed pointer would corrupt the reference, so an oversized pointer
		// must be rejected, never quietly clipped.
		expect(() => packResultData('x'.repeat(200))).toThrow(/exceeds 64 bytes/);
	});

	it('proofBytesFromHex round-trips to 32 bytes', () => {
		const hex = sha('proof');
		const bytes = proofBytesFromHex(hex);
		expect(bytes.length).toBe(32);
		expect(Buffer.from(bytes).toString('hex')).toBe(hex);
	});
});

describe('buildWorkResult — the standard profession return', () => {
	it('binds proofHash to the exact deliverable bytes', () => {
		const bytes = Buffer.from('GLB-LIKE-BYTES', 'utf8');
		const out = buildWorkResult({
			profession: 'sculptor',
			citizen: { agentIdHex: 'ab'.repeat(32), pubkey: null },
			deliverableUrl: 'https://cdn.example/x.glb',
			deliverableBytes: bytes,
			summary: 'sculpted a thing',
		});
		expect(out.proofHashHex).toBe(sha(bytes));
		expect(Buffer.from(out.proofHashBytes).toString('hex')).toBe(out.proofHashHex);
		expect(out.proofHashBytes.length).toBe(32);
		expect(out.resultData.length).toBe(64);
		expect(out.deliverableUrl).toBe('https://cdn.example/x.glb');
		expect(JSON.parse(out.resultText).proofHash).toBe(out.proofHashHex);
	});
});

describe('runVerifier — re-derives a producer proof (the trust loop)', () => {
	const cfg = { apiBase: 'https://three.ws', log: () => {} };
	const citizen = { agentIdHex: 'cd'.repeat(32), displayName: 'Vera' };

	it('PASSES when the deliverable hashes to the claimed proof', async () => {
		const bytes = Buffer.from('a real, byte-stable deliverable', 'utf8');
		const proofHash = sha(bytes);
		const out = await runVerifier({
			cfg,
			citizen,
			job: { target: { deliverableUrl: dataUrl(bytes), proofHash, profession: 'sculptor' } },
		});
		expect(out.vouch.match).toBe(true);
		expect(out.vouch.verdict).toBe('pass');
		expect(out.vouch.recomputed).toBe(proofHash);
		// The attestation itself is a real, hashable artifact.
		expect(out.proofHashHex).toMatch(/^[0-9a-f]{64}$/);
	});

	it('FAILS (no false vouch) when the proof does not match the bytes', async () => {
		const bytes = Buffer.from('the genuine bytes', 'utf8');
		const tampered = sha('different bytes entirely');
		const out = await runVerifier({
			cfg,
			citizen,
			job: { target: { deliverableUrl: dataUrl(bytes), proofHash: tampered, profession: 'scribe' } },
		});
		expect(out.vouch.match).toBe(false);
		expect(out.vouch.verdict).toBe('fail');
		expect(out.vouch.recomputed).toBe(sha(bytes));
	});

	it('rejects a target with no valid 32-byte proofHash', async () => {
		await expect(
			runVerifier({ cfg, citizen, job: { target: { deliverableUrl: dataUrl(Buffer.from('x')), proofHash: 'nope' } } }),
		).rejects.toThrow(/valid 32-byte/);
	});
});

describe('active roster — ships only professions with a reachable runner', () => {
	// The set that actually ships. Cartographer (bit 3) is deferred — its
	// /api/diorama compose route exceeds the serverless function budget — so it is
	// omitted from the active runners, not stubbed.
	const EXPECTED_ACTIVE = ['fetcher', 'sculptor', 'scribe', 'crier', 'appraiser', 'verifier', 'namekeeper'];

	it('the active set is exactly the shipped professions', () => {
		expect([...ACTIVE_PROFESSIONS].sort()).toEqual([...EXPECTED_ACTIVE].sort());
	});

	it('cartographer is omitted (deferred, not stubbed)', () => {
		expect(hasRunner('cartographer')).toBe(false);
		expect(() => runProfession('cartographer', {})).toThrow(/no work runner/);
	});

	it('no seeded citizen defaults to a profession without an active runner', () => {
		// A citizen's PRIMARY profession is its default WORK; every default fleet
		// citizen must have a reachable runner (never idles on a runnerless craft).
		const fleet = buildRoster([], { maxCitizens: 50 });
		expect(fleet.length).toBeGreaterThan(0);
		for (const c of fleet) {
			expect(hasRunner(c.profession), `${c.displayName} primaries "${c.profession}"`).toBe(true);
		}
	});

	it('the crafts survive a fleet crowded with platform agents', () => {
		// Every shapeSeeded() platform agent primaries `fetcher`; the crafts exist
		// only among the standalone specialists. When the platform-agent pool was
		// seated first, a populated DB plus the default cap of 4 cut every craft and
		// silently rebuilt the Fetcher-only workforce this task exists to replace.
		const seeds = Array.from({ length: 40 }, (_, i) => ({ id: `1111111${i}-0000-4000-8000-00000000000${i % 10}`, name: `Platform Agent ${i}` }));
		const fleet = buildRoster(seeds, { maxCitizens: 4 });

		expect(fleet).toHaveLength(4);
		const primaries = fleet.map((c) => c.profession);
		expect(primaries).not.toEqual(['fetcher', 'fetcher', 'fetcher', 'fetcher']);
		expect(primaries).toContain('sculptor');
		for (const c of fleet) expect(hasRunner(c.profession)).toBe(true);
	});

	it('platform agents still fill the fleet once the crafts are seated', () => {
		const seeds = Array.from({ length: 40 }, (_, i) => ({ id: `2222222${i}-0000-4000-8000-00000000000${i % 10}`, name: `Platform Agent ${i}` }));
		const fleet = buildRoster(seeds, { maxCitizens: 20 });

		expect(fleet).toHaveLength(20);
		// The seven standalone specialists, then real platform agents for the rest.
		expect(fleet.filter((c) => c.agentDbId != null).length).toBe(13);
		expect(new Set(fleet.map((c) => c.profession))).toContain('scribe');
	});

	it('professionForAgent never assigns a craft with no runner', () => {
		// Both paths: a real signal (category/tags/name) and the signal-less spread.
		const signalled = ['3d scene', 'world map', 'diorama builder', 'spatial architect', 'voice narrator', 'defi analytics', 'ens resolver', 'fact-check audit', 'research writing'];
		for (const category of signalled) {
			const prof = professionForAgent({ id: `sig-${category}`, category, tags: [], name: category });
			expect(hasRunner(prof), `"${category}" mapped to "${prof}"`).toBe(true);
		}
		for (let i = 0; i < 200; i++) {
			const prof = professionForAgent({ id: `signal-less-${i}`, category: null, tags: [], name: `Agent ${i}` });
			expect(hasRunner(prof), `signal-less agent ${i} mapped to "${prof}"`).toBe(true);
		}
	});

	it('verifier is never a citizen primary (it needs a verification target)', () => {
		// runVerifier requires job.target; if a citizen primaried it, a normal task
		// (no target) would always fail. Verifier is only ever a secondary bit.
		const fleet = buildRoster([], { maxCitizens: 50 });
		for (const c of fleet) {
			expect(primaryProfession(c.professionBits)).not.toBe('verifier');
			expect(c.profession).not.toBe('verifier');
		}
	});
});
