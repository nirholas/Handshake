// world-store — generic, durable per-world JSON persistence (T3).
//
// A "world" is any place that needs to remember its state across room disposal
// and server restarts: a coin's collaborative build, a realm's mutable layout, a
// gated world's pass roster. Each world is one JSON document addressed by an
// opaque `worldId` (e.g. a coin mint, "<mint>#holders", or a realm id).
//
// ── Storage split ────────────────────────────────────────────────────────────
// The roadmap calls for R2 for large blob docs and Postgres for indexed/queried
// data; this module honours that split per-document by size:
//
//   • Postgres `world_docs` is ALWAYS the source of truth for the index row —
//     etag, version, owner, timestamps — and is the single linearization point
//     for optimistic concurrency. Small docs are stored inline (`inline_doc`
//     jsonb) so the hot path is one indexed round-trip.
//   • Docs past INLINE_MAX_BYTES are offloaded to R2 at a CONTENT-ADDRESSED key
//     (`worlds/<id>/<etag>.json`). Because the key embeds the content hash,
//     concurrent writers never clobber each other's bytes; the committed index
//     row decides which blob is canonical. The previous blob is GC'd after a
//     successful supersede.
//
// ── Optimistic concurrency ───────────────────────────────────────────────────
// `etag` is a content hash. A writer reads (gets an etag), mutates, and saves
// with `ifMatch: <that etag>`. If the stored etag has since changed, the
// conditional commit affects zero rows and we throw ConflictError (HTTP 409).
//   • ifMatch omitted/null → "create": succeeds only if no row exists yet
//     (a concurrent create surfaces as a conflict).
//   • ifMatch === '*'      → unconditional overwrite (last-writer-wins).
//
// ── Testability ──────────────────────────────────────────────────────────────
// All storage goes through a tiny BACKEND interface (readRow/readBlob/writeBlob/
// deleteBlob/upsert/remove). The default backend is Postgres + R2; tests inject
// an in-memory backend with the same compare-and-set contract. The CAS semantics
// live in the backend (it's an atomicity concern); the orchestration — size
// limits, hashing, inline/offload routing, blob GC, conflict mapping — lives in
// createWorldStore() and is exercised by the unit tests.
//
// ── Auth ─────────────────────────────────────────────────────────────────────
// Reads are public (worlds are shared, visible places). Writes go through
// canWriteWorld() — the permission hook T16 tightens. The authoritative game
// server writes as a service principal (always permitted); a browser session
// writes subject to ownership.

import { sql } from './db.js';
import { putObject, getObjectBuffer, deleteObject } from './r2.js';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

// A whole world doc is capped so one save is one bounded write. Placed-object
// builds at the catalog's per-world object cap serialize well under this.
export const MAX_DOC_BYTES = 2 * 1024 * 1024; // 2 MB
// Below this a doc rides inline in Postgres; above it goes to R2.
export const INLINE_MAX_BYTES = 96 * 1024; // 96 KB

// worldId is used in an R2 object key and a primary key — keep it to a tight,
// path-safe alphabet (base58 mints, realm slugs, the "#holders" tier suffix).
const WORLD_ID_RE = /^[A-Za-z0-9:_#.-]{1,128}$/;

export class ConflictError extends Error {
	constructor(message = 'world changed since last read') {
		super(message);
		this.name = 'ConflictError';
		this.status = 409;
		this.code = 'world_conflict';
	}
}

export class TooLargeError extends Error {
	constructor(message = 'world document exceeds size limit') {
		super(message);
		this.name = 'TooLargeError';
		this.status = 413;
		this.code = 'world_too_large';
	}
}

export class PermissionError extends Error {
	constructor(message = 'not permitted to write this world') {
		super(message);
		this.name = 'PermissionError';
		this.status = 403;
		this.code = 'forbidden';
	}
}

export function isValidWorldId(worldId) {
	return typeof worldId === 'string' && WORLD_ID_RE.test(worldId);
}

function assertWorldId(worldId) {
	if (!isValidWorldId(worldId)) {
		const e = new Error('invalid worldId');
		e.status = 400;
		e.code = 'validation_error';
		throw e;
	}
}

// Deterministic bytes for a doc. Stable enough that an unchanged doc hashes the
// same across saves, so a no-op save keeps the etag steady.
function serialize(doc) {
	return Buffer.from(JSON.stringify(doc), 'utf8');
}

export function etagOf(bytes) {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}

function r2KeyFor(worldId, etag) {
	// Mints/tier keys can contain ':' and '#'; encode so the key is path-clean.
	return `worlds/${encodeURIComponent(worldId)}/${etag}.json`;
}

// Forward-migrate a doc loaded under an older schema. Identity today; this is the
// seam that keeps old builds loadable when the doc shape evolves.
export function migrateDoc(doc /* , fromVersion */) {
	return doc;
}

// The permission hook. T16 replaces the body with the real model (holder
// threshold, owner allowlist, open) — keep the signature stable.
//   isService    — the request came from the authoritative game server.
//   account      — the authenticated user id, or null for anonymous.
//   currentOwner — owner_id on the existing row, or null for a new/unowned world.
export function canWriteWorld({ isService = false, account = null, currentOwner = null } = {}) {
	if (isService) return true; // the game server is authoritative
	if (!account) return false; // anonymous browsers can't write
	if (!currentOwner) return true; // unclaimed world — first writer may seed it
	return account === currentOwner; // otherwise owner-only (T16 widens this)
}

// ── orchestration (storage-agnostic) ─────────────────────────────────────────
// Build a world store over any backend implementing the contract below.
export function createWorldStore(backend) {
	// Load a world's current document, or null if it has never been saved.
	async function loadWorld(worldId) {
		assertWorldId(worldId);
		const row = await backend.readRow(worldId);
		if (!row) return null;

		let doc;
		if (row.inline_doc != null) {
			doc = typeof row.inline_doc === 'string' ? JSON.parse(row.inline_doc) : row.inline_doc;
		} else {
			const buf = await backend.readBlob(row.r2_key);
			doc = JSON.parse(Buffer.from(buf).toString('utf8'));
		}
		if (row.schema_version < SCHEMA_VERSION) doc = migrateDoc(doc, row.schema_version);

		return {
			worldId,
			schemaVersion: SCHEMA_VERSION,
			version: Number(row.doc_version),
			etag: row.etag,
			size: row.size_bytes,
			ownerId: row.owner_id ?? null,
			updatedAt: row.updated_at,
			doc,
		};
	}

	// Persist a world document. Throws TooLargeError or ConflictError.
	//   ifMatch — the etag the caller last read (see concurrency notes above).
	//   writer  — the principal recorded as updated_by (account id or 'service').
	//   owner   — owner_id to set ON CREATE only; ignored for existing rows.
	async function saveWorld({ worldId, doc, ifMatch = null, writer = null, owner = null }) {
		assertWorldId(worldId);

		const bytes = serialize(doc);
		if (bytes.length > MAX_DOC_BYTES) {
			throw new TooLargeError(`world document is ${bytes.length} bytes (max ${MAX_DOC_BYTES})`);
		}
		const etag = etagOf(bytes);
		const inline = bytes.length <= INLINE_MAX_BYTES;
		const r2Key = inline ? null : r2KeyFor(worldId, etag);

		// Look up the prior blob key so we can GC it after a successful supersede.
		const prior = await backend.readRow(worldId);
		const priorR2 = prior ? prior.r2_key : null;

		// Offloaded body lands first (content-addressed → no clobber), so the index
		// row we commit next always points at bytes that already exist.
		if (!inline) {
			await backend.writeBlob(r2Key, bytes);
		}

		const res = await backend.upsert({
			worldId,
			schemaVersion: SCHEMA_VERSION,
			etag,
			size: bytes.length,
			inlineDoc: inline ? doc : null,
			r2Key,
			owner,
			writer,
			ifMatch,
		});

		if (!res.committed) {
			// A row exists but the guard failed → someone wrote between read and save.
			// Drop the orphan blob this losing write may have created.
			if (!inline && r2Key !== priorR2) {
				try { await backend.deleteBlob(r2Key); } catch { /* best-effort */ }
			}
			throw new ConflictError();
		}

		// Supersede succeeded — retire the previous distinct blob.
		if (priorR2 && priorR2 !== r2Key) {
			try { await backend.deleteBlob(priorR2); } catch { /* best-effort GC */ }
		}

		return {
			worldId,
			schemaVersion: SCHEMA_VERSION,
			version: Number(res.version),
			etag: res.etag,
			size: bytes.length,
			ownerId: res.ownerId ?? null,
			updatedAt: res.updatedAt,
		};
	}

	// Remove a world entirely (its index row and any offloaded blob).
	async function deleteWorld(worldId) {
		assertWorldId(worldId);
		const r2Key = await backend.remove(worldId);
		if (r2Key === false) return false;
		if (r2Key) {
			try { await backend.deleteBlob(r2Key); } catch { /* best-effort */ }
		}
		return true;
	}

	return { loadWorld, saveWorld, deleteWorld };
}

// ── default backend: Postgres index + R2 blob ────────────────────────────────
export const postgresR2Backend = {
	async readRow(worldId) {
		const rows = await sql`
			SELECT world_id, schema_version, doc_version, etag, size_bytes,
			       inline_doc, r2_key, owner_id, updated_at
			FROM world_docs
			WHERE world_id = ${worldId}
			LIMIT 1
		`;
		return rows.length ? rows[0] : null;
	},

	async readBlob(r2Key) {
		return getObjectBuffer(r2Key);
	},

	async writeBlob(r2Key, bytes) {
		await putObject({ key: r2Key, body: bytes, contentType: 'application/json' });
	},

	async deleteBlob(r2Key) {
		await deleteObject(r2Key);
	},

	// Compare-and-set upsert. The WHERE guard on DO UPDATE is the concurrency
	// gate: '*' overwrites unconditionally; otherwise the stored etag must equal
	// ifMatch (NULL for a create → never matches an existing row → conflict).
	async upsert({ worldId, schemaVersion, etag, size, inlineDoc, r2Key, owner, writer, ifMatch }) {
		const guard = ifMatch === '*' ? sql`TRUE` : sql`world_docs.etag = ${ifMatch}`;
		const inlineParam = inlineDoc == null ? null : JSON.stringify(inlineDoc);
		const rows = await sql`
			INSERT INTO world_docs (
				world_id, schema_version, doc_version, etag, size_bytes,
				inline_doc, r2_key, owner_id, updated_by, created_at, updated_at
			) VALUES (
				${worldId}, ${schemaVersion}, 1, ${etag}, ${size},
				${inlineParam}::jsonb, ${r2Key}, ${owner}, ${writer}, now(), now()
			)
			ON CONFLICT (world_id) DO UPDATE SET
				schema_version = ${schemaVersion},
				doc_version    = world_docs.doc_version + 1,
				etag           = EXCLUDED.etag,
				size_bytes     = EXCLUDED.size_bytes,
				inline_doc     = EXCLUDED.inline_doc,
				r2_key         = EXCLUDED.r2_key,
				updated_by     = EXCLUDED.updated_by,
				updated_at     = now()
			WHERE ${guard}
			RETURNING doc_version, etag, owner_id, updated_at
		`;
		if (!rows.length) return { committed: false };
		const row = rows[0];
		return {
			committed: true,
			version: Number(row.doc_version),
			etag: row.etag,
			ownerId: row.owner_id ?? null,
			updatedAt: row.updated_at,
		};
	},

	async remove(worldId) {
		const rows = await sql`
			DELETE FROM world_docs WHERE world_id = ${worldId}
			RETURNING r2_key
		`;
		if (!rows.length) return false;
		return rows[0].r2_key;
	},
};

const defaultStore = createWorldStore(postgresR2Backend);
export const loadWorld = defaultStore.loadWorld;
export const saveWorld = defaultStore.saveWorld;
export const deleteWorld = defaultStore.deleteWorld;
