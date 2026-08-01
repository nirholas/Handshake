#!/usr/bin/env node
// Probe every Solana RPC lane the platform would use, in the exact priority order
// `solanaRpcEndpoints()` resolves them, against the CALL SHAPES production actually
// makes. Prints a lane-by-method matrix with the precise refusal on every cell that
// fails.
//
// Why a capability matrix and not a liveness check:
//
//   1. `getHealth` is UNMETERED. It answers `ok` on an endpoint whose plan is hard
//      exhausted, so a liveness probe reads a dead tier as healthy. This script
//      never calls it, and neither should you.
//   2. Free lanes are NOT interchangeable. Every one of them serves `getBalance`,
//      `getLatestBlockhash` and `getSignatureStatuses`; they diverge on exactly the
//      calls that matter. PublicNode answers HTTP 403 `blocked parameter:
//      params.1.programId` for the programId-filtered `getTokenAccountsByOwner`
//      behind every token and USDC balance read, and refuses `getProgramAccounts`
//      outright. MagicBlock serves the token filters and IP-blocks
//      `getProgramAccounts`. A probe that only checks `getBalance` promotes
//      PublicNode to primary and takes $THREE holder gating down while every
//      dashboard stays green.
//
// Usage:
//   node --env-file=.env scripts/probe-rpc-lanes.mjs           # every lane, every shape
//   node --env-file=.env scripts/probe-rpc-lanes.mjs --json    # machine-readable
//   node --env-file=.env scripts/probe-rpc-lanes.mjs --ws      # also probe logsSubscribe
//   node --env-file=.env scripts/probe-rpc-lanes.mjs --network devnet
//
// Without `--env-file` it still runs: it probes whatever lanes resolve from the
// ambient environment, which for a bare shell is the keyless free chain. That is a
// useful offline-safe smoke test, not a picture of production.
//
// Exit code 1 when a lane cannot serve a single method (dead, not merely limited),
// so this can gate an ops check. A lane that refuses SOME methods is the normal,
// expected state of the free chain and exits 0.

import { solanaRpcEndpoints, resolveWsEndpoint, isMethodRefusal } from '../api/_lib/solana/connection.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const withWs = args.includes('--ws');
const netFlag = args.indexOf('--network');
const network = netFlag >= 0 ? args[netFlag + 1] : 'mainnet';
const TIMEOUT_MS = 12_000;
const WS_TIMEOUT_MS = 8_000;

// Read-only probe subjects. All three are permanent mainnet fixtures, so the probe
// is deterministic and costs nothing beyond the metered request itself.
//   • the SPL Token program: the `programId` filter every balance reader passes
//   • $THREE: the platform's own mint, so `getProgramAccounts` is filtered to a
//     real, small owner set rather than sweeping a program
//   • the all-zero signature: `getSignatureStatuses` answers `{value:[null]}` for
//     it, which exercises the method without depending on any particular
//     transaction still being in the node's status cache. Exactly 64 base58 '1'
//     characters: '1' is base58 zero, so this decodes to the 64 zero bytes a
//     signature must be. Any other length is rejected by every lane as
//     `-32602 Invalid param: WrongSize`, which would read as a universal refusal.
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const NEVER_SEEN_SIG = '1'.repeat(64);

// The call shapes production makes, in the order the failure hurts most. `weight`
// marks the ones whose refusal takes a user-visible feature down, so the summary
// can say which lanes are safe to promote rather than just which ones answer.
const METHODS = [
	{
		name: 'getLatestBlockhash',
		short: 'blockhash',
		critical: true,
		note: 'every signed transaction',
		params: [{ commitment: 'confirmed' }],
	},
	{
		name: 'getBalance',
		short: 'balance',
		critical: true,
		note: 'SOL balances, treasury, fee floors',
		params: [SYSVAR_CLOCK],
	},
	{
		name: 'getSignatureStatuses',
		short: 'sigStatus',
		critical: true,
		note: 'every confirmation poll',
		params: [[NEVER_SEEN_SIG], { searchTransactionHistory: false }],
	},
	{
		name: 'getTokenAccountsByOwner',
		short: 'tokenAcct',
		critical: true,
		note: '$THREE holder gating, USDC balances',
		params: [SYSVAR_CLOCK, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }],
	},
	{
		name: 'getProgramAccounts',
		short: 'progAcct',
		critical: false,
		note: 'holder census, ring sweeps',
		// dataSize-only filter against the token program: cheap for the node to
		// answer and refused by exactly the lanes that refuse the method class.
		params: [
			TOKEN_PROGRAM,
			{ encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: 165 }], limit: 1 },
		],
	},
	{
		name: 'getAccountInfo',
		short: 'acctInfo',
		critical: true,
		note: 'mint metadata, curve reads',
		params: [THREE_MINT, { encoding: 'base64' }],
	},
	{
		// simulateTransaction, not sendTransaction: it exercises the same
		// broadcast-side permission surface with zero chance of touching the chain.
		// An empty-instruction message from an unfunded key is refused for
		// *signature* reasons on a lane that supports the method, and refused with a
		// method/policy error on one that does not: which is exactly the split we
		// are measuring.
		name: 'simulateTransaction',
		short: 'simulate',
		critical: true,
		note: 'settle preflight (read-only stand-in for sendTransaction)',
		params: [
			'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
			{ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true },
		],
	},
];

const maskUrl = (url) =>
	String(url)
		.replace(/(api[-_]?key=)[^&]+/gi, '$1***')
		.replace(/(dkey=)[^&]+/gi, '$1***')
		.replace(/\/v2\/[^/?]+/, '/v2/***')
		.replace(/(quiknode\.pro\/)[^/?]+/i, '$1***')
		.replace(/(\/solana\/)[A-Za-z0-9]{16,}/i, '$1***');

const shortHost = (url) => {
	try {
		return new URL(url).host;
	} catch {
		return maskUrl(url).slice(0, 40);
	}
};

/**
 * One metered JSON-RPC call. Classifies the outcome into the same vocabulary the
 * router uses, so the matrix and the breaker cannot drift apart:
 *   ok: a usable result
 *   refused: this lane will not serve THIS shape (policy block, tier gate). The
 *              lane is healthy; the router demotes the method, not the lane.
 *   quota: the plan is spent. The lane is dead until it resets.
 *   auth: the key is bad or missing.
 *   error: anything else: a transport failure, a 5xx, a malformed body.
 */
async function probe(url, method) {
	const started = Date.now();
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method.name, params: method.params }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const ms = Date.now() - started;
		const text = await res.text();
		let body = null;
		try {
			body = JSON.parse(text);
		} catch {
			// An exhausted plan does not always answer in JSON, Helius returns a bare
			// 429 with an empty body. Classify on the status so a spent plan reads as
			// QUOTA rather than as a mystery transport failure, which is the difference
			// between "top this up" and "debug the network".
			if (res.status === 429) return { state: 'quota', ms, detail: `HTTP 429, non-JSON body` };
			if (res.status === 401 || res.status === 403) {
				return { state: 'auth', ms, detail: `HTTP ${res.status}, non-JSON body` };
			}
			return { state: 'error', ms, detail: `HTTP ${res.status}, unparseable body` };
		}
		const err = body?.error;
		if (err) {
			const msg = String(err.message || '').replace(/\s+/g, ' ').trim();
			const code = err.code ?? '';
			const detail = `${code} ${msg}`.trim().slice(0, 90);
			// isMethodRefusal is imported from the router, not re-implemented here: if
			// a new provider phrasing fools the matrix it fools production identically,
			// and the fix lands in one place.
			if (isMethodRefusal(msg)) return { state: 'refused', ms, detail };
			if (/max usage|quota|capacity|request limit|usage limit|credits?\s*exhausted/i.test(msg)) {
				return { state: 'quota', ms, detail };
			}
			if (res.status === 401 || res.status === 403 || /unauthor|api key|forbidden/i.test(msg)) {
				return { state: 'auth', ms, detail };
			}
			// simulateTransaction on a well-formed but unsigned/garbage message comes
			// back as a deterministic client error on every healthy lane. That is the
			// method WORKING: the node parsed the request and reached the simulator.
			if (method.name === 'simulateTransaction' && /signature|blockhash|deserial|sanitize|instruction/i.test(msg)) {
				return { state: 'ok', ms, detail: 'reached simulator' };
			}
			return { state: 'error', ms, detail };
		}
		if (!res.ok) {
			if (res.status === 429) return { state: 'quota', ms, detail: 'HTTP 429' };
			if (res.status === 401 || res.status === 403) return { state: 'auth', ms, detail: `HTTP ${res.status}` };
			return { state: 'error', ms, detail: `HTTP ${res.status}` };
		}
		if (!('result' in body)) return { state: 'error', ms, detail: 'no result field' };
		return { state: 'ok', ms, detail: '' };
	} catch (e) {
		const ms = Date.now() - started;
		return { state: 'error', ms, detail: String(e?.message || e).slice(0, 90) };
	}
}

/**
 * Open the lane's WebSocket and attempt a real `logsSubscribe`, then unsubscribe.
 * Free lanes advertise a wss endpoint they will not actually let you subscribe on
 * (the upgrade 429s, or the subscription is refused after the handshake), and that
 * distinction is invisible over HTTP.
 */
async function probeWs(httpUrl) {
	const wsUrl = resolveWsEndpoint(httpUrl, network);
	const started = Date.now();
	let socket;
	try {
		socket = new WebSocket(wsUrl);
	} catch (e) {
		return { state: 'error', ms: 0, detail: String(e?.message || e).slice(0, 90) };
	}
	return new Promise((resolve) => {
		let settled = false;
		const done = (out) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.close();
			} catch {
				/* already closing */
			}
			resolve({ ...out, ms: Date.now() - started });
		};
		const timer = setTimeout(() => done({ state: 'error', detail: 'no subscription reply' }), WS_TIMEOUT_MS);
		socket.addEventListener('open', () => {
			socket.send(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'logsSubscribe',
					params: [{ mentions: [TOKEN_PROGRAM] }, { commitment: 'confirmed' }],
				}),
			);
		});
		socket.addEventListener('message', (ev) => {
			let msg = null;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return done({ state: 'error', detail: 'unparseable frame' });
			}
			if (msg?.id !== 1) return; // a notification beat the reply; keep waiting
			if (msg.error) {
				const text = String(msg.error.message || '').replace(/\s+/g, ' ').trim();
				const detail = `${msg.error.code ?? ''} ${text}`.trim().slice(0, 90);
				return done({ state: isMethodRefusal(text) ? 'refused' : 'error', detail });
			}
			if (typeof msg.result === 'number') {
				socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'logsUnsubscribe', params: [msg.result] }));
				return done({ state: 'ok', detail: `sub ${msg.result}` });
			}
			done({ state: 'error', detail: 'no subscription id' });
		});
		socket.addEventListener('error', () => done({ state: 'error', detail: 'socket error (upgrade refused?)' }));
		socket.addEventListener('close', () => done({ state: 'error', detail: 'closed before reply' }));
	});
}

const GLYPH = { ok: 'ok', refused: 'REFUSED', quota: 'QUOTA', auth: 'AUTH', error: 'FAIL' };

function pad(s, n) {
	const v = String(s);
	return v.length >= n ? v.slice(0, n) : v + ' '.repeat(n - v.length);
}

const lanes = solanaRpcEndpoints(network);
if (lanes.length === 0) {
	console.error(`no ${network} lanes resolve from this environment`);
	process.exit(1);
}

const shapes = withWs
	? [...METHODS, { name: 'logsSubscribe', short: 'logsSub', critical: false, note: 'live trade windows', ws: true }]
	: METHODS;

const rows = [];
for (const url of lanes) {
	// Sequential per lane, so one lane's probe burst cannot itself trip that lane's
	// rate limiter and report a false refusal.
	const cells = {};
	for (const shape of shapes) {
		cells[shape.name] = shape.ws ? await probeWs(url) : await probe(url, shape);
	}
	const okCount = shapes.filter((m) => cells[m.name].state === 'ok').length;
	const quotaCount = shapes.filter((m) => cells[m.name].state === 'quota').length;
	const authCount = shapes.filter((m) => cells[m.name].state === 'auth').length;
	const criticalGaps = shapes.filter((m) => m.critical && cells[m.name].state !== 'ok').map((m) => m.name);
	const p50 =
		Math.round(shapes.map((m) => cells[m.name].ms).sort((a, b) => a - b)[Math.floor(shapes.length / 2)]) || 0;
	// A lane serving nothing is three very different situations with three very
	// different responses, and collapsing them into "dead" is what turns a routine
	// daily cap into a false alarm.
	const verdict =
		okCount > 0
			? criticalGaps.length === 0
				? 'safe as primary'
				: `usable, NOT safe as primary - missing ${criticalGaps.join(', ')}`
			: quotaCount > 0
				? 'quota spent - recovers on its own or with a top-up, keep it configured'
				: authCount > 0
					? 'key rejected - rotate or remove the credential'
					: 'DEAD - serves nothing and gives no reason, pull it from the env config';
	rows.push({ url: maskUrl(url), host: shortHost(url), cells, okCount, p50, criticalGaps, verdict });
}

if (asJson) {
	console.log(JSON.stringify({ network, probedAt: new Date().toISOString(), lanes: rows }, null, 2));
} else {
	const hostWidth = Math.min(40, Math.max(12, ...rows.map((r) => r.host.length))) + 2;
	const colWidth = Math.max(10, ...shapes.map((m) => m.short.length + 2));
	console.log(`\nSolana RPC capability matrix - ${network}, ${rows.length} lane(s), in resolution order`);
	console.log(`probed ${new Date().toISOString()} with metered calls only (never getHealth)\n`);
	console.log(pad('lane', hostWidth) + shapes.map((m) => pad(m.short, colWidth)).join(''));
	console.log('-'.repeat(hostWidth + colWidth * shapes.length));
	for (const row of rows) {
		console.log(
			pad(row.host, hostWidth) + shapes.map((m) => pad(GLYPH[row.cells[m.name].state], colWidth)).join(''),
		);
	}

	console.log('\nrefusals and failures, verbatim:');
	let printed = 0;
	for (const row of rows) {
		for (const shape of shapes) {
			const cell = row.cells[shape.name];
			if (cell.state === 'ok') continue;
			printed++;
			console.log(`  ${pad(row.host, hostWidth)} ${pad(shape.name, 26)} ${GLYPH[cell.state]}  ${cell.detail}`);
		}
	}
	if (printed === 0) console.log('  none: every lane served every shape');

	console.log('\nverdict per lane:');
	for (const row of rows) {
		console.log(
			`  ${pad(row.host, hostWidth)} ${row.okCount}/${shapes.length} shapes, p50 ${row.p50}ms - ${row.verdict}`,
		);
	}
	console.log(
		'\nA lane that refuses SOME shapes is normal: the router demotes that (lane, method)\n' +
			'pair for 15 minutes and keeps the lane in rotation for everything else.\n' +
			'A lane serving NOTHING is either quota-spent (it comes back on its own, or with\n' +
			'money) or genuinely dead (pull it from the env config). The verdict says which.\n',
	);
}

// Exit 1 only for a lane that is genuinely dead, refusing or erroring on every
// shape with no quota signal to explain it. A quota-spent lane is a billing fact,
// not a config fault, and failing an ops check on it would cry wolf every day the
// daily cap trips.
const dead = rows.filter((r) => r.verdict.startsWith('DEAD'));
if (dead.length) {
	console.error(`${dead.length} lane(s) serve nothing and show no quota signal: ${dead.map((r) => r.host).join(', ')}`);
	process.exit(1);
}
