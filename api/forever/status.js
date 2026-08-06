// GET /api/forever/status?id=<orderId>
//
// Returns the live status of an OrdinalsBot inscription order. Once paid +
// inscribed, the response includes the inscription ID, the reveal txid, and
// public viewer URLs (mempool.space, ordinals.com). When a reveal txid is
// known, the response also carries real Bitcoin chain confirmation for it,
// read keyless from Blockstream Esplora (api/_lib/esplora.js) so the user
// sees actual finality depth, not just OrdinalsBot's order state. That
// lookup fails soft: an Esplora outage degrades `inscription.onchain` to
// null and never breaks the status response.
//
// Response 200:
//   { orderId, state, paid, inscribed, charge?, inscription?, links }
//
//   inscription.onchain (when the reveal tx is known and reachable):
//     { confirmed, confirmations, blockHeight, blockTime, source: "esplora" }
//
//   state ∈ "waiting-payment" | "payment-received" | "inscribing" |
//           "inscribed" | "failed"

import { cors, error, json } from '../_lib/http.js';
import { getTransactionStatus, getTipHeight, isPlausibleTxid } from '../_lib/esplora.js';

const ORDINALSBOT_BASE_URL =
	process.env.ORDINALSBOT_BASE_URL || 'https://api.ordinalsbot.com';

function deriveState(order) {
	const raw = String(order.status || order.state || '').toLowerCase();
	if (['completed', 'inscribed', 'sent', 'delivered'].includes(raw)) return 'inscribed';
	if (['failed', 'cancelled', 'canceled', 'expired', 'refunded'].includes(raw)) return 'failed';
	if (['inscribing', 'broadcasted', 'broadcasting', 'mining', 'paid'].includes(raw))
		return 'inscribing';
	if (['payment-received', 'underpaid', 'overpaid', 'processing'].includes(raw))
		return 'payment-received';
	if (order.tx && (order.tx.reveal || order.tx.commit)) return 'inscribing';
	if (order.inscription || order.inscriptionId || order.reveal) return 'inscribed';
	if (order.paid === true) return 'inscribing';
	return 'waiting-payment';
}

function pickInscriptionId(order) {
	return (
		order.inscriptionId ||
		order.inscription_id ||
		(order.inscription && (order.inscription.id || order.inscription.inscriptionId)) ||
		(order.files && order.files[0] && (order.files[0].inscriptionId || order.files[0].inscription_id)) ||
		null
	);
}

function pickRevealTxid(order) {
	if (order.tx && order.tx.reveal) return order.tx.reveal;
	if (order.revealTxId) return order.revealTxId;
	if (order.reveal && typeof order.reveal === 'string') return order.reveal;
	const id = pickInscriptionId(order);
	if (id && typeof id === 'string') {
		// Inscription IDs are formatted "<txid>i<index>".
		const match = id.match(/^([0-9a-f]{64})i\d+$/i);
		if (match) return match[1];
	}
	return null;
}

function pickCommitTxid(order) {
	if (order.tx && order.tx.commit) return order.tx.commit;
	if (order.commitTxId) return order.commitTxId;
	return null;
}

function buildLinks({ inscriptionId, revealTxid, commitTxid, chargeAddress }) {
	const links = {};
	if (inscriptionId) {
		links.inscription = `https://ordinals.com/inscription/${inscriptionId}`;
		links.inscriptionPreview = `https://ordinals.com/preview/${inscriptionId}`;
	}
	if (revealTxid) {
		links.revealTx = `https://mempool.space/tx/${revealTxid}`;
	}
	if (commitTxid) {
		links.commitTx = `https://mempool.space/tx/${commitTxid}`;
	}
	if (chargeAddress) {
		links.chargeAddress = `https://mempool.space/address/${chargeAddress}`;
	}
	return links;
}

/**
 * Real chain confirmation for the reveal tx via Blockstream Esplora. Fails
 * soft on purpose: a 404 just means the tx has not been broadcast or indexed
 * yet (the OrdinalsBot state already covers that phase), and any other
 * upstream fault must never take the whole status endpoint down.
 */
async function fetchOnchainStatus(txid) {
	if (!isPlausibleTxid(txid)) return null;
	try {
		const [status, tip] = await Promise.all([getTransactionStatus(txid), getTipHeight()]);
		const confirmations =
			status.confirmed && Number.isFinite(status.blockHeight) && Number.isFinite(tip)
				? Math.max(1, tip - status.blockHeight + 1)
				: 0;
		return {
			confirmed: status.confirmed,
			confirmations,
			blockHeight: status.blockHeight,
			blockTime: status.blockTime,
			source: 'esplora',
		};
	} catch (e) {
		if (e?.status !== 404) {
			console.warn(`[forever/status] esplora lookup for ${txid} failed: ${e?.message || e}`);
		}
		return null;
	}
}

async function fetchOrdinalsBotOrder(orderId) {
	const headers = {};
	if (process.env.ORDINALSBOT_API_KEY) {
		headers['x-api-key'] = process.env.ORDINALSBOT_API_KEY;
	}
	const url = `${ORDINALSBOT_BASE_URL}/order?id=${encodeURIComponent(orderId)}`;
	const res = await fetch(url, { headers });
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		const err = new Error(`OrdinalsBot returned non-JSON (${res.status})`);
		err.status = 502;
		throw err;
	}
	if (!res.ok || data.status === 'error') {
		const err = new Error(data.message || data.error || `OrdinalsBot returned ${res.status}`);
		err.status = res.status === 404 ? 404 : 502;
		throw err;
	}
	return data;
}

export default async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const url = new URL(req.url, 'http://localhost');
	const orderId = url.searchParams.get('id');
	if (!orderId) return error(res, 400, 'missing_id', 'query param "id" is required');

	let order;
	try {
		order = await fetchOrdinalsBotOrder(orderId);
	} catch (e) {
		return error(res, e.status || 502, 'status_lookup_failed', e.message);
	}

	const state = deriveState(order);
	const inscriptionId = pickInscriptionId(order);
	const revealTxid = pickRevealTxid(order);
	const commitTxid = pickCommitTxid(order);
	const charge = order.charge || {};
	const chargeAddress = charge.address || order.payAddress || null;
	// Only worth a lookup when the inscription block below will render it.
	const onchain = inscriptionId && revealTxid ? await fetchOnchainStatus(revealTxid) : null;

	return json(res, 200, {
		orderId,
		state,
		paid: state !== 'waiting-payment',
		inscribed: state === 'inscribed',
		charge: chargeAddress
			? {
					address: chargeAddress,
					amount: Number(charge.amount ?? 0),
					amountBtc: Number(charge.amount ?? 0) / 1e8,
					paidAmount: Number(charge.paid_amount ?? charge.amount_received ?? 0),
				}
			: null,
		inscription: inscriptionId
			? {
					id: inscriptionId,
					revealTxid,
					commitTxid,
					onchain,
				}
			: null,
		links: buildLinks({ inscriptionId, revealTxid, commitTxid, chargeAddress }),
	});
}
