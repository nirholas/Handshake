// @ts-check
// The `partner-cn` fulfillment adapter: a contracted high-precision print
// partner, wired behind credentials.
//
// STATUS: the partner is UNCONTRACTED (00-CONTEXT, origin 2026-08-13). This
// module is fully structured and fully tested on every path that can run
// without credentials, and it registers itself ONLY when both env vars are
// present, exactly how the forge treats a BYOK lane. On a deployment without
// them the adapter does not appear in the registry at all, so no surface can
// route an order into a lane that cannot answer.
//
//   PRINT_PARTNER_CN_URL   https base of the partner API, no trailing slash
//   PRINT_PARTNER_CN_KEY   bearer credential, also the webhook HMAC secret
//
// ── THE REQUEST SHAPE THIS ASSUMES ───────────────────────────────────────────
//
// Nothing below is a fabricated endpoint: it is the contract to reconcile
// against the partner's real API documentation the day it arrives. It is
// written in the store's own vocabulary so that reconciliation is a rename of
// wire fields, never a redesign of the state machine.
//
//   POST {URL}/orders
//     headers: authorization: Bearer {KEY}, content-type: application/json
//     body: {
//       reference:   our order id (their idempotency key)
//       material:    catalog material id
//       quantity:    integer
//       height_mm:   target height, null when the mesh's own scale governs
//       files:       { stl, "3mf", glb } absolute URLs, fetchable for 7 days
//       shipping:    { name, line1, line2, city, region, postal_code, country, phone }
//     }
//     → 200 { id, state, lead_time_days }
//
//   GET {URL}/orders/{id}
//     → 200 { id, state, tracking_number, carrier, note }
//
//   POST {URL}/orders/{id}/cancel  body { reason }
//     → 200 { ok, state }
//
//   WEBHOOK  POST /api/print/webhook/partner-cn
//     headers: x-print-signature: sha256={hex hmac of the raw body, key=KEY}
//              x-print-delivery: their delivery id (optional; we derive one
//              from the payload hash when absent, so a retry is still one row)
//     body: { id, state, tracking_number, carrier, note }
//
// STATE VOCABULARY: theirs maps onto ours through PARTNER_STATE_MAP below. An
// unrecognized state maps to null, which the caller reads as "no news". That is
// deliberate: guessing a transition from a string a partner added in a release
// we have not read is exactly how a state machine gets corrupted.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AdapterUpstreamError, derivedDeliveryId, mapProviderStatus } from './contract.js';
import { fetchUpstream } from '../../upstream-fetch.js';

export const key = 'partner-cn';
export const label = 'Partner fulfillment (CN, high precision)';

export const capabilities = Object.freeze({
	// Named from the catalog's own ids. Deliberately a list, not '*': a partner
	// runs the machines they run, and an order for anything else must route to
	// another lane rather than fail after it was taken.
	materials: ['resin-standard', 'resin-tough', 'sls-nylon', 'sandstone-color'],
	maxBboxMm: { x: 400, y: 400, z: 500 },
	shipsFrom: 'CN',
	leadTimeDays: 14,
});

const REQUEST_TIMEOUT_MS = 20_000;

function config() {
	const base = (process.env.PRINT_PARTNER_CN_URL || '').replace(/\/+$/, '');
	const apiKey = process.env.PRINT_PARTNER_CN_KEY || '';
	if (!base || !apiKey) return null;
	return { base, apiKey };
}

/** Registered only when both credentials exist. */
export function configured() {
	return config() !== null;
}

/** Their state vocabulary → ours. The only place the two systems meet. */
export const PARTNER_STATE_MAP = Object.freeze({
	accepted: 'submitted',
	queued: 'submitted',
	in_production: 'printing',
	printing: 'printing',
	post_processing: 'quality_check',
	inspection: 'quality_check',
	quality_check: 'quality_check',
	shipped: 'shipped',
	in_transit: 'shipped',
	delivered: 'delivered',
	canceled: 'canceled',
	cancelled: 'canceled',
	rejected: 'rejected',
	failed: 'rejected',
});

/**
 * Map one of their states. Exported because it is the piece most likely to need
 * a line added when their real docs land, and it is unit-tested without
 * credentials.
 * @param {unknown} partnerState
 */
export function mapState(partnerState) {
	return mapProviderStatus(PARTNER_STATE_MAP, partnerState);
}

/**
 * @param {string} path
 * @param {RequestInit & { timeoutMs?: number }} [init]
 */
async function call(path, init = {}) {
	const cfg = config();
	if (!cfg) throw new AdapterUpstreamError(key, 'partner credentials are not configured');
	const res = await fetchUpstream(
		`${cfg.base}${path}`,
		{
			...init,
			headers: {
				authorization: `Bearer ${cfg.apiKey}`,
				'content-type': 'application/json',
				...(init.headers || {}),
			},
		},
		{ name: `print:${key}`, timeoutMs: REQUEST_TIMEOUT_MS, attempts: 2 },
	).catch((err) => {
		throw new AdapterUpstreamError(key, err?.message || String(err));
	});
	const body = await res.text().catch(() => '');
	if (!res.ok) throw new AdapterUpstreamError(key, `${path} returned ${res.status}: ${body.slice(0, 300)}`, res.status);
	try {
		return body ? JSON.parse(body) : {};
	} catch {
		throw new AdapterUpstreamError(key, `${path} returned non-JSON: ${body.slice(0, 200)}`, res.status);
	}
}

/**
 * @param {object} order
 * @param {{ stl?: string, '3mf'?: string, glb?: string }} [assets]
 */
export async function submit(order, assets = {}) {
	const payload = {
		reference: order?.id,
		material: order?.material_id,
		quantity: Number(order?.quantity) || 1,
		height_mm: order?.target_height_mm != null ? Number(order.target_height_mm) : null,
		files: { stl: assets?.stl || null, '3mf': assets?.['3mf'] || null, glb: assets?.glb || order?.source_glb_url || null },
		shipping: order?.shipping || null,
	};
	const body = await call('/orders', { method: 'POST', body: JSON.stringify(payload) });
	const providerOrderId = String(body?.id || '').trim();
	if (!providerOrderId) throw new AdapterUpstreamError(key, 'partner accepted the order without returning an id');
	return {
		providerOrderId,
		status: mapState(body?.state) || 'submitted',
		leadTimeDays: Number.isInteger(body?.lead_time_days) ? body.lead_time_days : capabilities.leadTimeDays,
		note: `Accepted by ${label}.`,
		state: body,
	};
}

/** @param {string} providerOrderId */
export async function status(providerOrderId) {
	const body = await call(`/orders/${encodeURIComponent(providerOrderId)}`);
	return {
		status: mapState(body?.state),
		trackingNumber: body?.tracking_number || '',
		carrier: body?.carrier || '',
		note: typeof body?.note === 'string' ? body.note : '',
		state: body,
	};
}

/**
 * @param {object} order
 * @param {string} [reason]
 */
export async function cancel(order, reason = '') {
	const body = await call(`/orders/${encodeURIComponent(order?.provider_order_id || '')}/cancel`, {
		method: 'POST',
		body: JSON.stringify({ reason: reason || 'canceled by three.ws' }),
	});
	return { ok: body?.ok !== false, note: 'Cancellation sent to the partner.', state: body };
}

/**
 * HMAC-SHA256 over the exact bytes received. Signature comparison is constant
 * time and length-guarded, because timingSafeEqual throws on a length mismatch
 * and an attacker controls the header.
 *
 * @param {string} rawBody
 * @param {Record<string, string|undefined>} headers
 * @returns {{ ok: boolean, deliveryId: string, reason: string }}
 */
export function verifyWebhook(rawBody, headers = {}) {
	const cfg = config();
	if (!cfg) return { ok: false, deliveryId: '', reason: 'partner credentials are not configured' };
	const presented = String(headers['x-print-signature'] || '').trim().replace(/^sha256=/i, '');
	if (!presented) return { ok: false, deliveryId: '', reason: 'missing x-print-signature' };
	const expected = createHmac('sha256', cfg.apiKey).update(rawBody, 'utf8').digest('hex');
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { ok: false, deliveryId: '', reason: 'signature mismatch' };
	}
	const supplied = String(headers['x-print-delivery'] || '').trim().slice(0, 200);
	return { ok: true, deliveryId: supplied || derivedDeliveryId(key, rawBody), reason: '' };
}

/** @param {any} payload */
export function parseWebhook(payload) {
	return {
		providerOrderId: String(payload?.id || '').trim(),
		status: mapState(payload?.state),
		trackingNumber: payload?.tracking_number || '',
		carrier: payload?.carrier || '',
		note: typeof payload?.note === 'string' ? payload.note : `Partner reported '${payload?.state}'.`,
		state: payload,
	};
}

export default { key, label, capabilities, configured, submit, status, cancel, verifyWebhook, parseWebhook };
