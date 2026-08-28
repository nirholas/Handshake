#!/usr/bin/env node
/**
 * Execute every declared degradation contract against a running server.
 *
 * "We have fallbacks" is a claim about code that, by construction, only runs
 * when something is broken. This turns the claim into a receipt: for each
 * contract it breaks the named upstream for one request, calls the real
 * endpoint, and checks what came back.
 *
 * The verdict that matters most is not pass or fail, it is `not_exercised`.
 * A fault can be accepted and still never reach the code, because a warm cache
 * answered before any upstream call happened. A prover that called that a pass
 * would be certifying a fallback nothing ran, which is worse than not testing
 * at all: it converts an unknown into a false assurance. So every contract
 * declares which sources must appear as FAILED in the response's provenance
 * trace, and a run that cannot show them is reported honestly.
 *
 *   node scripts/prove-brownout.mjs                        # against localhost:8080
 *   node scripts/prove-brownout.mjs --base https://three.ws --token $BROWNOUT_CHAOS_TOKEN
 *   node scripts/prove-brownout.mjs --write public/brownout.json
 *   node scripts/prove-brownout.mjs --json                 # machine-readable, no file
 *
 * Exit codes: 0 all contracts proven, 1 a contract failed its expectation,
 * 2 a contract could not be exercised (the fault never landed).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REGISTRY = 'data/brownout.json';
const CHAOS_HEADER = 'x-brownout-chaos';
const TOKEN_HEADER = 'x-brownout-chaos-token';
const STATUS_HEADER = 'x-brownout-chaos-status';

function arg(flag, fallback = null) {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

/**
 * Parse the `x-brownout` summary and `x-brownout-trace` breakdown a response
 * carries. Kept deliberately tolerant: a missing header means "this response
 * recorded nothing", which is a real and meaningful state (everything was
 * served from cache), not a parse error.
 *
 * @param {Headers} headers
 * @returns {{ tier: string|null, degraded: boolean, ok: number, failed: number, ms: number|null, sources: Array<{name:string,outcome:string,ms:number}> }}
 */
export function parseProvenance(headers) {
	const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]) || '';
	const summary = get('x-brownout');
	const trace = get('x-brownout-trace');
	const fields = {};
	for (const pair of summary.split(';')) {
		const [k, v] = pair.split('=');
		if (k) fields[k.trim()] = (v ?? '').trim();
	}
	const sources = trace
		? trace.split(',').map((entry) => {
				const parts = entry.split(';').map((p) => p.trim());
				const name = parts[0] || '';
				const outcome = (parts.find((p) => p.startsWith('o=')) || 'o=').slice(2);
				const ms = Number((parts.find((p) => p.startsWith('t=')) || 't=0').slice(2));
				return { name, outcome, ms: Number.isFinite(ms) ? ms : 0 };
			})
		: [];
	return {
		tier: fields.tier || null,
		degraded: fields.degraded === '1',
		ok: Number(fields.ok || 0),
		failed: Number(fields.failed || 0),
		ms: fields.ms ? Number(fields.ms) : null,
		sources,
	};
}

/** A source counts as exercised when the trace shows it and it did not succeed. */
export function wasExercised(prov, name) {
	const want = String(name).toLowerCase();
	return prov.sources.some((s) => {
		const got = s.name.toLowerCase();
		if (got !== want && !got.startsWith(`${want}:`)) return false;
		return s.outcome !== 'ok';
	});
}

/** Build the request URL, applying the contract's cache-busting parameter. */
export function contractUrl(base, contract, seed = Date.now()) {
	const url = new URL(contract.endpoint, base);
	for (const [k, v] of Object.entries(contract.query || {})) url.searchParams.set(k, String(v));
	const bust = contract.bust;
	if (bust?.param) {
		// A warm cache is the single biggest source of a false green here, so the
		// request is deliberately steered off whatever key the last one used. The
		// range is the contract's, because only it knows what stays meaningful.
		const span = Math.max(1, (bust.max ?? 10) - (bust.min ?? 1) + 1);
		url.searchParams.set(bust.param, String((bust.min ?? 1) + (seed % span)));
	}
	return url.toString();
}

export function chaosDirective(contract) {
	return Object.entries(contract.break || {})
		.map(([name, spec]) => `${name}=${spec}`)
		.join(', ');
}

/** Check one response against a contract's expectations. Pure, so it is testable. */
export function judge(contract, { status, prov, body, chaosStatus }) {
	const expect = contract.expect || {};
	const problems = [];

	if (chaosStatus && !/^applied/.test(chaosStatus)) {
		return { verdict: 'not_exercised', problems: [`the server refused the fault: ${chaosStatus}`] };
	}

	for (const name of expect.exercised || []) {
		if (!wasExercised(prov, name)) {
			return {
				verdict: 'not_exercised',
				problems: [
					`\`${name}\` never appears as a failed source in the response trace, so the fault did not reach the code. ` +
						'A warm cache almost certainly answered first; give the contract a `bust` parameter or widen it.',
				],
			};
		}
	}

	const wantStatus = [].concat(expect.status ?? 200);
	if (!wantStatus.includes(status)) problems.push(`status ${status}, expected ${wantStatus.join(' or ')}`);

	if (expect.tier) {
		const wantTier = [].concat(expect.tier);
		if (!prov.tier) problems.push(`expected tier ${wantTier.join(' or ')} but the response recorded no provenance`);
		else if (!wantTier.includes(prov.tier)) problems.push(`tier ${prov.tier}, expected ${wantTier.join(' or ')}`);
	}

	if (expect.degraded === true && !prov.degraded) {
		problems.push('the response did not report itself as degraded, though its upstream was broken');
	}

	for (const key of expect.jsonHas || []) {
		if (!body || typeof body !== 'object' || !(key in body)) problems.push(`response body is missing \`${key}\``);
	}

	return { verdict: problems.length ? 'fail' : 'pass', problems };
}

async function runContract(base, token, contract, timeoutMs) {
	const started = Date.now();
	const seed = Math.floor(Math.random() * 1e6);

	// A contract whose fallback is a last-good tier needs something to fall back
	// TO. One clean request first is not cheating: it is the state every real
	// user's request arrives in, and a cold process with no memory is a different
	// contract (the honest 503) that other entries assert.
	if (contract.warm) {
		try {
			await fetch(contractUrl(base, contract, seed), { signal: AbortSignal.timeout(timeoutMs) });
		} catch {
			/* a failed warm-up is not a verdict; the real attempt below is */
		}
	}

	const url = contractUrl(base, contract, seed);
	let res;
	try {
		res = await fetch(url, {
			headers: { [CHAOS_HEADER]: chaosDirective(contract), [TOKEN_HEADER]: token, accept: 'application/json' },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return {
			id: contract.id,
			title: contract.title,
			verdict: 'fail',
			ms: Date.now() - started,
			problems: [`the request itself failed: ${err?.message || err}`],
		};
	}

	const text = await res.text().catch(() => '');
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		/* a non-JSON body is judged on status and provenance alone */
	}
	const prov = parseProvenance(res.headers);
	const chaosStatus = res.headers.get(STATUS_HEADER);
	const { verdict, problems } = judge(contract, { status: res.status, prov, body, chaosStatus });

	return {
		id: contract.id,
		title: contract.title,
		surface: contract.surface || null,
		endpoint: contract.endpoint,
		broke: contract.break,
		why: contract.why || null,
		verdict,
		problems,
		ms: Date.now() - started,
		observed: {
			status: res.status,
			tier: prov.tier,
			degraded: prov.degraded,
			failedSources: prov.failed,
			trace: prov.sources.slice(0, 8),
		},
	};
}

async function main() {
	const base = arg('--base', process.env.BROWNOUT_BASE_URL || 'http://127.0.0.1:8080');
	const token = arg('--token', process.env.BROWNOUT_CHAOS_TOKEN || '');
	const timeoutMs = Number(arg('--timeout', '45000'));
	const outPath = arg('--write', null);
	const jsonOnly = has('--json');

	if (!token) {
		console.error('prove-brownout: no chaos token. Set BROWNOUT_CHAOS_TOKEN or pass --token.');
		console.error('Without it the server refuses every directive, which would report every contract as not_exercised.');
		process.exit(2);
	}

	const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
	const results = [];
	for (const contract of registry.contracts) {
		results.push(await runContract(base, token, contract, timeoutMs));
	}

	const counts = results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] || 0) + 1 }), {});
	const report = {
		generated_at: new Date().toISOString(),
		base,
		summary: registry.summary,
		counts,
		proven: counts.pass || 0,
		total: results.length,
		results,
	};

	if (outPath) {
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, `${JSON.stringify(report, null, '\t')}\n`);
	}
	if (jsonOnly) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`prove-brownout: ${report.proven}/${report.total} contracts proven against ${base}\n`);
		for (const r of results) {
			const mark = r.verdict === 'pass' ? 'PASS' : r.verdict === 'not_exercised' ? 'UNEX' : 'FAIL';
			console.log(`  ${mark}  ${r.id}  (${r.ms}ms)`);
			console.log(`        ${r.title}`);
			if (r.observed) {
				console.log(`        got ${r.observed.status}, tier=${r.observed.tier || 'none'}, failed sources=${r.observed.failedSources}`);
				for (const s of r.observed.trace) console.log(`          - ${s.name} ${s.outcome} ${s.ms}ms`);
			}
			for (const p of r.problems) console.log(`        ! ${p}`);
		}
		if (outPath) console.log(`\nwrote ${outPath}`);
	}

	if (counts.fail) process.exit(1);
	if (counts.not_exercised) process.exit(2);
	process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
