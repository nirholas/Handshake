// @ts-check
// GET /api/cron/forge-smoke — daily end-to-end generation smoke test.
//
// The June 2026 audit found fully-wired generation flows that were 100% dead
// in production while every config check read green. The only bar that counts
// is the one a stranger hits: a prompt in, a real GLB out. This cron runs that
// bar once a day against the deployed site (vercel.json crons):
//
//   1. POST /api/forge { prompt, tier: 'draft', force_regenerate: true } against
//      the free NVIDIA lane, so a daily run costs zero vendor spend. The flag is
//      load-bearing: see runGeneration for why a cached hit would make this leg
//      pass while generation is dead.
//   2. Poll the job (the draft lane usually answers synchronously) and fetch
//      the resulting GLB's first bytes — only the 'glTF' magic counts as up.
//   3. GET /api/forge?health — surfaces paid-lane breakage (provider auth,
//      quota, the rate-limiter store failing closed) that the free lane masks.
//   4. Agent surfaces — the June 2026 MCP audit found the 3D Studio answering
//      with the wrong server's 402 and missing from the discovery catalog for
//      months; nothing generation-shaped could catch that. This leg asserts
//      what a paying agent sees: free tools/list reaches the studio toolset,
//      the unpaid 402 names /api/mcp-3d and quotes the standard tier price,
//      /.well-known/x402.json lists every generation surface, and the paid
//      REST endpoint still challenges with usable accepts.
//   5. LLM completion — runs a trivial llmComplete through the real free-first
//      provider chain. A dead paid chain hides behind the free-tier fallback in
//      day-to-day use; this leg fails loudly so ops sees it. Runs concurrently
//      with the 3D legs so it never delays them.
//
// Failures page the ops Telegram channel; recovery is announced once. Like
// uptime-check, a concrete file keeps the import graph tiny.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { llmComplete } from '../_lib/llm.js';
import { fetchRedisDailyCommands, evaluateRedisBurn, redisBurnAlert } from '../_lib/redis-usage.js';
import { requireCron } from '../_lib/cron-auth.js';

const SMOKE_PROMPT = 'a small wooden toy boat with a striped sail';
const SUBMIT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_DEADLINE_MS = 180_000;
const LAST_STATUS_KEY = 'forge-smoke:last';
const LAST_STATUS_TTL_S = 7 * 24 * 60 * 60;

// Never throws: a timeout or network failure comes back as status 0 so every
// caller's non-200 branch reports it as a failed check instead of the
// rejection escaping Promise.all and 500ing the whole cron run.
async function fetchJson(url, options = {}, timeoutMs = 15_000) {
	let res;
	try {
		res = await fetch(url, {
			...options,
			headers: { 'user-agent': 'threews-forge-smoke/1.0', ...options.headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return { status: 0, body: { error: String(err?.message || err) } };
	}
	let body = null;
	try {
		body = await res.json();
	} catch {
		// non-JSON bodies are judged by status alone
	}
	return { status: res.status, body };
}

// A generation only counts when the GLB exists AND starts with the binary
// glTF magic — a 200 with an HTML error page must not pass.
async function verifyGlb(glbUrl) {
	let res;
	let bytes;
	try {
		res = await fetch(glbUrl, {
			headers: { range: 'bytes=0-3', 'user-agent': 'threews-forge-smoke/1.0' },
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) return { ok: false, reason: `GLB fetch returned HTTP ${res.status}` };
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch (err) {
		return { ok: false, reason: `GLB fetch failed: ${err?.message || err}` };
	}
	const magic = String.fromCharCode(...bytes.slice(0, 4));
	if (magic !== 'glTF') return { ok: false, reason: `GLB magic bytes were "${magic}", not "glTF"` };
	return { ok: true };
}

// Submit a draft generation and follow it to a verified GLB.
//
// force_regenerate is what makes this a generation test at all. /api/forge keeps
// a content-addressed result cache keyed on (path, tier, backend, prompt,
// options) with a 7-day TTL, and a read never refreshes that TTL. SMOKE_PROMPT is
// a constant and the submit sends no seed, so the key is stable forever: without
// this flag the daily run gets an instant cache hit, verifyGlb happily reads the
// GLB some earlier generation produced, and the check reports green while every
// GPU lane is dead. That is the exact failure this cron exists to catch (the June
// 2026 audit found flows 100% dead in production while every config check read
// green), and it was live: an audit run on 2026-08-12 completed all five legs in
// 0.55 s total, which no real generation can do. The flag skips only the cache
// READ; a fresh run is still written back, so the cache stays warm for users.
export async function runGeneration(origin) {
	const submit = await fetchJson(
		`${origin}/api/forge`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prompt: SMOKE_PROMPT, tier: 'draft', force_regenerate: true }),
		},
		SUBMIT_TIMEOUT_MS,
	);
	if (submit.status !== 200) {
		return {
			ok: false,
			reason: `submit returned HTTP ${submit.status}: ${submit.body?.error_description || submit.body?.error || 'no body'}`,
		};
	}
	// A cache hit under force_regenerate means the flag stopped being honoured, so
	// the run proved nothing about generation. Fail loudly rather than pass on a
	// replayed mesh.
	if (submit.body?.cached) {
		return { ok: false, reason: 'submit was served from the forge result cache: force_regenerate is not being honoured, so the generation pipeline was never exercised' };
	}

	let { status, glb_url: glbUrl, job_id: jobId } = submit.body || {};
	const deadline = Date.now() + POLL_DEADLINE_MS;
	while (status !== 'done' && jobId && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		const poll = await fetchJson(`${origin}/api/forge?job=${encodeURIComponent(jobId)}`);
		if (poll.status !== 200) return { ok: false, reason: `poll returned HTTP ${poll.status}` };
		status = poll.body?.status;
		glbUrl = poll.body?.glb_url || glbUrl;
		if (status === 'failed') {
			return { ok: false, reason: `job failed: ${poll.body?.error || 'no error detail'}` };
		}
	}
	if (status !== 'done' || !glbUrl) {
		return { ok: false, reason: `job did not finish within ${POLL_DEADLINE_MS / 1000}s (status: ${status})` };
	}

	const glb = await verifyGlb(glbUrl);
	if (!glb.ok) return { ok: false, reason: glb.reason };
	return { ok: true, glb_url: glbUrl };
}

// Health must be 'ok' — 'degraded' means a lane users can pick is down (a
// provider, a worker, or the limiter store failing paid lanes closed).
async function runHealthCheck(origin) {
	const health = await fetchJson(`${origin}/api/forge?health`);
	if (health.status !== 200) return { ok: false, reason: `health returned HTTP ${health.status}` };
	if (health.body?.status === 'ok') return { ok: true };
	const broken = [
		...Object.values(health.body?.backends || {}),
		...(health.body?.limiter ? [health.body.limiter] : []),
	]
		.filter((b) => b.status === 'down' || b.status === 'degraded')
		.map((b) => `${b.id}: ${b.message}`);
	// The LLM section is shaped { [provider]: { status, error }, overall } — flag
	// any failing provider by name so a degraded chain isn't a nameless "degraded".
	for (const [name, v] of Object.entries(health.body?.llm || {})) {
		if (name !== 'overall' && v?.status === 'error') broken.push(`llm/${name}: ${v.error}`);
	}
	return { ok: false, reason: broken.join('\n') || `health status: ${health.body?.status}` };
}

// Exercise the real LLM completion path (in-process, not over HTTP) so a dead
// provider chain pages ops even when the free-tier fallback masks it from users.
// Runs through llmComplete so it follows the exact free-first ordering production
// uses; any successful provider returning the sentinel is a pass.
async function runLlmSmoke() {
	try {
		const { text, provider } = await llmComplete({
			system: 'You are a health probe. Reply with exactly one word.',
			user: 'Respond with exactly the word: HEALTHY',
			maxTokens: 10,
			timeoutMs: 20_000,
		});
		if (!/healthy/i.test(text || '')) {
			return { ok: false, reason: `LLM replied "${(text || '').slice(0, 80)}" via ${provider}, expected HEALTHY` };
		}
		return { ok: true, provider };
	} catch (err) {
		return { ok: false, reason: `LLM completion failed: ${err?.message || err}` };
	}
}

// What a wallet-holding agent actually experiences, end to end minus the
// payment broadcast. Each probe asserts the exact contract the agent tooling
// keys on; any drift (wrong resource URL, missing catalog entry, vanished
// accepts) pages ops the same day instead of rotting for months.
async function runAgentSurfaceCheck(origin) {
	const failures = [];
	const postJsonRpc = (path, payload) =>
		fetchJson(`${origin}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});

	// Free discovery: a plain (non-MCP-protocol) client lists tools with no
	// credentials and must see the generation tools.
	const list = await postJsonRpc('/api/mcp-3d', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
	const toolNames = (list.body?.result?.tools || []).map((t) => t.name);
	if (list.status !== 200 || !toolNames.includes('text_to_3d')) {
		failures.push(
			`mcp-3d free tools/list: HTTP ${list.status}, ` +
				`${toolNames.length} tools, text_to_3d ${toolNames.includes('text_to_3d') ? 'present' : 'MISSING'}`,
		);
	}

	// 402 identity: an unpaid text_to_3d call must be challenged by the 3D
	// Studio itself — its own resource URL and the standard-tier price.
	const challenge = await postJsonRpc('/api/mcp-3d', {
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: { name: 'text_to_3d', arguments: { prompt: 'smoke probe — a small clay fox' } },
	});
	const resourceUrl = challenge.body?.resource?.url;
	const amounts = (challenge.body?.accepts || []).map((a) => a.amount);
	if (challenge.status !== 402 || resourceUrl !== `${origin}/api/mcp-3d`) {
		failures.push(
			`mcp-3d 402 identity: HTTP ${challenge.status}, resource ${resourceUrl || 'none'}`,
		);
	} else if (!amounts.includes('150000')) {
		failures.push(`mcp-3d 402 price: expected standard-tier 150000, got [${amounts.join(', ')}]`);
	}

	// Discovery catalog: every generation surface stays indexed for crawlers.
	const wk = await fetchJson(`${origin}/.well-known/x402.json`);
	const cataloged = new Set((wk.body?.resources || []).map((r) => r.path));
	for (const path of ['/api/x402/forge', '/api/mcp-3d', '/api/mcp']) {
		if (!cataloged.has(path)) failures.push(`${path} missing from /.well-known/x402.json`);
	}

	// Paid REST: the bare endpoint must still challenge with usable accepts.
	const forge = await fetchJson(`${origin}/api/x402/forge`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prompt: 'smoke probe — a small clay fox', tier: 'draft' }),
	});
	if (forge.status !== 402 || !(forge.body?.accepts || []).length) {
		failures.push(
			`x402/forge challenge: HTTP ${forge.status}, ${(forge.body?.accepts || []).length} accepts`,
		);
	}

	return failures.length ? { ok: false, reason: failures.join('\n') } : { ok: true };
}

// Redis quota-burn early warning. The free Upstash plan ceils at 500k
// commands/month; when it's exhausted every critical limiter fails closed and
// the whole paid surface 503s (June 2026). We read the real daily command count
// and, if the 30-day projection crosses the upgrade thresholds, page ops BEFORE
// the ceiling instead of after the outage. This is advisory — a burn warning
// never fails the smoke run (generation is still up today); it exists to make
// the upgrade a deliberate decision. Unknown usage (no management creds) is a
// no-op, never a false alarm.
async function runRedisQuotaCheck() {
	const burn = evaluateRedisBurn(await fetchRedisDailyCommands());
	const alert = redisBurnAlert(burn);
	if (alert) {
		sendOpsAlert(alert.title, alert.message, {
			signature: `forge-smoke:redis-quota:${alert.level}`,
		});
	}
	return burn;
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const origin = env.APP_ORIGIN || 'https://three.ws';
	const [generation, health, agentSurfaces, llm, redisBurn] = await Promise.all([
		runGeneration(origin),
		runHealthCheck(origin),
		runAgentSurfaceCheck(origin),
		runLlmSmoke(),
		runRedisQuotaCheck(),
	]);
	// Redis burn is an early-warning signal, not a liveness check — it pages ops
	// on its own threshold but never fails the smoke run (generation is up today).
	const ok = generation.ok && health.ok && agentSurfaces.ok && llm.ok;

	const previous = await cacheGet(LAST_STATUS_KEY);
	await cacheSet(LAST_STATUS_KEY, { ok, at: Date.now() }, LAST_STATUS_TTL_S);

	if (!generation.ok) {
		sendOpsAlert(
			'FORGE SMOKE FAILED: text→3D draft generation',
			`${origin}/forge\n${generation.reason}`,
			{ signature: 'forge-smoke:generation' },
		);
	}
	if (!health.ok) {
		sendOpsAlert('FORGE SMOKE: degraded generation backends', health.reason, {
			signature: 'forge-smoke:health',
		});
	}
	if (!agentSurfaces.ok) {
		sendOpsAlert('FORGE SMOKE: agent surface contract broken', agentSurfaces.reason, {
			signature: 'forge-smoke:agent-surfaces',
		});
	}
	if (!llm.ok) {
		sendOpsAlert('FORGE SMOKE: LLM completion path down', llm.reason, {
			signature: 'forge-smoke:llm',
		});
	}
	if (ok && previous && previous.ok === false) {
		sendOpsAlert('RECOVERED: forge generation smoke test', `${origin}/forge — prompt→GLB verified`, {
			signature: `forge-smoke:recovered:${Date.now()}`,
		});
	}

	return json(res, 200, {
		ok,
		generation,
		health,
		agent_surfaces: agentSurfaces,
		llm: llm.ok ? { status: 'ok', provider: llm.provider } : { status: 'error', reason: llm.reason },
		redis: redisBurn,
	});
});
