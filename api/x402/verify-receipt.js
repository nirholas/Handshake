// POST/GET /api/x402/verify-receipt
//
// x402 receipt verifier — FREE, keyless. Two independent checks; supply either
// or both, and the response says exactly what was and wasn't verifiable.
//
//   1. Attestation integrity — pass a three.ws paid-response object that carries
//      a "sha256:…" attestation (fact-check style). We recompute the digest over
//      the fields the scheme commits to and confirm or deny that the object is
//      unaltered. No trust in the caller: if a committed field was changed after
//      signing, the recomputed digest won't match.
//   2. Settlement confirmation — pass { tx: { hash, network } } and we do a
//      read-only on-chain lookup to confirm the settlement transaction exists and
//      is confirmed on that chain. RPC unavailable → reported as "unverifiable",
//      never a false "confirmed".
//
// Body: { result?: object, tx?: { hash: string, network: string } }
//   result.attestation — the "sha256:…" string; result must also carry the
//                        attested fields (verdict, confidence, claim, sources).
//   tx.network         — CAIP-2 ("solana:…", "eip155:8453") or shorthand
//                        ("solana", "base").
//
// GET carries no body, so check 2 also reads ?hash=&network= from the query
// string: GET /api/x402/verify-receipt?hash=<sig>&network=solana. Check 1 needs
// the whole attested object and stays POST-only. On POST the body wins whenever
// it supplies `tx`.

import { wrap, cors, method, json, error, readJson, rateLimited, setRateLimitHeaders } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { verifyAttestation } from '../_lib/x402/dev-tools.js';

const ROUTE = '/api/x402/verify-receipt';

// Map a network string (CAIP-2 or shorthand) to a chain family + EVM chainId.
function resolveNetwork(network) {
	const n = String(network || '').toLowerCase().trim();
	if (!n) return { family: null };
	if (n.startsWith('solana') || n === 'sol') return { family: 'solana' };
	const caip = n.match(/^eip155:(\d+)$/);
	if (caip) return { family: 'evm', chainId: Number(caip[1]) };
	const alias = { base: 8453, arbitrum: 42161, bsc: 56, xlayer: 196, ethereum: 1 }[n];
	if (alias) return { family: 'evm', chainId: alias };
	return { family: null };
}

// Read-only confirmation that a settlement tx landed on-chain. Never throws —
// returns { verified, status, detail } with verified:false + a reason when the
// chain can't be read (so an outage never reads as "confirmed").
async function confirmSettlementTx(hash, network) {
	const { family, chainId } = resolveNetwork(network);
	if (!family) {
		return { verified: false, status: 'unsupported_network', detail: `network "${network}" is not one we can look up (use solana / eip155:<id>)` };
	}
	if (typeof hash !== 'string' || !hash.trim()) {
		return { verified: false, status: 'invalid_hash', detail: 'tx.hash is required' };
	}

	try {
		if (family === 'solana') {
			const { solanaConnection } = await import('../_lib/solana/connection.js');
			const conn = solanaConnection({ commitment: 'confirmed' });
			const statuses = await conn.getSignatureStatuses([hash.trim()], { searchTransactionHistory: true });
			const st = statuses?.value?.[0];
			if (!st) return { verified: false, status: 'not_found', detail: 'signature not found on Solana mainnet' };
			if (st.err) return { verified: false, status: 'failed', detail: 'transaction failed on-chain', slot: st.slot ?? null };
			const confirmed = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
			return { verified: confirmed, status: st.confirmationStatus || 'processed', detail: confirmed ? 'settlement confirmed on Solana' : 'seen but not yet confirmed', slot: st.slot ?? null };
		}
		// EVM
		const { evmFallbackProvider } = await import('../_lib/evm/rpc.js');
		const provider = await evmFallbackProvider(chainId);
		const receipt = await provider.getTransactionReceipt(hash.trim());
		if (!receipt) return { verified: false, status: 'not_found', detail: `transaction not found on chain ${chainId} (pending or wrong network?)` };
		const ok = Number(receipt.status) === 1;
		return { verified: ok, status: ok ? 'confirmed' : 'reverted', detail: ok ? `settlement confirmed on chain ${chainId}` : 'transaction reverted on-chain', block: receipt.blockNumber ?? null };
	} catch (err) {
		return { verified: false, status: 'rpc_unavailable', detail: `could not reach the chain RPC to confirm: ${err?.message || 'unknown error'}` };
	}
}

// Settlement inputs from the query string, so a plain GET (no body) can still
// run check 2. Returns undefined when neither param is present, which keeps the
// "nothing to verify" branch below intact for a bare GET.
function txFromQuery(req) {
	const q = req.query || {};
	const hash = typeof q.hash === 'string' ? q.hash.trim() : '';
	const network = typeof q.network === 'string' ? q.network.trim() : '';
	if (!hash && !network) return undefined;
	return { hash, network };
}

async function handle(req, res) {
	const ip = clientIp(req);
	const rl = await limits.x402DevToolIp(ip);
	if (!rl.success) return rateLimited(res, rl);
	setRateLimitHeaders(res, rl);

	let body = {};
	if (req.method === 'POST') {
		try {
			body = (await readJson(req)) || {};
		} catch (err) {
			// readJson rejects a non-JSON content-type with status 415; keep that
			// distinction instead of flattening every body problem into a 400.
			const status = err.status || 400;
			const code = status === 415 ? 'unsupported_media_type' : 'invalid_json';
			return error(res, status, code, err.message || 'request body must be valid JSON');
		}
	}

	const result = body.result;
	const tx = body.tx !== undefined ? body.tx : txFromQuery(req);
	if (result === undefined && tx === undefined) {
		return error(res, 400, 'nothing_to_verify', 'POST `result` (an attested paid response) and/or `tx` ({ hash, network }); or GET ?hash=<tx>&network=<chain> to confirm a settlement only', {
			example: { result: { verdict: 'true', confidence: 0.9, claim: '…', sources: ['https://…'], attestation: 'sha256:…' }, tx: { hash: '…', network: 'solana' } },
			getExample: `${ROUTE}?hash=<settlement-signature-or-hash>&network=solana`,
		});
	}

	const out = { ok: true, ts: new Date().toISOString() };

	if (result !== undefined) {
		if (!result || typeof result !== 'object') {
			out.attestation = { verified: false, mismatchReason: 'result must be a JSON object carrying the attested fields' };
		} else {
			out.attestation = verifyAttestation(result);
		}
	}

	if (tx !== undefined) {
		if (!tx || typeof tx !== 'object') {
			out.settlement = { verified: false, status: 'invalid_tx', detail: 'tx must be an object { hash, network }' };
		} else {
			out.settlement = await confirmSettlementTx(tx.hash, tx.network);
		}
	}

	// Top-level ok reflects that we RAN the checks, not that they passed — each
	// sub-result carries its own verified flag so a caller reads outcomes precisely.
	return json(res, 200, out, { 'cache-control': 'no-store' });
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;
	return handle(req, res);
});
