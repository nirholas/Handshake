// Core behaviour of the vitals graph. Every probe here is a plain function, so
// the whole suite runs with no network, no clock and no database: the point of
// the pure-core / injected-I/O split is that the interesting logic is testable
// on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { vitals } from '../src/index.js';

const up = () => ({ ok: true });
const down = (detail) => () => ({ ok: false, detail });

test('a capability over healthy vitals is ready', async () => {
	const verdict = await vitals({ agent: 'a1' })
		.vital('solvency', { probe: up })
		.vital('cognition', { probe: up })
		.capability('trade', { needs: ['solvency', 'cognition'] })
		.attest();

	assert.equal(verdict.can.trade, true);
	assert.equal(verdict.healthy, true);
	assert.deepEqual(verdict.rootCauses, []);
	assert.equal(verdict.explain(), 'a1: can trade');
});

test('reports the root cause, not the symptom it caused', async () => {
	const verdict = await vitals()
		.vital('deploy-fresh', { probe: down('image is 16 days old'), remedy: 'redeploy the worker' })
		.vital('cognition', { needs: ['deploy-fresh'], probe: up })
		.vital('solvency', { probe: up })
		.capability('trade', { needs: ['cognition', 'solvency'] })
		.attest();

	assert.equal(verdict.can.trade, false);
	assert.deepEqual(verdict.rootCauses.map((r) => r.id), ['deploy-fresh']);
	assert.equal(verdict.vital('cognition').status, 'blocked');
	assert.deepEqual(verdict.remedies, ['redeploy the worker']);
});

test('a vital behind a failing dependency is never probed', async () => {
	let probed = 0;
	await vitals()
		.vital('deploy-fresh', { probe: down() })
		.vital('cognition', {
			needs: ['deploy-fresh'],
			probe: () => {
				probed += 1;
				return { ok: true };
			},
		})
		.capability('trade', { needs: ['cognition'] })
		.attest();

	// Probing it would spend a timeout rediscovering a failure we already know.
	assert.equal(probed, 0);
});

test('an unreadable probe is unknown, never down', async () => {
	const verdict = await vitals()
		.vital('balance', { probe: () => { throw new Error('rpc 429'); } })
		.capability('trade', { needs: ['balance'] })
		.attest();

	assert.equal(verdict.vital('balance').status, 'unknown');
	// "cannot say" and "cannot act" are different answers and must not collapse.
	assert.equal(verdict.can.trade, null);
	assert.match(verdict.vital('balance').detail, /rpc 429/);
});

test('a probe returning no verdict is unknown, not a silent pass', async () => {
	const verdict = await vitals()
		.vital('feed', { probe: () => ({ detail: 'upstream gave no answer' }) })
		.capability('trade', { needs: ['feed'] })
		.attest();

	assert.equal(verdict.vital('feed').status, 'unknown');
	assert.equal(verdict.can.trade, null);
});

test('a definite failure outranks an unreadable one', async () => {
	const verdict = await vitals()
		.vital('solvency', { probe: down('wallet empty') })
		.vital('feed', { probe: () => { throw new Error('timeout'); } })
		.capability('trade', { needs: ['solvency', 'feed'] })
		.attest();

	// One precondition is definitively broken, so the agent definitively cannot
	// act; an unreadable second precondition does not soften that.
	assert.equal(verdict.can.trade, false);
	assert.equal(verdict.rootCauses[0].id, 'solvency');
});

test('a probe that overruns its deadline is unknown, and the chart keeps going', async () => {
	const verdict = await vitals({ timeoutMs: 20 })
		.vital('slow', { probe: () => new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 5_000).unref?.(); }) })
		.vital('fast', { probe: up })
		.capability('trade', { needs: ['slow', 'fast'] })
		.attest();

	assert.equal(verdict.vital('slow').status, 'unknown');
	assert.equal(verdict.vital('fast').status, 'up');
	assert.match(verdict.vital('slow').detail, /exceeded 20ms/);
});

test('a per-vital timeout overrides the chart default', async () => {
	const verdict = await vitals({ timeoutMs: 5_000 })
		.vital('slow', {
			timeoutMs: 20,
			probe: () => new Promise((resolve) => { setTimeout(() => resolve({ ok: true }), 5_000).unref?.(); }),
		})
		.capability('trade', { needs: ['slow'] })
		.attest();

	assert.equal(verdict.vital('slow').status, 'unknown');
	assert.match(verdict.vital('slow').detail, /exceeded 20ms/);
});

test('a remedy function is handed the probe detail so the fix names real numbers', async () => {
	const verdict = await vitals()
		.vital('solvency', {
			probe: () => ({ ok: false, detail: 'short by 0.0187 SOL', data: { deficit: 0.0187 } }),
			remedy: ({ data }) => `send ${data.deficit} SOL to the arm wallet`,
		})
		.capability('trade', { needs: ['solvency'] })
		.attest();

	assert.deepEqual(verdict.remedies, ['send 0.0187 SOL to the arm wallet']);
});

test('a remedy that throws does not take down the attestation', async () => {
	const verdict = await vitals()
		.vital('solvency', { probe: down(), remedy: () => { throw new Error('bad template'); } })
		.capability('trade', { needs: ['solvency'] })
		.attest();

	assert.equal(verdict.can.trade, false);
	assert.equal(verdict.vital('solvency').remedy, null);
	assert.deepEqual(verdict.remedies, []);
});

test('a healthy vital carries no remedy', async () => {
	const verdict = await vitals()
		.vital('solvency', { probe: up, remedy: 'fund it' })
		.capability('trade', { needs: ['solvency'] })
		.attest();

	assert.equal(verdict.vital('solvency').remedy, null);
});

test('independent vitals at the same depth probe concurrently', async () => {
	let peak = 0;
	let active = 0;
	const slow = () => new Promise((resolve) => {
		active += 1;
		peak = Math.max(peak, active);
		setTimeout(() => { active -= 1; resolve({ ok: true }); }, 25).unref?.();
	});

	await vitals()
		.vital('a', { probe: slow })
		.vital('b', { probe: slow })
		.vital('c', { probe: slow })
		.capability('trade', { needs: ['a', 'b', 'c'] })
		.attest();

	assert.equal(peak, 3);
});

test('a dependent probes strictly after its dependency', async () => {
	const order = [];
	await vitals()
		.vital('first', { probe: async () => { order.push('first'); return { ok: true }; } })
		.vital('second', { needs: ['first'], probe: async () => { order.push('second'); return { ok: true }; } })
		.capability('trade', { needs: ['second'] })
		.attest();

	assert.deepEqual(order, ['first', 'second']);
});

test('one root cause blocking several capabilities is reported once', async () => {
	const verdict = await vitals()
		.vital('deploy-fresh', { probe: down(), remedy: 'redeploy' })
		.vital('cognition', { needs: ['deploy-fresh'], probe: up })
		.vital('execution', { needs: ['deploy-fresh'], probe: up })
		.capability('trade', { needs: ['cognition'] })
		.capability('exit', { needs: ['execution'] })
		.attest();

	assert.equal(verdict.can.trade, false);
	assert.equal(verdict.can.exit, false);
	// The operator's work queue is one item, not two.
	assert.deepEqual(verdict.rootCauses.map((r) => r.id), ['deploy-fresh']);
	assert.deepEqual(verdict.remedies, ['redeploy']);
});

test('explain() reads as a causal chain from symptom to cause', async () => {
	const verdict = await vitals({ agent: 'sniper-1' })
		.vital('deploy-fresh', { probe: down('image is 16 days old'), remedy: 'redeploy the worker' })
		.vital('cognition', { needs: ['deploy-fresh'], probe: up })
		.capability('trade', { needs: ['cognition'] })
		.attest();

	const text = verdict.explain();
	assert.match(text, /sniper-1: cannot trade because cognition is blocked, because deploy-fresh is down \(image is 16 days old\)/);
	assert.match(text, /fix: redeploy the worker/);
});

test('a capability scoped to healthy vitals stays ready while another fails', async () => {
	const verdict = await vitals()
		.vital('solvency', { probe: up })
		.vital('cognition', { probe: down() })
		.capability('exit', { needs: ['solvency'] })
		.capability('trade', { needs: ['solvency', 'cognition'] })
		.attest();

	// Closing a position needs no model. Failing to notice that is how a fleet
	// gets marked fully dead while it can still get out of its open risk.
	assert.equal(verdict.can.exit, true);
	assert.equal(verdict.can.trade, false);
	assert.equal(verdict.healthy, false);
});

test('a dependency cycle is a build error naming its members', async () => {
	const chart = vitals()
		.vital('a', { needs: ['b'], probe: up })
		.vital('b', { needs: ['a'], probe: up })
		.capability('trade', { needs: ['a'] });

	await assert.rejects(() => chart.attest(), /cycle among \[a, b\]/);
});

test('an edge to an undeclared vital fails loudly with the name in it', async () => {
	const chart = vitals().vital('a', { needs: ['ghost'], probe: up }).capability('trade', { needs: ['a'] });
	await assert.rejects(() => chart.attest(), /vital "a" needs unknown vital "ghost"/);

	const chart2 = vitals().vital('a', { probe: up }).capability('trade', { needs: ['ghost'] });
	await assert.rejects(() => chart2.attest(), /capability "trade" needs unknown vital "ghost"/);
});

test('malformed declarations are rejected at build time', () => {
	assert.throws(() => vitals().vital('a', {}), /needs a probe function/);
	assert.throws(() => vitals().vital('', { probe: up }), /needs a string id/);
	assert.throws(() => vitals().vital('a', { probe: up }).vital('a', { probe: up }), /duplicate vital "a"/);
	assert.throws(() => vitals().vital('a', { probe: up }).capability('c', { needs: [] }), /non-empty needs array/);
	assert.throws(
		() => vitals().vital('a', { probe: up }).capability('c', { needs: ['a'] }).capability('c', { needs: ['a'] }),
		/duplicate capability "c"/,
	);
});

test('an aborted attestation marks the unrun probes unknown rather than passing them', async () => {
	const controller = new AbortController();
	controller.abort();
	const verdict = await vitals()
		.vital('a', { probe: up })
		.capability('trade', { needs: ['a'] })
		.attest({ signal: controller.signal });

	assert.equal(verdict.vital('a').status, 'unknown');
	assert.equal(verdict.can.trade, null);
});

test('toJSON is plain, serialisable, and carries the answer up front', async () => {
	const verdict = await vitals({ agent: 'a1' })
		.vital('solvency', { probe: down('empty'), remedy: 'fund it' })
		.capability('trade', { needs: ['solvency'] })
		.attest();

	const json = JSON.parse(JSON.stringify(verdict));
	assert.equal(json.agent, 'a1');
	assert.equal(json.healthy, false);
	assert.equal(json.can.trade, false);
	assert.deepEqual(json.root_causes, ['solvency']);
	assert.deepEqual(json.remedies, ['fund it']);
	assert.equal(typeof json.at, 'string');
});

test('a boolean probe is accepted as shorthand', async () => {
	const verdict = await vitals()
		.vital('a', { probe: () => true })
		.vital('b', { probe: () => false })
		.capability('trade', { needs: ['a', 'b'] })
		.attest();

	assert.equal(verdict.vital('a').status, 'up');
	assert.equal(verdict.vital('b').status, 'down');
});

test('a probe returning a non-result value is unknown, and keeps the value for debugging', async () => {
	const verdict = await vitals()
		.vital('a', { probe: () => 'yes' })
		.capability('trade', { needs: ['a'] })
		.attest();

	assert.equal(verdict.vital('a').status, 'unknown');
	assert.equal(verdict.vital('a').data, 'yes');
});

test('a deep chain reports the deepest cause, not the middle of the chain', async () => {
	const verdict = await vitals()
		.vital('billing', { probe: down('account on hold'), remedy: 'clear the billing hold' })
		.vital('deploy', { needs: ['billing'], probe: up })
		.vital('cognition', { needs: ['deploy'], probe: up })
		.vital('decision', { needs: ['cognition'], probe: up })
		.capability('trade', { needs: ['decision'] })
		.attest();

	assert.deepEqual(verdict.rootCauses.map((r) => r.id), ['billing']);
	assert.equal(verdict.vital('deploy').status, 'blocked');
	assert.equal(verdict.vital('decision').status, 'blocked');
	assert.match(verdict.explain(), /fix: clear the billing hold/);
});

// ── block severity ───────────────────────────────────────────────────────────
// Blocking on an unreadable dependency is not the same as blocking on a broken
// one. Collapsing the two inverts the library's own "unread is not failed" rule
// one level down the graph, and it reported an agent that had acted sixty
// seconds earlier as definitively unable.

test('a block behind an unreadable probe leaves the capability unknown, not unable', async () => {
	const verdict = await vitals()
		.vital('image', { probe: () => ({ ok: null, detail: 'build time unread' }) })
		.vital('cognition', { needs: ['image'], probe: up })
		.capability('trade', { needs: ['cognition'] })
		.attest();

	assert.equal(verdict.vital('cognition').status, 'blocked');
	assert.equal(verdict.vital('cognition').blockedSeverity, 'unknown');
	assert.equal(verdict.can.trade, null);
});

test('a block behind a real failure makes the capability unable', async () => {
	const verdict = await vitals()
		.vital('image', { probe: down('16 days old') })
		.vital('cognition', { needs: ['image'], probe: up })
		.capability('trade', { needs: ['cognition'] })
		.attest();

	assert.equal(verdict.vital('cognition').blockedSeverity, 'down');
	assert.equal(verdict.can.trade, false);
});

test('block severity propagates through a chain of blocks', async () => {
	const verdict = await vitals()
		.vital('billing', { probe: down('on hold') })
		.vital('deploy', { needs: ['billing'], probe: up })
		.vital('cognition', { needs: ['deploy'], probe: up })
		.capability('trade', { needs: ['cognition'] })
		.attest();

	assert.equal(verdict.vital('deploy').blockedSeverity, 'down');
	assert.equal(verdict.vital('cognition').blockedSeverity, 'down');
	assert.equal(verdict.can.trade, false);
});

test('one broken dependency outranks an unreadable sibling when both block a vital', async () => {
	const verdict = await vitals()
		.vital('unreadable', { probe: () => ({ ok: null }) })
		.vital('broken', { probe: down('really down') })
		.vital('dependent', { needs: ['unreadable', 'broken'], probe: up })
		.capability('trade', { needs: ['dependent'] })
		.attest();

	assert.equal(verdict.vital('dependent').blockedSeverity, 'down');
	assert.equal(verdict.can.trade, false);
});

test('an unreadable probe never makes a healthy sibling capability unable', async () => {
	const verdict = await vitals()
		.vital('image', { probe: () => ({ ok: null }) })
		.vital('rpc', { probe: up })
		.vital('cognition', { needs: ['image'], probe: up })
		.capability('enter', { needs: ['cognition', 'rpc'] })
		.capability('exit', { needs: ['rpc'] })
		.attest();

	// Exiting never depended on the unreadable reading, so it stays definitively
	// ready. A fleet that can still close its open risk must not read as dead.
	assert.equal(verdict.can.exit, true);
	assert.equal(verdict.can.enter, null);
});

test('a blocked vital carries no blockedSeverity when it was actually probed', async () => {
	const verdict = await vitals()
		.vital('a', { probe: up })
		.vital('b', { probe: down() })
		.capability('trade', { needs: ['a', 'b'] })
		.attest();

	assert.equal(verdict.vital('a').blockedSeverity, null);
	assert.equal(verdict.vital('b').blockedSeverity, null);
});
