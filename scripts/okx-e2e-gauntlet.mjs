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
 * This spends real USD₮0 on X Layer. It refuses to run without --yes.
 *
 * Cases (each runs individually, none is "covered by" another):
 *   1   free lane serves live data with no payment demanded
 *   2   cheapest paid service ($0.01 text-to-3d) delivers a real GLB
 *   3   flagship ($0.50 avatar) delivers a GLB with a skeleton and skin weights
 *   4   settlement verified on-chain for every payment (tx, recipient, amount)
 *   5a  replaying an authorization does not buy a second job
 *   5b  an authorization bound to one price cannot buy a dearer service
 *   5c  an expired authorization is rejected and a fresh challenge offered
 *   5d  a garbage payment header gets a clean 4xx and runs no tool
 *   6   a job that fails after payment leaves the authorization unspent
 *   7   a legacy (non-X-Layer) rail still answers its own challenge
 *
 * Usage:
 *   node scripts/okx-e2e-gauntlet.mjs --yes
 *   node scripts/okx-e2e-gauntlet.mjs --yes --only 2,3,4
 *   node scripts/okx-e2e-gauntlet.mjs --dry-run          # no signing, no spend
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { catalogEntry, listedCatalog } from '../api/_lib/okx-catalog.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = resolve(REPO, 'prompts/okx-ai/e2e-evidence');
const CLI = `${process.env.HOME}/.local/bin/onchainos`;

const XLAYER_RPCS = ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com', 'https://rpc.ankr.com/xlayer'];
const USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
// Event/selector hashes: Transfer(address,address,uint256) topic0, and the
// authorizationState(address,bytes32) selector for the EIP-3009 nonce read.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EIP3009_AUTH_STATE = '0xe94a0102';

function parseArgs(argv) {
	const args = { base: 'https://three.ws', yes: false, dryRun: false, only: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--base') args.base = argv[++i].replace(/\/$/, '');
		else if (argv[i] === '--yes') args.yes = true;
		else if (argv[i] === '--dry-run') args.dryRun = true;
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
const wanted = (id) => !args.only || args.only.has(id) || args.only.has(id.replace(/[a-z]$/, ''));

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

// ── HTTP + buyer-side signing ────────────────────────────────────────────────
async function call(entry, body, { paymentHeader, headerName = 'PAYMENT-SIGNATURE' } = {}) {
	const headers = { 'content-type': 'application/json' };
	if (paymentHeader) headers[headerName] = paymentHeader;
	const res = await fetch(entry.endpoint, {
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
const decodeB64Json = (v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

// Sign through the TEE wallet, the exact path an OKX buyer agent takes.
// `mutate` lets a case hand the signer a doctored challenge (case 5c needs a
// one-second validity window) without ever hand-rolling a signature.
function signChallenge(challengeHeader, { mutate } = {}) {
	let payload = challengeHeader;
	if (mutate) {
		const decoded = decodeB64Json(challengeHeader);
		mutate(decoded);
		payload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64');
	}
	const out = execFileSync(CLI, ['payment', 'pay', '--payload', payload, '--selected-index', '0'], {
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

// ── Cases ────────────────────────────────────────────────────────────────────

async function case1Free() {
	const health = await fetch(`${args.base}/api/okx/3d/health`, { signal: AbortSignal.timeout(60_000) });
	const healthBody = await health.json();
	const catalog = await fetch(`${args.base}/api/okx/3d/catalog`, { signal: AbortSignal.timeout(60_000) });
	const catalogBody = await catalog.json();
	const ref = evidence('30-case1-free-lane.json', { health: { status: health.status, body: healthBody }, catalog: { status: catalog.status, body: catalogBody } });

	const healthOk = health.status === 200 && healthBody.ok === true && Array.isArray(healthBody.subsystems) && healthBody.subsystems.length > 0;
	const live = healthBody.subsystems?.every((s) => typeof s.latency_ms === 'number');
	// `services` is the listed line-up; back-burner rows ship under `unlisted`.
	const catalogOk = catalog.status === 200 && catalogBody.services?.length === listedCatalog().length;
	record(
		'1',
		'free lane serves live data, no payment demanded',
		healthOk && live && catalogOk,
		`health ${health.status} (${healthBody.subsystems?.length} subsystems, real latencies), catalog ${catalog.status} (${catalogBody.services?.length} rows)`,
		ref,
	);
}

// The full buy: 402 → sign → replay → artifact → on-chain settlement.
async function buyAndVerify({ id, serviceId, title, body, rigged }) {
	const entry = catalogEntry(serviceId);
	const unpaid = await call(entry, body);
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
	const paid = await call(entry, body, { paymentHeader: signed.header, headerName: signed.headerName });

	const ref = evidence(`31-case${id}-${serviceId}.json`, {
		unpaid: { status: unpaid.status, challenge },
		signed: { wallet: signed.wallet, headerName: signed.headerName, authorization: auth, authorization_header: signed.header },
		paid: { status: paid.status, body: paid.body, receiptHeader: paid.receiptHeader },
	});

	if (paid.status !== 200) {
		return record(id, title, false, `paid replay returned ${paid.status}: ${JSON.stringify(paid.body).slice(0, 300)}`, ref);
	}

	const modelUrl = paid.body?.model_url || paid.body?.glb_url || paid.body?.url || paid.body?.result?.model_url;
	if (!modelUrl) {
		return record(id, title, false, `200 but no model URL in response: ${JSON.stringify(paid.body).slice(0, 300)}`, ref);
	}

	// Artifact truth: parse the bytes, do not trust the 200.
	let artifactOk = false;
	let artifactDetail = '';
	try {
		execFileSync('node', ['scripts/okx-verify-glb.mjs', modelUrl, ...(rigged ? ['--rigged'] : []), '--json', `${EVIDENCE}/32-case${id}-artifact.json`], {
			cwd: REPO,
			encoding: 'utf8',
			stdio: 'pipe',
			timeout: 300_000,
		});
		artifactOk = true;
	} catch (err) {
		artifactDetail = (err.stdout || err.message || '').toString().trim().split('\n').slice(-4).join(' / ');
	}

	const receipt = paid.receiptHeader ? decodeB64Json(paid.receiptHeader) : null;
	if (receipt?.transaction) {
		settlements.push({ case: id, service: serviceId, tx: receipt.transaction, amount: entry.amountAtomics, priceUsd: entry.priceUsd, payTo: accept.payTo, payer: receipt.payer || auth?.from, authorization: auth });
	}

	return record(
		id,
		title,
		artifactOk && Boolean(receipt?.transaction),
		`200, artifact ${artifactOk ? 'verified' : `FAILED (${artifactDetail})`}, tx ${receipt?.transaction || 'MISSING from PAYMENT-RESPONSE'}`,
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
	return record('4', 'settlement verified on-chain (tx, recipient, exact amount)', allOk && verified.length >= 1, `${verified.filter((v) => v.verification.ok).length}/${verified.length} settlements confirmed`, ref);
}

async function case5aReplay() {
	const entry = catalogEntry('text-to-3d');
	const body = { prompt: 'a small brass astrolabe' };
	const unpaid = await call(entry, body);
	if (unpaid.status !== 402) return record('5a', 'replayed authorization buys no second job', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('5a', 'replayed authorization buys no second job', false, 'dry run', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const first = await call(entry, body, { paymentHeader: signed.header, headerName: signed.headerName });
	const second = await call(entry, body, { paymentHeader: signed.header, headerName: signed.headerName });
	// A different body on the same proof must not be honoured either: that is
	// the variant that would buy a second, different job on one payment.
	const third = await call(entry, { prompt: 'a completely different object, a wooden chair' }, { paymentHeader: signed.header, headerName: signed.headerName });

	const firstReceipt = first.receiptHeader ? decodeB64Json(first.receiptHeader) : null;
	if (firstReceipt?.transaction) {
		settlements.push({ case: '5a', service: 'text-to-3d', tx: firstReceipt.transaction, amount: entry.amountAtomics, priceUsd: entry.priceUsd, payTo: decodeB64Json(unpaid.challengeHeader).accepts[0].payTo, payer: firstReceipt.payer || auth?.from, authorization: auth });
	}

	// Idempotent replay (same proof, same body) must return the SAME job, not a
	// new one; the differing-body replay must be refused outright.
	const sameJob =
		second.status === first.status &&
		JSON.stringify(second.body) === JSON.stringify(first.body);
	const differentBodyRefused = third.status >= 400;
	const ref = evidence('50-case5a-replay.json', {
		first: { status: first.status, body: first.body, receipt: firstReceipt },
		secondSameBody: { status: second.status, body: second.body },
		thirdDifferentBody: { status: third.status, body: third.body },
		authorization: auth,
	});
	return record(
		'5a',
		'replayed authorization buys no second job',
		first.status === 200 && sameJob && differentBodyRefused,
		`first 200; same-body replay ${second.status} ${sameJob ? '(identical cached response)' : '(DIFFERENT response, a second job ran)'}; different-body replay ${third.status} ${differentBodyRefused ? '(refused)' : '(ACCEPTED, defect)'}`,
		ref,
	);
}

async function case5bCrossService() {
	const cheap = catalogEntry('text-to-3d');
	const dear = catalogEntry('avatar');
	const unpaid = await call(cheap, { prompt: 'a tin whistle' });
	if (unpaid.status !== 402) return record('5b', 'cheap authorization cannot buy a dearer service', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('5b', 'cheap authorization cannot buy a dearer service', false, 'dry run', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const attempt = await call(dear, { prompt: 'a heroic knight in silver armor, full body' }, { paymentHeader: signed.header, headerName: signed.headerName });
	// The authorization must be untouched: rejected before any redemption.
	const spent = auth ? await authorizationUsed(auth.from, auth.nonce) : null;
	const ref = evidence('51-case5b-cross-service.json', {
		signedFor: { service: cheap.id, amount: cheap.amountAtomics },
		replayedAgainst: { service: dear.id, amount: dear.amountAtomics },
		attempt: { status: attempt.status, body: attempt.body },
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
	const entry = catalogEntry('text-to-3d');
	const unpaid = await call(entry, { prompt: 'a paper lantern' });
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
	const attempt = await call(entry, { prompt: 'a paper lantern' }, { paymentHeader: signed.header, headerName: signed.headerName });
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
	const entry = catalogEntry('text-to-3d');
	const body = { prompt: 'a small ceramic teapot' };
	const cases = {
		notBase64: 'not-a-real-payment-header',
		wrongShape: Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64'),
		emptyString: '   ',
		truncatedJson: Buffer.from('{"x402Version":2,"payload":{', 'utf8').toString('base64'),
	};
	const out = {};
	let ok = true;
	for (const [name, header] of Object.entries(cases)) {
		const r = await call(entry, body, { paymentHeader: header, headerName: 'x-payment' });
		out[name] = { status: r.status, body: r.body };
		// Safe failure: a 4xx, and nothing that looks like a delivered artifact.
		const clean = r.status >= 400 && r.status < 500 && !JSON.stringify(r.body).includes('model_url');
		if (!clean) ok = false;
		log(`      ${clean ? 'ok  ' : 'FAIL'} ${name}: ${r.status} ${r.body?.error || r.body?.error_description || ''}`.slice(0, 160));
	}
	const ref = evidence('53-case5d-garbage.json', out);
	return record('5d', 'garbage payment header gets a clean 4xx, runs no tool', ok, Object.entries(out).map(([k, v]) => `${k}=${v.status}`).join(', '), ref);
}

async function case6PayOnlySuccess() {
	// A job that passes payment verification and then fails in the engine: a
	// well-formed request pointing at a model URL that does not exist. If the
	// promise holds, the authorization is still unspent on-chain afterwards.
	const entry = catalogEntry('fbx-export');
	const body = { model_url: `${args.base}/models/definitely-not-a-real-model-${Date.now()}.glb` };
	const unpaid = await call(entry, body);
	if (unpaid.status !== 402) return record('6', 'failed job leaves the authorization unspent', false, `setup failed, expected 402 got ${unpaid.status}`, null);
	if (args.dryRun) return record('6', 'failed job leaves the authorization unspent', false, 'dry run', null);

	const signed = signChallenge(unpaid.challengeHeader);
	const auth = authFromHeader(signed.header);
	const before = await authorizationUsed(auth.from, auth.nonce);
	const attempt = await call(entry, body, { paymentHeader: signed.header, headerName: signed.headerName });
	const after = await authorizationUsed(auth.from, auth.nonce);
	const ref = evidence('60-case6-pay-only-on-success.json', {
		request: body,
		authorization: auth,
		authorizationSpentBefore: before,
		attempt: { status: attempt.status, body: attempt.body, receiptHeader: attempt.receiptHeader },
		authorizationSpentAfter: after,
	});
	const failed = attempt.status >= 400;
	const notCharged = after === false && !attempt.receiptHeader;
	return record(
		'6',
		'failed job leaves the authorization unspent (pay-only-on-success)',
		failed && notCharged,
		`job ${attempt.status} (${attempt.body?.error || ''}), nonce redeemed on-chain: ${after}, settlement receipt emitted: ${Boolean(attempt.receiptHeader)}`,
		ref,
	);
}

async function case7LegacyRail() {
	// The pre-OKX rails must still answer their own challenge: adding X Layer
	// must not have broken the Solana/Base path the platform already sells on.
	const entry = catalogEntry('text-to-3d');
	const unpaid = await call(entry, { prompt: 'a copper kettle' });
	if (unpaid.status !== 402 || !unpaid.challengeHeader) {
		return record('7', 'legacy rails still offered alongside X Layer', false, `expected 402, got ${unpaid.status}`, null);
	}
	const challenge = decodeB64Json(unpaid.challengeHeader);
	const solana = challenge.accepts.find((a) => a.network?.startsWith('solana:'));
	const base = challenge.accepts.find((a) => a.network === 'eip155:8453');
	const ref = evidence('70-case7-legacy-rails.json', challenge);
	const amountsMatch = [solana, base].every((a) => a && a.amount === entry.amountAtomics);
	return record(
		'7',
		'legacy rails still offered alongside X Layer, same price',
		Boolean(solana && base) && amountsMatch,
		`accepts: ${challenge.accepts.map((a) => a.network).join(', ')}; solana ${solana?.amount}, base ${base?.amount}, want ${entry.amountAtomics}`,
		ref,
	);
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
	if (!args.yes && !args.dryRun) {
		console.error('This gauntlet spends real USD₮0 on X Layer against production.');
		console.error('Re-run with --yes to authorize spending, or --dry-run to exercise the unpaid legs only.');
		process.exit(2);
	}
	log(`OKX.AI end-to-end gauntlet against ${args.base}${args.dryRun ? '  (DRY RUN, no signing)' : ''}\n`);

	if (wanted('1')) await case1Free();
	if (wanted('2')) await buyAndVerify({ id: '2', serviceId: 'text-to-3d', title: 'cheapest paid service delivers a real GLB', body: { prompt: 'a brass steampunk owl, full body' }, rigged: false });
	if (wanted('3')) await buyAndVerify({ id: '3', serviceId: 'avatar', title: 'flagship delivers a rigged GLB (skeleton + skin weights)', body: { prompt: 'a heroic knight in silver armor, full body' }, rigged: true });
	if (wanted('5a')) await case5aReplay();
	if (wanted('5b')) await case5bCrossService();
	if (wanted('5c')) await case5cExpired();
	if (wanted('5d')) await case5dGarbage();
	if (wanted('6')) await case6PayOnlySuccess();
	if (wanted('7')) await case7LegacyRail();
	// Case 4 runs last: it verifies every settlement the paid cases produced.
	if (wanted('4')) await case4Settlement();

	const ref = evidence('00-gauntlet-summary.json', { base: args.base, dryRun: args.dryRun, results, settlements });
	const passed = results.filter((r) => r.ok).length;
	log('\n' + '-'.repeat(72));
	for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(3)} ${r.title}`);
	log('-'.repeat(72));
	log(`${passed}/${results.length} cases passed. Settlements: ${settlements.length}. Summary: ${ref}`);
	process.exit(passed === results.length ? 0 : 1);
}

await main();
