#!/usr/bin/env node
// Vertex Claude LLM smoke test — exercises every text-inference surface against a
// live `npm run dev` server and asserts the reply came from Google Vertex.
//
// Prerequisites:
//   1. GCP creds + flags set in the dev server's environment:
//        GOOGLE_CLOUD_PROJECT=<proj> GCP_SERVICE_ACCOUNT_JSON='<json>' \
//        VERTEX_CLAUDE_ENABLED=1 VERTEX_CLAUDE_PRIMARY=1 npm run dev
//   2. Claude enabled in the project's Vertex Model Garden (prompt 01).
//
// Usage:
//   node scripts/gcp/vertex-llm-smoke.mjs
//   BASE_URL=http://localhost:3000 node scripts/gcp/vertex-llm-smoke.mjs
//
// Optional env:
//   BASE_URL          — dev server origin (default http://localhost:3000)
//   SMOKE_AGENT_ID    — a public agent/avatar id to exercise /api/llm/anthropic
//                       (the embed proxy). Skipped when unset. Its embed policy
//                       must select a Claude model: the proxy clamps a
//                       caller-requested host-billed model back to the owner's.
//   SMOKE_BEARER      — a bearer token for an authenticated /api/chat call.
//                       /api/chat gates the Vertex (paid-tier) lane behind auth,
//                       so anonymous callers only get the free lanes — provide a
//                       token to prove the /api/chat Vertex lane end to end.
//
// Surfaces covered:
//   (a) llmComplete()      via POST /api/forge-enhance  → asserts provider
//   (b) /api/llm/anthropic streaming → asserts x-llm-transport response header
//   (c) /api/chat          streaming → asserts the done event's provider
//
// Exit code is non-zero if any required assertion fails.

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const AGENT_ID = process.env.SMOKE_AGENT_ID || '';
const BEARER = process.env.SMOKE_BEARER || '';

let failures = 0;
let skips = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
	failures++;
	console.error(`  ✗ ${m}`);
};
const skip = (m) => {
	skips++;
	console.warn(`  ⊘ SKIP ${m}`);
};

// ── (a) llmComplete via /api/forge-enhance ──────────────────────────────────
async function surfaceLlmComplete() {
	console.log('\n(a) llmComplete → POST /api/forge-enhance');
	let res;
	try {
		res = await fetch(`${BASE_URL}/api/forge-enhance`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prompt: 'a small brass telescope on a wooden desk' }),
		});
	} catch (err) {
		fail(`request failed: ${err.message} (is the dev server running at ${BASE_URL}?)`);
		return;
	}
	if (!res.ok) {
		fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
		return;
	}
	const body = await res.json().catch(() => ({}));
	console.log(`    provider=${body.provider} model=${body.model}`);
	if (body.provider === 'vertex-anthropic') {
		pass('served by Vertex (provider=vertex-anthropic)');
	} else {
		fail(
			`expected provider=vertex-anthropic, got "${body.provider}". ` +
				'Ensure VERTEX_CLAUDE_ENABLED=1 and VERTEX_CLAUDE_PRIMARY=1 with GCP creds on the dev server.',
		);
	}
}

// ── (b) /api/llm/anthropic streaming (embed proxy) ──────────────────────────
async function surfaceEmbedProxy() {
	console.log('\n(b) embed proxy → POST /api/llm/anthropic (streaming)');
	if (!AGENT_ID) {
		skip('set SMOKE_AGENT_ID=<public agent or avatar id> to exercise this surface');
		return;
	}
	let res;
	try {
		res = await fetch(`${BASE_URL}/api/llm/anthropic?agent=${encodeURIComponent(AGENT_ID)}`, {
			method: 'POST',
			// The proxy denies header-less anonymous callers (they bypass the embed
			// origin allowlist). This is a first-party check, so it presents the
			// first-party origin a real embed on the site would send.
			headers: { 'content-type': 'application/json', origin: new URL(BASE_URL).origin },
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 64,
				stream: true,
				messages: [{ role: 'user', content: 'Say hello in five words.' }],
			}),
		});
	} catch (err) {
		fail(`request failed: ${err.message}`);
		return;
	}
	if (!res.ok) {
		fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
		return;
	}
	const transport = res.headers.get('x-llm-transport');
	console.log(`    x-llm-transport=${transport}`);
	// Drain a little of the stream to confirm tokens actually flow.
	const text = await readSomeStream(res, 1500);
	const streamed = /content_block_delta|text_delta|message_start/.test(text);
	if (transport === 'vertex-anthropic') pass('served by Vertex (x-llm-transport=vertex-anthropic)');
	else
		fail(
			`expected x-llm-transport=vertex-anthropic, got "${transport}". ` +
				"SMOKE_AGENT_ID's embed policy must select a Claude model: the proxy clamps a " +
				'caller-requested host-billed model back to the one the agent owner configured.',
		);
	if (streamed) pass('SSE tokens streamed');
	else fail('no Anthropic SSE events observed in the stream');
}

// ── (c) /api/chat streaming ─────────────────────────────────────────────────
async function surfaceChat() {
	console.log('\n(c) viewer chat → POST /api/chat (streaming)');
	if (!BEARER) {
		skip(
			'set SMOKE_BEARER=<token> — /api/chat clamps anonymous callers to the free lanes, ' +
				'so proving the Vertex lane requires an authenticated call',
		);
		return;
	}
	let res;
	try {
		res = await fetch(`${BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
			body: JSON.stringify({ message: 'Say hello in five words.', context: {} }),
		});
	} catch (err) {
		fail(`request failed: ${err.message}`);
		return;
	}
	if (!res.ok) {
		fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
		return;
	}
	const text = await readSomeStream(res, 4000);
	// Parse the terminal done event for the provider attribution.
	let provider = null;
	for (const line of text.split('\n')) {
		if (!line.startsWith('data:')) continue;
		try {
			const evt = JSON.parse(line.slice(5).trim());
			if (evt.type === 'done' && evt.provider) provider = evt.provider;
		} catch {
			// non-JSON keepalive line — ignore
		}
	}
	console.log(`    done.provider=${provider}`);
	if (provider === 'vertex') pass('served by Vertex (done.provider=vertex)');
	else fail(`expected done.provider=vertex, got "${provider}"`);
}

// Read from an SSE response for up to `ms`, returning the accumulated text. Used
// to observe streamed events without hanging on an open stream.
async function readSomeStream(res, ms) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let out = '';
	const deadline = Date.now() + ms;
	try {
		while (Date.now() < deadline) {
			const { done, value } = await Promise.race([
				reader.read(),
				new Promise((r) => setTimeout(() => r({ done: true, timeout: true }), deadline - Date.now())),
			]);
			if (done) break;
			out += decoder.decode(value, { stream: true });
			if (out.includes('"type":"done"') || out.includes('message_stop')) break;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// stream already closed
		}
	}
	return out;
}

async function main() {
	console.log(`Vertex Claude LLM smoke — target ${BASE_URL}`);
	await surfaceLlmComplete();
	await surfaceEmbedProxy();
	await surfaceChat();

	console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s), ${skips} skipped.`);
	if (failures > 0) process.exit(1);
}

main().catch((err) => {
	console.error('smoke run crashed:', err);
	process.exit(1);
});
