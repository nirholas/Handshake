// @ts-check
// The fulfillment adapter contract.
//
// A "provider" is whoever actually turns a prepared mesh into an object in a
// box: a human operator driving a print bureau by hand (the `manual` adapter,
// which is how this product launches) or a contracted partner's API. Both are
// the same interface, because the day a partner contract lands their API must
// be a config change rather than a rebuild.
//
// The design mirrors the forge's engine registry: adapters are data plus a
// module. Capabilities are declared, not inferred, so routing an order to a
// lane is a comparison against published facts (materials, bounding box,
// origin country, lead time) rather than a try-and-see.
//
// THE RULE THAT MATTERS: an adapter never writes the database. It returns
// vocabulary the store understands, and the caller drives transitionOrder().
// That is what keeps a partner changing their payload shape from being able to
// corrupt an order's state machine.
//
// ── the interface ────────────────────────────────────────────────────────────
//
//   key            string, stable, stored in print_orders.provider
//   label          human name for the console
//   capabilities   { materials, maxBboxMm, shipsFrom, leadTimeDays }
//   configured()   → boolean. False hides the adapter from the registry.
//   submit(order, assets)      → SubmitResult
//   status(providerOrderId)    → StatusResult
//   cancel(order, reason)      → CancelResult
//   verifyWebhook(raw, headers) → { ok, deliveryId, reason }
//   parseWebhook(payload)       → WebhookEvent
//
// Every result shape is normalized through this module, so a malformed return
// from any adapter fails at its own boundary with a named error instead of
// travelling into the store as junk.

import { createHash } from 'node:crypto';
import { PRINT_STATUSES } from '../../print-store.js';

/**
 * The statuses a fulfillment provider is allowed to drive. Everything before
 * `submitted` is ours (quoting, payment, safety screening) and no adapter may
 * reach back into it; `refunded` is a money action and stays operator-only.
 */
export const ADAPTER_DRIVABLE_STATUSES = Object.freeze([
	'submitted',
	'printing',
	'quality_check',
	'shipped',
	'delivered',
	'canceled',
	'rejected',
]);

/** Thrown when an adapter returns something the store cannot use. */
export class AdapterContractError extends Error {
	/**
	 * @param {string} adapterKey
	 * @param {string} detail
	 */
	constructor(adapterKey, detail) {
		super(`adapter '${adapterKey}' violated the fulfillment contract: ${detail}`);
		this.name = 'AdapterContractError';
		this.code = 'adapter_contract';
		this.adapterKey = adapterKey;
	}
}

/** Thrown when a partner's API is unreachable or answers badly. */
export class AdapterUpstreamError extends Error {
	/**
	 * @param {string} adapterKey
	 * @param {string} detail
	 * @param {number} [status]
	 */
	constructor(adapterKey, detail, status = 0) {
		super(`adapter '${adapterKey}' upstream failure: ${detail}`);
		this.name = 'AdapterUpstreamError';
		this.code = 'adapter_upstream';
		this.adapterKey = adapterKey;
		this.status = status;
	}
}

const REQUIRED_METHODS = Object.freeze([
	'configured',
	'submit',
	'status',
	'cancel',
	'verifyWebhook',
	'parseWebhook',
]);

/**
 * Validate an adapter module's shape. Called by the registry at import time and
 * by the conformance suite, so a new adapter cannot be registered half-built.
 * @param {any} adapter
 * @returns {any} the same adapter, for chaining
 */
export function assertAdapterShape(adapter) {
	const key = adapter?.key;
	if (typeof key !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(key)) {
		throw new AdapterContractError(String(key), 'key must be lower-kebab, 2 to 32 chars');
	}
	if (typeof adapter.label !== 'string' || !adapter.label.trim()) {
		throw new AdapterContractError(key, 'label is required');
	}
	for (const m of REQUIRED_METHODS) {
		if (typeof adapter[m] !== 'function') {
			throw new AdapterContractError(key, `missing method ${m}()`);
		}
	}
	assertCapabilities(key, adapter.capabilities);
	return adapter;
}

/**
 * Capabilities are the adapter's published promises. They are what an order
 * router compares against, so they are validated as strictly as any wire
 * format.
 * @param {string} key
 * @param {any} caps
 */
export function assertCapabilities(key, caps) {
	if (!caps || typeof caps !== 'object') {
		throw new AdapterContractError(key, 'capabilities object is required');
	}
	const { materials, maxBboxMm, shipsFrom, leadTimeDays } = caps;
	// '*' means "every material in the catalog"; the manual lane genuinely can
	// run anything a bureau accepts, and pretending otherwise would be a lie
	// that blocks orders.
	const materialsOk = materials === '*' || (Array.isArray(materials) && materials.every((m) => typeof m === 'string' && m));
	if (!materialsOk) throw new AdapterContractError(key, "capabilities.materials must be '*' or a list of material ids");
	const bboxOk = maxBboxMm && ['x', 'y', 'z'].every((axis) => Number.isFinite(maxBboxMm[axis]) && maxBboxMm[axis] > 0);
	if (!bboxOk) throw new AdapterContractError(key, 'capabilities.maxBboxMm must carry positive x, y, z');
	if (typeof shipsFrom !== 'string' || !/^[A-Z]{2}$/.test(shipsFrom)) {
		throw new AdapterContractError(key, 'capabilities.shipsFrom must be an ISO 3166-1 alpha-2 country code');
	}
	if (!Number.isInteger(leadTimeDays) || leadTimeDays < 1 || leadTimeDays > 120) {
		throw new AdapterContractError(key, 'capabilities.leadTimeDays must be an integer between 1 and 120');
	}
	return caps;
}

/**
 * Can this adapter physically run this order? A pure comparison against the
 * declared capabilities: no network, no side effects.
 * @param {any} adapter
 * @param {{ material_id?: string, analysis?: { bbox_mm?: { x?: number, y?: number, z?: number } } }} order
 * @returns {{ ok: boolean, reason: string }}
 */
export function adapterSupportsOrder(adapter, order) {
	const caps = adapter?.capabilities;
	if (!caps) return { ok: false, reason: 'adapter declares no capabilities' };
	const material = order?.material_id || '';
	if (caps.materials !== '*' && !caps.materials.includes(material)) {
		return { ok: false, reason: `material '${material || 'none'}' is not offered by ${adapter.key}` };
	}
	const bbox = order?.analysis?.bbox_mm;
	if (bbox && ['x', 'y', 'z'].some((a) => Number(bbox[a]) > caps.maxBboxMm[a])) {
		return { ok: false, reason: `part exceeds ${adapter.key}'s build volume` };
	}
	return { ok: true, reason: '' };
}

/** @param {string} key @param {any} value @param {string} field */
function requireDrivableStatus(key, value, field) {
	if (!ADAPTER_DRIVABLE_STATUSES.includes(value)) {
		throw new AdapterContractError(key, `${field} must be one of ${ADAPTER_DRIVABLE_STATUSES.join(', ')}, got '${value}'`);
	}
	return value;
}

/**
 * Normalize what submit() returned.
 * @param {string} key
 * @param {any} result
 * @returns {{ providerOrderId: string, status: string, leadTimeDays: number, note: string, state: object }}
 */
export function normalizeSubmitResult(key, result) {
	if (!result || typeof result !== 'object') throw new AdapterContractError(key, 'submit() returned no result');
	const providerOrderId = String(result.providerOrderId || '').trim();
	if (!providerOrderId) throw new AdapterContractError(key, 'submit() must return a providerOrderId');
	if (providerOrderId.length > 200) throw new AdapterContractError(key, 'providerOrderId is implausibly long');
	const status = requireDrivableStatus(key, result.status || 'submitted', 'submit().status');
	const leadTimeDays = Number.isInteger(result.leadTimeDays) ? result.leadTimeDays : null;
	return {
		providerOrderId,
		status,
		leadTimeDays: leadTimeDays ?? 0,
		note: typeof result.note === 'string' ? result.note.slice(0, 2000) : '',
		state: plainState(result.state),
	};
}

/**
 * Normalize what status() returned. `status: null` is legal and means "nothing
 * changed": a provider that has no news is not an error.
 * @param {string} key
 * @param {any} result
 * @returns {{ status: string|null, trackingNumber: string, carrier: string, note: string, state: object }}
 */
export function normalizeStatusResult(key, result) {
	if (!result || typeof result !== 'object') throw new AdapterContractError(key, 'status() returned no result');
	const status = result.status == null ? null : requireDrivableStatus(key, result.status, 'status().status');
	return {
		status,
		trackingNumber: cleanShort(result.trackingNumber),
		carrier: cleanShort(result.carrier),
		note: typeof result.note === 'string' ? result.note.slice(0, 2000) : '',
		state: plainState(result.state),
	};
}

/**
 * Normalize what parseWebhook() returned into one applyable event.
 * @param {string} key
 * @param {any} result
 * @returns {{ providerOrderId: string, status: string|null, trackingNumber: string, carrier: string, note: string, state: object }}
 */
export function normalizeWebhookEvent(key, result) {
	if (!result || typeof result !== 'object') throw new AdapterContractError(key, 'parseWebhook() returned no event');
	const providerOrderId = String(result.providerOrderId || '').trim();
	if (!providerOrderId) throw new AdapterContractError(key, 'parseWebhook() must identify the order');
	const status = result.status == null ? null : requireDrivableStatus(key, result.status, 'parseWebhook().status');
	return {
		providerOrderId,
		status,
		trackingNumber: cleanShort(result.trackingNumber),
		carrier: cleanShort(result.carrier),
		note: typeof result.note === 'string' ? result.note.slice(0, 2000) : '',
		state: plainState(result.state),
	};
}

/**
 * Normalize what cancel() returned.
 * @param {string} key
 * @param {any} result
 */
export function normalizeCancelResult(key, result) {
	if (!result || typeof result !== 'object') throw new AdapterContractError(key, 'cancel() returned no result');
	return {
		ok: result.ok === true,
		note: typeof result.note === 'string' ? result.note.slice(0, 2000) : '',
		state: plainState(result.state),
	};
}

/** @param {any} v */
function cleanShort(v) {
	return typeof v === 'string' ? v.trim().slice(0, 120) : '';
}

// Providers return whatever they like. We keep it for diagnostics but never
// let a non-serializable or oversized blob reach a jsonb column.
function plainState(state) {
	if (!state || typeof state !== 'object') return {};
	try {
		const json = JSON.stringify(state);
		if (json.length > 16_000) return { truncated: true, bytes: json.length };
		return JSON.parse(json);
	} catch {
		return {};
	}
}

/**
 * A stable delivery id for a provider that sends none. Hashing the payload
 * means "the same event twice" is still one row, which is the whole point of
 * the idempotency ledger.
 * @param {string} provider
 * @param {string} rawBody
 */
export function derivedDeliveryId(provider, rawBody) {
	return `sha256:${createHash('sha256').update(`${provider}:${rawBody}`).digest('hex')}`;
}

/**
 * Map a provider's own status vocabulary onto ours through a declared table.
 * Unknown provider statuses return null ("no news"), never a guess: inventing a
 * transition from an unrecognized string is exactly how a state machine gets
 * corrupted by a partner's release notes.
 * @param {Record<string, string>} table
 * @param {unknown} providerStatus
 * @returns {string|null}
 */
export function mapProviderStatus(table, providerStatus) {
	if (typeof providerStatus !== 'string') return null;
	const mapped = table[providerStatus.trim().toLowerCase()];
	return mapped && PRINT_STATUSES.includes(mapped) ? mapped : null;
}
