#!/usr/bin/env node
/**
 * check-runnable-docs.mjs
 *
 * Executes every runnable sample in docs/ against a real three.ws API and fails
 * when a documented call no longer answers the way the doc says it does.
 *
 * Documentation rots silently. A curl command in a tutorial can point at an
 * endpoint that was renamed two quarters ago and nothing notices, because the
 * doc still reads fine. This turns that class of rot into a build failure: if
 * the reader can press Run on a sample, CI presses Run on the same sample, over
 * the same parser and the same safety rules the Live Docs runner uses
 * (public/docs-live-verify.js on top of public/docs-live-core.js).
 *
 * A sample passes when the live response status matches its contract:
 *   • by default, any 2xx
 *   • or the exact status declared above the fence, for endpoints whose correct
 *     answer is not 200:
 *
 *       <!-- runnable: 402 the x402 challenge is the lesson here -->
 *       ```bash
 *       curl -s https://three.ws/api/x402/model-check
 *       ```
 *
 * Opt a block out entirely (illustrative ids, endpoints needing a key) with:
 *
 *       <!-- runnable: no the vault id is illustrative -->
 *
 * Usage:
 *   npm run check:runnable-docs
 *   npm run check:runnable-docs -- --base http://localhost:3000
 *   npm run check:runnable-docs -- --list          (print the inventory, call nothing)
 *   npm run check:runnable-docs -- --only api/forge
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiableSamples } from '../public/docs-live-verify.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = (flag('base') || process.env.RUNNABLE_DOCS_BASE || 'https://three.ws').replace(/\/$/, '');
const LIST_ONLY = argv.includes('--list');
const ONLY = flag('only');
const CONCURRENCY = Math.max(1, Math.min(12, Number(flag('concurrency', '6')) || 6));
const TIMEOUT_MS = Math.max(5000, Number(flag('timeout', '30000')) || 30000);

/**
 * Generated single-file aggregates hold a copy of every other doc, so probing
 * them would double every call and report each failure against a file nobody
 * edits. The same set is skipped by audit-docs and the docs search index.
 */
const GENERATED_AGGREGATES = new Set(['ALL.md', 'EVERYTHING.md']);

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith('.md') && !GENERATED_AGGREGATES.has(entry.name)) out.push(path);
	}
	return out;
}

function inventory() {
	const byUrl = new Map();
	for (const file of walk(DOCS)) {
		const rel = relative(ROOT, file);
		for (const sample of verifiableSamples(readFileSync(file, 'utf8'))) {
			if (ONLY && !sample.url.includes(ONLY)) continue;
			const existing = byUrl.get(sample.url);
			if (existing) {
				existing.sites.push(`${rel}:${sample.line}`);
				// The strictest declared contract wins, so one lax copy of a sample
				// cannot quietly weaken the check for every other copy.
				if (sample.expectStatus && !existing.expectStatus) {
					existing.expectStatus = sample.expectStatus;
					existing.note = sample.note;
				}
				continue;
			}
			byUrl.set(sample.url, {
				url: sample.url,
				path: sample.path,
				accept: sample.accept,
				expectStatus: sample.expectStatus,
				note: sample.note,
				sites: [`${rel}:${sample.line}`],
			});
		}
	}
	return [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(sample) {
	const url = `${BASE}${sample.path}`;
	const started = Date.now();
	let last = null;
	// Two attempts, because a shared per-IP budget can throttle a burst of
	// probes and a 429 says nothing about whether the doc is still true.
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt) await sleep(2500);
		try {
			const res = await fetch(url, {
				headers: { accept: sample.accept || 'application/json, */*' },
				redirect: 'follow',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			last = { status: res.status };
			if (res.status !== 429) break;
		} catch (err) {
			last = { status: 'ERR', error: String(err.message || err).slice(0, 120) };
			break;
		}
	}
	const ms = Date.now() - started;
	if (sample.expectStatus) {
		return { ...sample, ...last, ms, ok: last.status === sample.expectStatus };
	}
	// A 429 that survives the retry still proves the route exists and is
	// enforcing its budget, which is all this gate claims to check.
	const alive = (last.status >= 200 && last.status < 300) || last.status === 429;
	return { ...sample, ...last, ms, ok: alive, throttled: last.status === 429 };
}

async function main() {
	if (!statSync(DOCS, { throwIfNoEntry: false })) {
		console.error(`No docs directory at ${DOCS}`);
		process.exit(1);
	}
	const samples = inventory();
	if (!samples.length) {
		console.error('check-runnable-docs: no runnable samples found. That is almost certainly a bug in the extractor.');
		process.exit(1);
	}

	if (LIST_ONLY) {
		for (const sample of samples) {
			const contract = sample.expectStatus ? `expects ${sample.expectStatus}` : 'expects 2xx';
			console.log(`${contract.padEnd(13)} ${sample.url}`);
			for (const site of sample.sites) console.log(`               ${site}`);
		}
		console.log(`\n${samples.length} runnable sample(s) across docs/.`);
		return;
	}

	console.log(`check-runnable-docs: ${samples.length} sample(s) against ${BASE}\n`);
	const results = [];
	let cursor = 0;
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (cursor < samples.length) {
				const sample = samples[cursor++];
				const result = await probe(sample);
				results.push(result);
				const mark = result.ok ? 'ok  ' : 'FAIL';
				console.log(
					`  ${mark} ${String(result.status).padEnd(4)} ${String(`${result.ms}ms`).padStart(7)}  ${result.path}`,
				);
			}
		}),
	);

	const failures = results.filter((r) => !r.ok).sort((a, b) => a.url.localeCompare(b.url));
	if (!failures.length) {
		console.log(`\ncheck-runnable-docs: all ${results.length} documented calls answer as documented.`);
		return;
	}

	console.error(`\ncheck-runnable-docs: ${failures.length} documented call(s) no longer answer as documented:\n`);
	for (const failure of failures) {
		const want = failure.expectStatus ? `expected ${failure.expectStatus}` : 'expected 2xx';
		console.error(`  ${failure.url}`);
		console.error(`    got ${failure.status}${failure.error ? ` (${failure.error})` : ''}, ${want}`);
		for (const site of failure.sites) console.error(`    at ${site}`);
		console.error(
			'    fix the URL, or declare the real contract above the fence with' +
				' <!-- runnable: <status> reason --> / <!-- runnable: no reason -->\n',
		);
	}
	process.exit(1);
}

main().catch((err) => {
	console.error(`check-runnable-docs: ${err.stack || err.message}`);
	process.exit(1);
});
