import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	parseProvenance,
	isStale,
	failedSources,
	describeProvenance,
	chaosDirective,
	chaosHeaders,
	withChaos,
	chaosOutcome,
	assertDegraded,
	BrownoutAssertionError,
} from '../src/index.js';

const resWith = (headers, status = 200) => new Response('{}', { status, headers });

const DEGRADED = {
	'x-brownout': 'v=1;tier=stale;sources=3;ok=1;failed=2;ms=512;degraded=1',
	'x-brownout-trace': 'birdeye;o=429;t=412, tokens-xyz;o=timeout;t=8000, dex;o=ok;t=88',
	'x-brownout-chaos-status': 'applied;faults=1',
};

test('parseProvenance reads the summary and the trace', () => {
	const p = parseProvenance(resWith(DEGRADED));
	assert.equal(p.tier, 'stale');
	assert.equal(p.degraded, true);
	assert.equal(p.ok, 1);
	assert.equal(p.failed, 2);
	assert.equal(p.ms, 512);
	assert.deepEqual(p.trace[0], { name: 'birdeye', outcome: '429', ms: 412 });
	assert.equal(p.trace.length, 3);
});

test('parseProvenance accepts a Response, a Headers, or a plain object', () => {
	const fromHeaders = parseProvenance(new Headers(DEGRADED));
	const fromObject = parseProvenance({ 'X-Brownout': DEGRADED['x-brownout'] });
	assert.equal(fromHeaders.tier, 'stale');
	assert.equal(fromObject.tier, 'stale');
});

test('parseProvenance returns null when no upstream was touched', () => {
	assert.equal(parseProvenance(resWith({})), null);
	assert.equal(parseProvenance(null), null);
});

test('parseProvenance refuses an unknown tier rather than passing it through', () => {
	const p = parseProvenance(resWith({ 'x-brownout': 'v=1;tier=invented;ok=1' }));
	assert.equal(p.tier, null);
});

test('isStale separates "caption this number" from "something failed over"', () => {
	// degraded is true for both; only stale and fallback mean the number is old.
	assert.equal(isStale(parseProvenance(resWith({ 'x-brownout': 'v=1;tier=stale;degraded=1' }))), true);
	assert.equal(isStale(parseProvenance(resWith({ 'x-brownout': 'v=1;tier=fallback;degraded=1' }))), true);
	assert.equal(isStale(parseProvenance(resWith({ 'x-brownout': 'v=1;tier=live;degraded=1' }))), false);
	assert.equal(isStale(parseProvenance(resWith({ 'x-brownout': 'v=1;tier=cache' }))), false);
	assert.equal(isStale(null), false);
});

test('failedSources lists only what did not answer, in order', () => {
	const failed = failedSources(parseProvenance(resWith(DEGRADED)));
	assert.deepEqual(failed.map((f) => f.name), ['birdeye', 'tokens-xyz']);
});

test('describeProvenance renders a log line', () => {
	const line = describeProvenance(parseProvenance(resWith(DEGRADED)));
	assert.match(line, /tier=stale/);
	assert.match(line, /2 sources failed/);
	assert.match(line, /birdeye\(429\)/);
	assert.equal(describeProvenance(null), 'no upstream was touched');
});

test('chaosDirective renders the wire format', () => {
	assert.equal(chaosDirective({ birdeye: 'http:429', dex: 'timeout' }), 'birdeye=http:429, dex=timeout');
});

test('chaosHeaders refuses to build a directive without a token', () => {
	assert.throws(() => chaosHeaders({ birdeye: 'timeout' }, ''), /chaos token is required/);
});

test('withChaos injects the headers and preserves the caller\'s own', async () => {
	let seen;
	const fetchImpl = async (url, init) => {
		seen = init.headers;
		return resWith({});
	};
	const broken = withChaos({ birdeye: 'http:429' }, { token: 'tok', fetch: fetchImpl });
	await broken('https://example.test/x', { headers: { accept: 'application/json' } });
	assert.equal(seen.get('x-brownout-chaos'), 'birdeye=http:429');
	assert.equal(seen.get('x-brownout-chaos-token'), 'tok');
	assert.equal(seen.get('accept'), 'application/json');
});

test('chaosOutcome distinguishes applied from refused', () => {
	assert.deepEqual(chaosOutcome(resWith({ 'x-brownout-chaos-status': 'applied;faults=2' })), {
		applied: true,
		reason: null,
		faults: 2,
	});
	assert.deepEqual(chaosOutcome(resWith({ 'x-brownout-chaos-status': 'refused;reason=money_path' })), {
		applied: false,
		reason: 'money_path',
		faults: 0,
	});
	assert.equal(chaosOutcome(resWith({})).applied, false);
});

test('assertDegraded passes a response that degraded as expected', () => {
	const prov = assertDegraded(resWith(DEGRADED), {
		status: 200,
		tier: ['stale', 'fallback'],
		degraded: true,
		exercised: ['birdeye'],
	});
	assert.equal(prov.tier, 'stale');
});

test('assertDegraded refuses when the upstream under test never failed', () => {
	// The single most important behaviour: a warm cache answered, nothing was
	// tested, and a green assertion here would be worse than no test at all.
	const warm = resWith({
		'x-brownout': 'v=1;tier=cache;sources=1;ok=1;failed=0',
		'x-brownout-chaos-status': 'applied;faults=1',
	});
	assert.throws(() => assertDegraded(warm, { exercised: ['birdeye'] }), BrownoutAssertionError);
	assert.throws(() => assertDegraded(warm, { exercised: ['birdeye'] }), /never failed during this request/);
});

test('assertDegraded refuses when the server declined the directive', () => {
	const refused = resWith({ 'x-brownout-chaos-status': 'refused;reason=bad_token', 'x-brownout': 'v=1;tier=live' });
	assert.throws(() => assertDegraded(refused, { exercised: ['birdeye'] }), /did not apply the fault \(bad_token\)/);
});

test('assertDegraded matches a sub-scoped source from the provider name', () => {
	const scoped = resWith({
		'x-brownout': 'v=1;tier=stale;ok=1;failed=1;degraded=1',
		'x-brownout-trace': 'birdeye:txs;o=429;t=1',
		'x-brownout-chaos-status': 'applied;faults=1',
	});
	assert.doesNotThrow(() => assertDegraded(scoped, { exercised: ['birdeye'] }));
});

test('assertDegraded reports a wrong status and a wrong tier', () => {
	assert.throws(() => assertDegraded(resWith(DEGRADED, 200), { status: 503 }), /status 200, expected 503/);
	assert.throws(() => assertDegraded(resWith(DEGRADED), { tier: 'live' }), /tier stale, expected live/);
});
