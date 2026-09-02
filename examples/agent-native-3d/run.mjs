#!/usr/bin/env node
// Agent-native 3D — end to end, no browser, no mocks.
// ====================================================
// Roadmap campaign, work order 10 (retired; readable in git history), track A:
// an agent given a goal generates the 3D assets it needs and uses them, chaining
// real MCP tool calls against the live three.ws "Free 3D Studio"
// (`/api/mcp-studio` — see docs/mcp-studio.md). Every call in this script is a
// real HTTP JSON-RPC request; every URL it prints resolves.
//
// The chain:
//   1. tools/list           — confirm the composable tool contracts are live.
//   2. mesh_forge(prompt)   — text → a static 3D mesh (Granite-directed chain).
//   3. rig_mesh(glb_url)    — auto-rig the mesh into an animation-ready GLB.
//   4. create_agent_persona — save the rigged GLB as a NAMED, persistent body.
//   5. persona_say          — perform a line through that body (lip-sync + emote).
//   6. get_agent_persona    — reload by id in a FRESH call — proves continuity.
//   7. Build every distribution snippet (iframe / web component / <agent-3d> /
//      page-agent / walk companion) with the SAME pure builders the Forge UI's
//      embed panel uses (src/forge-embed-snippets.js) — not a reimplementation,
//      so what this script prints is byte-identical to what a human would copy
//      from the "Embed this model" panel on /forge.
//
// All six MCP tools are FREE (no x402, no wallet, no API key) — this is the
// "Free 3D Studio" lane, the same one the /forge web page's drafts use. Steps
// 2–3 share a global generation rate limit with the rest of the platform; on a
// `rate_limited` response this script backs off using the server's own
// `retry_after` (bounded, never a blind sleep loop) and, if the lane stays
// saturated past the budget, falls back to a known-good rigged GLB so steps
// 4–7 still run for real — the fallback is logged loudly in the transcript,
// never silently substituted.
//
// Usage:
//   node run.mjs                                  # against production
//   MCP_STUDIO_URL=http://localhost:3000/api/mcp-studio node run.mjs   # local dev
//
// Writes a full transcript (every request + response) to
// prompts/roadmap/_generated/10/agent-native-3d-transcript.json.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
	buildIframeSnippet,
	buildWebComponentSnippet,
	buildAgentThreeDSnippet,
	buildPageAgentSnippet,
	buildWalkCompanionSnippet,
	embedPageUrl,
} from '../../src/forge-embed-snippets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const OUT_DIR = join(REPO_ROOT, 'prompts/roadmap/_generated/10');
const OUT_FILE = join(OUT_DIR, 'agent-native-3d-transcript.json');

const MCP_URL = process.env.MCP_STUDIO_URL || 'https://three.ws/api/mcp-studio';
const PROMPT = process.env.DEMO_PROMPT || 'a small friendly round robot mascot, glossy white plastic, blue visor';
const AGENT_NAME = process.env.DEMO_NAME || 'Roadmap-10 Demo Agent';
// A known-good, already-rigged public GLB — used ONLY if the shared generation
// lane stays rate-limited past the retry budget, so the embodiment/distribution
// half of the chain (steps 4-7) still runs for real. Logged, never silent.
const FALLBACK_RIGGED_GLB = 'https://three.ws/avatars/default.glb';

const transcript = { started_at: new Date().toISOString(), mcp_url: MCP_URL, prompt: PROMPT, steps: [] };
let rpcId = 0;

function log(...args) {
	console.log(...args);
}

async function call(method, params) {
	const id = ++rpcId;
	const body = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
	const startedAt = Date.now();
	const res = await fetch(MCP_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = await res.json();
	const entry = {
		method,
		tool: params?.name || null,
		request: params?.arguments || null,
		http_status: res.status,
		duration_ms: Date.now() - startedAt,
		response: json,
	};
	transcript.steps.push(entry);
	return json;
}

// Every tool on this free studio is guarded by its own rate limiter (a
// per-call generation-lane cap on the five generators, a per-IP write burst
// cap on the three persona tools — see api/_mcp-studio/persona-tools.js
// guardWrite) and the two limiters return different shapes: the generation
// tools return a structured { error: 'rate_limited', retry_after }, the
// persona write tools return a plain isError text ("Too many requests…") with
// no retry_after. Detect both and back off — bounded to maxWaitMs total so a
// saturated lane degrades to the documented fallback instead of hanging.
function rateLimitInfo(json) {
	const result = json.result;
	const text = result?.content?.[0]?.text || '';
	if (result?.structuredContent?.error === 'rate_limited' || result?.error === 'rate_limited') {
		return { limited: true, retryAfterS: Number(result?.retry_after ?? result?.structuredContent?.retry_after ?? 3) };
	}
	if (result?.isError && /too many requests|rate.?limit/i.test(text)) {
		return { limited: true, retryAfterS: 6 }; // no retry_after quoted — fixed backoff
	}
	return { limited: false };
}

async function callToolWithBackoff(name, args, { maxWaitMs = 60_000 } = {}) {
	let waited = 0;
	for (;;) {
		const json = await call('tools/call', { name, arguments: args });
		const { limited, retryAfterS } = rateLimitInfo(json);
		if (!limited) return json;

		const waitMs = Math.max(1000, Math.min(15_000, retryAfterS * 1000));
		if (waited + waitMs > maxWaitMs) {
			log(`  ⏳ ${name} still rate-limited after ${Math.round(waited / 1000)}s of backoff — giving up for this run.`);
			return json; // caller decides the fallback
		}
		log(`  ⏳ ${name} rate-limited — backing off ${Math.round(waitMs / 1000)}s (server-quoted retry_after=${retryAfterS}s)…`);
		await new Promise((r) => setTimeout(r, waitMs));
		waited += waitMs;
	}
}

function isToolError(json) {
	return Boolean(json?.result?.isError) || Boolean(json?.error);
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });

	log(`\n1. tools/list — ${MCP_URL}`);
	const list = await call('tools/list');
	const names = (list.result?.tools || []).map((t) => t.name);
	log(`   ${names.length} tools live: ${names.join(', ')}`);
	for (const need of ['mesh_forge', 'rig_mesh', 'create_agent_persona', 'get_agent_persona', 'persona_say']) {
		if (!names.includes(need)) throw new Error(`expected composable tool "${need}" missing from tools/list`);
	}

	log(`\n2. mesh_forge — "${PROMPT}"`);
	let meshJson = await callToolWithBackoff('mesh_forge', { prompt: PROMPT });
	let staticGlb = meshJson.result?.structuredContent?.glbUrl || meshJson.result?.structuredContent?.glb_url || null;
	let generationUsed = Boolean(staticGlb) && !isToolError(meshJson);

	let riggedGlb = null;
	if (generationUsed) {
		log(`   ✓ static mesh: ${staticGlb}`);
		log(`\n3. rig_mesh — ${staticGlb}`);
		const rigJson = await callToolWithBackoff('rig_mesh', { glb_url: staticGlb });
		riggedGlb = rigJson.result?.structuredContent?.glbUrl || rigJson.result?.structuredContent?.glb_url || null;
		if (!riggedGlb || isToolError(rigJson)) {
			log('   ⚠ rig_mesh did not return a rigged GLB — falling back to the known-good rig for steps 4+.');
			generationUsed = false;
		} else {
			log(`   ✓ rigged: ${riggedGlb}`);
		}
	} else {
		log(`   ⚠ generation lane unavailable this run (${JSON.stringify(meshJson.result || meshJson.error)}).`);
	}

	const bodyGlb = riggedGlb || FALLBACK_RIGGED_GLB;
	if (!riggedGlb) {
		log(`\n⚠ FALLBACK — using a known-good rigged GLB for steps 4-7: ${bodyGlb}`);
		log('  (The generation lane is shared platform-wide and was saturated at run time; the failed');
		log('   mesh_forge/rig_mesh calls above are recorded verbatim in the transcript for audit.)');
	}

	log(`\n4. create_agent_persona — "${AGENT_NAME}"`);
	const personaJson = await callToolWithBackoff('create_agent_persona', {
		glb_url: bodyGlb,
		name: AGENT_NAME,
		source_prompt: PROMPT,
	});
	if (isToolError(personaJson)) throw new Error(`create_agent_persona failed: ${JSON.stringify(personaJson.result)}`);
	const persona = personaJson.result.structuredContent;
	log(`   ✓ persona_id: ${persona.persona_id}`);
	log(`   ✓ live body: ${personaJson.result.content[1]?.resource?.uri}`);

	log(`\n5. persona_say — perform a line through the body`);
	const sayJson = await callToolWithBackoff('persona_say', {
		persona_id: persona.persona_id,
		text: `Hello — I generated and embodied myself through three.ws MCP tools, autonomously.`,
	});
	if (isToolError(sayJson)) throw new Error(`persona_say failed: ${JSON.stringify(sayJson.result)}`);
	log(`   ✓ turn_count: ${sayJson.result.structuredContent.turn_count}, emotion: ${sayJson.result.structuredContent.emotion}`);

	log(`\n6. get_agent_persona — reload in a FRESH call (proves continuity)`);
	const reloadJson = await callToolWithBackoff('get_agent_persona', { persona_id: persona.persona_id });
	if (isToolError(reloadJson)) throw new Error(`get_agent_persona failed: ${JSON.stringify(reloadJson.result)}`);
	const reloaded = reloadJson.result.structuredContent;
	if (reloaded.turn_count !== sayJson.result.structuredContent.turn_count) {
		throw new Error('continuity check failed: turn_count did not persist across a fresh call');
	}
	log(`   ✓ same body reloaded by persona_id — turn_count persisted (${reloaded.turn_count})`);

	log(`\n7. Distribution — every embed flavour, built with the SAME pure functions`);
	log(`   the Forge UI's "Embed this model" panel uses (src/forge-embed-snippets.js):`);
	const snippets = {
		standalone_viewer: embedPageUrl(persona.glb_url, AGENT_NAME),
		iframe: buildIframeSnippet(persona.glb_url, AGENT_NAME, 'wide'),
		web_component: buildWebComponentSnippet(persona.glb_url, AGENT_NAME, 'wide'),
		agent_3d: buildAgentThreeDSnippet(persona.glb_url, AGENT_NAME, 'wide'),
		page_agent: buildPageAgentSnippet(persona.glb_url, AGENT_NAME),
		walk_companion: buildWalkCompanionSnippet(persona.glb_url, AGENT_NAME),
	};
	for (const [flavor, snippet] of Object.entries(snippets)) {
		log(`\n   — ${flavor} —`);
		log('   ' + snippet.split('\n').join('\n   '));
	}

	transcript.result = {
		ok: true,
		generation_used: generationUsed,
		fallback_used: !generationUsed,
		persona_id: persona.persona_id,
		body_glb_url: persona.glb_url,
		embodiment_view: personaJson.result.content[1]?.resource?.uri || null,
		distribution_snippets: snippets,
	};
	transcript.finished_at = new Date().toISOString();
	await writeFile(OUT_FILE, JSON.stringify(transcript, null, 2));
	log(`\n✓ Full chain complete. Transcript written to ${OUT_FILE.replace(REPO_ROOT + '/', '')}`);
	log(`✓ ${generationUsed ? 'Generated, rigged,' : 'Embodied (fallback rig — generation lane was saturated),'} embodied, spoke, reloaded, and distributed — one agent, one goal, zero mocks.`);
}

main().catch(async (err) => {
	transcript.error = String(err?.stack || err);
	transcript.finished_at = new Date().toISOString();
	await mkdir(OUT_DIR, { recursive: true }).catch(() => {});
	await writeFile(OUT_FILE, JSON.stringify(transcript, null, 2)).catch(() => {});
	console.error('\n✗ FAILED:', err);
	process.exitCode = 1;
});
