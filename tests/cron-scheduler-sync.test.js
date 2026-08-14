// Tests for the Cloud Scheduler sync script's pure decision logic
// (scripts/create-gcp-scheduler.mjs).
//
// Two things here can take the whole cron fleet down without leaving a trace in
// any config file, which is why they are pinned:
//
//   1. The run-state decision. A bare sync must NOT touch whether existing jobs
//      are running. When it paused every job by default, following the
//      `scripts/gcp-triage.mjs` remedy for one drifted cron stopped all of them
//      (payouts, buybacks, treasury, changelog push, dead-man switch) while
//      vercel.json still read as perfectly correct.
//   2. The job-id derivation, which is the only link between a declared cron and
//      its live job. `scripts/check-cron-drift.mjs` imports this exact function;
//      a second copy drifting by one character makes every job read as MISSING.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { jobId, runStateAction, cronSecretFromArgs } from '../scripts/create-gcp-scheduler.mjs';

describe('runStateAction', () => {
	it('leaves run state alone for a bare config sync', () => {
		expect(runStateAction([])).toBe(null);
		expect(runStateAction(['--env-file', '/tmp/prod.env'])).toBe(null);
	});

	it('pauses the fleet only when asked explicitly', () => {
		expect(runStateAction(['--pause'])).toBe('pause');
	});

	it('resumes the fleet only when asked explicitly', () => {
		expect(runStateAction(['--resume'])).toBe('resume');
	});

	it('refuses both levers at once rather than guessing an order', () => {
		expect(() => runStateAction(['--pause', '--resume'])).toThrow(/mutually exclusive/);
	});
});

describe('jobId', () => {
	it('matches the ids Cloud Scheduler already holds', () => {
		expect(jobId('/api/cron/economy-tick')).toBe('cron-api-cron-economy-tick');
		expect(jobId('/api/llm/health')).toBe('cron-api-llm-health');
	});

	it('collapses every run of non-alphanumerics to a single hyphen', () => {
		expect(jobId('/api/cron/a__b.c')).toBe('cron-api-cron-a-b-c');
	});

	it('produces one unique, id-legal job per declared cron', () => {
		const { crons } = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
		expect(crons.length).toBeGreaterThan(0);
		const ids = crons.map((c) => jobId(c.path));
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
			expect(id.length).toBeLessThanOrEqual(500);
		}
	});
});

describe('cronSecretFromArgs', () => {
	it('reads CRON_SECRET out of the named env file', () => {
		const read = () => 'OTHER=1\nCRON_SECRET="s3cr3t"\nMORE=2\n';
		expect(cronSecretFromArgs(['--env-file', 'prod.env'], read)).toBe('s3cr3t');
	});

	it('accepts an unquoted value', () => {
		expect(cronSecretFromArgs(['--env-file', 'prod.env'], () => 'CRON_SECRET=plain\n')).toBe('plain');
	});

	it('returns null when no env file was passed, so process.env can win', () => {
		expect(cronSecretFromArgs([])).toBe(null);
		expect(cronSecretFromArgs(['--env-file'])).toBe(null);
	});

	it('returns null when the file holds no CRON_SECRET line', () => {
		expect(cronSecretFromArgs(['--env-file', 'prod.env'], () => 'DATABASE_URL=x\n')).toBe(null);
	});
});
