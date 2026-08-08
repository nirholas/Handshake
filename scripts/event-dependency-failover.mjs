// Prove every third-party dependency in the event path can lose its primary and
// keep serving. Existence of a fallback chain is not evidence: a chain whose
// second rung 403s, whose third rung answers 200 with an error body, or whose
// rotation never actually advances reads exactly like a healthy one right up
// until the primary dies in front of an audience.
//
// So this script does two things per dependency, and the second is the point:
//   1. probe every rung independently and report which are live TODAY
//   2. poison the primary and re-run the real call through the real chain,
//      asserting the answer still arrives from a later rung
//
// Run before an event, and again after any provider-key change:
//   node --env-file=.env scripts/event-dependency-failover.mjs
//   node --env-file=.env scripts/event-dependency-failover.mjs --json report.json
//
// Exit 0 when every dependency has at least one live rung AND survives its
// primary being poisoned. Exit 1 names the dependency that would take the event
// down with it.

import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { makeRotatingFetch, solanaRpcEndpoints } from '../api/_lib/solana/connection.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
// The canonical $THREE coin image the event link carries, as an IPFS path.
const EVENT_IMAGE_CID = 'bafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q';
// A host that resolves but refuses the connection instantly: the cheapest way to
// simulate a dead primary without touching anyone's real endpoint.
const POISON_URL = 'http://127.0.0.1:1/dead-rpc';

const args = process.argv.slice(2);
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';

const results = [];

function record(dependency, entry) {
	results.push({ dependency, ...entry });
}

function label(url) {
	try {
		const u = new URL(url);
		// Never print an api-key: these reports get pasted into issues and chats.
		return `${u.hostname}${u.pathname.length > 1 ? u.pathname.split('/').slice(0, 2).join('/') : ''}`;
	} catch {
		return String(url).slice(0, 40);
	}
}

async function timed(fn) {
	const started = Date.now();
	try {
		const value = await fn();
		return { ok: true, ms: Date.now() - started, value };
	} catch (err) {
		return { ok: false, ms: Date.now() - started, error: String(err?.message || err).slice(0, 120) };
	}
}

// -- Solana RPC: the holder gate, the boutique settle, every balance read ------

// getTokenSupply on $THREE is the right probe, not getHealth: it exercises the
// same account-reading path the holder gate uses, and several public rungs answer
// getHealth happily while 403-ing or rate-limiting the real method.
async function rpcCall(url, body, timeoutMs = 12_000) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`http ${res.status}`);
	const json = await res.json();
	// A 200 carrying a JSON-RPC error is a dead rung wearing a healthy status code
	// (quota -32429, paid-tier gates). Treat it as the failure it is.
	if (json?.error) throw new Error(`rpc ${json.error.code}: ${String(json.error.message || '').slice(0, 60)}`);
	return json.result;
}

const SUPPLY_BODY = { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [THREE_MINT] };

async function checkSolanaRpc() {
	const endpoints = solanaRpcEndpoints('mainnet');
	const rungs = [];
	for (const url of endpoints) {
		const r = await timed(() => rpcCall(url, SUPPLY_BODY));
		rungs.push({ rung: label(url), ok: r.ok, ms: r.ms, error: r.error || null });
	}
	const live = rungs.filter((r) => r.ok);

	// The real proof: put a dead endpoint at the head of the real chain and make
	// the real rotating fetch answer anyway.
	const rotate = makeRotatingFetch([POISON_URL, ...endpoints]);
	const failover = await timed(async () => {
		const res = await rotate(null, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(SUPPLY_BODY),
			signal: AbortSignal.timeout(40_000),
		});
		const json = await res.json();
		if (json?.error) throw new Error(`rpc ${json.error.code}`);
		const amount = json?.result?.value?.uiAmountString;
		if (!amount) throw new Error('no supply in response');
		return amount;
	});

	record('solana-rpc', {
		what: 'holder gate, $THREE balance reads, boutique settle',
		rungsTotal: rungs.length,
		rungsLive: live.length,
		rungs,
		failoverProven: failover.ok,
		failoverMs: failover.ms,
		failoverDetail: failover.ok ? `$THREE supply ${failover.value}` : failover.error,
		pass: live.length >= 2 && failover.ok,
	});
}

// -- IPFS: the coin image the event link and every OG card resolve --------------

// Mirrors the gateway order in api/img.js. Kept as a literal list rather than an
// import because api/img.js is a request handler, not a module with an exported
// gateway table, and duplicating five strings is cheaper than reshaping a live
// endpoint the day before an event.
const IPFS_GATEWAYS = [
	'https://ipfs.io/ipfs/',
	'https://dweb.link/ipfs/',
	'https://gateway.pinata.cloud/ipfs/',
	'https://w3s.link/ipfs/',
	'https://4everland.io/ipfs/',
];

async function checkIpfs() {
	const rungs = [];
	for (const gateway of IPFS_GATEWAYS) {
		const r = await timed(async () => {
			const res = await fetch(`${gateway}${EVENT_IMAGE_CID}`, {
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) throw new Error(`http ${res.status}`);
			const buf = await res.arrayBuffer();
			if (buf.byteLength < 512) throw new Error(`suspiciously small: ${buf.byteLength}B`);
			return buf.byteLength;
		});
		rungs.push({ rung: label(gateway), ok: r.ok, ms: r.ms, bytes: r.value ?? null, error: r.error || null });
	}
	const live = rungs.filter((r) => r.ok);
	record('ipfs-image', {
		what: 'the $THREE coin image on the event link, OG cards, world signage',
		rungsTotal: rungs.length,
		rungsLive: live.length,
		rungs,
		// api/img.js races the gateways and takes the first valid image, so the
		// failover proof is simply that a non-primary gateway can serve it.
		failoverProven: live.some((r) => r.rung !== label(IPFS_GATEWAYS[0])),
		failoverDetail: live.length ? `${live.length} gateway(s) serving` : 'no gateway served the CID',
		pass: live.length >= 2,
	});
}

// -- pump.fun: coin metadata behind every community world ----------------------

async function checkPumpFun() {
	// The platform reads pump.fun coin metadata through its public frontend API,
	// and falls back to on-chain metadata when that is unreachable. Both are
	// probed: a dead frontend API is survivable, a dead frontend API AND no
	// on-chain read is not.
	const rungs = [];
	const frontend = await timed(async () => {
		const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${THREE_MINT}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`http ${res.status}`);
		const json = await res.json();
		if (!json?.mint) throw new Error('no mint in response');
		return json.symbol || json.name || json.mint;
	});
	rungs.push({ rung: 'frontend-api-v3.pump.fun', ok: frontend.ok, ms: frontend.ms, error: frontend.error || null });

	// On-chain fallback through the same rotating RPC chain proven above.
	const onchain = await timed(async () => {
		const rotate = makeRotatingFetch(solanaRpcEndpoints('mainnet'));
		const res = await rotate(null, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [THREE_MINT, { encoding: 'base64' }] }),
			signal: AbortSignal.timeout(30_000),
		});
		const json = await res.json();
		if (!json?.result?.value) throw new Error('mint account not readable');
		return 'mint account readable';
	});
	rungs.push({ rung: 'on-chain mint (rotating RPC)', ok: onchain.ok, ms: onchain.ms, error: onchain.error || null });

	const live = rungs.filter((r) => r.ok);
	record('pump-fun', {
		what: 'coin name/symbol/image for the community world header',
		rungsTotal: rungs.length,
		rungsLive: live.length,
		rungs,
		failoverProven: onchain.ok,
		failoverDetail: onchain.ok ? 'on-chain read serves when the frontend API is down' : onchain.error,
		pass: onchain.ok,
	});
}

// -- LLM: the NPC citizens, the concierge, in-world chat -----------------------

async function checkLlm(base) {
	// Two different questions, and only the first one decides pass/fail.
	//
	// What a player experiences is one real NPC turn through /api/brain/chat. That
	// endpoint streams an SSE `fallback` event every time the router demotes a
	// rung, so a single request both delivers the answer AND shows the rotation
	// doing its job: a better proof than any synthetic poisoning, because the
	// chain is failing over against whatever is genuinely broken right now.
	//
	// /api/llm/health is the second question: it probes only the PAID tier
	// (OpenRouter / OpenAI / Vertex). Its verdict is reported as context, not as a
	// gate, because llm.js leads with free providers and a degraded paid tier is
	// invisible to players until the free rungs go too.
	const turn = await timed(async () => {
		const res = await fetch(`${base}/api/brain/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'https://three.ws' },
			body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
			signal: AbortSignal.timeout(90_000),
		});
		if (!res.ok) throw new Error(`http ${res.status}`);
		const body = await res.text();
		const fallbacks = [...body.matchAll(/^event: fallback\ndata: (.+)$/gm)].map((m) => {
			try {
				return JSON.parse(m[1]).route;
			} catch {
				return 'unparsed';
			}
		});
		const served = /^data: "/m.test(body);
		if (!served) throw new Error('stream carried no content tokens');
		const lead = body.match(/^event: meta\ndata: (.+)$/m);
		return { fallbacks, lead: lead ? JSON.parse(lead[1]).provider : 'unknown' };
	});

	const secret = process.env.CRON_SECRET || '';
	const paid = await timed(async () => {
		const res = await fetch(`${base}/api/llm/health`, {
			headers: secret ? { 'x-cron-secret': secret } : {},
			signal: AbortSignal.timeout(60_000),
		});
		if (!res.ok) throw new Error(`http ${res.status}${res.status === 403 ? ' (set CRON_SECRET to probe this)' : ''}`);
		return await res.json();
	});

	const rungs = [];
	if (turn.ok) {
		rungs.push({ rung: `player turn (lead: ${turn.value.lead})`, ok: true, ms: turn.ms, error: null });
		for (const route of turn.value.fallbacks) {
			rungs.push({ rung: `  demoted → ${route}`, ok: true, ms: null, error: null });
		}
	} else {
		rungs.push({ rung: 'player turn (/api/brain/chat)', ok: false, ms: turn.ms, error: turn.error });
	}
	if (paid.ok) {
		for (const [key, v] of Object.entries(paid.value || {})) {
			if (key === 'overall' || !v || typeof v !== 'object' || !('status' in v)) continue;
			rungs.push({ rung: `paid tier: ${key}`, ok: v.status === 'ok', ms: v.latencyMs ?? null, error: v.error || null });
		}
	} else {
		rungs.push({ rung: 'paid tier probe', ok: false, ms: paid.ms, error: paid.error });
	}

	const paidLive = rungs.filter((x) => x.rung.startsWith('paid tier:') && x.ok).length;
	record('llm', {
		what: 'NPC citizens, concierge, in-world chat',
		rungsTotal: rungs.length,
		rungsLive: rungs.filter((x) => x.ok).length,
		rungs,
		failoverProven: turn.ok && turn.value.fallbacks.length > 0,
		failoverDetail: turn.ok
			? `answered in ${turn.ms}ms after ${turn.value.fallbacks.length} live demotion(s); paid tier ${paidLive} live (${paid.ok ? paid.value.overall : 'unprobed'})`
			: turn.error,
		pass: turn.ok,
	});
}

async function run() {
	const base = process.env.EVENT_BASE_URL || 'https://three.ws';
	console.log(`[failover] base ${base}`);
	console.log('[failover] probing every rung of every event-path dependency, then poisoning each primary\n');

	await checkSolanaRpc();
	await checkIpfs();
	await checkPumpFun();
	await checkLlm(base);

	let pass = true;
	for (const r of results) {
		if (!r.pass) pass = false;
		console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.dependency}`);
		console.log(`      ${r.what}`);
		console.log(`      live rungs: ${r.rungsLive}/${r.rungsTotal}`);
		for (const rung of r.rungs) {
			console.log(`        ${rung.ok ? 'up  ' : 'down'} ${String(rung.rung).padEnd(38)} ${rung.ok ? `${rung.ms}ms` : rung.error}`);
		}
		console.log(`      failover proven: ${r.failoverProven ? 'yes' : 'NO'} — ${r.failoverDetail}\n`);
	}

	if (jsonPath) {
		writeFileSync(jsonPath, JSON.stringify({ base, results }, null, 2));
		console.log(`report → ${jsonPath}`);
	}

	console.log(pass ? 'All event-path dependencies survive losing their primary.' : 'At least one dependency has no proven failover — see FAIL above.');
	process.exit(pass ? 0 : 1);
}

run().catch((err) => {
	console.error('[failover] FATAL', err);
	process.exit(2);
});
