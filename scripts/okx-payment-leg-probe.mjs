#!/usr/bin/env node
/**
 * Replay a real, TEE-signed x402 authorization against the four paid OKX.AI
 * forge rows and prove the payment leg accepts it.
 *
 * This is the half of the listing review that the compliance probe cannot see.
 * `okx-compliance-probe.mjs` proves the 402 quotation is well formed; this one
 * proves what happens after a buyer signs it. OKX's 2026-08-27 listing QA got
 * that far and was refused: every OKX agentic wallet is an EIP-7702 delegated
 * EOA, our verifier asked viem's `verifyTypedData`, viem took its ERC-1271
 * branch, and a perfectly good authorization was answered with a second 402.
 *
 * The buyer here is our own agentic wallet, which holds no USD₮0, so the run
 * settles nothing. That is the point: with an empty payer, the ONLY refusal a
 * correct rail may answer is `insufficient_balance`, which is thrown after the
 * signature, recipient, amount, validity window and nonce have all passed. Any
 * other refusal is the defect coming back. If the buyer is ever funded, a pass
 * becomes an actual settlement, so the run refuses to sign without
 * `--allow-spend`.
 *
 * Usage:
 *   node scripts/okx-payment-leg-probe.mjs [--base https://three.ws] [--out <file>]
 *   node scripts/okx-payment-leg-probe.mjs --rows forge-draft
 *   node scripts/okx-payment-leg-probe.mjs --allow-spend   # buyer is funded: this BUYS
 *
 * Requires a live `onchainos` wallet session (`onchainos wallet status`).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { catalogEntry, FORGE_TOOL } from '../api/_lib/okx-catalog.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const BASE = (flag('--base', 'https://three.ws') || '').replace(/\/+$/, '');
const OUT = flag('--out', '');
const ALLOW_SPEND = has('--allow-spend');
const ROWS = (flag('--rows', 'forge-draft,forge-standard,forge-hd,forge-image') || '').split(',').map((s) => s.trim()).filter(Boolean);

const CLI = `${process.env.HOME}/.local/bin/onchainos`;
const XLAYER_RPCS = ['https://rpc.xlayer.tech', 'https://xlayerrpc.okx.com'];
const USDT0 = '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const XLAYER = 'eip155:196';
const EIP3009_AUTH_STATE = '0xe94a0102';
const ERC20_BALANCE_OF = '0x70a08231';
const pad32 = (v) => String(v).toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** The refusal a correct rail owes an empty payer, and nothing else. */
const EMPTY_PAYER_ERROR = 'insufficient_balance';

async function rpc(method, params) {
	let lastErr;
	for (const url of XLAYER_RPCS) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
				signal: AbortSignal.timeout(30_000),
			});
			const body = await res.json();
			if (body.error) throw new Error(body.error.message || 'rpc error');
			return body.result;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

const cli = (argv, timeout = 200_000) =>
	JSON.parse(execFileSync(CLI, argv, { encoding: 'utf8', maxBuffer: 1 << 24, timeout }));

const decodeB64Json = (v) => JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

/** The buyer's own EVM address, read from the wallet rather than assumed. */
function buyerAddress() {
	const out = cli(['wallet', 'addresses'], 90_000);
	const evm = (out.data ?? out).evm;
	const entry = Array.isArray(evm) ? evm.find((e) => e.address) : null;
	if (!entry) throw new Error('wallet addresses returned no EVM address; is the session live?');
	return entry.address;
}

async function buyerFloat(address) {
	const out = await rpc('eth_call', [{ to: USDT0, data: ERC20_BALANCE_OF + pad32(address) }, 'latest']);
	return BigInt(out);
}

async function nonceRedeemed(from, nonce) {
	const out = await rpc('eth_call', [{ to: USDT0, data: EIP3009_AUTH_STATE + pad32(from) + pad32(nonce) }, 'latest']);
	return BigInt(out) !== 0n;
}

function pricedCall(prompt) {
	return {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: FORGE_TOOL, arguments: { prompt } },
	};
}

const MCP_HEADERS = {
	'content-type': 'application/json',
	accept: 'application/json, text/event-stream',
	'mcp-protocol-version': '2025-06-18',
};

async function callRow(endpoint, body, paymentHeader) {
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { ...MCP_HEADERS, ...(paymentHeader ? { 'PAYMENT-SIGNATURE': paymentHeader } : {}) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(180_000),
	});
	const text = await res.text();
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		/* a non-JSON body is reported raw */
	}
	return {
		status: res.status,
		challengeHeader: res.headers.get('payment-required'),
		receiptHeader: res.headers.get('payment-response') || res.headers.get('x-payment-response'),
		body: parsed,
		text,
	};
}

const failures = [];
const results = [];

const buyer = buyerAddress();
const float = await buyerFloat(buyer);

for (const id of ROWS) {
	const entry = catalogEntry(id);
	if (!entry) {
		failures.push(`${id}: not in the catalog`);
		continue;
	}
	const endpoint = entry.endpoint.replace(/^https?:\/\/[^/]+/, BASE);
	const listPrice = BigInt(entry.amountAtomics);
	const row = { service: id, endpoint, list_price_atomics: entry.amountAtomics, buyer, buyer_usdt0_atomics: float.toString() };

	const unpaid = await callRow(endpoint, pricedCall(`a probe subject for ${id}`));
	row.challenge = { status: unpaid.status, has_header: Boolean(unpaid.challengeHeader) };
	if (unpaid.status !== 402 || !unpaid.challengeHeader) {
		failures.push(`${id}: priced call answered ${unpaid.status} with${unpaid.challengeHeader ? '' : 'out'} a PAYMENT-REQUIRED header, expected a 402 quotation`);
		results.push(row);
		continue;
	}

	const challenge = decodeB64Json(unpaid.challengeHeader);
	const index = (challenge.accepts || []).findIndex((a) => a.network === XLAYER);
	if (index === -1) {
		failures.push(`${id}: the quotation carries no ${XLAYER} rail, so an OKX buyer has nothing to sign`);
		results.push(row);
		continue;
	}
	const accept = challenge.accepts[index];
	row.xlayer_accept = { index, amount: accept.amount, payTo: accept.payTo, asset: accept.asset };
	if (BigInt(accept.amount) !== listPrice) {
		failures.push(`${id}: X Layer rail quotes ${accept.amount}, the listing registers ${entry.amountAtomics}`);
	}

	if (float >= BigInt(accept.amount) && !ALLOW_SPEND) {
		failures.push(`${id}: buyer ${buyer} holds ${float} USD₮0 atomics, at or above the ${accept.amount} quote, so replaying would really buy. Re-run with --allow-spend to authorize the purchase.`);
		results.push(row);
		continue;
	}

	const signed = cli(['payment', 'pay', '--payload', unpaid.challengeHeader, '--selected-index', String(index)]);
	const header = (signed.data ?? signed).authorization_header;
	if (!header) {
		failures.push(`${id}: the wallet returned no authorization_header to replay`);
		results.push(row);
		continue;
	}
	const authorization = decodeB64Json(header).payload?.authorization ?? null;
	row.authorization = authorization;

	const paid = await callRow(endpoint, pricedCall(`a probe subject for ${id}`), header);
	const error = paid.body?.error ?? (paid.challengeHeader ? decodeB64Json(paid.challengeHeader).error : null);
	row.replay = { status: paid.status, error: typeof error === 'string' ? error : JSON.stringify(error ?? null) };

	if (paid.status === 200) {
		row.verdict = 'settled';
		if (!ALLOW_SPEND) failures.push(`${id}: the replay settled from a wallet that read empty, which should be impossible`);
	} else if (paid.status === 402 && row.replay.error === EMPTY_PAYER_ERROR) {
		// Everything above the balance check passed: signature, recipient,
		// amount, validity window and an unredeemed nonce. A funded buyer, such
		// as the OKX audit wallet, settles from here.
		row.verdict = 'authorization accepted, stopped only at the empty payer';
	} else {
		row.verdict = 'refused';
		failures.push(`${id}: replay answered ${paid.status} "${row.replay.error}", expected ${EMPTY_PAYER_ERROR} from an empty payer`);
	}

	if (authorization?.from && authorization?.nonce) {
		const redeemed = await nonceRedeemed(authorization.from, authorization.nonce);
		row.nonce_redeemed_on_chain = redeemed;
		if (redeemed && !ALLOW_SPEND) failures.push(`${id}: the authorization nonce was redeemed on-chain, so money moved`);
	}

	results.push(row);
}

const report = {
	captured_at: new Date().toISOString(),
	base: BASE,
	what: 'Live replay of a TEE-signed EIP-3009 authorization against every paid OKX.AI forge row, proving the payment leg accepts an EIP-7702 delegated payer and refuses only for the empty test wallet.',
	buyer,
	buyer_usdt0_atomics: float.toString(),
	pass: failures.length === 0,
	failures,
	rows: results,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (OUT) {
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, serialized);
	console.log(`wrote ${OUT}`);
} else {
	process.stdout.write(serialized);
}

for (const f of failures) console.error(`FAIL ${f}`);
console.log(failures.length === 0 ? `PASS ${results.length} paid rows accepted a signed authorization against ${BASE}` : `${failures.length} failing check(s)`);
process.exit(failures.length === 0 ? 0 : 1);
