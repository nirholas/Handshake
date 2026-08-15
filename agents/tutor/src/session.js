// Pay-As-You-Learn Tutor: session ledger.
//
// Each tutoring session keeps a running tab: every answered question appends an
// itemized charge, and "end session" produces an itemized invoice with a
// SHA-256 attestation over the entries.
//
// Storage tiers, in order of preference:
//   1. Postgres `tutor_sessions` (DATABASE_URL). This is the platform's real
//      store and the tier production runs on; the table is created lazily.
//   2. Upstash/Vercel KV REST (UPSTASH_REDIS_REST_URL/TOKEN), for a deployment
//      that has KV but no database.
//   3. Process-local memory, for local dev with neither configured. Resume then
//      works within one server process and nowhere else.
//
// Records expire 7 days after the last write, so a learner can close the tab
// and resume the same session later.
//
// Reads propagate a storage fault to the caller: reporting "$0, no questions"
// because the store is down would tell a learner who owes money that they owe
// nothing. Writes on the paid path are best-effort, because losing a ledger row
// must never cost the learner the answer they already paid for.

import { createHash } from 'crypto';
import { sql } from '../../../api/_lib/db.js';
import { databaseConfigured } from '../../../api/_lib/env.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_ENTRIES = 500; // hard cap so a session object can't grow unbounded
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // at most one expired-row sweep per hour per process

function kvCredentials() {
	const url =
		process.env.UPSTASH_REDIS_REST_URL ||
		process.env.three_KV_REST_API_URL ||
		process.env.KV_REST_API_URL;
	const token =
		process.env.UPSTASH_REDIS_REST_TOKEN ||
		process.env.three_KV_REST_API_TOKEN ||
		process.env.KV_REST_API_TOKEN;
	return { url, token };
}

/** Which backend this process will use: 'db', 'kv', or 'memory'. */
export function sessionBackend() {
	if (databaseConfigured()) return 'db';
	const { url, token } = kvCredentials();
	return url && token ? 'kv' : 'memory';
}

// ── Postgres tier ─────────────────────────────────────────────────────────────

let schemaReady = null;

function ensureSchema() {
	if (schemaReady) return schemaReady;
	schemaReady = (async () => {
		await sql`
			create table if not exists tutor_sessions (
				session_id    text primary key,
				status        text not null default 'open',
				total_atomics bigint not null default 0,
				session       jsonb not null,
				created_at    timestamptz not null default now(),
				updated_at    timestamptz not null default now(),
				expires_at    timestamptz not null
			)
		`;
		await sql`create index if not exists tutor_sessions_expires_idx on tutor_sessions (expires_at)`;
		return true;
	})();
	// A failed CREATE (outage, permissions) must not poison every later call with
	// the same rejected promise; drop it so the next request retries.
	schemaReady.catch(() => {
		schemaReady = null;
	});
	return schemaReady;
}

let lastPruneAt = 0;

function prunePostgres() {
	const now = Date.now();
	if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = now;
	sql`delete from tutor_sessions where expires_at < now()`.catch((err) => {
		console.warn('[tutor] expired-session sweep failed:', err?.message || err);
	});
}

async function dbRead(sessionId) {
	await ensureSchema();
	const rows = await sql`
		select session from tutor_sessions
		where session_id = ${sessionId} and expires_at > now()
	`;
	const raw = rows?.[0]?.session;
	if (!raw) return null;
	return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function dbWrite(session) {
	await ensureSchema();
	await sql`
		insert into tutor_sessions (session_id, status, total_atomics, session, created_at, updated_at, expires_at)
		values (
			${session.sessionId},
			${session.status},
			${session.totalAtomics},
			${JSON.stringify(session)}::jsonb,
			${session.createdAt}::timestamptz,
			now(),
			now() + ${`${SESSION_TTL_SECONDS} seconds`}::interval
		)
		on conflict (session_id) do update set
			status        = excluded.status,
			total_atomics = excluded.total_atomics,
			session       = excluded.session,
			updated_at    = now(),
			expires_at    = excluded.expires_at
	`;
	prunePostgres();
}

// ── KV tier ───────────────────────────────────────────────────────────────────

function sessionKey(sessionId) {
	return `tutor:session:v1:${sessionId}`;
}

async function kvRead(sessionId) {
	const { url, token } = kvCredentials();
	const r = await fetch(`${url}/get/${encodeURIComponent(sessionKey(sessionId))}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!r.ok) throw new Error(`kv get failed with ${r.status}`);
	const d = await r.json();
	return d.result ? JSON.parse(d.result) : null;
}

async function kvWrite(session) {
	const { url, token } = kvCredentials();
	// Upstash REST: the raw request body IS the stored value; TTL goes in the
	// query string. A JSON envelope body would be stored verbatim and corrupt
	// every subsequent read.
	const key = encodeURIComponent(sessionKey(session.sessionId));
	const r = await fetch(`${url}/set/${key}?EX=${SESSION_TTL_SECONDS}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}` },
		body: JSON.stringify(session),
	});
	if (!r.ok) throw new Error(`kv set failed with ${r.status}`);
}

// ── Memory tier ───────────────────────────────────────────────────────────────

const memory = new Map();

function memoryRead(sessionId) {
	const rec = memory.get(sessionId);
	if (!rec) return null;
	if (rec.expiresAt <= Date.now()) {
		memory.delete(sessionId);
		return null;
	}
	return JSON.parse(JSON.stringify(rec.session));
}

function memoryWrite(session) {
	memory.set(session.sessionId, {
		session: JSON.parse(JSON.stringify(session)),
		expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
	});
}

// ── Backend dispatch ──────────────────────────────────────────────────────────

/** Read the stored session, or null when this id has no tab. Throws on a store fault. */
async function readSession(sessionId) {
	const backend = sessionBackend();
	const stored =
		backend === 'db' ? await dbRead(sessionId) : backend === 'kv' ? await kvRead(sessionId) : memoryRead(sessionId);
	// A record written by a foreign writer (or an older shape) lacks the session
	// fields; treat it as absent rather than crashing the charge path.
	if (!stored || !Array.isArray(stored.entries)) return null;
	if (!Number.isFinite(stored.totalAtomics)) stored.totalAtomics = 0;
	if (!stored.status) stored.status = 'open';
	return stored;
}

async function writeSession(session) {
	const backend = sessionBackend();
	if (backend === 'db') return dbWrite(session);
	if (backend === 'kv') return kvWrite(session);
	return memoryWrite(session);
}

function emptySession(sessionId) {
	return { sessionId, createdAt: new Date().toISOString(), entries: [], totalAtomics: 0, status: 'open' };
}

/** Load a session, or a fresh empty one when this id has no tab yet. */
export async function loadSession(sessionId) {
	return (await readSession(sessionId)) || emptySession(sessionId);
}

/**
 * Append one answered-question charge to the session tab and persist it.
 * Returns the updated session.
 */
export async function appendCharge(sessionId, entry) {
	let session;
	try {
		session = await loadSession(sessionId);
	} catch (err) {
		// The learner has already paid for this answer: a ledger outage costs them
		// the running total, never the explanation itself.
		console.warn('[tutor] session ledger read failed, charging a fresh tab:', err?.message || err);
		session = emptySession(sessionId);
	}
	if (session.status === 'closed') {
		const err = new Error('session is closed, start a new session');
		err.status = 409;
		err.code = 'session_closed';
		err.expose = true;
		throw err;
	}
	session.entries.push({
		question: String(entry.question || '').slice(0, 500),
		level: entry.level,
		costAtomics: entry.costAtomics,
		outputTokens: entry.outputTokens || 0,
		sandboxRan: Boolean(entry.sandboxRan),
		at: new Date().toISOString(),
	});
	if (session.entries.length > MAX_ENTRIES) {
		session.entries = session.entries.slice(-MAX_ENTRIES);
	}
	session.totalAtomics = session.entries.reduce((sum, e) => sum + (e.costAtomics || 0), 0);
	try {
		await writeSession(session);
	} catch (err) {
		console.warn('[tutor] session ledger write failed:', err?.message || err);
	}
	return session;
}

/** Convert atomics (USDC 6dp) to a human "$x.xxxxxx" string. */
export function atomicsToUsd(atomics) {
	return (Number(atomics) / 1_000_000).toFixed(6);
}

function buildInvoice(session) {
	const lineItems = session.entries.map((e, i) => ({
		n: i + 1,
		question: e.question,
		level: e.level,
		outputTokens: e.outputTokens,
		costAtomics: e.costAtomics,
		costUsd: atomicsToUsd(e.costAtomics),
		at: e.at,
	}));

	const attestation =
		'sha256:' +
		createHash('sha256')
			.update(JSON.stringify({ sessionId: session.sessionId, lineItems, totalAtomics: session.totalAtomics }))
			.digest('hex');

	return {
		sessionId: session.sessionId,
		createdAt: session.createdAt,
		closedAt: new Date().toISOString(),
		questionCount: lineItems.length,
		lineItems,
		totalAtomics: session.totalAtomics,
		totalUsd: atomicsToUsd(session.totalAtomics),
		attestation,
	};
}

/**
 * Close a session and produce an itemized, attested invoice.
 * Idempotent: closing an already-closed session returns the stored invoice
 * verbatim, closedAt included.
 */
export async function closeSession(sessionId) {
	const stored = await readSession(sessionId);
	if (stored?.status === 'closed' && stored.invoice) return stored.invoice;

	const session = stored || emptySession(sessionId);
	const invoice = buildInvoice(session);

	// Never persist a close for an id that has no tab. Writing a `closed` record
	// for an unused id would make it permanently unusable (appendCharge rejects a
	// closed session) for whoever actually holds it.
	if (stored) {
		session.status = 'closed';
		session.invoice = invoice;
		await writeSession(session);
	}
	return invoice;
}
