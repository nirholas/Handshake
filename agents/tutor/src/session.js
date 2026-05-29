// Pay-As-You-Learn Tutor — session ledger.
//
// Each tutoring session keeps a running tab: every answered question appends an
// itemized charge, and "end session" produces an itemized invoice with a
// SHA-256 attestation over the entries. State lives in Upstash/Vercel KV (REST)
// with a 7-day TTL so a learner can resume a session after closing the tab.
//
// Storage is best-effort: when no KV is configured the tutor still works as a
// stateless per-question service — each answer simply reports its own charge
// and the session total reflects only the current request.

import { createHash } from 'crypto';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_ENTRIES = 500; // hard cap so a session object can't grow unbounded

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

export function kvAvailable() {
	const { url, token } = kvCredentials();
	return Boolean(url && token);
}

async function kvGet(key) {
	const { url, token } = kvCredentials();
	if (!url || !token) return null;
	try {
		const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		const d = await r.json();
		return d.result ? JSON.parse(d.result) : null;
	} catch {
		return null;
	}
}

async function kvSet(key, value, ttlSeconds) {
	const { url, token } = kvCredentials();
	if (!url || !token) return;
	try {
		await fetch(`${url}/set/${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSeconds }),
		});
	} catch {
		// Non-fatal — session simply won't persist.
	}
}

function sessionKey(sessionId) {
	return `tutor:session:v1:${sessionId}`;
}

function emptySession(sessionId) {
	return { sessionId, createdAt: new Date().toISOString(), entries: [], totalAtomics: 0, status: 'open' };
}

/** Load a session, or a fresh empty one when absent/unstored. */
export async function loadSession(sessionId) {
	const existing = await kvGet(sessionKey(sessionId));
	return existing || emptySession(sessionId);
}

/**
 * Append one answered-question charge to the session tab and persist it.
 * Returns the updated session.
 */
export async function appendCharge(sessionId, entry) {
	const session = await loadSession(sessionId);
	if (session.status === 'closed') {
		const err = new Error('session is closed — start a new session');
		err.status = 409;
		err.code = 'session_closed';
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
	await kvSet(sessionKey(sessionId), session, SESSION_TTL_SECONDS);
	return session;
}

/** Convert atomics (USDC 6dp) to a human "$x.xxxxxx" string. */
export function atomicsToUsd(atomics) {
	return (Number(atomics) / 1_000_000).toFixed(6);
}

/**
 * Close a session and produce an itemized, attested invoice.
 * Idempotent: closing an already-closed session returns the same invoice.
 */
export async function closeSession(sessionId) {
	const session = await loadSession(sessionId);

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
			.update(JSON.stringify({ sessionId, lineItems, totalAtomics: session.totalAtomics }))
			.digest('hex');

	const invoice = {
		sessionId,
		createdAt: session.createdAt,
		closedAt: new Date().toISOString(),
		questionCount: lineItems.length,
		lineItems,
		totalAtomics: session.totalAtomics,
		totalUsd: atomicsToUsd(session.totalAtomics),
		attestation,
	};

	session.status = 'closed';
	session.invoice = invoice;
	await kvSet(sessionKey(sessionId), session, SESSION_TTL_SECONDS);
	return invoice;
}
