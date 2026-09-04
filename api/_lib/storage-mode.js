// Per-avatar storage mode: one JSONB column on avatars tracking R2 / IPFS /
// on-chain attestation state. Designed in the embed-hardening campaign, work
// order 05 (storage flags), retired from prompts/ once shipped; see git history.

import { z } from 'zod';
import { sql } from './db.js';

export const STORAGE_MODE_VERSION = 1;

export const storageModeSchema = z.object({
	version: z.literal(1).optional(),
	primary: z.enum(['r2', 'ipfs']),
	r2: z.object({
		present: z.boolean(),
		key: z.string().nullable(),
	}),
	ipfs: z.object({
		pinned: z.boolean(),
		cid: z.string().nullable(),
		pinned_at: z.string().datetime().nullable(),
	}),
	attestation: z.object({
		hash: z
			.string()
			.regex(/^[a-f0-9]{64}$/i)
			.nullable(),
		chain_id: z.number().int().nullable(),
		tx_hash: z
			.string()
			.regex(/^0x[a-fA-F0-9]{64}$/)
			.nullable(),
		attested_at: z.string().datetime().nullable(),
	}),
});

export function defaultStorageMode(avatarRow = {}) {
	return {
		version: STORAGE_MODE_VERSION,
		primary: 'r2',
		r2: { present: true, key: avatarRow.storage_key ?? null },
		ipfs: { pinned: false, cid: null, pinned_at: null },
		attestation: {
			hash: avatarRow.checksum_sha256 ?? null,
			chain_id: null,
			tx_hash: null,
			attested_at: null,
		},
	};
}

export async function readStorageMode(avatarId) {
	try {
		const [row] = await sql`
			SELECT id, owner_id, storage_key, checksum_sha256, storage_mode
			FROM avatars
			WHERE id = ${avatarId} AND deleted_at IS NULL
		`;
		if (!row) return null;
		const base = defaultStorageMode(row);
		if (!row.storage_mode) return base;
		return {
			...base,
			...row.storage_mode,
			r2: { ...base.r2, ...(row.storage_mode.r2 || {}) },
			ipfs: { ...base.ipfs, ...(row.storage_mode.ipfs || {}) },
			attestation: { ...base.attestation, ...(row.storage_mode.attestation || {}) },
		};
	} catch (err) {
		if (/column .* does not exist/i.test(String(err?.message))) return null;
		throw err;
	}
}

export function validateStorageMode(input) {
	return storageModeSchema.parse(input);
}

/**
 * Batch sibling of readStorageMode: resolve the stored mode for many avatars in
 * one indexed query instead of one round trip per row.
 *
 * The settings page lists every avatar the caller owns with its R2 / IPFS
 * state, so the per-id endpoint would have turned one panel into N requests.
 * Rows missing a stored mode fall back to the same default the single reader
 * uses, and a deployment whose avatars table predates the storage_mode column
 * gets an empty map rather than a 500 (identical guard to readStorageMode).
 *
 * @param {string[]} avatarIds
 * @returns {Promise<Map<string, ReturnType<typeof defaultStorageMode>>>}
 */
export async function readStorageModes(avatarIds) {
	const ids = [...new Set((avatarIds || []).filter(Boolean))];
	if (!ids.length) return new Map();
	try {
		const rows = await sql`
			SELECT id, storage_key, checksum_sha256, storage_mode
			FROM avatars
			WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
		`;
		const out = new Map();
		for (const row of rows) {
			const base = defaultStorageMode(row);
			out.set(
				row.id,
				row.storage_mode
					? {
							...base,
							...row.storage_mode,
							r2: { ...base.r2, ...(row.storage_mode.r2 || {}) },
							ipfs: { ...base.ipfs, ...(row.storage_mode.ipfs || {}) },
							attestation: { ...base.attestation, ...(row.storage_mode.attestation || {}) },
						}
					: base,
			);
		}
		return out;
	} catch (err) {
		if (/column .* does not exist/i.test(String(err?.message))) return new Map();
		throw err;
	}
}
