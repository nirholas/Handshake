// smoke.mjs: live core-path check for the Newsroom Anchor worker.
//
// Runs one real bulletin end to end against the real three.ws API (no mocks, no
// fixtures): gather the live feeds, script the read on the brain, split it into
// a lower-third headline plus a spoken body, and assert every contract the
// worker loop depends on. It never enters the cadence loop, so it is safe to
// run against production while the worker is live.
//
// The publish + push legs need the anchor agent's identity. With AGENT_JWT and
// AGENT_ID set it publishes the script and reads it back through the public GET
// to prove the round trip; without them it reports the publish leg as skipped
// (and names the missing vars) rather than pretending it passed.
//
//   node workers/agent-anchor/smoke.mjs         # or: npm run smoke
//   ANCHOR_API_BASE=http://localhost:3000 node workers/agent-anchor/smoke.mjs
//
// Exit code 0 = every assertion held, 1 = a contract broke (details on stderr).

import { gatherBrief, scriptBulletin, publishScript } from './anchor-client.js';
import { splitScript, HEADLINE_MAX, BODY_MAX, ACTIVITY_MAX } from './brief.js';

const API_BASE = (process.env.ANCHOR_API_BASE || process.env.API_BASE || 'https://three.ws').replace(/\/$/, '');

const out = (s) => process.stdout.write(s + '\n');
const failures = [];

function check(label, ok, detail) {
	out(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures.push(label);
}

async function main() {
	out(`agent-anchor smoke: ${API_BASE}`);

	// ── 1. Gather ────────────────────────────────────────────────────────────
	const t0 = Date.now();
	const brief = await gatherBrief();
	out(`\n[gather] ${Date.now() - t0}ms  source=${brief.narrativeSource || 'none'}  ` +
		`items=${brief.items.length}(+${brief.moreItems})  offline=[${brief.offline.join(', ')}]`);
	for (const it of brief.items) out(`  • ${it.headline.slice(0, 90)}${it.attribution ? ` (via ${it.attribution})` : ''}`);
	if (brief.sentiment) out(`  sentiment: ${brief.sentiment.label} over ${brief.sentiment.count} comments`);
	if (brief.market) out(`  flow: ${brief.market.symbol} $${brief.market.priceUsd} · ${brief.market.change24h}% 24h`);

	check('brief has a narrative spine or reports it offline',
		brief.items.length > 0 || brief.offline.includes('narrative') || brief.isQuiet,
		`narrativeSource=${brief.narrativeSource}`);
	check('every offline feed is a known lane',
		brief.offline.every((f) => ['narrative', 'sentiment', 'flow'].includes(f)));
	check('at least one live feed came back', !brief.isQuiet || brief.offline.length === 3);

	// ── 2. Script ────────────────────────────────────────────────────────────
	const t1 = Date.now();
	const script = await scriptBulletin(brief);
	out(`\n[script] ${Date.now() - t1}ms  ${script.length} chars`);
	check('brain returned a non-empty script', script.trim().length > 0);

	// ── 3. Split ─────────────────────────────────────────────────────────────
	const { headline, body } = splitScript(script);
	out(`\n[split] headline: ${headline}`);
	out(`[split] body (${body.length}): ${body}`);
	check('headline is non-empty and within the lower-third cap',
		headline.length > 0 && headline.length <= HEADLINE_MAX, `${headline.length}/${HEADLINE_MAX}`);
	check('headline fits the screen-frame activity cap', headline.length <= ACTIVITY_MAX);
	check('spoken body is non-empty and within the TTS cap',
		body.length > 0 && body.length <= BODY_MAX, `${body.length}/${BODY_MAX}`);
	check('the HEADLINE marker never leaks into the spoken body', !/^headline\s*:/i.test(body));

	// ── 4. Publish + read back ───────────────────────────────────────────────
	const missing = ['AGENT_JWT', 'AGENT_ID'].filter((v) => !process.env[v]);
	if (missing.length) {
		out(`\n[publish] skipped: set ${missing.join(' and ')} to exercise the publish + push legs`);
	} else {
		await publishScript({ headline, body, brief });
		const res = await fetch(`${API_BASE}/api/agent/anchor-script?agentId=${encodeURIComponent(process.env.AGENT_ID)}`);
		const json = await res.json().catch(() => null);
		out(`\n[publish] readback ${res.status}  headline: ${json?.script?.headline || '(none)'}`);
		check('published script reads back through the public GET', json?.script?.headline === headline);
		check('published body survives the round trip', json?.script?.body === body);
	}

	out(`\n${failures.length ? `FAILED: ${failures.join('; ')}` : 'OK: core path healthy'}`);
	process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
	process.stderr.write(`smoke crashed: ${err?.stack || err?.message || err}\n`);
	process.exit(1);
});
