// The profession WORK registry — one dispatch point for the daily loop's WORK
// step. Each profession is a capability bit (docs/agora.md / roster.js) backed by
// a REAL platform skill; every runner returns the same shape work/fetcher.js
// established, so the engine submits the proof on-chain and a Verifier can
// re-derive it:
//
//     run<Profession>({ cfg, citizen, job })
//       → { result, resultText, proofHashHex, proofHashBytes(32),
//           resultData(≤64), deliverableUrl, bytes, summary, ... }
//
// Open registry: add a bit + a real backing skill + its runner here, never a
// hardcoded allowlist. Nothing is stubbed — a profession appears only when its
// runner produces a real artifact + proof.

import { runFetcher, defaultTarget } from './fetcher.js';
import { runSculptor } from './sculptor.js';
import { runScribe } from './scribe.js';
import { runCrier } from './crier.js';
import { runAppraiser } from './appraiser.js';
import { runVerifier } from './verifier.js';
import { runNamekeeper } from './namekeeper.js';

// profession key → { runner, skill }. Bits/labels live in roster.js (the single
// source of truth for the capability bitmap); this maps a key to its real work.
export const WORK_RUNNERS = {
	fetcher: { runner: runFetcher, skill: 'x402 / HTTP service call' },
	sculptor: { runner: runSculptor, skill: 'text → rig-ready GLB (forge)' },
	scribe: { runner: runScribe, skill: 'research / write (brain)' },
	crier: { runner: runCrier, skill: 'TTS / voice clip (voice)' },
	appraiser: { runner: runAppraiser, skill: 'token / market intel (intel)' },
	verifier: { runner: runVerifier, skill: 're-derive proofHash + attest' },
	namekeeper: { runner: runNamekeeper, skill: '.sol resolve (names)' },
};

// Deferred, NOT stubbed — a documented capability bit with no active runner yet
// (docs/agora.md keeps the bit; the active roster reflects only what ships):
//   cartographer (bit 3) - the real backing skill is the /api/diorama `compose`
//     route (work/cartographer.js is complete and calls it for real), but that
//     route decomposes a scene via an LLM chain whose latency overruns the
//     request budget, so a citizen could never complete the job in time. Rather
//     than ship a profession that always fails (or a fake success), it is omitted
//     from WORK_RUNNERS. Re-activation is a one-line re-add here once
//     /api/diorama runs in budget: a longer request timeout on the Cloud Run
//     service, or a synchronous, in-budget compose lane.

/** The profession keys with a real, reachable backing skill (the active roster). */
export const ACTIVE_PROFESSIONS = Object.keys(WORK_RUNNERS);

/** Is there a real runner for this profession key? */
export function hasRunner(profession) {
	return Boolean(WORK_RUNNERS[String(profession || '').toLowerCase()]);
}

/**
 * Run the WORK step for a profession. The engine calls this in place of the
 * hardcoded Fetcher: `await runProfession(citizen.profession, { cfg, citizen, job })`.
 * Throws (a real task failure) if the profession has no runner.
 */
export function runProfession(profession, ctx) {
	const key = String(profession || '').toLowerCase();
	const entry = WORK_RUNNERS[key];
	if (!entry) throw new Error(`no work runner for profession "${profession}"`);
	return entry.runner(ctx);
}

export { runFetcher, defaultTarget, runSculptor, runScribe, runCrier, runAppraiser, runVerifier, runNamekeeper };
