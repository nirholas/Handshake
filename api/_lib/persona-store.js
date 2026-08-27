/**
 * Persistent agent personas — the identity layer behind an embodied agent.
 *
 * A persona is a NAMED, durable body: a rigged GLB the agent reuses turn after
 * turn and session after session, plus the small bag of identity that makes it
 * itself (display name, look notes, voice, an emotional baseline, the prompt that
 * forged it). Where save_avatar persists a model into a signed-in user's library,
 * a persona is addressable by an unguessable id ALONE — so an embodiment component
 * embedded in ChatGPT/Claude can mint one anonymously and return to the exact same
 * body later by id, with no account required. The id IS the capability.
 *
 * Storage, real and tiered:
 *   • Production: a Postgres `agent_personas` row (created lazily, see ensureSchema)
 *     plus a durable R2 copy of the GLB so the body outlives the provider URL.
 *   • Local/dev/test (no DATABASE_URL): a JSON record on disk under a data dir, so
 *     "reload the same persona id in a new process and get the same body" actually
 *     works on a laptop with zero cloud config. Same record shape either way.
 *
 * Nothing here touches tokens, wallets, or payments — a persona is a body and a
 * name. The public projection (personaPublicView) strips storage keys and owner
 * ids so a tool response never leaks internal identifiers.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from './db.js';
import { databaseConfigured } from './env.js';
import { putObject, copyObject, publicUrl } from './r2.js';
import { fetchUpstream } from './upstream-fetch.js';

const dbConfigured = () => databaseConfigured();
const r2Configured = () => !!(process.env.S3_BUCKET && process.env.S3_PUBLIC_DOMAIN);

// ── pure helpers (no backend — unit-testable on their own) ────────────────────

const ID_PREFIX = 'persona_';

/**
 * Mint a stable, URL-safe, unguessable persona id. Deterministic when a `seed` is
 * supplied (for tests / reproducible fixtures), random otherwise.
 * @param {string} [seed]
 * @returns {string}
 */
export function makePersonaId(seed) {
	const bytes = seed
		? createHash('sha256').update(String(seed)).digest().subarray(0, 15)
		: randomBytes(15);
	return ID_PREFIX + bytes.toString('base64url');
}

/** True if a string is a well-formed persona id (cheap guard before a lookup). */
export function isPersonaId(v) {
	return typeof v === 'string' && /^persona_[A-Za-z0-9_-]{16,32}$/.test(v);
}

/**
 * Normalize raw create input into the canonical persona record fields. Pure: no
 * I/O. Clamps/sanitizes user-supplied strings so neither backend stores garbage.
 * @param {object} input
 * @returns {object}
 */
export function normalizePersonaInput(input = {}) {
	const clamp = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
	const look = input.look && typeof input.look === 'object' ? input.look : {};
	return {
		name: clamp(input.name, 80) || 'Agent',
		glb_url: clamp(input.glbUrl ?? input.glb_url, 2048),
		glb_key: clamp(input.glbKey ?? input.glb_key, 1024),
		thumbnail_url: clamp(input.thumbnailUrl ?? input.thumbnail_url, 2048),
		voice: clamp(input.voice, 64),
		emotion_baseline: clamp(input.emotionBaseline ?? input.emotion_baseline, 24) || 'neutral',
		source_prompt: clamp(input.sourcePrompt ?? input.source_prompt, 1000),
		owner_id: clamp(input.ownerId ?? input.owner_id, 128),
		look: {
			rigged: look.rigged ?? null,
			has_visemes: look.has_visemes ?? look.hasVisemes ?? null,
			mesh_count: Number.isFinite(look.mesh_count) ? look.mesh_count : null,
			animation_count: Number.isFinite(look.animation_count) ? look.animation_count : null,
			style: clamp(look.style, 120),
		},
	};
}

/**
 * The safe, outward projection of a persona — what a tool response or the
 * embodiment component is allowed to see. Drops storage keys and owner ids;
 * keeps only what's needed to render and reload the body.
 * @param {object} rec
 */
export function personaPublicView(rec) {
	if (!rec) return null;
	return {
		persona_id: rec.id,
		name: rec.name,
		glb_url: rec.glb_url,
		thumbnail_url: rec.thumbnail_url || null,
		voice: rec.voice || null,
		emotion_baseline: rec.emotion_baseline || 'neutral',
		look: rec.look || {},
		turn_count: rec.turn_count || 0,
		created_at: rec.created_at || null,
		last_seen_at: rec.last_seen_at || null,
	};
}

// ── durable GLB copy ──────────────────────────────────────────────────────────

/**
 * Copy a forged GLB into our own durable storage so the persona's body survives
 * the provider's delivery URL expiring. Returns { glbUrl, glbKey }. When R2 isn't
 * configured (local dev) the source URL is kept as-is — the persona still persists,
 * it just references the original asset.
 *
 * @param {string} sourceUrl   public https GLB URL (or a same-origin /asset path)
 * @param {string} personaId
 * @param {Buffer|null} [buffer]  pre-fetched bytes (skip a re-download)
 */
export async function persistPersonaGlb(sourceUrl, personaId, buffer = null) {
	if (!r2Configured()) return { glbUrl: sourceUrl, glbKey: null };
	const key = `personas/${personaId}.glb`;
	try {
		if (buffer) {
			await putObject({ key, body: buffer, contentType: 'model/gltf-binary', metadata: { kind: 'persona', persona_id: personaId } });
		} else if (/^https?:\/\//i.test(sourceUrl)) {
			// Fetch + put (copyObject only works for keys already in our bucket).
			const resp = await fetchUpstream(sourceUrl, {}, { timeoutMs: 60_000, attempts: 3, okWhen: () => true });
			if (!resp.ok) throw new Error(`fetch ${resp.status}`);
			const body = Buffer.from(await resp.arrayBuffer());
			await putObject({ key, body, contentType: 'model/gltf-binary', metadata: { kind: 'persona', persona_id: personaId } });
		} else {
			return { glbUrl: sourceUrl, glbKey: null };
		}
		return { glbUrl: publicUrl(key), glbKey: key };
	} catch {
		// Durable copy failed — keep the source URL rather than losing the persona.
		return { glbUrl: sourceUrl, glbKey: null };
	}
}

// ── Postgres backend ──────────────────────────────────────────────────────────

let _schemaReady = null;
async function ensureSchema() {
	if (_schemaReady) return _schemaReady;
	_schemaReady = sql`
		create table if not exists agent_personas (
			id            text primary key,
			owner_id      text,
			name          text not null,
			glb_url       text not null,
			glb_key       text,
			thumbnail_url text,
			voice         text,
			emotion_baseline text default 'neutral',
			look          jsonb not null default '{}'::jsonb,
			source_prompt text,
			turn_count    integer not null default 0,
			created_at    timestamptz not null default now(),
			updated_at    timestamptz not null default now(),
			last_seen_at  timestamptz not null default now()
		)
	`.then(() => true);
	return _schemaReady;
}

function rowToRecord(row) {
	if (!row) return null;
	return {
		id: row.id,
		owner_id: row.owner_id,
		name: row.name,
		glb_url: row.glb_url,
		glb_key: row.glb_key,
		thumbnail_url: row.thumbnail_url,
		voice: row.voice,
		emotion_baseline: row.emotion_baseline || 'neutral',
		look: typeof row.look === 'string' ? JSON.parse(row.look) : row.look || {},
		source_prompt: row.source_prompt,
		turn_count: row.turn_count || 0,
		created_at: row.created_at,
		updated_at: row.updated_at,
		last_seen_at: row.last_seen_at,
	};
}

// ── filesystem backend (local/dev/test fallback) ──────────────────────────────

function storeDir() {
	return process.env.PERSONA_STORE_DIR || path.join(process.cwd(), '.data', 'personas');
}
async function fsDir() {
	const dir = storeDir();
	try {
		await fs.mkdir(dir, { recursive: true });
		return dir;
	} catch {
		// cwd is read-only (serverless) — fall back to the OS temp dir. Ephemeral,
		// but it keeps the path working; production uses Postgres, not this.
		const tmp = path.join(os.tmpdir(), 'threews-personas');
		await fs.mkdir(tmp, { recursive: true });
		return tmp;
	}
}
const fsFile = (dir, id) => path.join(dir, `${id}.json`);

async function fsWrite(rec) {
	const dir = await fsDir();
	await fs.writeFile(fsFile(dir, rec.id), JSON.stringify(rec, null, 2), 'utf8');
	return rec;
}
async function fsRead(id) {
	const dir = await fsDir();
	try {
		return JSON.parse(await fs.readFile(fsFile(dir, id), 'utf8'));
	} catch {
		return null;
	}
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Create and persist a new persona. The GLB is copied into durable storage first
 * (when configured) so the body outlives the provider URL.
 *
 * @param {object} input  { name, glbUrl, glbKey?, thumbnailUrl?, voice?, emotionBaseline?, sourcePrompt?, ownerId?, look? }
 * @returns {Promise<object>} the stored record
 */
export async function createPersona(input) {
	const norm = normalizePersonaInput(input);
	if (!norm.glb_url) throw new Error('createPersona requires a glbUrl');
	const id = makePersonaId(input.idSeed);

	// Durable-copy the body unless the caller already handed us a stored key.
	let glbUrl = norm.glb_url;
	let glbKey = norm.glb_key;
	if (!glbKey) {
		const persisted = await persistPersonaGlb(norm.glb_url, id, input.glbBuffer || null);
		glbUrl = persisted.glbUrl;
		glbKey = persisted.glbKey;
	}

	const record = {
		id,
		owner_id: norm.owner_id,
		name: norm.name,
		glb_url: glbUrl,
		glb_key: glbKey,
		thumbnail_url: norm.thumbnail_url,
		voice: norm.voice,
		emotion_baseline: norm.emotion_baseline,
		look: norm.look,
		source_prompt: norm.source_prompt,
		turn_count: 0,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		last_seen_at: new Date().toISOString(),
	};

	if (dbConfigured()) {
		await ensureSchema();
		const [row] = await sql`
			insert into agent_personas (id, owner_id, name, glb_url, glb_key, thumbnail_url, voice, emotion_baseline, look, source_prompt)
			values (${record.id}, ${record.owner_id}, ${record.name}, ${record.glb_url}, ${record.glb_key},
				${record.thumbnail_url}, ${record.voice}, ${record.emotion_baseline},
				${JSON.stringify(record.look)}::jsonb, ${record.source_prompt})
			returning *`;
		return rowToRecord(row);
	}
	return fsWrite(record);
}

/**
 * Load a persona by id. The id is the capability, so no ownership check is
 * required to read — that is what lets a fresh session reload the same body.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getPersona(id) {
	if (!isPersonaId(id)) return null;
	if (dbConfigured()) {
		await ensureSchema();
		const [row] = await sql`select * from agent_personas where id = ${id} limit 1`;
		return rowToRecord(row);
	}
	return fsRead(id);
}

/**
 * Patch a persona's mutable identity (name, look, voice, thumbnail). Storage keys
 * and the owner are immutable here.
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>}
 */
export async function updatePersona(id, patch = {}) {
	const cur = await getPersona(id);
	if (!cur) return null;
	const next = {
		...cur,
		name: patch.name != null ? String(patch.name).trim().slice(0, 80) : cur.name,
		voice: patch.voice != null ? String(patch.voice).trim().slice(0, 64) : cur.voice,
		thumbnail_url: patch.thumbnailUrl != null ? String(patch.thumbnailUrl).slice(0, 2048) : cur.thumbnail_url,
		emotion_baseline: patch.emotionBaseline != null ? String(patch.emotionBaseline).slice(0, 24) : cur.emotion_baseline,
		look: patch.look && typeof patch.look === 'object' ? { ...cur.look, ...patch.look } : cur.look,
		updated_at: new Date().toISOString(),
	};
	if (dbConfigured()) {
		await ensureSchema();
		const [row] = await sql`
			update agent_personas set
				name = ${next.name}, voice = ${next.voice}, thumbnail_url = ${next.thumbnail_url},
				emotion_baseline = ${next.emotion_baseline}, look = ${JSON.stringify(next.look)}::jsonb,
				updated_at = now()
			where id = ${id} returning *`;
		return rowToRecord(row);
	}
	return fsWrite(next);
}

/**
 * Record that the persona spoke a turn — bumps turn_count and last_seen, the
 * continuity signal that proves the same body is being reused across a session.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function touchPersona(id) {
	if (dbConfigured()) {
		await ensureSchema();
		const [row] = await sql`
			update agent_personas set turn_count = turn_count + 1, last_seen_at = now()
			where id = ${id} returning *`;
		return rowToRecord(row);
	}
	const cur = await fsRead(id);
	if (!cur) return null;
	cur.turn_count = (cur.turn_count || 0) + 1;
	cur.last_seen_at = new Date().toISOString();
	return fsWrite(cur);
}
