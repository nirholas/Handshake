// Records a successful paid checkout call against a SKU.
//
// The hosted checkout page (/pay/c/<slug>) calls this after the drop-in
// modal returns a settled payment.
//
// Trust model, stated plainly because the numbers this table feeds are a
// merchant's revenue dashboard: the endpoint is public and the row is NOT
// authenticated. Anyone can POST a record against any active SKU. What bounds
// the damage is that the row is analytics-only (it moves no funds, unlocks no
// resource), the per-IP limiter caps the write rate, and the (sku_id,
// tx_signature) unique index means one on-chain signature can be counted once.
// Forging a row therefore means lying to yourself about your own conversion
// numbers. Verifying the tx on-chain before recording would close the gap; it
// costs an RPC round-trip on the checkout hot path and is not done today.

import { z } from 'zod';
import { sql } from './_lib/db.js';
import { cors, json, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { limits, clientIp } from './_lib/rate-limit.js';

const recordSchema = z.object({
	sku_id: z.string().uuid(),
	network: z.string().min(3).max(80),
	tx_signature: z.string().max(180).optional(),
	payer_address: z.string().max(64).optional(),
	amount_atomics: z.string().regex(/^\d+$/),
	asset: z.string().max(64),
	response_status: z.number().int().min(100).max(599),
	error_code: z.string().max(80).optional(),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'use POST');

	// Public + write endpoint — bound per IP so it can't be scripted into a flood
	// of fabricated revenue rows.
	const rl = await limits.x402RecordIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl, 'too many checkout records, slow down');

	const body = parse(recordSchema, await readJson(req));

	// Confirm the SKU exists (and is active) before inserting — keeps the table
	// clean of orphan rows pointing at archived SKUs.
	const [sku] = await sql`select id from x402_skus where id = ${body.sku_id} and archived_at is null limit 1`;
	if (!sku) return error(res, 404, 'sku_not_found', 'no active SKU with that id');

	// Replay guard: a given on-chain tx may only be recorded once per SKU.
	// Without this, replaying one real payment header inflates the merchant's
	// revenue/conversion analytics arbitrarily. Idempotently return the existing
	// row instead of erroring so a legitimate double-submit is a no-op. The
	// (sku_id, tx_signature) unique index makes this race-safe under concurrency.
	if (body.tx_signature) {
		const [existing] = await sql`
			select id, paid_at from x402_checkout_calls
			where sku_id = ${body.sku_id} and tx_signature = ${body.tx_signature} limit 1
		`;
		if (existing) return json(res, 200, { ok: true, id: existing.id, paid_at: existing.paid_at, deduped: true });
	}

	const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
	const ipHash = ip ? simpleHash(ip) : null;
	const ua = (req.headers['user-agent'] || '').toString().slice(0, 240);

	let row;
	try {
		[row] = await sql`
		insert into x402_checkout_calls (
			sku_id, network, tx_signature, payer_address,
			amount_atomics, asset, response_status, error_code,
			buyer_ip_hash, user_agent
		) values (
			${body.sku_id}, ${body.network},
			${body.tx_signature ?? null}, ${body.payer_address ?? null},
			${body.amount_atomics}, ${body.asset},
			${body.response_status}, ${body.error_code ?? null},
			${ipHash}, ${ua}
		)
			returning id, paid_at
		`;
	} catch (err) {
		// Lost the race to a concurrent record of the same tx — the unique index
		// rejected the duplicate. Return the row that won, idempotently.
		if (body.tx_signature && /duplicate key|unique/i.test(err?.message || '')) {
			const [existing] = await sql`
				select id, paid_at from x402_checkout_calls
				where sku_id = ${body.sku_id} and tx_signature = ${body.tx_signature} limit 1
			`;
			if (existing) return json(res, 200, { ok: true, id: existing.id, paid_at: existing.paid_at, deduped: true });
		}
		throw err;
	}
	return json(res, 201, { ok: true, id: row.id, paid_at: row.paid_at });
});

function simpleHash(s) {
	// Tiny FNV-1a — we just need a stable non-reversible bucket for abuse
	// detection. Not crypto. 32-bit hex output is enough granularity.
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}
