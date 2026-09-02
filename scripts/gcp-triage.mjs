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
 *   npm run triage:gcp:deep            # EVERYTHING: logs + version, TLS,
 *                                      # fleet, pages, crons, DB, wallets
 *
 * --deep layers nine read-only probes on top of the log sweep, each wrapping
 * an existing standalone audit, so one command answers "what's wrong with
 * three.ws?" across the whole surface instead of only what happened to log.
 * --skip <id,id> drops individual probes (ids in DEEP_PROBE_IDS below).
 *
 * Exit codes: 0 = healthy or self-healing noise only; 1 = findings that need
 * action; 2 = usage error. Agents: run with --json, then follow the fix
 * playbook in .agents/skills/gcp-triage/SKILL.md.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import tls from 'node:tls';
import { auditCapacity, recommend as recommendCapacity } from './gpu-capacity.mjs';

import './lib/gcloud-path.mjs';

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
		id: 'hf-hub-rate-limited',
		match: /We had to rate limit your IP|429 Client Error: Too Many Requests for url: https:\/\/huggingface\.co|LocalEntryNotFoundError/i,
		class: 'env-action',
		action: `A model worker fetched weights from huggingface.co at startup and HF rate-limited the Cloud Run egress IP, so the container never listened and Cloud Run killed the revision (crash loop). Anonymous HF pulls are per-IP capped and Cloud Run IPs are shared — never depend on a live HF fetch at boot. Fix (config-only, pre-approved): stage the needed files into the HF cache layout under gs://three-ws-model-weights/hf-cache/hub/models--<org>--<repo>/{refs/main,snapshots/<sha>/...} (the weights bucket is already gcsfuse-mounted at /weights), then gcloud run services update <service> --region us-central1 --update-env-vars HF_HOME=/weights/hf-cache,HF_HUB_OFFLINE=1,HUGGING_FACE_HUB_TOKEN=<HF_TOKEN from .env>. Note the token env var: the pinned huggingface_hub reads the LEGACY name HUGGING_FACE_HUB_TOKEN, so setting HF_TOKEN alone changes nothing. 2026-07-28 case: model-triposr, facebook/dino-vitb16 config.json. ${RUNBOOK} §hf-hub-rate-limited.`,
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
	{
		id: 'colyseus-seat-expired',
		match: /Error: seat reservation expired\./i,
		class: 'self-healing',
		action: `Colyseus matchmaking issued a seat and the client never completed the WebSocket upgrade inside the reservation TTL (slow network, closed tab, backgrounded mobile browser). The server correctly refuses the stale ticket; the client's next join request gets a fresh seat. Steady low cadence is normal. Investigate only if it spikes alongside multiplayer connect complaints (then suspect LB/WebSocket latency, not Colyseus). ${RUNBOOK} §colyseus-seat-expired.`,
	},
	{
		// Scoped to the service: an identical signal line from any OTHER service
		// must stay `investigate` — this entry only explains the pinned SRH image.
		id: 'redis-proxy-srh-crash',
		match: /Uncaught signal: 10, pid=\d+, tid=\d+/i,
		services: ['three-ws-redis-proxy'],
		class: 'self-healing',
		action: `The pinned hiett/serverless-redis-http (SRH) image aborts sporadically (~3x/day observed) and Cloud Run restarts it; minScale 2 keeps a warm sibling serving and the API's cache circuit breaker + memory fallback ride out the blip (healthz cache stays ok). No user impact at the observed rate. Durable fix when the owner approves an image change: bump the SRH image tag on three-ws-redis-proxy. Investigate only if the crash rate climbs to many per hour or healthz cache degrades. ${RUNBOOK} §redis-proxy-srh-crash.`,
	},
	{
		// Deliberately narrow: only the SHORT window is self-healing. A 403 benched
		// for 30m is a credential failure and must stay `investigate` so a dead key
		// is never classified as noise.
		id: 'solana-rpc-policy-block',
		match: /\[solana-rpc\] \S+ 403 .* cooling \d+s/i,
		class: 'self-healing',
		action: `A keyless Solana RPC node refused ONE call shape (PublicNode answers 403 to getTokenAccountsByOwner filtered by programId) while serving every other method. The request fails over and the lane stays in service, cooling seconds rather than the 30m an auth failure earns. No action needed. If instead you see this host cooling 30m, that is a real key problem, not this signature. ${RUNBOOK} §solana-rpc-403.`,
	},
	{
		id: 'okx-bot-session-logged-out',
		match: /session_logged_out/i,
		services: ['okx-chat-bot'],
		class: 'owner',
		action: `The OKX marketplace chat bot's wallet session expired, so every XMTP client is offline and buyer chat for agent #2632 is NOT delivered. Nothing here is config-fixable and a redeploy will not help: OKX requires a human to complete an email OTP as claude@three.ws. The host already minted the login URL and holds the exact three commands, so do not go hunting for them: curl -s https://okx-chat-bot-<hash>-uc.a.run.app/readyz | jq .remedy (or read the ops alert, which carries the same lines). Renewing the session restores delivery within a minute; the host's next probe flips healthz okx_chat_bot back to ok on its own. Left unfixed, OKX's own chat test times out at 30 minutes and flags the listing offline. See workers/okx-chat-bot/README.md.`,
	},
	{
		id: 'okx-bot-daemon-restart',
		match: /"msg":"daemon exited"/i,
		services: ['okx-chat-bot'],
		class: 'self-healing',
		action: `The okx-a2a XMTP daemon child died and the supervisor is restarting it with capped backoff (workers/okx-chat-bot/supervisor.js). One or two of these around a revision change is normal. Investigate only if the restart count climbs continuously, which means the daemon is failing at startup rather than dying in service: read the forwarded "daemon" lines just before the exit for the real error, most often a corrupt restored state tree (delete the GCS snapshot object and re-login) or a missing AI-provider credential.`,
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
		action: `Cloud Run cannot allocate a GPU for this service: the shared L4 pool (NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion, granted 3 in BOTH us-central1 and us-east4) is fully pinned by warm min-instances IN THE STARVED SERVICE'S OWN REGION. Quota is per region, so check the region on the failing revision first, not us-central1 by reflex. Fix order: (1) find the idle holder in that region by measuring real job traffic per warm GPU service (POST /infer, not health pings) and confirm which env var on three-ws-api routes production there, then set the idle one to --min-instances=0 (config-only, pre-approved). Twice now the same service was the idle holder: 2026-07-26 model-hunyuan3d in us-central1, 2026-08-11 model-hunyuan3d in us-east4 (zero jobs in 7 days; its real lane is model-hunyuan3d-21-rtx on the RTX quota). (2) Check the pending raise: gcloud alpha quotas preferences list --project=aerial-vehicle-466722-p5 (l4-no-zonal-us-central1-8 preferred 16, l4-no-zonal-us-east4-8 preferred 8). Fleet map + lessons: docs/ops/gcp-credits-plan.md. ${RUNBOOK} §gpu-quota-starved.`,
	},
	{
		id: 'worker-coldstart-health-503',
		test: (g) => g.status === 503 && g.path === '/health' && /Google-Cloud-Scheduler/i.test(g.userAgent),
		class: 'self-healing',
		action: `A keep-warm scheduler probe hit a GPU/model worker while it was cold-booting (weights stream for 30-60s before the server reports ready); the very purpose of the probe is to absorb that cold start. Verify the service logged its "ready" line shortly after (npm run logs -- -s <service> --since 1h) and move on. Investigate only if the SAME service repeats this across multiple sweeps, which means it is crash-looping instead of booting. ${RUNBOOK} §worker-coldstart-health.`,
	},
	{
		id: 'x402-wallets-dry-5xx',
		// The ring calls its own paid routes under several user agents, not just
		// the autonomous/seed drivers: persona agents ride "threews-ring-agent/
		// <persona>" (api/_lib/x402/agents/persona-kit.js), plus the wallet
		// monitor and thumbnail regen pipelines. Matching only two of them left
		// the rest landing in `investigate` every sweep with the same root cause
		// (2026-07-28: /api/x402/club-cover from threews-ring-agent/agora-citizen).
		// Any "threews-*" agent is the platform paying itself — one signature.
		test: (g) => g.status >= 500 && (g.path.startsWith('/api/x402') || g.path === '/api/mcp')
			&& /^threews-/.test(g.userAgent),
		class: 'owner',
		action: `5xx on paid x402 routes from the platform's own agent traffic has THREE distinct causes that look identical here; diagnose from app logs before concluding anything (2026-07-28 incident: all three fired at once). (0) FIRST read healthz x402_settle metrics.cause: it reconciles these 5xx against the facilitator's reject_reason book, so fee_governor there means the wallet fee governor spent the daily SOL budget (fund the fee wallet or accept the pacing; not a rail fault), and sponsor_floor means the floor case in (1). Only cause "rail" needs the log archaeology below. (1) npm run logs -- -s three-ws-api --app --grep "fee_wallet_below_floor" --since 1h; hits mean the sponsor fee wallet is under X402_SPONSOR_SOL_FLOOR_LAMPORTS. Config/self-heal territory: run POST /api/cron/treasury-topup (its reclaimIdleAgentSol leg refunds the fee wallet from idle agent SOL), no owner money needed unless every reclaim source reports at_or_below_floor. (2) grep "data_unavailable" instead; those are paid endpoints refunding honestly (no charge) because no market data source could answer. Fixed for pump.fun mints 2026-07-28 (crypto-intel prices bonding-curve coins via the pump.fun feed); a recurrence means a data-source outage, not wallets. (3) grep "broadcast_failed"; the reason now carries the simulation-log tail. "insufficient funds" on the token transfer = the ring payer's USDC float dipped below per-tick volume; run POST /api/cron/economy-rebalance (Bearer CRON_SECRET) and expect results[].status "swapped". ONLY when rebalance skips with insufficient_sol_surplus AND treasury-topup's reclaim finds nothing is it genuinely dry; then the owner sends SOL (or USDC) to the economy master WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW and treasury-topup distributes within minutes. Verify recovery: healthz x402_settle returns to ok and the 5xx storm stops. Alternative to funding: throttle the ring to funded runway (X402_RING_TICK_CONCURRENCY and cadence knobs). ${RUNBOOK} §x402-wallets-dry.`,
	},
	{
		id: 'coingecko-quota-exhausted-502',
		test: (g) => g.status === 502 && g.path.startsWith('/api/coin/'),
		class: 'env-action',
		action: `502 on a /api/coin/* route means every CoinGecko rung failed and no cached last-good existed. The usual cause is the DEMO KEY, not the upstream: the demo tier caps at 10,000 calls per MONTH, and once exhausted every request carrying COINGECKO_API_KEY gets 429 while the identical keyless request is still served (2026-07-28: /coin/detail, /tickers and /exchange all 502'd for hours on an exhausted key). Confirm in one call: curl -s -H "x-cg-demo-api-key: $KEY" https://api.coingecko.com/api/v3/key — error_code 10006 is the cap. geckoFetch now benches a rejected key for 15 min and retries keyless on its own, so a lingering 502 means the keyless tier is ALSO throttled (the Cloud Run egress IP is shared). Fix: gcloud run services update three-ws-api --region us-central1 --remove-env-vars COINGECKO_API_KEY (config-only, pre-approved) to stop paying the round trip, and tell the owner the key needs a paid tier or a monthly reset. ${RUNBOOK} §coingecko-quota-exhausted.`,
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
	{
		id: 'watsonx-unconfigured-503',
		test: (g) => g.status === 503 && (g.path === '/api/galaxy' || g.path.startsWith('/api/galaxy/')),
		class: 'owner',
		action: `/api/galaxy returns its designed 503 watsonx_unavailable: the Agent Galaxy positions stars with IBM Granite embeddings on watsonx.ai, and WATSONX_API_KEY / WATSONX_PROJECT_ID exist nowhere (Cloud Run env, .env, Secret Manager — swept 2026-07-29). The /galaxy page already renders a designed "IBM Granite isn't connected" state, so there is no broken user path and nothing to fix in code. Owner provisions watsonx credentials at cloud.ibm.com, then: gcloud run services update three-ws-api --region us-central1 --update-env-vars WATSONX_API_KEY=<key>,WATSONX_PROJECT_ID=<id>. Harmless noise until then. ${RUNBOOK} §watsonx-unconfigured.`,
	},
];

const DEEP_PROBE_IDS = [
	'version', 'tls', 'fleet', 'pages', 'cron-drift', 'cron-liveness',
	'db-migrations', 'service-wallets', 'custodial-keys',
];

function parseArgs(argv) {
	const opts = { since: '1h', json: false, limit: 1000, project: PROJECT, deep: false, skip: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case '--since': opts.since = next(); break;
			case '--json': opts.json = true; break;
			case '--deep': opts.deep = true; break;
			case '--skip': opts.skip = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean); break;
			case '-n': case '--limit': opts.limit = Number(next()); break;
			case '--project': opts.project = next(); break;
			case '-h': case '--help':
				console.log('Usage: node scripts/gcp-triage.mjs [--since 1h] [--json] [--deep] [--skip id,id] [--limit 1000] [--project <id>]');
				console.log(`Deep probe ids: ${DEEP_PROBE_IDS.join(', ')}`);
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
	const badSkips = opts.skip.filter((s) => !DEEP_PROBE_IDS.includes(s));
	if (badSkips.length) {
		console.error(`Unknown --skip probe id(s): ${badSkips.join(', ')} (valid: ${DEEP_PROBE_IDS.join(', ')})`);
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
		const why = res.error?.message || (res.stderr || '').trim() || 'unknown error';
		console.error(`gcloud logging read failed: ${why}`);
		if (/ENOENT/.test(why)) console.error('gcloud is not installed at any known path; see scripts/lib/gcloud-path.mjs.');
		if (/reauth|invalid_grant|credential/i.test(why)) console.error('gcloud auth has lapsed; only the owner can re-run `gcloud auth login` here.');
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

export function classify(message, services) {
	for (const sig of KNOWN_SIGNATURES) {
		if (!sig.match.test(message)) continue;
		// A signature may scope itself to specific services (e.g. a known crash in
		// one pinned third-party image); the same text from anywhere else must
		// stay unclassified so it surfaces as `investigate`.
		if (sig.services && !(services || []).some((s) => sig.services.includes(s))) continue;
		return sig;
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
		const sig = classify(g.sample, [...g.services]) || classify(g.title, [...g.services]);
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

	return sortFindings(findings);
}

const sortFindings = (arr) => arr.sort((a, b) =>
	(CLASS_ORDER[a.class] - CLASS_ORDER[b.class]) || (b.count - a.count));

const CLASS_BADGE = {
	owner: '🔴 owner',
	'env-action': '🟡 env-action',
	investigate: '🟠 investigate',
	'self-healing': '🟢 self-healing',
};

const PROBE_BADGE = { ok: '✅', findings: '❗', skipped: '⏭️', error: '💥' };

function renderReport({ opts, healthz, findings, scanned, deep }) {
	const lines = [];
	lines.push(`# gcp-triage: last ${opts.since}, project ${opts.project}${opts.deep ? ' (deep sweep)' : ''}`);
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
	if (deep) {
		lines.push(`## Deep sweep: ${deep.length} probes`);
		for (const p of deep) {
			lines.push(`  ${PROBE_BADGE[p.status] || '?'} ${p.id} [${Math.round(p.ms / 1000)}s] ${p.status}${p.note ? `: ${p.note}` : ''}`);
		}
		lines.push('');
	}
	const actionable = findings.filter((f) => f.class !== 'self-healing');
	lines.push(`## Log sweep: ${scanned} WARNING+ entries → ${findings.length} distinct signatures (${actionable.length} actionable)`);
	lines.push('');
	if (!findings.length) lines.push('Nothing above WARNING in the window. Production is quiet.');
	for (const f of findings) {
		lines.push(`### ${CLASS_BADGE[f.class]} ×${f.count} [${f.services.join(', ')}] ${f.title}`);
		lines.push(`    last seen ${f.lastSeen}`);
		if (f.kind === 'deep' && f.sample) {
			for (const s of f.sample.split('\n').slice(0, 8)) lines.push(`    | ${s}`);
		}
		lines.push(`    → ${f.action}`);
		lines.push('');
	}
	return lines.join('\n');
}

// A GPU-starvation finding names the symptom; the fix depends on where the free
// capacity actually is, which only the per-region capacity audit knows. Rather
// than making every triage run pay for that sweep, run it ONLY when the sweep
// already saw starvation, and fold the concrete answer into the finding.
function gpuCapacityFindings(findings) {
	const starved = findings.filter((f) => f.signature === 'gpu-quota-starved');
	if (!starved.length) return [];
	let report;
	try {
		report = auditCapacity({ project: PROJECT });
	} catch {
		return []; // capacity audit is advisory; never let it fail the sweep
	}
	if (!report) return [];
	const recs = recommendCapacity(report).filter((r) => r.priority <= 2);
	if (!recs.length) return [];
	const free = report.regions
		.filter((r) => r.headroom > 0)
		.map((r) => `${r.region} (${r.headroom} free of ${r.granted})`);
	return [{
		kind: 'capacity',
		class: 'env-action',
		signature: 'gpu-capacity-plan',
		title: 'GPU capacity plan for the starvation above',
		severity: 'WARNING',
		count: starved.reduce((n, f) => n + f.count, 0),
		services: [...new Set(starved.flatMap((f) => f.services))],
		firstSeen: starved[0].firstSeen,
		lastSeen: starved[starved.length - 1].lastSeen,
		sample: free.length ? `unpinned GPUs available in: ${free.join(', ')}` : 'no region currently has an unpinned GPU',
		action: `${recs.map((r, i) => `${i + 1}. ${r.detail} → ${r.command}`).join('  ')}  Full picture: npm run gpu. Fleet map: docs/ops/gcp-credits-plan.md.`,
	}];
}

// ---------------------------------------------------------------------------
// Deep sweep (--deep). Nine read-only probes, each wrapping an audit that
// already exists standalone in scripts/, normalized into the same findings
// stream as the log sweep. All probes run concurrently. A probe that cannot
// run is itself a finding (a blind spot is not "healthy"); a probe skipped
// for missing local secrets is reported as skipped, not silently dropped.
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const tail = (s, n = 12) => String(s || '').trim().split('\n').slice(-n).join('\n').slice(0, 1400);

function runCommand(argv, { timeoutMs = 180000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { cwd: process.cwd() });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
		child.stdout.on('data', (d) => { stdout += d; });
		child.stderr.on('data', (d) => { stderr += d; });
		child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || err.message, timedOut }); });
		child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
	});
}

function deepFinding(probe, cls, title, { count = 1, services = [], sample = '', action }) {
	return {
		kind: 'deep', class: cls, signature: `deep-${probe}`, title,
		severity: cls === 'self-healing' ? 'WARNING' : 'ERROR',
		count, services, firstSeen: nowIso(), lastSeen: nowIso(),
		sample: String(sample).slice(0, 1400), action,
	};
}

async function probeVersion() {
	let body;
	try {
		const res = await fetch('https://three.ws/api/version', { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		body = await res.json();
	} catch (err) {
		return { status: 'findings', findings: [deepFinding('version', 'investigate', '/api/version unreachable on the live site', {
			services: ['three-ws-api'], sample: err?.message || String(err),
			action: 'The version endpoint should always answer; treat as outage-adjacent. Check three-ws-api revisions (gcloud run revisions list --service three-ws-api --region us-central1) and the LB per docs/ops/gcp-production.md.',
		})] };
	}
	const commit = body.commit || '';
	let ahead = null;
	if (commit) {
		const r = spawnSync('git', ['rev-list', '--count', `${commit}..HEAD`], { encoding: 'utf8' });
		if (r.status === 0) ahead = Number(r.stdout.trim());
	}
	const note = `prod ${body.commitShort || commit.slice(0, 9) || '?'} rev ${body.runtime?.revision || '?'}${ahead == null ? '' : `, local HEAD ${ahead} commit(s) ahead`}`;
	if (commit && ahead == null) {
		return { status: 'findings', note, findings: [deepFinding('version', 'investigate', 'deployed commit is unknown to this clone', {
			services: ['three-ws-api'], sample: `deployed commit ${commit}`,
			action: 'Production runs a commit not in local history. git fetch threews and re-check; if still unknown, the deploy came from outside this repo lineage and needs the owner to confirm what shipped.',
		})] };
	}
	return { status: 'ok', note };
}

function certDaysLeft(host) {
	return new Promise((resolve, reject) => {
		const sock = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
			const cert = sock.getPeerCertificate();
			sock.end();
			if (!cert || !cert.valid_to) return reject(new Error('no certificate presented'));
			resolve((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
		});
		sock.on('error', (err) => reject(err));
		sock.on('timeout', () => { sock.destroy(); reject(new Error('TLS handshake timeout')); });
	});
}

async function probeTls() {
	const findings = [];
	const notes = [];
	for (const host of ['three.ws', 'world.three.ws']) {
		try {
			const days = Math.floor(await certDaysLeft(host));
			notes.push(`${host} ${days}d`);
			if (days < 21) {
				findings.push(deepFinding('tls', 'env-action', `TLS certificate for ${host} expires in ${days} days`, {
					sample: `${host}: ${days} days of validity left`,
					action: 'Google-managed LB certs renew on their own roughly 30 days out; under 21 days means renewal is stuck (domain authorization or DNS). gcloud compute ssl-certificates list, then docs/ops/gcp-production.md.',
				}));
			}
		} catch (err) {
			findings.push(deepFinding('tls', 'investigate', `TLS handshake to ${host} failed`, {
				sample: err?.message || String(err),
				action: `If curl -sI https://${host} also fails this is an LB/DNS problem for that hostname; follow docs/ops/gcp-production.md. If only the probe fails, re-run it standalone before acting.`,
			}));
		}
	}
	return { status: findings.length ? 'findings' : 'ok', note: notes.join(', '), findings };
}

async function probeFleet(opts) {
	const r = await runCommand(['gcloud', 'run', 'services', 'list', `--project=${opts.project}`, '--region=us-central1', '--format=json'], { timeoutMs: 90000 });
	if (r.code !== 0) return { status: 'error', note: tail(r.stderr, 3) };
	const services = JSON.parse(r.stdout || '[]');
	const notReady = [];
	for (const s of services) {
		const name = s.metadata?.name || '?';
		const ready = (s.status?.conditions || []).find((c) => c.type === 'Ready');
		if (ready && ready.status !== 'True') notReady.push(`${name}: ${(ready.message || ready.reason || 'not ready').slice(0, 160)}`);
	}
	if (!notReady.length) return { status: 'ok', note: `${services.length} services, all Ready` };
	return { status: 'findings', note: `${notReady.length}/${services.length} not Ready`, findings: [deepFinding('fleet', 'investigate', `${notReady.length} Cloud Run service(s) not Ready`, {
		count: notReady.length, services: notReady.map((l) => l.split(':')[0]), sample: notReady.join('\n'),
		action: 'The latest revision is failing while an older one may still serve. gcloud run revisions list --service <name> --region us-central1, then npm run logs -- -s <name> --errors --since 6h for the crash reason. Rollback: docs/ops/gcp-production.md.',
	})] };
}

async function probePages() {
	const r = await runCommand(['node', 'scripts/check-pages.mjs', '--base', 'https://three.ws'], { timeoutMs: 420000 });
	if (r.timedOut) return { status: 'error', note: 'live page sweep timed out after 7 minutes' };
	const out = `${r.stdout}\n${r.stderr}`;
	if (r.code === 0) {
		const m = out.match(/all (\d+) declared pages reachable/);
		return { status: 'ok', note: m ? `all ${m[1]} advertised pages reachable` : 'all advertised pages reachable' };
	}
	const lines = out.split('\n').filter((l) => l.includes('[check-pages]') && !l.includes(' OK ')).slice(0, 14);
	const countMatch = out.match(/(\d+) declared page/);
	return { status: 'findings', note: `${countMatch ? countMatch[1] : 'some'} page(s) failing`, findings: [deepFinding('pages', 'investigate', 'advertised pages failing on the live site', {
		count: countMatch ? Number(countMatch[1]) : 1, services: ['three-ws-api'], sample: lines.join('\n'),
		action: 'Each failing path is advertised in the sitemap and llms.txt. The sweep output states whether it is a routing bug or deploy lag (route landed after the running image). Routing bug: add the vercel.json rewrite and vite input, commit. Deploy lag: note it for the next owner-approved deploy.',
	})] };
}

async function probeCronDrift() {
	const r = await runCommand(['node', 'scripts/check-cron-drift.mjs', '--json'], { timeoutMs: 120000 });
	let report;
	try { report = JSON.parse(r.stdout); } catch { return { status: 'error', note: tail(r.stderr || r.stdout, 3) }; }
	if (report.liveError) return { status: 'error', note: `Cloud Scheduler unreadable: ${report.liveError}` };
	const cats = [
		['invalid expression', report.invalid], ['duplicate job id', report.duplicates],
		['missing in Cloud Scheduler', report.missing], ['schedule mismatch', report.mismatched],
		['not enabled', report.paused],
	].filter(([, rows]) => rows?.length);
	if (!cats.length) return { status: 'ok', note: `${report.declared} declared crons in sync with Cloud Scheduler` };
	const sample = cats.map(([label, rows]) => `${label} (${rows.length}): ${rows.slice(0, 5).map((x) => x.path || x.id).join(', ')}`).join('\n');
	return { status: 'findings', note: cats.map(([l, rows]) => `${rows.length} ${l}`).join(', '), findings: [deepFinding('cron-drift', 'env-action', 'cron declarations drifted from Cloud Scheduler', {
		count: cats.reduce((n, [, rows]) => n + rows.length, 0), sample,
		action: 'Re-sync Cloud Scheduler from vercel.json with node scripts/create-gcp-scheduler.mjs. That is config-only and leaves run state alone, so a missing job is created ENABLED and a mismatched schedule is corrected without disturbing the rest of the fleet. A NOT ENABLED job can be a deliberate incident hold: resume that one job by name (gcloud scheduler jobs resume cron--api-cron-<name>, note the double hyphen) rather than passing --resume, which restarts every job. Invalid or duplicate declarations are code fixes in vercel.json.',
	})] };
}

async function probeCronLiveness() {
	const r = await runCommand(['node', 'scripts/audit-cron-liveness.mjs', '--static', '--json'], { timeoutMs: 300000 });
	let report;
	try { report = JSON.parse(r.stdout); } catch { return { status: 'error', note: tail(r.stderr || r.stdout, 3) }; }
	const bad = (report.crons || []).filter((c) => c.verdict === 'DEAD' || c.verdict === 'BROKEN' || c.verdict === 'UNGATED');
	if (!bad.length) return { status: 'ok', note: `${report.declared} crons route, resolve, and load` };
	const sample = bad.slice(0, 10).map((c) => `${c.verdict} ${c.path} (${c.notes?.[0] || c.handler || 'no detail'})`).join('\n');
	return { status: 'findings', note: `${bad.length} cron(s) dead/broken/ungated`, findings: [deepFinding('cron-liveness', 'investigate', `${bad.length} declared cron(s) cannot actually run`, {
		count: bad.length, sample,
		action: 'DEAD = no route or handler resolves; BROKEN = the handler throws at load; UNGATED = it runs for anonymous callers (security fix: gate on CRON_SECRET). Reproduce with npm run audit:cron-liveness, fix in code, commit. These fail silently in production: Cloud Scheduler keeps reporting success.',
	})] };
}

async function probeDbMigrations() {
	const r = await runCommand(['node', 'scripts/apply-migrations.mjs', '--check'], { timeoutMs: 90000 });
	if (r.code === 0) return { status: 'ok', note: 'no pending DB migrations' };
	if (r.code === 4) {
		return { status: 'findings', note: 'pending migrations', findings: [deepFinding('db-migrations', 'investigate', 'DB migrations pending against the database', {
			sample: tail(r.stdout, 10),
			action: 'npm run db:status lists them. db:migrate applies EVERY pending migration immediately with no dry run, so apply only in coordination with the deploy that needs the schema. The deploy gate (npm run db:check) fails until this is resolved.',
		})] };
	}
	if (/DATABASE_URL/i.test(r.stderr + r.stdout)) return { status: 'skipped', note: 'no DATABASE_URL in this environment' };
	return { status: 'error', note: tail(r.stderr || r.stdout, 3) };
}

async function probeServiceWallets() {
	if (!existsSync('.env')) return { status: 'skipped', note: 'no .env with signer secrets here' };
	const r = await runCommand(['node', '--env-file=.env', 'scripts/audit-service-wallets.mjs'], { timeoutMs: 300000 });
	if (r.timedOut) return { status: 'error', note: 'wallet audit timed out' };
	const lines = r.stdout.split('\n').map((l) => l.trim());
	// `✗` = the chain was read and the money is wrong (owner). `‼` = the balance
	// could not be read at all (investigate). Reporting an unreadable wallet as a
	// funding emergency is the 2026-08-07 false alarm this split exists to stop.
	const issues = lines.filter((l) => l.startsWith('✗'));
	const unread = lines.filter((l) => l.startsWith('‼'));
	if (r.code === 0 && !issues.length && !unread.length) return { status: 'ok', note: 'service wallets above floors, advertised keys consistent' };
	const findings = [];
	if (issues.length) {
		findings.push(deepFinding('service-wallets', 'owner', 'service wallet balances or advertised keys failing audit', {
			count: issues.length, sample: issues.join('\n'),
			action: `Money surface; diagnose before concluding the owner must fund. Below-floor balances: run the self-heal first (POST /api/cron/treasury-topup reclaim leg, then /api/cron/economy-rebalance) per ${RUNBOOK} §x402-wallets-dry, or the x402-economy-triage agent. A fee-payer/payTo mismatch is env config on the Cloud Run service, not funding.`,
		}));
	}
	if (unread.length) {
		findings.push(deepFinding('service-wallets-unreadable', 'investigate', 'wallet balances could not be read, so funding state is unverified', {
			count: unread.length, sample: unread.join('\n'),
			action: 'NOT a funding verdict: the audit could not reach a working Solana RPC lane for these wallets. Check healthz rpc_lanes for how many lanes are cooling, then re-run the audit once a lane recovers. Do not fund or rebalance anything off an unreadable balance.',
		}));
	}
	if (findings.length) {
		const parts = [issues.length ? `${issues.length} wallet issue(s)` : '', unread.length ? `${unread.length} unreadable` : ''].filter(Boolean);
		return { status: 'findings', note: parts.join(', '), findings };
	}
	return { status: 'error', note: tail(r.stderr || r.stdout, 3) };
}

async function probeCustodialKeys() {
	if (!existsSync('.env')) return { status: 'skipped', note: 'no .env with DB/encryption secrets here' };
	const r = await runCommand(['node', 'scripts/audit-custodial-key-health.mjs', '--json'], { timeoutMs: 300000 });
	if (r.code !== 0 || r.timedOut) {
		// Exit 3 with a structured error is the audit refusing to guess: no
		// decryption key is configured here, so every wallet would read as
		// undecryptable and a 100%-stranded verdict would be an artifact of this
		// machine. Match on the code, not on prose that can be reworded.
		let blocked;
		try { blocked = JSON.parse(r.stdout); } catch { blocked = null; }
		if (blocked?.error === 'no_decryption_key') return { status: 'skipped', note: 'custodial audit has no decryption key here' };
		if (/DATABASE_URL|WALLET_ENCRYPTION_KEY/i.test(r.stderr + r.stdout)) return { status: 'skipped', note: 'custodial audit secrets not present' };
		return { status: 'error', note: tail(r.stderr || r.stdout, 3) };
	}
	let report;
	try { report = JSON.parse(r.stdout); } catch { return { status: 'error', note: 'unparseable custodial audit output' }; }
	const strandedFunded = report.counts?.stranded_funded || 0;
	const strandedUnread = report.counts?.stranded_unread || 0;
	const findings = [];
	// A "0 SOL stranded" verdict is only trustworthy if every undecryptable
	// wallet actually got a balance read. When the audit's RPC lane fails, its
	// own sum() now skips unread addresses instead of coalescing them to zero
	// (2026-08-09 fix), so surface that here too rather than reporting "ok".
	if (strandedUnread) {
		const sample = (report.unread_stranded || []).slice(0, 6).map((w) => `${w.address} ${w.platform ? 'platform' : 'CUSTOMER'} (${w.reason})`).join('\n');
		findings.push(deepFinding('custodial-keys-unread', 'investigate', `${strandedUnread} undecryptable wallet(s) never got a balance read, so "stranded" is unknown for them`, {
			count: strandedUnread, sample,
			action: 'NOT a "0 stranded" verdict: the audit could not reach a working Solana RPC lane for these wallets. Check healthz rpc_lanes for how many lanes are cooling, then re-run once a lane recovers.',
		}));
	}
	const note = `${report.wallets} wallets, ${report.undecryptable} undecryptable, ${strandedUnread ? 'unknown (unread)' : `${report.sol?.stranded ?? 0}`} SOL stranded`;
	if (strandedFunded) {
		const sample = (report.top_stranded || []).slice(0, 6).map((w) => `${w.sol} SOL ${w.address} ${w.platform ? 'platform' : 'CUSTOMER'} (${w.reason})`).join('\n');
		findings.push(deepFinding('custodial-keys', 'owner', `${strandedFunded} funded custodial wallet(s) behind undecryptable keys`, {
			count: strandedFunded, sample,
			action: 'These balances are invisible to treasury self-heal and, for customer wallets, block withdrawals (support obligation; escalate those first). Usual cause is a WALLET_ENCRYPTION_KEY rotation; scripts/rekey-stale-launch-wallets.mjs documents the recovery path.',
		}));
	}
	if (findings.length) return { status: 'findings', note, findings };
	return { status: 'ok', note };
}

const DEEP_PROBES = {
	version: probeVersion,
	tls: probeTls,
	fleet: probeFleet,
	pages: probePages,
	'cron-drift': probeCronDrift,
	'cron-liveness': probeCronLiveness,
	'db-migrations': probeDbMigrations,
	'service-wallets': probeServiceWallets,
	'custodial-keys': probeCustodialKeys,
};

async function runDeepSweep(opts) {
	const ids = DEEP_PROBE_IDS.filter((id) => !opts.skip.includes(id));
	return Promise.all(ids.map(async (id) => {
		const started = Date.now();
		let result;
		try {
			result = await DEEP_PROBES[id](opts);
		} catch (err) {
			result = { status: 'error', note: (err?.message || String(err)).slice(0, 300) };
		}
		const probe = { id, ms: Date.now() - started, status: result.status, note: result.note || '', findings: result.findings || [] };
		if (probe.status === 'error' && !probe.findings.length) {
			probe.findings = [deepFinding(id, 'investigate', `deep probe "${id}" could not run`, {
				sample: probe.note,
				action: `The sweep is blind on this surface until the probe runs. Re-run it standalone (see DEEP_PROBES in scripts/gcp-triage.mjs for the underlying command) and fix whatever stops it.`,
			})];
		}
		return probe;
	}));
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	// Kick the deep probes off first: they are child processes and keep running
	// while the synchronous gcloud log read blocks the parent.
	const deepPromise = opts.deep ? runDeepSweep(opts) : Promise.resolve(null);
	const [healthz, entries] = await Promise.all([
		fetchHealthz(),
		Promise.resolve().then(() => readLogs(opts)),
	]);
	const findings = buildFindings(entries);
	findings.push(...gpuCapacityFindings(findings));
	const deep = await deepPromise;
	if (deep) {
		for (const p of deep) findings.push(...p.findings);
		sortFindings(findings);
	}
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
			deep: deep ? deep.map(({ findings: _f, ...rest }) => rest) : null,
			findings,
			actionable: actionable.length,
			healthy: !unhealthy,
		}, null, 2) + '\n');
	} else {
		console.log(renderReport({ opts, healthz, findings, scanned: entries.length, deep }));
	}
	process.exit(unhealthy ? 1 : 0);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) await main();
