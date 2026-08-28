#!/usr/bin/env node
/**
 * Turn a feedback report into a failing test in this repo.
 *
 *   npm run feedback:repro -- <report-id>
 *   npm run feedback:repro -- <report-id> --run
 *   npm run feedback:repro -- --list
 *
 * This is the last mile of the loop that starts when a visitor tells the corner
 * companion something is broken. The session they recorded (packages/witness)
 * compiles into a Playwright spec written to tests/repros/, and the spec asserts
 * the FAILURE IS GONE, so it is red now and green when the bug is fixed. The
 * report stops being a description of a bug and becomes the test for it.
 *
 * Reads the database directly rather than the HTTP API, because the person
 * running this is already the maintainer and should not have to mint a session
 * to read their own queue. Needs DATABASE_URL (.env.local).
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'tests', 'repros');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

function usage(message) {
	if (message) console.error(`\n${message}\n`);
	console.error('Usage:');
	console.error('  npm run feedback:repro -- <report-id>      write tests/repros/<slug>.spec.js');
	console.error('  npm run feedback:repro -- <report-id> --run  write it, then run it');
	console.error('  npm run feedback:repro -- --list            list reports that carry a recorded session');
	console.error('  npm run feedback:repro -- <id> --base <url> replay against a different origin');
	process.exit(message ? 1 : 0);
}

if (flags.has('--help') || flags.has('-h')) usage();

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is not set. Run with `node --env-file=.env.local` or export it first.');
	process.exit(2);
}

const { sql } = await import('../api/_lib/db.js');
const { compileToPlaywright, narrate, replayConfidence } = await import('../packages/witness/src/compile.js');

if (flags.has('--list')) {
	const rows = await sql`
		select id, coalesce(summary, left(body, 70)) as label, route, replay_confidence, trace_steps,
		       status, created_at
		from feedback_reports
		where trace is not null
		order by created_at desc
		limit 30
	`;
	if (!rows.length) {
		console.log('No reports carry a recorded session yet.');
		console.log('One arrives as soon as somebody reports a problem from a page running the recorder.');
		process.exit(0);
	}
	console.log(`${rows.length} report(s) with a replayable session:\n`);
	for (const row of rows) {
		const score = row.replay_confidence ?? 0;
		console.log(
			`  ${row.id}  ${String(score).padStart(3)}/100  ${String(row.trace_steps ?? 0).padStart(2)} steps  ` +
				`${(row.route || '').padEnd(24).slice(0, 24)}  ${row.label}`,
		);
	}
	console.log('\nCompile one:  npm run feedback:repro -- <id>');
	process.exit(0);
}

const id = positional[0];
if (!id) usage('Pass a report id, or --list to see the ones that can be replayed.');

const [report] = await sql`
	select id, body, summary, route, build_sha, trace, trace_steps, replay_confidence, created_at
	from feedback_reports
	where id = ${id}
`;

if (!report) {
	console.error(`No feedback report with id ${id}. Try --list.`);
	process.exit(1);
}
if (!report.trace) {
	console.error(`Report ${id} has no recorded session, so there is nothing to replay.`);
	console.error('Reports filed before the recorder shipped, or from a browser that opted out, arrive without one.');
	process.exit(1);
}

const baseIdx = args.indexOf('--base');
const baseUrl = baseIdx >= 0 ? args[baseIdx + 1] : process.env.WITNESS_REPRO_BASE_URL || 'http://localhost:3000';

const compiled = compileToPlaywright(report.trace, {
	title: report.summary || report.body || 'reported issue',
	baseUrl,
	reportId: report.id,
});

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, compiled.filename);
const existed = existsSync(outPath);
writeFileSync(outPath, compiled.source);

const confidence = replayConfidence(report.trace);
const steps = narrate(report.trace);

console.log(`\n${existed ? 'Rewrote' : 'Wrote'} ${relative(ROOT, outPath)}`);
console.log(`Replay confidence ${confidence.score}/100. ${confidence.note}`);
console.log(`Replaying against ${baseUrl}\n`);
console.log('What the visitor did:');
for (const step of steps) console.log(`  ${step}`);

if (flags.has('--run')) {
	console.log(`\nRunning it. It should FAIL while the reported bug is present.\n`);
	// Repros carry their own config: they live outside tests/e2e precisely so an
	// unfixed bug does not turn `npm test` red for everyone.
	const result = spawnSync('npx', ['playwright', 'test', '-c', 'tests/repros/playwright.config.mjs', relative(OUT_DIR, outPath)], {
		cwd: ROOT,
		stdio: 'inherit',
	});
	// A failing repro is the expected outcome, not an error in this script, so
	// the exit code is passed through for CI while the message stays honest.
	if (result.status !== 0) {
		console.log('\nThe reproduction failed, which means it reproduces. Fix the bug and run it again.');
	} else {
		console.log('\nThe reproduction passed. Either the bug is already fixed, or the session did not capture it.');
	}
	process.exit(result.status ?? 0);
}

console.log(`\nRun it:  npx playwright test -c tests/repros/playwright.config.mjs ${relative(OUT_DIR, outPath)}`);
console.log('It is red until the bug is fixed.\n');
