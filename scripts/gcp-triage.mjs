#!/usr/bin/env node
/**
 * gcp-triage: automated production monitor for the Cloud Run fleet.
 *
 * One command that answers "is production healthy, and if not, what exactly
 * do I do about it": pulls /api/healthz (the platform's own subsystem
 * roll-up), sweeps WARNING+ logs across every Cloud Run service, fingerprints
 * repeated signatures, matches them against the known-signature runbook
 * (docs/ops/production-log-triage.md), and emits a classified action plan.
 *
 *   npm run triage:gcp                 # human report, last hour
 *   npm run triage:gcp -- --since 6h   # wider window
 *   npm run triage:gcp -- --json       # machine-readable, for agents
 *
 * Exit codes: 0 = healthy or self-healing noise only; 1 = findings that need
 * action; 2 = usage error. Agents: run with --json, then follow the fix
 * playbook in .agents/skills/gcp-triage/SKILL.md.
 */

import { spawnSync } from 'node:child_process';

const PROJECT = process.env.GCP_PROJECT || 'aerial-vehicle-466722-p5';
const HEALTHZ_URL = process.env.TRIAGE_HEALTHZ_URL || 'https://three.ws/api/healthz';
const RUNBOOK = 'docs/ops/production-log-triage.md';

// Classes, in escalation order. `owner` = only the owner can act (money,
// billing, security credential). `env-action` = fix is a pre-approved
// config-only `gcloud run services update` or quota lever. `investigate` =
// unknown signature, an agent should root-cause it. `self-healing` =
// documented graceful degradation, no action.
const CLASS_ORDER = { owner: 0, 'env-action': 1, investigate: 2, 'self-healing': 3 };

const KNOWN_SIGNATURES = [
	{
		id: 'ring-guard-violated',
		match: /\[ring-invariants\] SPEND PATH DISABLED/i,
		class: 'owner',
		action: `x402 ring guard env is half-configured; loop fails closed. Owner picks: pause (X402_AUTONOMOUS_ENABLED=false) or finish arming. ${RUNBOOK} §ring.`,
	},
	{
		id: 'world-unprotected',
		match: /world is UNPROTECTED|ADMIN_CODE is not set/i,
		class: 'owner',
		action: `world.three.ws serving without ADMIN_CODE: every visitor has build rights. Owner runs deploy/world/apply-hardening.sh. ${RUNBOOK} §world.`,
	},
	{
		id: 'replicate-credit',
		match: /replicate billing\/credit failure|insufficient credit/i,
		class: 'owner',
		action: `Replicate out of credit; forge degrades to free NVIDIA NIM lane meanwhile. Owner adds credit at replicate.com/account/billing. ${RUNBOOK} §replicate.`,
	},
	{
		id: 'db-storage-cap',
		match: /db at storage cap/i,
		class: 'env-action',
		action: `Neon over high-water; write crons preflight-skip until retention reclaims. Levers: DB_RETENTION_HIGH_WATER_MB, PUMP_INTEL_RETENTION_DAYS, or bigger Neon plan. ${RUNBOOK} §storage-cap.`,
	},
	{
		id: 'db-deadline',
		match: /\[x402-audit\] insert failed|db query exceeded \d+ms deadline/i,
		class: 'env-action',
		action: `Neon saturated; best-effort audit write timed out (telemetry only, never a payment). Capacity lever: Neon compute/pooler, or X402_AUDIT_WRITE_TIMEOUT_MS. ${RUNBOOK} §audit-insert.`,
	},
	{
		id: 'run-oom',
		match: /memory limit of \d+\s?MiB exceeded|Consider increasing the memory limit/i,
		class: 'env-action',
		action: 'Container OOM. Raise the service memory: gcloud run services update <service> --region us-central1 --memory <2x-current> (config-only, pre-approved).',
	},
	{
		id: 'run-no-instance',
		match: /no available instance|The request was aborted because there was no available instance/i,
		class: 'env-action',
		action: 'Cloud Run could not schedule an instance (max-instances or quota ceiling). Raise --max-instances or file the quota increase per docs/ops/gcp-credits-plan.md.',
	},
	{
		id: 'indexer-budget',
		match: /time-budget-exceeded/i,
		class: 'self-healing',
		action: `Indexer checkpointed mid-backfill and resumes next tick. Only act if it persists for many hours (slow RPC). ${RUNBOOK} §indexer.`,
	},
	{
		id: 'redis-degraded',
		match: /redis (SET|GET)? ?(failed|degraded)|circuit open(ed)?|memory fallback/i,
		class: 'self-healing',
		action: `Cache circuit breaker riding out an Upstash blip; reads keep serving. Optional: same-region cache store. ${RUNBOOK} §cache.`,
	},
	{
		id: 'helius-backoff',
		match: /helius quota|rate.?limited|refresh deferred \(transient upstream\)/i,
		class: 'self-healing',
		action: `Helius 429; public-RPC fallback serving. Optional: raise Helius plan. ${RUNBOOK} §helius.`,
	},
	{
		id: 'forge-fallback',
		match: /paid .* lane unavailable|degrading .* to free|falling back/i,
		class: 'self-healing',
		action: `Forge lane failover fired; generation keeps succeeding on the next rung. Tied to Replicate credit if you want the paid lane back. ${RUNBOOK} §forge.`,
	},
	{
		id: 'sns-name-not-found',
		match: /Invalid name account provided/i,
		class: 'self-healing',
		action: `x402 pay-by-name resolve() hit a .sol name with no on-chain account. resolveName() catches it and returns a clean 404 to the caller; the ERROR line is @bonfida/spl-name-service leaking a sibling promise rejection from its multi-strategy lookup (the awaited path is caught, the orphan is not). No user impact. ${RUNBOOK} §sns-name-not-found.`,
	},
	{
		id: 'pump-launch-sim-rejected',
		match: /\[pump\/launch-agent\] send failed .*pre-broadcast simulation failed/i,
		class: 'self-healing',
		action: `The pump.fun launch handler simulates every transaction before broadcasting; this line is the simulation REFUSING a launch that would have failed on-chain (program custom errors: slippage moved, mint state raced, metadata rejected), which protects the user's fees. The caller gets a clean 502 and a retry succeeds (verify: a 201 from the same route usually follows within minutes). Investigate only if the same wallet repeats the failure many times or the 502 rate on /api/pump/launch-agent becomes a sustained group. ${RUNBOOK} §pump-launch-sim-rejected.`,
	},
];

// Known signatures for request-log (5xx) groups. `test` sees the http group:
// { service, status, path, userAgent }. First match wins; unmatched 5xx stays
// `investigate`.
const KNOWN_HTTP_SIGNATURES = [
	{
		// MUST precede worker-coldstart-health-503: a quota-starved 503 also
		// arrives as 503 /health from the scheduler, but the instance never
		// started at all — that is allocation starvation, not a cold boot.
		id: 'gpu-quota-starved',
		test: (g) => g.status === 503 && /exceeded its quota limit/i.test(g.detail),
		class: 'env-action',
		action: `Cloud Run cannot allocate a GPU for this service: the shared L4 pool (NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion, granted 3 in us-central1) is fully pinned by warm min-instances. Fix order: (1) find the idle holder — measure real job traffic per warm GPU service (POST requests, not health pings) and set the idle one to --min-instances=0 (config-only, pre-approved); 2026-07-26 case: model-hunyuan3d held a warm L4 with zero jobs in 3 days while model-text2motion starved. (2) Check the pending raise: gcloud alpha quotas preferences list --project=aerial-vehicle-466722-p5 (preference l4-no-zonal-us-central1-8, preferred 16). Fleet map + lessons: docs/ops/gcp-credits-plan.md. ${RUNBOOK} §gpu-quota-starved.`,
	},
	{
		id: 'worker-coldstart-health-503',
		test: (g) => g.status === 503 && g.path === '/health' && /Google-Cloud-Scheduler/i.test(g.userAgent),
		class: 'self-healing',
		action: `A keep-warm scheduler probe hit a GPU/model worker while it was cold-booting (weights stream for 30-60s before the server reports ready); the very purpose of the probe is to absorb that cold start. Verify the service logged its "ready" line shortly after (npm run logs -- -s <service> --since 1h) and move on. Investigate only if the SAME service repeats this across multiple sweeps, which means it is crash-looping instead of booting. ${RUNBOOK} §worker-coldstart-health.`,
	},
	{
		id: 'x402-wallets-dry-5xx',
		test: (g) => g.status >= 500 && (g.path.startsWith('/api/x402') || g.path === '/api/mcp')
			&& /threews-x402-(autonomous|seed)/.test(g.userAgent),
		class: 'owner',
		action: `5xx on paid x402 routes from the platform's own agent traffic means the economy wallets are out of SOL for tx fees (symptom map: 502 = fee wallet below SOL floor, 503 = payer self-pay refused). The economy-rebalance keypair crash is FIXED and LIVE (commit bb02839f9); when it reports skipped: "insufficient_sol_surplus" there is genuinely nothing left to swap. At the 94-calls/min ring shape the burn is ~1-1.4 SOL/day. Owner action: send SOL (or USDC) to the economy master WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW; treasury-topup distributes to engines within minutes and economy-rebalance restores the payer's USDC float. Verify recovery: POST /api/cron/economy-rebalance (Bearer CRON_SECRET) returns results[].status "swapped", healthz x402_settle returns to ok, 5xx storm stops. Alternative to daily funding: throttle the ring to funded runway (X402_RING_TICK_CONCURRENCY and cadence knobs). ${RUNBOOK} §x402-wallets-dry.`,
	},
	{
		id: 'cc-unconfigured-503',
		// Every /api/community/* and /api/clash route wraps the same client and
		// answers the same designed 503 when CC_API_KEY is absent — match the
		// whole family, not just the worlds lobby.
		test: (g) => g.status === 503 && (g.path.startsWith('/api/community/') || g.path.startsWith('/api/clash')),
		class: 'owner',
		action: `/api/community/worlds returns its designed 503 cc_unconfigured: CC_API_KEY exists nowhere (Cloud Run env, .env, Secret Manager — swept 2026-07-26). The coin-worlds lobby stays empty until the owner provisions a CoinCommunities API key (api.coin-communities.xyz), then: gcloud run services update three-ws-api --region us-central1 --update-env-vars CC_API_KEY=<key>. Harmless noise until then. ${RUNBOOK} §cc-unconfigured.`,
	},
];

function parseArgs(argv) {
	const opts = { since: '1h', json: false, limit: 1000, project: PROJECT };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case '--since': opts.since = next(); break;
			case '--json': opts.json = true; break;
			case '-n': case '--limit': opts.limit = Number(next()); break;
			case '--project': opts.project = next(); break;
			case '-h': case '--help':
				console.log('Usage: node scripts/gcp-triage.mjs [--since 1h] [--json] [--limit 1000] [--project <id>]');
				process.exit(0);
				break;
			default:
				console.error(`Unknown option: ${a}`);
				process.exit(2);
		}
	}
	if (!/^\d+[smhdw]$/.test(opts.since)) {
		console.error(`--since must look like 30m, 2h, 1d (got "${opts.since}")`);
		process.exit(2);
	}
	return opts;
}

async function fetchHealthz() {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		const res = await fetch(HEALTHZ_URL, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
		const body = await res.json();
		return {
			reachable: true,
			status: body.subsystems?.status || body.status,
			degraded: body.subsystems?.degraded || [],
			subsystems: (body.subsystems?.subsystems || []).map((s) => ({
				name: s.name, status: s.status, detail: s.detail,
			})),
			ring: body.x402?.ring || null,
		};
	} catch (err) {
		return { reachable: false, error: err?.message || String(err) };
	}
}

function readLogs(opts) {
	const query = 'resource.type="cloud_run_revision" severity>=WARNING';
	const res = spawnSync('gcloud', [
		'logging', 'read', query,
		`--project=${opts.project}`,
		`--freshness=${opts.since}`,
		`--limit=${opts.limit}`,
		'--format=json',
	], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	if (res.status !== 0) {
		console.error((res.stderr || '').trim() || 'gcloud logging read failed');
		process.exit(1);
	}
	return JSON.parse(res.stdout || '[]');
}

function entryMessage(entry) {
	if (entry.textPayload != null) return entry.textPayload;
	if (entry.jsonPayload != null) {
		const p = entry.jsonPayload;
		return typeof p.message === 'string' ? p.message : JSON.stringify(p);
	}
	if (entry.protoPayload != null) {
		return `${entry.protoPayload.methodName || 'audit'} ${entry.protoPayload.status?.message || ''}`.trim();
	}
	return '';
}

// Collapse volatile tokens so repeated occurrences of one signature group
// together regardless of ids, sizes, and durations embedded in the line.
export function fingerprint(message) {
	return message
		.replace(/\b0x[0-9a-fA-F]{6,}\b/g, '<hex>')
		.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}\b/g, '<uuid>')
		.replace(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, '<addr>')
		.replace(/\bhttps?:\/\/\S+/g, '<url>')
		.replace(/\d+(\.\d+)?/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 160);
}

export function classify(message) {
	for (const sig of KNOWN_SIGNATURES) {
		if (sig.match.test(message)) return sig;
	}
	return null;
}

function normalizePath(url) {
	try {
		const path = new URL(url).pathname;
		return path
			.replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}(?=\/|$)/g, '/<uuid>')
			.replace(/\/\d+(?=\/|$)/g, '/<n>')
			.replace(/\/[1-9A-HJ-NP-Za-km-z]{32,44}(?=\/|$)/g, '/<addr>');
	} catch {
		return url || '(unknown)';
	}
}

export function buildFindings(entries) {
	const appGroups = new Map();
	const httpGroups = new Map();

	for (const entry of entries) {
		const service = entry.resource?.labels?.service_name || '?';
		const ts = entry.timestamp || '';
		if (entry.httpRequest) {
			const status = entry.httpRequest.status || 0;
			if (status < 500 && status !== 429) continue; // 4xx is client behavior; 402 is the product
			const path = normalizePath(entry.httpRequest.requestUrl);
			const key = `${service} ${status} ${entry.httpRequest.requestMethod} ${path}`;
			const g = httpGroups.get(key) || {
				kind: 'http', service, status, path,
				userAgent: entry.httpRequest.userAgent || '-',
				title: `HTTP ${status} ${entry.httpRequest.requestMethod} ${path}`,
				count: 0, firstSeen: ts, lastSeen: ts,
				sample: `${entry.httpRequest.requestUrl} (ua: ${entry.httpRequest.userAgent || '-'})`,
				detail: '',
			};
			// Cloud Run rides the request's failure explanation (quota exhaustion,
			// no-instance aborts) in the request entry's textPayload; keep the first
			// one so message-based HTTP signatures can match on it.
			if (!g.detail && typeof entry.textPayload === 'string') g.detail = entry.textPayload.slice(0, 300);
			g.count++;
			if (ts < g.firstSeen) g.firstSeen = ts;
			if (ts > g.lastSeen) g.lastSeen = ts;
			httpGroups.set(key, g);
		} else {
			const message = entryMessage(entry);
			if (!message) continue;
			const fp = fingerprint(message);
			const g = appGroups.get(fp) || {
				kind: 'app', title: fp, count: 0, services: new Set(),
				severity: entry.severity || 'WARNING', firstSeen: ts, lastSeen: ts, sample: message.slice(0, 400),
			};
			g.count++;
			g.services.add(service);
			if ((entry.severity || '') === 'ERROR' || (entry.severity || '').startsWith('CRIT')) g.severity = entry.severity;
			if (ts < g.firstSeen) g.firstSeen = ts;
			if (ts > g.lastSeen) g.lastSeen = ts;
			appGroups.set(fp, g);
		}
	}

	const findings = [];
	for (const g of appGroups.values()) {
		const sig = classify(g.sample) || classify(g.title);
		findings.push({
			kind: 'app',
			class: sig ? sig.class : 'investigate',
			signature: sig ? sig.id : null,
			title: g.title,
			severity: g.severity,
			count: g.count,
			services: [...g.services],
			firstSeen: g.firstSeen,
			lastSeen: g.lastSeen,
			sample: g.sample,
			action: sig
				? sig.action
				: `Unknown signature. Root-cause it: npm run logs -- -s ${[...g.services][0]} --grep "${g.title.split(' ').slice(0, 3).join(' ')}" --since 6h, then fix in code or add it to ${RUNBOOK} + this script's KNOWN_SIGNATURES if it is expected degradation.`,
		});
	}
	for (const g of httpGroups.values()) {
		const sig = KNOWN_HTTP_SIGNATURES.find((s) => s.test(g));
		findings.push({
			kind: 'http',
			class: sig ? sig.class : (g.status === 429 ? 'self-healing' : 'investigate'),
			signature: sig ? sig.id : null,
			title: g.title,
			severity: g.status >= 500 ? 'ERROR' : 'WARNING',
			count: g.count,
			services: [g.service],
			firstSeen: g.firstSeen,
			lastSeen: g.lastSeen,
			sample: g.sample,
			action: sig
				? sig.action
				: (g.status === 429
					? 'Rate limiter doing its job; only act on a legitimate-traffic spike.'
					: `5xx on a served route. Correlate with app logs: npm run logs -- -s ${g.service} --errors --app --since 6h, and check forge_creations if it is a generation route.`),
		});
	}

	findings.sort((a, b) =>
		(CLASS_ORDER[a.class] - CLASS_ORDER[b.class]) || (b.count - a.count));
	return findings;
}

const CLASS_BADGE = {
	owner: '🔴 owner',
	'env-action': '🟡 env-action',
	investigate: '🟠 investigate',
	'self-healing': '🟢 self-healing',
};

function renderReport({ opts, healthz, findings, scanned }) {
	const lines = [];
	lines.push(`# gcp-triage: last ${opts.since}, project ${opts.project}`);
	lines.push('');
	if (!healthz.reachable) {
		lines.push(`## Healthz: UNREACHABLE (${healthz.error}); treat as an outage: check the LB and three-ws-api first`);
	} else {
		lines.push(`## Healthz: ${healthz.status}${healthz.degraded.length ? ` (${healthz.degraded.map((d) => d.name || d).join(', ')})` : ' (all subsystems ok)'}`);
		for (const s of healthz.subsystems.filter((s) => s.status !== 'ok')) {
			lines.push(`  - ${s.name}: ${s.status} (${s.detail})`);
		}
	}
	lines.push('');
	const actionable = findings.filter((f) => f.class !== 'self-healing');
	lines.push(`## Log sweep: ${scanned} WARNING+ entries → ${findings.length} distinct signatures (${actionable.length} actionable)`);
	lines.push('');
	if (!findings.length) lines.push('Nothing above WARNING in the window. Production is quiet.');
	for (const f of findings) {
		lines.push(`### ${CLASS_BADGE[f.class]} ×${f.count} [${f.services.join(', ')}] ${f.title}`);
		lines.push(`    last seen ${f.lastSeen}`);
		lines.push(`    → ${f.action}`);
		lines.push('');
	}
	return lines.join('\n');
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const [healthz, entries] = await Promise.all([
		fetchHealthz(),
		Promise.resolve().then(() => readLogs(opts)),
	]);
	const findings = buildFindings(entries);
	const actionable = findings.filter((f) => f.class !== 'self-healing');
	const unhealthy = !healthz.reachable
		|| (healthz.degraded && healthz.degraded.length > 0)
		|| actionable.length > 0;

	if (opts.json) {
		process.stdout.write(JSON.stringify({
			generatedAt: new Date().toISOString(),
			window: opts.since,
			project: opts.project,
			scannedEntries: entries.length,
			healthz,
			findings,
			actionable: actionable.length,
			healthy: !unhealthy,
		}, null, 2) + '\n');
	} else {
		console.log(renderReport({ opts, healthz, findings, scanned: entries.length }));
	}
	process.exit(unhealthy ? 1 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) await main();
