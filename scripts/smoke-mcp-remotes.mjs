#!/usr/bin/env node
// Live health probe for every three.ws remote MCP endpoint.
//
// Free endpoints (no x402 gate) must answer initialize + tools/list and run a
// read-only tool. Paid endpoints (whole transport gated by x402) must answer a
// bare request with a well-formed 401/402 payment challenge whose `accepts[]`
// carries valid requirements — proof the server is live and the gate is wired.
// No real payment is ever sent.
//
//   node scripts/smoke-mcp-remotes.mjs                    # against https://three.ws
//   node scripts/smoke-mcp-remotes.mjs http://localhost:3000
//
// Exit code is non-zero if any endpoint is unhealthy.

const BASE = (process.argv[2] || 'https://three.ws').replace(/\/$/, '');

// USDC on Base mainnet — the only asset a paid challenge should price in.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const ENDPOINTS = [
	{
		path: '/api/pump-fun-mcp',
		type: 'free',
		// On-chain tool that needs no external indexer — $THREE is the only mint we touch.
		probe: {
			name: 'get_token_details',
			args: { mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' },
		},
		// Indexer-backed probe, run only when pumpfun_bot_status reports the bot is
		// configured AND healthy. Skipped (not failed) when the indexer is absent.
		indexerProbe: { name: 'get_new_tokens', args: { limit: 3 } },
	},
	{
		// The free generation lane. Every tool here except check_job/get_agent_persona
		// spends real GPU minutes, so the probe asserts the catalog the manifest and
		// /.well-known/mcp.json promise instead of firing a generation on every run.
		path: '/api/mcp-studio',
		type: 'free',
		requireTools: ['mesh_forge', 'rig_mesh', 'forge_avatar', 'text_to_avatar', 'check_job'],
	},
	{ path: '/api/mcp', type: 'paid' },
	{ path: '/api/mcp-3d', type: 'paid' },
	{ path: '/api/mcp-agent', type: 'paid' },
	{ path: '/api/ibm-mcp', type: 'paid' },
	{ path: '/api/mcp-bazaar', type: 'paid' },
];

function rpc(method, params, id = 1) {
	return { jsonrpc: '2.0', id, method, params };
}

// MCP Streamable HTTP may answer as application/json or as an SSE stream
// (text/event-stream). Parse the first JSON-RPC payload out of either.
function parseBody(text, contentType) {
	if (contentType.includes('text/event-stream')) {
		for (const line of text.split('\n')) {
			const t = line.trim();
			if (t.startsWith('data:')) {
				try {
					return JSON.parse(t.slice(5).trim());
				} catch {
					/* keep scanning */
				}
			}
		}
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function post(path, payload) {
	const res = await fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify(payload),
	});
	const text = await res.text();
	return {
		status: res.status,
		body: parseBody(text, res.headers.get('content-type') || ''),
		raw: text,
	};
}

function validateChallenge(body) {
	if (!body || !Array.isArray(body.accepts) || body.accepts.length === 0) {
		return 'no accepts[] in challenge body';
	}
	for (const a of body.accepts) {
		if (!a.scheme || !a.network || !a.payTo || !a.asset) {
			return `accept entry missing scheme/network/payTo/asset: ${JSON.stringify(a).slice(0, 80)}`;
		}
	}
	const base = body.accepts.find((a) => a.network === 'eip155:8453');
	if (base && base.asset.toLowerCase() !== USDC_BASE) {
		return `Base accept asset is not USDC: ${base.asset}`;
	}
	return null;
}

const results = [];

async function checkFree(ep) {
	const checks = [];
	const init = await post(
		ep.path,
		rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'smoke', version: '0' },
		}),
	);
	const name = init.body?.result?.serverInfo?.name;
	checks.push([
		'initialize',
		init.status === 200 && !!name,
		name ? `serverInfo=${name}` : `status ${init.status}`,
	]);

	const list = await post(ep.path, rpc('tools/list', {}, 2));
	const tools = list.body?.result?.tools;
	checks.push([
		'tools/list',
		Array.isArray(tools) && tools.length > 0,
		`${tools?.length ?? 0} tools`,
	]);

	for (const want of ep.requireTools ?? []) {
		const present = (tools || []).some((t) => t.name === want);
		checks.push([`serves ${want}`, present, present ? 'ok' : 'absent from tools/list']);
	}

	if (ep.probe) {
		const call = await post(
			ep.path,
			rpc('tools/call', { name: ep.probe.name, arguments: ep.probe.args }, 3),
		);
		const isErr = !!call.body?.error;
		checks.push([
			`call ${ep.probe.name}`,
			!isErr,
			isErr ? call.body.error.message?.slice(0, 60) : 'ok',
		]);
	}

	// Indexer-backed tools are conditionally available: pumpfun_bot_status reports
	// whether PUMPFUN_BOT_URL is wired and the bot answers. Probe an indexer tool
	// only when configured AND healthy; an unconfigured backend skips, a
	// configured-but-down backend is degraded (live endpoint, indexer offline) —
	// neither is a hard failure of the endpoint itself.
	if (ep.indexerProbe) {
		const status = await post(ep.path, rpc('tools/call', { name: 'pumpfun_bot_status' }, 4));
		const s = status.body?.result?.structuredContent;
		const statusOk = !status.body?.error && typeof s?.configured === 'boolean';
		checks.push([
			'pumpfun_bot_status',
			statusOk,
			statusOk
				? `configured=${s.configured} healthy=${s.healthy}`
				: status.body?.error?.message?.slice(0, 60) || 'malformed status',
		]);

		// Confirm tools/list honours the same capability gate: indexer tools appear
		// iff the backend is configured.
		if (statusOk) {
			const listed = (tools || []).some((t) => t.name === ep.indexerProbe.name);
			checks.push([
				`tools/list gating ${ep.indexerProbe.name}`,
				listed === s.configured,
				`listed=${listed} configured=${s.configured}`,
			]);
		}

		if (statusOk && s.configured && !s.healthy) {
			checks.push([
				'indexer health',
				true,
				`degraded: bot configured but unhealthy (${s.error || 'no detail'})`,
			]);
		} else if (statusOk && s.configured && s.healthy) {
			const ix = await post(
				ep.path,
				rpc('tools/call', { name: ep.indexerProbe.name, arguments: ep.indexerProbe.args }, 5),
			);
			const ixErr = !!ix.body?.error;
			checks.push([
				`call ${ep.indexerProbe.name}`,
				!ixErr,
				ixErr ? ix.body.error.message?.slice(0, 60) : 'ok',
			]);
		} else if (statusOk && !s.configured) {
			console.log('    skip  indexer not configured — skipping indexer tool probes');
		}
	}
	return checks;
}

async function checkPaid(ep) {
	const res = await post(
		ep.path,
		rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'smoke', version: '0' },
		}),
	);
	const gated = res.status === 401 || res.status === 402;
	const challengeErr = validateChallenge(res.body);
	return [
		['payment-gated', gated, `HTTP ${res.status}`],
		[
			'valid x402 challenge',
			gated && !challengeErr,
			challengeErr || `${res.body?.accepts?.length} accept(s)`,
		],
	];
}

console.log(`\nMCP remote smoke → ${BASE}\n`);
let failures = 0;
for (const ep of ENDPOINTS) {
	let checks;
	try {
		checks = ep.type === 'free' ? await checkFree(ep) : await checkPaid(ep);
	} catch (e) {
		checks = [['reachable', false, e.message]];
	}
	const epOk = checks.every((c) => c[1]);
	if (!epOk) failures++;
	console.log(`${epOk ? '✓' : '✗'} ${ep.path}  (${ep.type})`);
	for (const [label, ok, detail] of checks) {
		console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(22)} ${detail}`);
	}
	results.push({ path: ep.path, ok: epOk });
}

console.log(
	`\n${failures === 0 ? '✓ all remotes healthy' : `✗ ${failures} endpoint(s) unhealthy`} (${results.length} checked)\n`,
);
process.exit(failures === 0 ? 0 : 1);
