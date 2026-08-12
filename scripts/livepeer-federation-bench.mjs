// Livepeer federation comparison harness (Phase 4 compute federation).
//
// Runs N real text-to-image jobs through each lane of the chain this adapter
// plugs into (the platform's own image lanes in api/_mcp3d/text-to-image.js
// and the federated Livepeer lane in api/_providers/livepeer.js) and reports
// per-lane latency, cost, and success rate, plus a verdict.
//
// Run it:
//
//   node --env-file=.env scripts/livepeer-federation-bench.mjs
//   node --env-file=.env scripts/livepeer-federation-bench.mjs --jobs 20
//   node --env-file=.env scripts/livepeer-federation-bench.mjs --out /tmp/bench.json
//
// Lanes probed (in chain order):
//   baseline : textToImage() with the federation flag OFF: whichever platform
//              lanes are configured (Vertex Gemini image, NIM FLUX, Replicate)
//   livepeer : livepeerTextToImage() against the gateway the env resolves
//              (LIVEPEER_GATEWAY_URL > LIVEPEER_API_KEY studio > public dream
//              gateway). The lane is forced on for the bench by setting the
//              flag in-process; --dry-run forces it off so the whole harness
//              proves the gating instead.
//
// Every result records the failure class (timeout / tls / status / refused)
// verbatim: a dry run against a dead gateway is still full proof of the
// request boundary: the exact request the adapter would send, the exact
// response the network gave back, and what a funded run needs to clear it.
//
// Cost model (per successful image):
//   livepeer public gateway : $0 (rate-limited free tier)
//   livepeer studio gateway : LIVEPEER_STUDIO_COST_PER_IMAGE env, default
//                             $0.0025 (the documented ~1s-of-GPU SDXL-light
//                             job on the studio free tier is covered by
//                             credit; the number here is the metered rate)
//   replicate flux-schnell  : $0.003 (published per-run price)
//   vertex / nim            : $0 to the platform (GCP credits / free tier)

import { writeFileSync } from 'node:fs';

const JOBS = Math.max(1, Number(process.argv.find((a, i) => process.argv[i - 1] === '--jobs')) || 20);
const DRY_RUN = process.argv.includes('--dry-run');
const OUT = (() => {
	const i = process.argv.indexOf('--out');
	return i >= 0 ? process.argv[i + 1] : null;
})();

// Prompts: short, single-subject, the shape the forge reference-image lane
// actually sends. Seeded variation keeps the network from serving one warm
// orchestrator's cache for all 20.
const PROMPTS = [
	'a ceramic coffee mug, studio photo',
	'a wooden desk lamp, studio photo',
	'a leather backpack, studio photo',
	'a potted succulent plant, studio photo',
	'a wireless computer mouse, studio photo',
	'a stainless steel water bottle, studio photo',
	'a vintage mechanical keyboard key, studio photo',
	'a small analog alarm clock, studio photo',
	'a pair of canvas sneakers, single shoe, studio photo',
	'a cast iron skillet, studio photo',
	'a glass mason jar, studio photo',
	'a hardcover notebook with fabric cover, studio photo',
	'a brass desk bell, studio photo',
	'a rubber duck, studio photo',
	'a folding pocket knife, closed, studio photo',
	'a bar of handmade soap, studio photo',
	'a wooden chess knight piece, studio photo',
	'a small bluetooth speaker, studio photo',
	'a metal carabiner clip, studio photo',
	'a wool winter beanie, studio photo',
];

const COST_PER_IMAGE = {
	livepeer_public: 0,
	livepeer_studio: Number(process.env.LIVEPEER_STUDIO_COST_PER_IMAGE ?? 0.0025),
	replicate: 0.003,
	platform_free: 0,
};

function laneCost(lane, gateway, model) {
	if (lane === 'livepeer') return gateway === 'studio' ? COST_PER_IMAGE.livepeer_studio : COST_PER_IMAGE.livepeer_public;
	if (/replicate|flux-schnell$/i.test(model || '')) return COST_PER_IMAGE.replicate;
	return COST_PER_IMAGE.platform_free;
}

async function timed(fn) {
	const t0 = performance.now();
	try {
		const result = await fn();
		return { ok: true, latencyMs: Math.round(performance.now() - t0), result };
	} catch (err) {
		const msg = String(err?.message || err);
		let failureClass = 'error';
		if (err?.code === 'provider_unreachable') failureClass = /certificate|tls|altname/i.test(msg) ? 'tls' : 'unreachable';
		else if (err?.code === 'rate_limited') failureClass = 'rate_limited';
		else if (err?.code === 'verification_failed') failureClass = 'verification_failed';
		else if (err?.providerStatus) failureClass = `http_${err.providerStatus}`;
		else if (/unconfigured/.test(msg)) failureClass = 'unconfigured';
		return { ok: false, latencyMs: Math.round(performance.now() - t0), error: msg.slice(0, 240), failureClass };
	}
}

function summarize(name, results) {
	const ok = results.filter((r) => r.ok);
	const lat = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
	const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : null);
	const cost = ok.reduce((sum, r) => sum + laneCost(r.result?.lane, r.result?.gateway, r.result?.model), 0);
	return {
		lane: name,
		attempted: results.length,
		succeeded: ok.length,
		successRate: results.length ? Number((ok.length / results.length).toFixed(3)) : 0,
		latencyMs: { min: lat[0] ?? null, p50: pct(50), p95: pct(95), max: lat[lat.length - 1] ?? null },
		costUsd: Number(cost.toFixed(4)),
		servedBy: [...new Set(ok.map((r) => `${r.result?.lane || 'platform'}:${r.result?.gateway || r.result?.model || '?'}`))],
		failures: results.filter((r) => !r.ok).map((r) => ({ failureClass: r.failureClass, error: r.error })),
	};
}

const { livepeerTextToImage, livepeerGatewayConfig } = await import('../api/_providers/livepeer.js');
const { textToImage } = await import('../api/_mcp3d/text-to-image.js');

const gateway = livepeerGatewayConfig();
const report = {
	generatedAt: new Date().toISOString(),
	jobs: JOBS,
	dryRun: DRY_RUN,
	livepeerGateway: gateway,
	lanes: {},
};

// Baseline: the platform chain exactly as production runs it today (flag off).
delete process.env.LIVEPEER_FEDERATION_ENABLED;
console.log(`[bench] baseline lane x${JOBS} (federation flag off, platform chain)`);
const baseline = [];
for (let i = 0; i < JOBS; i++) {
	const r = await timed(() => textToImage(PROMPTS[i % PROMPTS.length], { aspectRatio: '1:1', seed: i }));
	console.log(`  [${String(i + 1).padStart(2)}/${JOBS}] ${r.ok ? `ok ${r.latencyMs}ms via ${r.result?.model || r.result?.lane}` : `FAIL ${r.failureClass}: ${r.error}`}`);
	baseline.push(r);
}
report.lanes.baseline = summarize('baseline', baseline);

// Livepeer lane: direct adapter calls against the resolved gateway. The flag
// is set in-process so the run exercises the lane exactly as the chain would.
if (!DRY_RUN) process.env.LIVEPEER_FEDERATION_ENABLED = '1';
console.log(`[bench] livepeer lane x${JOBS} (${DRY_RUN ? 'dry run, flag forced off' : `gateway=${gateway.gateway} ${gateway.base}`})`);
const livepeer = [];
for (let i = 0; i < JOBS; i++) {
	const r = await timed(() =>
		DRY_RUN
			? Promise.reject(new Error('dry run: federation flag off'))
			: livepeerTextToImage(PROMPTS[i % PROMPTS.length], { aspectRatio: '1:1', seed: i }),
	);
	console.log(`  [${String(i + 1).padStart(2)}/${JOBS}] ${r.ok ? `ok ${r.latencyMs}ms via ${r.result?.gateway}` : `FAIL ${r.failureClass}: ${r.error}`}`);
	livepeer.push(r);
}
report.lanes.livepeer = summarize('livepeer', livepeer);
delete process.env.LIVEPEER_FEDERATION_ENABLED;

// Verdict: expand only if the federated lane cleared a real job rate AND beat
// or matched the paid backstop's cost at acceptable latency.
const lp = report.lanes.livepeer;
const base = report.lanes.baseline;
report.verdict =
	lp.succeeded >= Math.ceil(0.9 * JOBS)
		? `expand: ${lp.succeeded}/${JOBS} livepeer jobs succeeded at $${lp.costUsd} total`
		: `do not expand yet: ${lp.succeeded}/${JOBS} livepeer jobs succeeded (${gateway.gateway} gateway)`;

console.log('\n[bench] summary');
console.log(JSON.stringify(report, null, 2));
if (OUT) {
	writeFileSync(OUT, JSON.stringify(report, null, 2));
	console.log(`[bench] written to ${OUT}`);
}
if (!base.succeeded && !lp.succeeded) process.exitCode = 1;
