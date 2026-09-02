#!/usr/bin/env node
/**
 * End-to-end real-payment gauntlet for OKX.AI agent #2632 (work order 04).
 *
 * Acts as an OKX buyer agent against PRODUCTION: hits the 402, signs a real
 * EIP-3009 authorization through the `onchainos` TEE wallet, replays it, takes
 * delivery of the artifact, and then proves the money actually moved by reading
 * the settlement transaction off X Layer. Every case writes its evidence to
 * prompts/okx-ai/e2e-evidence/.
 *
 * The listed line-up is A2MCP (rebuilt 2026-08-22): every paid row is an MCP
 * Streamable HTTP server whose `forge_3d` tool is x402-gated, and generation is
 * asynchronous, so a buy is submit -> job id -> poll the FREE `forge_status`
 * tool -> GLB. That is the flow exercised here, because it is the flow an OKX
 * reviewer runs. The back-burner REST rows stay payable and case 3r buys one of
 * them, which is where the rigged-artifact assertion lives: forge output is a
 * static mesh, only the `avatar` chain ships a skeleton.
 *
 * This spends real USD₮0 on X Layer. It refuses to run without --yes.
 *
 * Cases (each runs individually, none is "covered by" another):
 *   1   free lane serves live data with no payment demanded
 *   2   cheapest paid row ($0.01 forge-draft) delivers a real GLB
 *   2b  mid paid row ($0.05 forge-standard) delivers a real GLB
 *   3   flagship listed row ($0.25 forge-hd) delivers a real GLB
 *   3i  image lane ($0.25 forge-image) rebuilds a GLB from a reference image
 *   3r  rigged flagship ($0.50 avatar) delivers a GLB with skeleton + skin
 *   4   settlement verified on-chain for every payment (tx, recipient, amount)
 *   5a  replaying an authorization does not buy a second job
 *   5b  an authorization bound to one price cannot buy a dearer service
 *   5c  an expired authorization is rejected and a fresh challenge offered
 *   5d  a garbage payment header gets a clean 4xx and runs no tool
 *   6   a job that fails after payment leaves the authorization unspent
 *   7   a legacy (non-X-Layer) rail still answers, and pays, its own challenge
 *
 * Usage:
 *   node scripts/okx-e2e-gauntlet.mjs --yes
 *   node scripts/okx-e2e-gauntlet.mjs --yes --only 2,3,4
 *   node scripts/okx-e2e-gauntlet.mjs --dry-run          # no signing, no spend
 *   node scripts/okx-e2e-gauntlet.mjs --budget           # what a full run costs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { catalogEntry, listedCatalog, FORGE_TOOL, FORGE_STATUS_TOOL } from '../api/_lib/okx-catalog.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = resolve(REPO, 'prompts/okx-ai/e2e-evidence');
const CLI = `${process.env.HOME}/.local/bin/onchainos`;

const XLAYER_RPCS = ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com', 'https://rpc.ankr.com/xlayer'];
const USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const BUYER = '0x75d00a2713565171f33216e5aa2a375e076ecf69';
// Event/selector hashes: Transfer(address,address,uint256) topic0, the
// authorizationState(address,bytes32) selector for the EIP-3009 nonce read, and
// balanceOf(address) for the spendable-float preflight.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EIP3009_AUTH_STATE = '0xe94a0102';
const ERC20_BALANCE_OF = '0x70a08231';

// A reference image every image-lane case can point at: our own OG asset, so
// the test never depends on a third party staying up.
const REFERENCE_IMAGE = 'https://three.ws/og/three-ws.png';
// How long a forge job may take before the buyer gives up. The HD lane is the
// slow one; the catalog tells buyers to keep polling, so the gauntlet does too.
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function parseArgs(argv) {
	const args = { base: 'https://three.ws', yes: false, dryRun: false, budget: false, only: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--base') args.base = argv[++i].replace(/\/$/, '');
		else if (argv[i] === '--yes') args.yes = true;
		else if (argv[i] === '--dry-run') args.dryRun = true;
		else if (argv[i] === '--budget') args.budget = true;
		else if (argv[i] === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()));
	}
	return args;
}
const args = parseArgs(process.argv.slice(2));

mkdirSync(EVIDENCE, { recursive: true });
const results = [];
const settlements = [];

const log = (m) => console.log(m);
const evidence = (name, data) => {
	const path = `${EVIDENCE}/${name}`;
	writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
	return `prompts/okx-ai/e2e-evidence/${name}`;
};
function record(id, title, ok, detail, ref) {
	results.push({ id, title, ok, detail, evidence: ref });
	log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${title}${detail ? `: ${detail}` : ''}`);
	return ok;
}
const wanted = (id) => !args.only || args.only.has(id);

// ── X Layer reads ────────────────────────────────────────────────────────────
let rpcId = 1;
async function rpc(method, params) {
	let lastErr;
	for (const url of XLAYER_RPCS) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
				signal: AbortSignal.timeout(20_000),
			});
			const body = await res.json();
			if (body.error) throw new Error(JSON.stringify(body.error));
			return body.result;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}
const pad32 = (hexOrAddr) => hexOrAddr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// Has this EIP-3009 nonce been redeemed on-chain? The single fact that
// separates "the buyer was charged" from "the buyer was not".
async function authorizationUsed(from, nonce) {
	const data = EIP3009_AUTH_STATE + pad32(from) + pad32(nonce);
	const out = await rpc('eth_call', [{ to: USDT0, data }, 'latest']);
	return BigInt(out) !== 0n;
}

async function buyerFloat() {
	const out = await rpc('eth_call', [{ to: USDT0, data: ERC20_BALANCE_OF + pad32(BUYER) }, 'latest']);
	return BigInt(out);
}

// Confirm a settlement moved the advertised amount to the advertised payTo.
// A tx hash in a PAYMENT-RESPONSE header proves nothing until its Transfer log
// is read back off-chain: this is the check that makes case 4 real.
async function verifySettlement({ txHash, expectPayTo, expectAmount, expectPayer }) {
	const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
	if (!receipt) return { ok: false, reason: `tx ${txHash} not found on X Layer` };
	if (BigInt(receipt.status) !== 1n) return { ok: false, reason: `tx ${txHash} reverted (status ${receipt.status})` };

	const transfers = (receipt.logs || [])
		.filter((l) => l.address.toLowerCase() === USDT0 && l.topics[0].toLowerCase() === TRANSFER_TOPIC)
		.map((l) => ({
			from: '0x' + l.topics[1].slice(26),
			to: '0x' + l.topics[2].slice(26),
			value: BigInt(l.data).toString(),
		}));
	const match = transfers.find(
		(t) => t.to.toLowerCase() === expectPayTo.toLowerCase() && t.value === String(expectAmount),
	);
	if (!match) {
		return {
			ok: false,
			reason: `no USD₮0 Transfer of ${expectAmount} to ${expectPayTo} in tx ${txHash}; saw ${JSON.stringify(transfers)}`,
			transfers,
		};
	}
	if (expectPayer && match.from.toLowerCase() !== expectPayer.toLowerCase()) {
		return { ok: false, reason: `payer mismatch: log says ${match.from}, PAYMENT-RESPONSE says ${expectPayer}`, transfers };
	}
	return {
		ok: true,
		block: BigInt(receipt.blockNumber).toString(),
		gasUsed: BigInt(receipt.gasUsed).toString(),
		relayer: receipt.from,
		transfer: match,
		transfers,
	};
}

// ── HTTP: A2MCP and REST ─────────────────────────────────────────────────────
async function post(url, body, { paymentHeader, headerName = 'PAYMENT-SIGNATURE', extraHeaders } = {}) {
	const headers = { 'content-type': 'application/json', ...(extraHeaders || {}) };
	if (paymentHeader) headers[headerName] = paymentHeader;
	const res = await fetch(url, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(600_000),
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* non-JSON bodies are reported as raw text */
	}
	return {
		status: res.status,
		challengeHeader: res.headers.get('payment-required'),
		receiptHeader: res.headers.get('payment-response') || res.headers.get('x-payment-response'),
		body: parsed ?? text,
	};
}

let rpcCallId = 1;
const jsonRpc = (name, toolArgs) => ({
	jsonrpc: '2.0',
	id: rpcCallId++,
	method: 'tools/call',
	params: { name, arguments: toolArgs },
});

// One tools/call against an A2MCP row, with the buyer's structured result
// unwrapped so a case reads `.structured.status` instead of walking the
// JSON-RPC envelope every time.
async function mcpCall(entry, toolName, toolArgs, opts = {}) {
	const r = await post(entry.endpoint, jsonRpc(toolName, toolArgs), opts);
	const result = r.body && !Array.isArray(r.body) ? r.body.result : null;
	return {
		...r,
		rpcError: r.body?.error ?? null,
		isToolError: Boolean(result?.isError),
		structured: result?.structuredContent ?? null,
		text: result?.content?.[0]?.text ?? '',
	};
}

// Poll the FREE forge_status tool until the job finishes. This is the buyer's
// half of the async contract, and it must cost nothing: a poll that ever
// answers 402 is a defect, so the loop records that rather than paying.
async function pollForgeJob(jobId, title) {
	const statusEntry = catalogEntry('forge-status');
	const started = Date.now();
	let frames = 0;
	let last = null;
	while (Date.now() - started < POLL_TIMEOUT_MS) {
		const r = await mcpCall(statusEntry, FORGE_STATUS_TOOL, { job_id: jobId, ...(title ? { title } : {}) });
		frames++;
		last = r;
		if (r.status !== 200) {
			return { ok: false, reason: `free poll answered ${r.status}`, frames, last: r, elapsedMs: Date.now() - started };
		}
		const status = r.structured?.status;
		if (status === 'done') {
			return { ok: true, frames, elapsedMs: Date.now() - started, done: r.structured, last: r };
		}
		if (status === 'error' || r.isToolError) {
			return { ok: false, reason: r.structured?.error || r.text || 'job failed', frames, last: r, elapsedMs: Date.now() - started };
		}
		await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
	}
	return { ok: false, reason: `job did not finish within ${POLL_TIMEOUT_MS / 1000}s`, frames, last, elapsedMs: Date.now() - started };
}

// Poll the free REST job route the back-burner rows hand back.
async function pollRestJob(jobId) {
	const started = Date.now();
	let frames = 0;
	let last = null;
	while (Date.now() - started < POLL_TIMEOUT_MS) {
		const res = await fetch(`${args.base}/api/forge?job=${encodeURIComponent(jobId)}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(60_000),
		});
		const body = await res.json().catch(() => null);
		frames++;
		last = { status: res.status, body };
		if (body?.status === 'done' && body?.glb_url) {
			return { ok: true, frames, elapsedMs: Date.now() - started, glbUrl: body.glb_url, last };
		}
		if (body?.status === 'error' || body?.error) {
			return { ok: false, reason: body.error || 'job failed', frames, last, elapsedMs: Date.now() - started };
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return { ok: false, reason: `job did not finish within ${POLL_TIMEOUT_MS / 1000}s`, frames, last, elapsedMs: Date.now() - started };
}

const decodeB64Json = (v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

// Sign through the TEE wallet, the exact path an OKX buyer agent takes.
// `mutate` lets a case hand the signer a doctored challenge (case 5c needs a
// one-second validity window) without ever hand-rolling a signature.
// `selectedIndex` picks the rail: 0 is always X Layer, case 7 pays another.
function signChallenge(challengeHeader, { mutate, selectedIndex = 0 } = {}) {
	let payload = challengeHeader;
	if (mutate) {
		const decoded = decodeB64Json(challengeHeader);
		mutate(decoded);
		payload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');
	}
	const out = execFileSync(CLI, ['payment', 'pay', '--payload', payload, '--selected-index', String(selectedIndex)], {
		encoding: 'utf8',
		maxBuffer: 1 << 24,
		timeout: 180_000,
	});
	const parsed = JSON.parse(out);
	const data = parsed.data ?? parsed;
	if (!data.authorization_header) throw new Error(`payment pay returned no authorization_header: ${out.slice(0, 400)}`);
	return { header: data.authorization_header, headerName: data.header_name || 'PAYMENT-SIGNATURE', wallet: data.wallet, raw: data };
}
// The signed authorization, so a case can check its nonce on-chain afterwards.
function authFromHeader(header) {
	const payload = decodeB64Json(header);
	const p = payload.payload ?? payload;
	return p.authorization ?? null;
}

// Verify the bytes behind a delivered URL are a real model. A 200 is not
// delivery until the container parses and carries geometry.
function verifyArtifact(modelUrl, { rigged, name }) {
	try {
		execFileSync('node', ['scripts/okx-verify-glb.mjs', modelUrl, ...(rigged ? ['--rigged'] : []), '--json', `${EVIDENCE}/${name}`], {
			cwd: REPO,
			encoding: 'utf8',
			stdio: 'pipe',
			timeout: 300_000,
		});
		return { ok: true, detail: '' };
	} catch (err) {
		return { ok: false, detail: (err.stdout || err.message || '').toString().trim().split('\n').slice(-4).join(' / ') };
	}
}

// ── Cases ────────────────────────────────────────────────────────────────────

async function case1Free() {
	const health = await fetch(`${args.base}/api/okx/3d/health`, { signal: AbortSignal.timeout(60_000) });
	const healthBody = await health.json();
	const catalog = await fetch(`${args.base}/api/okx/3d/catalog`, { signal: AbortSignal.timeout(60_000) });
	const catalogBody = await catalog.json();

	// The free tools must be free ON A PAID ROW too: a buyer polls the job where
	// it paid for it. A 402 on either of these strands a paid buyer mid-flight.
	const paidRow = catalogEntry('forge-draft');
	const freePoll = await mcpCall(paidRow, FORGE_STATUS_TOOL, { job_id: 'f1.not-a-real-job' });
	const gettingStarted = await mcpCall(paidRow, 'getting_started', {});

	const ref = evidence('30-case1-free-lane.json', {
		health: { status: health.status, body: healthBody },
		catalog: { status: catalog.status, body: catalogBody },
		freeToolsOnPaidRow: {
			forge_status: { status: freePoll.status, isToolError: freePoll.isToolError, structured: freePoll.structured, text: freePoll.text.slice(0, 400) },
			getting_started: { status: gettingStarted.status, text: gettingStarted.text.slice(0, 400) },
		},
	});

	const healthOk = health.status === 200 && healthBody.ok === true && Array.isArray(healthBody.subsystems) && healthBody.subsystems.length > 0;
	const live = healthBody.subsystems?.every((s) => typeof s.latency_ms === 'number');
	// `services` is the listed line-up; back-burner rows ship under `unlisted`.
	const catalogOk = catalog.status === 200 && catalogBody.services?.length === listedCatalog().length;
	// A free tool answering anything but 200 means it was paywalled.
	const freeOk = freePoll.status === 200 && gettingStarted.status === 200;
	record(
		'1',
		'free lane serves live data, no payment demanded',
		healthOk && live && catalogOk && freeOk,
		`health ${health.status} (${healthBody.subsystems?.length} subsystems, real latencies), catalog ${catalog.status} (${catalogBody.services?.length} rows), free tools on a paid row: forge_status ${freePoll.status}, getting_started ${gettingStarted.status}`,
		ref,
	);
}

// The full A2MCP buy: 402 -> sign -> replay -> job id -> free poll -> artifact
// -> on-chain settlement.
async function buyForge({ id, serviceId, title, toolArgs }) {
	const entry = catalogEntry(serviceId);
	const unpaid = await mcpCall(entry, FORGE_TOOL, toolArgs);
	if (unpaid.status !== 402 || !unpaid.challengeHeader) {
		return record(id, title, false, `expected 402, got ${unpaid.status}`, evidence(`31-case${id}-unpaid.json`, unpaid));
	}
	const challenge = decodeB64Json(unpaid.challengeHeader);
	const accept = challenge.accepts[0];
	if (accept.network !== 'eip155:196' || accept.amount !== entry.amountAtomics) {
		return record(id, title, false, `challenge mismatch: ${accept.network} @ ${accept.amount}, want eip155:196 @ ${entry.amountAtomics}`, evidence(`31-case${id}-unpaid.json`, unpaid));
	}

	if (args.dryRun) return record(id, title, false, 'dry run: signing skipped', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const paid = await mcpCall(entry, FORGE_TOOL, toolArgs, { paymentHeader: signed.header, headerName: signed.headerName });

	const receipt = paid.receiptHeader ? decodeB64Json(paid.receiptHeader) : null;
	if (receipt?.transaction) {
		settlements.push({ case: id, service: serviceId, tx: receipt.transaction, amount: entry.amountAtomics, priceUsd: entry.priceUsd, payTo: accept.payTo, payer: receipt.payer || auth?.from, authorization: auth });
	}

	const writeEvidence = (extra) =>
		evidence(`31-case${id}-${serviceId}.json`, {
			unpaid: { status: unpaid.status, challenge },
			signed: { wallet: signed.wallet, headerName: signed.headerName, authorization: auth, authorization_header: signed.header },
			paid: { status: paid.status, structured: paid.structured, text: paid.text, receipt },
			...extra,
		});

	if (paid.status !== 200 || paid.isToolError) {
		return record(id, title, false, `paid call returned ${paid.status}${paid.isToolError ? ' (tool error)' : ''}: ${(paid.text || JSON.stringify(paid.body)).slice(0, 300)}`, writeEvidence({}));
	}

	// Async by contract: a submit answers `pending` with a job id, and the free
	// status tool carries it to `done`. A submit that is already done is fine.
	let doneFrame = paid.structured?.status === 'done' ? paid.structured : null;
	let poll = null;
	if (!doneFrame) {
		const jobId = paid.structured?.job;
		if (!jobId) {
			return record(id, title, false, `200 but no job id and no model: ${JSON.stringify(paid.structured).slice(0, 300)}`, writeEvidence({}));
		}
		poll = await pollForgeJob(jobId, toolArgs.prompt);
		if (!poll.ok) {
			return record(id, title, false, `job ${jobId} did not deliver: ${poll.reason}`, writeEvidence({ poll }));
		}
		doneFrame = poll.done;
	}

	const modelUrl = doneFrame?.glbUrl;
	if (!modelUrl) {
		return record(id, title, false, `job finished with no glbUrl: ${JSON.stringify(doneFrame).slice(0, 300)}`, writeEvidence({ poll }));
	}
	const artifact = verifyArtifact(modelUrl, { rigged: false, name: `32-case${id}-artifact.json` });
	const ref = writeEvidence({ poll: poll ? { ok: poll.ok, frames: poll.frames, elapsedMs: poll.elapsedMs } : null, done: doneFrame });

	return record(
		id,
		title,
		artifact.ok && Boolean(receipt?.transaction),
		`200, ${poll ? `job done in ${Math.round(poll.elapsedMs / 1000)}s over ${poll.frames} free polls, ` : ''}artifact ${artifact.ok ? 'verified' : `FAILED (${artifact.detail})`}, tx ${receipt?.transaction || 'MISSING from PAYMENT-RESPONSE'}`,
		ref,
	);
}

// The rigged artifact assertion. The listed forge rows deliver a static mesh by
// design; the `avatar` chain (back burner, still payable) is the row that ships
// a skeleton, so the "flagship delivers bones and skin weights" check lives on
// it rather than being quietly dropped when the listing was rebuilt.
async function case3Rigged() {
	const id = '3r';
	const title = 'rigged row delivers a GLB with a skeleton and skin weights';
	const entry = catalogEntry('avatar');
	const body = { prompt: 'a heroic knight in silver armor, full body' };
	const unpaid = await post(entry.endpoint, body);
	if (unpaid.status !== 402 || !unpaid.challengeHeader) {
		return record(id, title, false, `expected 402, got ${unpaid.status}`, evidence(`31-case${id}-unpaid.json`, unpaid));
	}
	const challenge = decodeB64Json(unpaid.challengeHeader);
	const accept = challenge.accepts[0];
	if (accept.network !== 'eip155:196' || accept.amount !== entry.amountAtomics) {
		return record(id, title, false, `challenge mismatch: ${accept.network} @ ${accept.amount}, want eip155:196 @ ${entry.amountAtomics}`, evidence(`31-case${id}-unpaid.json`, unpaid));
	}
	if (args.dryRun) return record(id, title, false, 'dry run: signing skipped', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const paid = await post(entry.endpoint, body, { paymentHeader: signed.header, headerName: signed.headerName });
	const receipt = paid.receiptHeader ? decodeB64Json(paid.receiptHeader) : null;
	if (receipt?.transaction) {
		settlements.push({ case: id, service: entry.id, tx: receipt.transaction, amount: entry.amountAtomics, priceUsd: entry.priceUsd, payTo: accept.payTo, payer: receipt.payer || auth?.from, authorization: auth });
	}
	const writeEvidence = (extra) =>
		evidence(`31-case${id}-avatar.json`, {
			unpaid: { status: unpaid.status, challenge },
			signed: { wallet: signed.wallet, authorization: auth, authorization_header: signed.header },
			paid: { status: paid.status, body: paid.body, receipt },
			...extra,
		});
	if (paid.status !== 200) {
		return record(id, title, false, `paid call returned ${paid.status}: ${JSON.stringify(paid.body).slice(0, 300)}`, writeEvidence({}));
	}
	let modelUrl = paid.body?.glb_url || paid.body?.model_url;
	let poll = null;
	if (!modelUrl) {
		const jobId = paid.body?.job_id;
		if (!jobId) return record(id, title, false, `200 with neither a model nor a job id: ${JSON.stringify(paid.body).slice(0, 300)}`, writeEvidence({}));
		poll = await pollRestJob(jobId);
		if (!poll.ok) return record(id, title, false, `job ${jobId} did not deliver: ${poll.reason}`, writeEvidence({ poll }));
		modelUrl = poll.glbUrl;
	}
	const artifact = verifyArtifact(modelUrl, { rigged: true, name: `32-case${id}-artifact.json` });
	const ref = writeEvidence({ poll: poll ? { ok: poll.ok, frames: poll.frames, elapsedMs: poll.elapsedMs } : null, modelUrl });
	return record(
		id,
		title,
		artifact.ok && Boolean(receipt?.transaction),
		`200, artifact ${artifact.ok ? 'verified rigged' : `FAILED (${artifact.detail})`}, tx ${receipt?.transaction || 'MISSING from PAYMENT-RESPONSE'}`,
		ref,
	);
}

async function case4Settlement() {
	if (!settlements.length) return record('4', 'settlement verified on-chain', false, 'no settlements to verify (paid cases did not run or did not settle)', null);
	const verified = [];
	let allOk = true;
	for (const s of settlements) {
		const v = await verifySettlement({ txHash: s.tx, expectPayTo: s.payTo, expectAmount: s.amount, expectPayer: s.payer });
		verified.push({ ...s, verification: v });
		log(`      ${v.ok ? 'ok  ' : 'FAIL'} ${s.service} $${s.priceUsd} tx=${s.tx} ${v.ok ? `block ${v.block}, ${s.amount} atomics -> ${s.payTo}` : v.reason}`);
		if (!v.ok) allOk = false;
	}
	const ref = evidence('40-case4-settlements.json', verified);
	return record('4', 'settlement verified on-chain (tx, recipient, exact amount)', allOk && verified.length >= 3, `${verified.filter((v) => v.verification.ok).length}/${verified.length} settlements confirmed`, ref);
}

async function case5aReplay() {
	const entry = catalogEntry('forge-draft');
	const toolArgs = { prompt: 'a small brass astrolabe' };
	const unpaid = await mcpCall(entry, FORGE_TOOL, toolArgs);
	if (unpaid.status !== 402) return record('5a', 'replayed authorization buys no second job', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('5a', 'replayed authorization buys no second job', false, 'dry run', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const pay = { paymentHeader: signed.header, headerName: signed.headerName };
	const first = await mcpCall(entry, FORGE_TOOL, toolArgs, pay);
	const second = await mcpCall(entry, FORGE_TOOL, toolArgs, pay);
	// A different body on the same proof must not be honoured either: that is
	// the variant that would buy a second, different job on one payment.
	const third = await mcpCall(entry, FORGE_TOOL, { prompt: 'a completely different object, a wooden chair' }, pay);

	const firstReceipt = first.receiptHeader ? decodeB64Json(first.receiptHeader) : null;
	if (firstReceipt?.transaction) {
		settlements.push({ case: '5a', service: entry.id, tx: firstReceipt.transaction, amount: entry.amountAtomics, priceUsd: entry.priceUsd, payTo: decodeB64Json(unpaid.challengeHeader).accepts[0].payTo, payer: firstReceipt.payer || auth?.from, authorization: auth });
	}

	// Idempotent replay (same proof, same body) must return the SAME job, not a
	// new one; the differing-body replay must be refused outright.
	const firstJob = first.structured?.job ?? null;
	const secondJob = second.structured?.job ?? null;
	const sameJob = second.status === first.status && firstJob !== null && secondJob === firstJob;
	const differentBodyRefused = third.status >= 400 || third.isToolError || Boolean(third.rpcError);
	const ref = evidence('50-case5a-replay.json', {
		first: { status: first.status, structured: first.structured, receipt: firstReceipt },
		secondSameBody: { status: second.status, structured: second.structured, receipt: second.receiptHeader ? decodeB64Json(second.receiptHeader) : null },
		thirdDifferentBody: { status: third.status, structured: third.structured, rpcError: third.rpcError, text: third.text },
		authorization: auth,
	});
	return record(
		'5a',
		'replayed authorization buys no second job',
		first.status === 200 && sameJob && differentBodyRefused,
		`first 200 job ${firstJob}; same-body replay ${second.status} job ${secondJob} ${sameJob ? '(identical cached job)' : '(DIFFERENT job, a second job ran)'}; different-body replay ${third.status} ${differentBodyRefused ? '(refused)' : '(ACCEPTED, defect)'}`,
		ref,
	);
}

async function case5bCrossService() {
	const cheap = catalogEntry('forge-draft');
	const dear = catalogEntry('forge-hd');
	const unpaid = await mcpCall(cheap, FORGE_TOOL, { prompt: 'a tin whistle' });
	if (unpaid.status !== 402) return record('5b', 'cheap authorization cannot buy a dearer service', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('5b', 'cheap authorization cannot buy a dearer service', false, 'dry run', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const attempt = await mcpCall(dear, FORGE_TOOL, { prompt: 'a heroic knight in silver armor, full body' }, { paymentHeader: signed.header, headerName: signed.headerName });
	// The authorization must be untouched: rejected before any redemption.
	const spent = auth ? await authorizationUsed(auth.from, auth.nonce) : null;
	const ref = evidence('51-case5b-cross-service.json', {
		signedFor: { service: cheap.id, amount: cheap.amountAtomics },
		replayedAgainst: { service: dear.id, amount: dear.amountAtomics },
		attempt: { status: attempt.status, structured: attempt.structured, body: attempt.body },
		authorization: auth,
		authorizationSpentOnChain: spent,
	});
	const refused = attempt.status === 402 || attempt.status === 400;
	const freshChallenge = Boolean(attempt.challengeHeader);
	return record(
		'5b',
		'cheap authorization cannot buy a dearer service',
		refused && spent === false,
		`${attempt.status}${freshChallenge ? ' with a fresh challenge' : ''}, authorization unspent on-chain: ${spent}, error: ${attempt.body?.error || attempt.body?.error_description || ''}`,
		ref,
	);
}

async function case5cExpired() {
	const entry = catalogEntry('forge-draft');
	const toolArgs = { prompt: 'a paper lantern' };
	const unpaid = await mcpCall(entry, FORGE_TOOL, toolArgs);
	if (unpaid.status !== 402) return record('5c', 'expired authorization is rejected, fresh challenge offered', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('5c', 'expired authorization is rejected, fresh challenge offered', false, 'dry run', null);

	// Sign against a one-second validity window, then let it lapse. This is a
	// genuinely expired real signature, not a hand-edited authorization.
	const signed = signChallenge(unpaid.challengeHeader, {
		mutate: (c) => {
			c.accepts[0].maxTimeoutSeconds = 1;
		},
	});
	const auth = authFromHeader(signed.header);
	await new Promise((r) => setTimeout(r, 4000));
	const attempt = await mcpCall(entry, FORGE_TOOL, toolArgs, { paymentHeader: signed.header, headerName: signed.headerName });
	const spent = auth ? await authorizationUsed(auth.from, auth.nonce) : null;
	const ref = evidence('52-case5c-expired.json', {
		authorization: auth,
		nowSeconds: Math.floor(Date.now() / 1000),
		attempt: { status: attempt.status, body: attempt.body, freshChallenge: attempt.challengeHeader ? decodeB64Json(attempt.challengeHeader) : null },
		authorizationSpentOnChain: spent,
	});
	const expiredMsg = /expire|validBefore/i.test(JSON.stringify(attempt.body));
	return record(
		'5c',
		'expired authorization is rejected, fresh challenge offered',
		attempt.status === 402 && Boolean(attempt.challengeHeader) && expiredMsg && spent === false,
		`${attempt.status}, fresh challenge: ${Boolean(attempt.challengeHeader)}, message names expiry: ${expiredMsg}, unspent: ${spent}`,
		ref,
	);
}

async function case5dGarbage() {
	const entry = catalogEntry('forge-draft');
	const toolArgs = { prompt: 'a small ceramic teapot' };
	const cases = {
		notBase64: 'not-a-real-payment-header',
		wrongShape: Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64'),
		emptyString: '   ',
		truncatedJson: Buffer.from('{"x402Version":2,"payload":{', 'utf8').toString('base64'),
	};
	const out = {};
	let ok = true;
	for (const [name, header] of Object.entries(cases)) {
		const r = await mcpCall(entry, FORGE_TOOL, toolArgs, { paymentHeader: header, headerName: 'x-payment' });
		out[name] = { status: r.status, body: r.body, receiptHeader: r.receiptHeader, structured: r.structured };
		// Safe failure: an actionable 4xx, no job started, no settlement. Read
		// that off the structured result and the receipt header, never off a
		// string match on the body: a 402 carries the bazaar discovery block,
		// whose worked example legitimately contains a specimen job id.
		const startedJob = Boolean(r.structured?.job || r.structured?.glbUrl);
		const clean = r.status >= 400 && r.status < 500 && !startedJob && !r.receiptHeader;
		if (!clean) ok = false;
		log(`      ${clean ? 'ok  ' : 'FAIL'} ${name}: ${r.status} ${r.body?.error || r.body?.error_description || ''}`.slice(0, 160));
	}
	const ref = evidence('53-case5d-garbage.json', out);
	return record('5d', 'garbage payment header gets a clean 4xx, runs no tool', ok, Object.entries(out).map(([k, v]) => `${k}=${v.status}`).join(', '), ref);
}

async function case6PayOnlySuccess() {
	// A job that passes payment verification and then fails in the lane: a
	// well-formed image request pointing at a URL that does not resolve to an
	// image. If the promise holds, the authorization is still unspent on-chain
	// afterwards and no settlement receipt was emitted.
	const entry = catalogEntry('forge-image');
	const toolArgs = { image_urls: [`${args.base}/definitely-not-a-real-image-${Date.now()}.png`] };
	const unpaid = await mcpCall(entry, FORGE_TOOL, toolArgs);
	if (unpaid.status !== 402) return record('6', 'failed job leaves the authorization unspent', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('6', 'failed job leaves the authorization unspent', false, 'dry run', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const before = await authorizationUsed(auth.from, auth.nonce);
	const attempt = await mcpCall(entry, FORGE_TOOL, toolArgs, { paymentHeader: signed.header, headerName: signed.headerName });
	const after = await authorizationUsed(auth.from, auth.nonce);
	const ref = evidence('60-case6-pay-only-on-success.json', {
		request: toolArgs,
		authorization: auth,
		authorizationSpentBefore: before,
		attempt: { status: attempt.status, structured: attempt.structured, text: attempt.text, isToolError: attempt.isToolError, receiptHeader: attempt.receiptHeader },
		authorizationSpentAfter: after,
	});
	// A refusal can be an HTTP 4xx or an MCP tool error inside a 200: both mean
	// the work was not delivered, and both must leave the money alone.
	const failed = attempt.status >= 400 || attempt.isToolError;
	const notCharged = after === false && !attempt.receiptHeader;
	return record(
		'6',
		'failed job leaves the authorization unspent (pay-only-on-success)',
		failed && notCharged,
		`job ${attempt.status}${attempt.isToolError ? ' tool error' : ''} (${attempt.structured?.error || ''}), nonce redeemed on-chain: ${after}, settlement receipt emitted: ${Boolean(attempt.receiptHeader)}`,
		ref,
	);
}

async function case7LegacyRail() {
	// The pre-OKX rails must still answer their own challenge AND still take a
	// real payment: adding X Layer must not have broken the Solana/Base path the
	// platform already sells on. Advertisement is checked always; the paid leg
	// runs when the buyer's Solana account holds the fee.
	const entry = catalogEntry('forge-draft');
	const toolArgs = { prompt: 'a copper kettle' };
	const unpaid = await mcpCall(entry, FORGE_TOOL, toolArgs);
	if (unpaid.status !== 402 || !unpaid.challengeHeader) {
		return record('7', 'legacy rail still answers and pays its own challenge', false, `expected 402, got ${unpaid.status}`, null);
	}
	const challenge = decodeB64Json(unpaid.challengeHeader);
	const solanaIndex = challenge.accepts.findIndex((a) => a.network?.startsWith('solana:') && a.extra?.name === 'USDC');
	const solana = challenge.accepts[solanaIndex];
	const base = challenge.accepts.find((a) => a.network === 'eip155:8453');
	const advertised = Boolean(solana && base) && [solana, base].every((a) => a.amount === entry.amountAtomics);

	let paidLeg = null;
	if (advertised && !args.dryRun) {
		// Sign on the Solana rail rather than X Layer. The rail sponsors gas
		// through its feePayer, so this needs USDC and no SOL.
		try {
			const signed = signChallenge(unpaid.challengeHeader, { selectedIndex: solanaIndex });
			const paid = await mcpCall(entry, FORGE_TOOL, toolArgs, { paymentHeader: signed.header, headerName: signed.headerName });
			const receipt = paid.receiptHeader ? decodeB64Json(paid.receiptHeader) : null;
			paidLeg = {
				rail: solana.network,
				asset: solana.asset,
				status: paid.status,
				job: paid.structured?.job ?? null,
				receipt,
				ok: paid.status === 200 && !paid.isToolError,
			};
		} catch (err) {
			paidLeg = { rail: solana.network, ok: false, error: String(err.message || err).slice(0, 400) };
		}
	}

	const ref = evidence('70-case7-legacy-rails.json', { challenge, paidLeg });
	return record(
		'7',
		'legacy rail still answers and pays its own challenge',
		advertised && (args.dryRun || paidLeg?.ok === true),
		`accepts: ${challenge.accepts.map((a) => `${a.network}@${a.amount}`).join(', ')}; paid leg: ${paidLeg ? (paidLeg.ok ? `200 on ${paidLeg.rail}, tx ${paidLeg.receipt?.transaction || 'none in receipt'}` : `FAILED (${paidLeg.error || paidLeg.status})`) : 'not attempted'}`,
		ref,
	);
}

// ── Budget ───────────────────────────────────────────────────────────────────
// What a full run costs, and the floor the buyer must hold at each point. Verify
// refuses any authorization whose value exceeds balanceOf(buyer), including the
// ones designed to be rejected, so the binding constraint is the floor at the
// moment each case signs, not the sum of what settles.
const SPEND_PLAN = [
	{ id: '2', service: 'forge-draft', settles: true },
	{ id: '2b', service: 'forge-standard', settles: true },
	{ id: '3', service: 'forge-hd', settles: true },
	{ id: '3i', service: 'forge-image', settles: true },
	{ id: '3r', service: 'avatar', settles: true },
	{ id: '5a', service: 'forge-draft', settles: true },
	{ id: '5b', service: 'forge-draft', settles: false },
	{ id: '5c', service: 'forge-draft', settles: false },
	{ id: '6', service: 'forge-image', settles: false },
	{ id: '7', service: 'forge-draft', settles: false, rail: 'solana USDC' },
];
function budget() {
	let spend = 0n;
	let floor = 0n;
	const rows = [];
	// Walk the plan in order, tracking the balance still required behind each
	// signature: a case that does not settle still has to be affordable.
	let remaining = 0n;
	for (let i = SPEND_PLAN.length - 1; i >= 0; i--) {
		const step = SPEND_PLAN[i];
		const entry = catalogEntry(step.service);
		const amount = BigInt(entry.amountAtomics);
		const needHere = step.settles ? amount + remaining : (amount > remaining ? amount : remaining);
		remaining = needHere;
		rows.unshift({ ...step, priceUsd: entry.priceUsd, amountAtomics: entry.amountAtomics, floorAfterHere: needHere.toString() });
		if (step.settles) spend += amount;
	}
	floor = remaining;
	return { rows, settlesAtomics: spend.toString(), settlesUsd: (Number(spend) / 1e6).toFixed(2), floorAtomics: floor.toString(), floorUsd: (Number(floor) / 1e6).toFixed(2) };
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
	const plan = budget();
	if (args.budget) {
		log('Per-case spend plan (X Layer USD₮0 unless noted):\n');
		for (const r of plan.rows) log(`  ${r.id.padEnd(3)} ${r.service.padEnd(16)} $${r.priceUsd.padStart(5)}  ${r.settles ? 'settles' : 'rejected before settlement'}${r.rail ? `  [${r.rail}]` : ''}`);
		log(`\n  one clean run settles $${plan.settlesUsd} and needs a starting float of $${plan.floorUsd}`);
		log(`  buyer ${BUYER}`);
		const held = await buyerFloat();
		log(`  held now: ${(Number(held) / 1e6).toFixed(6)} USD₮0 (${held} atomics)`);
		log(held >= BigInt(plan.floorAtomics) ? '  FUNDED: a full run fits.' : `  SHORT by ${(Number(BigInt(plan.floorAtomics) - held) / 1e6).toFixed(2)} USD₮0.`);
		process.exit(0);
	}

	if (!args.yes && !args.dryRun) {
		console.error('This gauntlet spends real USD₮0 on X Layer against production.');
		console.error(`A full run settles $${plan.settlesUsd} and needs a starting float of $${plan.floorUsd} at ${BUYER}.`);
		console.error('Re-run with --yes to authorize spending, --budget to price it, or --dry-run to exercise the unpaid legs only.');
		process.exit(2);
	}
	log(`OKX.AI end-to-end gauntlet against ${args.base}${args.dryRun ? '  (DRY RUN, no signing)' : ''}\n`);

	// Refuse to start a paid run that cannot finish: a half-funded run burns the
	// cheap cases and then fails the dear ones on balance, which reads like a
	// rail defect and is not one.
	if (!args.dryRun && !args.only) {
		const held = await buyerFloat();
		if (held < BigInt(plan.floorAtomics)) {
			console.error(`Buyer ${BUYER} holds ${(Number(held) / 1e6).toFixed(6)} USD₮0, a full run needs ${plan.floorUsd}.`);
			console.error('Fund the buyer or scope the run with --only. Nothing was signed.');
			process.exit(3);
		}
		log(`buyer float ${(Number(held) / 1e6).toFixed(6)} USD₮0, run needs ${plan.floorUsd}\n`);
	}

	if (wanted('1')) await case1Free();
	if (wanted('2')) await buyForge({ id: '2', serviceId: 'forge-draft', title: 'cheapest paid row delivers a real GLB', toolArgs: { prompt: 'a brass steampunk owl, full body' } });
	if (wanted('2b')) await buyForge({ id: '2b', serviceId: 'forge-standard', title: 'mid paid row delivers a real GLB', toolArgs: { prompt: 'a weathered wooden fishing boat' } });
	if (wanted('3')) await buyForge({ id: '3', serviceId: 'forge-hd', title: 'flagship listed row delivers a real GLB', toolArgs: { prompt: 'an ornate Venetian carnival mask, gold leaf' } });
	if (wanted('3i')) await buyForge({ id: '3i', serviceId: 'forge-image', title: 'image lane rebuilds a GLB from a reference image', toolArgs: { image_urls: [REFERENCE_IMAGE] } });
	if (wanted('3r')) await case3Rigged();
	if (wanted('5a')) await case5aReplay();
	if (wanted('5b')) await case5bCrossService();
	if (wanted('5c')) await case5cExpired();
	if (wanted('5d')) await case5dGarbage();
	if (wanted('6')) await case6PayOnlySuccess();
	if (wanted('7')) await case7LegacyRail();
	// Case 4 runs last: it verifies every settlement the paid cases produced.
	if (wanted('4')) await case4Settlement();

	const ref = evidence('00-gauntlet-summary.json', { base: args.base, dryRun: args.dryRun, ranAt: new Date().toISOString(), results, settlements });
	const passed = results.filter((r) => r.ok).length;
	log('\n' + '-'.repeat(72));
	for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(3)} ${r.title}`);
	log('-'.repeat(72));
	log(`${passed}/${results.length} cases passed. Settlements: ${settlements.length}. Summary: ${ref}`);
	process.exit(passed === results.length ? 0 : 1);
}

await main();
