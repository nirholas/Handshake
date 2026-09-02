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
import {
	jobId,
	runStateAction,
	cronSecretFromArgs,
	cronSecretFromService,
	selectCrons,
} from '../scripts/create-gcp-scheduler.mjs';

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

// Production's authoritative CRON_SECRET lives on the Cloud Run service, not in
// any checked-out file: .env does not carry it and `vercel env pull` returns
// empty for secret-type vars. Without this fallback, repairing a drifted cron on
// a fresh machine dead-ends on "CRON_SECRET not set" even with gcloud working.
describe('cronSecretFromService', () => {
	const service = (env) => () => JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } });

	it('reads the secret out of the service env', () => {
		expect(
			cronSecretFromService(service([{ name: 'DATABASE_URL', value: 'postgres://x' }, { name: 'CRON_SECRET', value: 's3cr3t' }])),
		).toBe('s3cr3t');
	});

	it('returns null when the service does not carry one', () => {
		expect(cronSecretFromService(service([{ name: 'DATABASE_URL', value: 'postgres://x' }]))).toBe(null);
	});

	// A secret-manager-backed var has valueFrom instead of value; treating that
	// empty string as a secret would write an unauthenticated header to 111 jobs.
	it('rejects a secret-manager reference that carries no inline value', () => {
		expect(cronSecretFromService(service([{ name: 'CRON_SECRET', valueFrom: { secretKeyRef: { key: 'latest' } } }]))).toBe(
			null,
		);
	});

	// An unauthenticated gcloud must not deny a caller who passed --env-file.
	it('returns null instead of throwing when gcloud fails', () => {
		expect(
			cronSecretFromService(() => {
				throw new Error('Reauthentication failed.');
			}),
		).toBe(null);
	});
});

describe('selectCrons', () => {
	const crons = [
		{ path: '/api/cron/garment-job-sweep', schedule: '*/10 * * * *' },
		{ path: '/api/cron/garment-catalog-audit', schedule: '20 6 * * *' },
		{ path: '/api/cron/economy-tick', schedule: '* * * * *' },
	];

	it('syncs every declared cron when no filter is passed', () => {
		expect(selectCrons(crons, ['--env-file', '/tmp/prod.env'])).toEqual(crons);
	});

	it('narrows a repair to the one drifted job instead of the whole fleet', () => {
		expect(selectCrons(crons, ['--only', 'garment-job-sweep']).map((c) => c.path)).toEqual([
			'/api/cron/garment-job-sweep',
		]);
	});

	it('accepts a comma-separated list', () => {
		expect(selectCrons(crons, ['--only', 'garment-job-sweep,economy-tick']).map((c) => c.path)).toEqual([
			'/api/cron/garment-job-sweep',
			'/api/cron/economy-tick',
		]);
	});

	// A filter that quietly matched nothing would print a clean "0/0 jobs synced"
	// and leave the drifted cron exactly as missing as it was.
	it('refuses a filter that matches nothing rather than syncing zero jobs', () => {
		expect(() => selectCrons(crons, ['--only', 'no-such-cron'])).toThrow(/matched none/);
	});

	it('refuses a bare --only with no value', () => {
		expect(() => selectCrons(crons, ['--only'])).toThrow(/needs a value/);
		expect(() => selectCrons(crons, ['--only', '--resume'])).toThrow(/needs a value/);
	});

	it('matches a real declared cron path from vercel.json', () => {
		const { crons: declared } = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
		const picked = selectCrons(declared, ['--only', 'garment-job-sweep']);
		expect(picked).toHaveLength(1);
		expect(jobId(picked[0].path)).toBe('cron--api-cron-garment-job-sweep');
	});
});

describe('jobId', () => {
	// The leading slash of the path becomes a hyphen of its own, so a live job id
	// carries a DOUBLE hyphen after the prefix. Every hand-typed `gcloud scheduler
	// jobs pause|run|describe` command that spells it with one hyphen fails with
	// NOT_FOUND, which is why the exact string is pinned here.
	it('matches the ids Cloud Scheduler already holds', () => {
		expect(jobId('/api/cron/economy-tick')).toBe('cron--api-cron-economy-tick');
		expect(jobId('/api/llm/health')).toBe('cron--api-llm-health');
	});

	it('collapses every run of non-alphanumerics to a single hyphen', () => {
		expect(jobId('/api/cron/a__b.c')).toBe('cron--api-cron-a-b-c');
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

// The cron count is quoted as a literal in prose across the repo, and every copy
// rots the moment a cron lands: on 2026-08-14 vercel.json held 107 while
// README.md said 105 and docs/build.md said 103. scripts/check-claude-md.mjs
// already pins the number in CLAUDE.md; this covers the other prose that states
// it, so adding a cron fails here instead of silently making three docs wrong.
describe('the documented cron count', () => {
	const QUOTING_FILES = ['README.md', 'docs/build.md'];
	// Only "<N> crons/entries in vercel.json" phrasings. Incident write-ups that
	// count crons which SKIPPED (docs/ops/db-retention.md, production-log-triage)
	// are historical records of a different quantity and must not be swept in.
	const QUOTED = /\((\d{2,4}) entries on \d{4}-\d{2}-\d{2}\)|\b(\d{2,4}) crons in `vercel\.json`/g;

	it('matches the vercel.json crons array everywhere it is stated', () => {
		const expected = JSON.parse(readFileSync('vercel.json', 'utf8')).crons.length;
		const wrong = [];
		let quotes = 0;
		for (const file of QUOTING_FILES) {
			const text = readFileSync(file, 'utf8');
			for (const m of text.matchAll(QUOTED)) {
				quotes += 1;
				const stated = Number(m[1] ?? m[2]);
				if (stated === expected) continue;
				const line = text.slice(0, m.index).split('\n').length;
				wrong.push(`${file}:${line} says ${stated}, vercel.json declares ${expected}`);
			}
		}
		expect(wrong, `stale cron counts:\n  ${wrong.join('\n  ')}`).toEqual([]);
		expect(quotes, 'the count pattern matched nothing; the prose was reworded').toBeGreaterThanOrEqual(
			QUOTING_FILES.length,
		);
	});
});
