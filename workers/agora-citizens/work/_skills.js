// Shared plumbing for the Agora profession WORK modules added in Task 04
// (Sculptor, Scribe, Cartographer, Crier, Appraiser, Verifier, Namekeeper).
//
// Every module is a pluggable unit with the SAME contract the Fetcher established
// (work/fetcher.js): a `run<Profession>({ cfg, citizen, job })` that produces a
// REAL artifact and returns a proof the engine submits on-chain and any Verifier
// can re-derive:
//
//     { result, resultText, proofHashHex, proofHashBytes (32),
//       resultData (≤64), deliverableUrl, bytes, ... }
//
// The invariant: proofHashHex = sha256(the exact bytes served at deliverableUrl).
// Re-download the deliverable, sha256 it, and you reproduce the on-chain proof —
// the verifiable supply chain. No mocks, no placeholders; a failed forge/brain/
// voice call throws and the citizen reports a real task failure.

import { createHash } from 'node:crypto';

// ── Proof primitives ──────────────────────────────────────────────────────────

export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest();
}
export function sha256Hex(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

// Deterministic JSON (keys sorted at every level) so a producer and a Verifier on
// different machines hash byte-identical bytes for the same object.
function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value === undefined ? null : value);
}
export function canonicalJsonBytes(obj) {
	return Buffer.from(stableStringify(obj), 'utf8');
}

// 32-byte proof as the Uint8Array completeTask wants.
export function proofBytesFromHex(hex) {
	return Uint8Array.from(Buffer.from(String(hex), 'hex'));
}

// A compact, deterministic 64-byte on-chain resultData pointer — a CID-style
// sha256 reference to the artifact. The on-chain slot is exactly [u8;64], so the
// pointer is zero-padded into a fixed 64-byte buffer. A content-addressed pointer
// is meaningless if clipped — a truncated `cid:sha256:<hex>` resolves to the wrong
// bytes (or nothing) — so an over-long pointer is REJECTED, never quietly clipped.
// Producer pointers (`agora:<profession>:cid:sha256:<32hex>`) top out at 62 bytes,
// so the guard is a correctness backstop the real path never trips.
export function packResultData(pointer) {
	const src = Buffer.from(String(pointer), 'utf8');
	if (src.length > 64) {
		throw new Error(`resultData pointer exceeds 64 bytes (${src.length}): ${String(pointer).slice(0, 48)}…`);
	}
	const buf = Buffer.alloc(64);
	src.copy(buf, 0);
	return Uint8Array.from(buf);
}

// ── The standard profession return ────────────────────────────────────────────

// Build the uniform result the engine consumes. `deliverableBytes` are the EXACT
// bytes the proof binds and that live at `deliverableUrl`.
export function buildWorkResult({ profession, citizen, deliverableUrl, deliverableBytes, summary, meta = {} }) {
	const proofHashHex = sha256Hex(deliverableBytes);
	const result = {
		worker: citizen?.agentIdHex || null,
		workerPubkey: citizen?.pubkey || null,
		profession,
		deliverableUrl,
		proofHash: proofHashHex,
		bytes: deliverableBytes.length,
		summary,
		...meta,
		completedAt: new Date().toISOString(),
	};
	return {
		result,
		resultText: JSON.stringify(result),
		proofHashHex,
		proofHashBytes: proofBytesFromHex(proofHashHex),
		// 32 hex chars (128-bit prefix) keeps the pointer ≤64 bytes even for the
		// longest profession name ("cartographer" → 62 bytes); the full proof lives
		// in the on-chain proofHash field, this is a forensic locator.
		resultData: packResultData(`agora:${profession}:cid:sha256:${proofHashHex.slice(0, 32)}`),
		deliverableUrl,
		bytes: deliverableBytes.length,
		summary,
		meta,
	};
}

// ── Work prompt ───────────────────────────────────────────────────────────────

// Best creative brief from a job. On-chain tasks carry only a 64-byte
// description; the dispatcher/board attaches the real prompt as `job.prompt`.
//
// `job.resource` is deliberately NOT a source. It is the Fetcher's x402 target
// URL, which the engine attaches to EVERY job, and work/fetcher.js reads it
// directly. Accepting it here meant a generative profession never reached its
// own default brief: a Sculptor handed a board job sculpted a mesh of the
// literal string "https://api.example.com/v0/inboxes/:inbox_id/…", producing a
// real GLB of nothing anybody asked for. A bare URL is filtered for the same
// reason, whichever field carries it: it is an address, never a brief.
export function jobPrompt(job) {
	const raw = String(job?.prompt || job?.title || job?.description || '').trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/\s/.test(raw)) return '';
	return raw;
}

// ── Deliverable storage (R2) ──────────────────────────────────────────────────

// Store the exact deliverable bytes and return their public URL — the supply
// chain's anchor. R2 is imported lazily so these modules load without the S3 SDK
// or credentials (work-only dev runs, unit tests). When R2 is unconfigured AND
// the bytes already live at a durable source URL (e.g. forge's hosted GLB), fall
// back to that URL: still real, still re-downloadable, still the same proof. With
// neither, that's a real failure — never a fabricated link.
// `optional: true` lets text/JSON deliverables degrade to inline (url: null) when
// R2 is unconfigured — the proof still binds the exact bytes; it just isn't
// re-downloadable in that environment. Binary deliverables pass a durable
// `sourceUrl` (e.g. forge's hosted GLB) so they stay re-downloadable either way.
export async function storeDeliverable({ profession, ext, contentType, bytes, sourceUrl = null, optional = false }) {
	const digest = sha256Hex(bytes);
	const key = `agora/deliverables/${profession}/${digest}.${ext}`;
	try {
		const { putObject, publicUrl } = await import('../../../api/_lib/r2.js');
		await putObject({ key, body: bytes, contentType });
		return { url: publicUrl(key), key, digest, stored: true };
	} catch (err) {
		if (sourceUrl) return { url: sourceUrl, key: null, digest, stored: false, storeError: err?.message };
		if (optional) return { url: null, key: null, digest, stored: false, storeError: err?.message };
		throw new Error(
			`deliverable storage unavailable — configure S3_*/R2 env or supply a durable source URL (${err?.message || err})`,
		);
	}
}

// ── Real HTTP against the three.ws API ────────────────────────────────────────

function joinUrl(apiBase, path) {
	// A leading "/" is a relative API path to join onto the base; anything else is
	// already an absolute URL (https:, data:, …) and is used verbatim.
	if (String(path).startsWith('/')) return `${String(apiBase || 'https://three.ws').replace(/\/+$/, '')}${path}`;
	return path;
}

export async function httpJson(apiBase, path, { method = 'GET', body, headers, query, signal } = {}) {
	const url = new URL(joinUrl(apiBase, path));
	if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
	const res = await fetch(url, {
		method,
		headers: {
			accept: 'application/json',
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			...(headers || {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal,
	});
	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}
	if (!res.ok) {
		const err = new Error(data?.message || data?.error || `HTTP ${res.status} ${path}`);
		err.status = res.status;
		err.code = data?.error || `http_${res.status}`;
		err.body = data;
		throw err;
	}
	return data;
}

export async function httpBytes(apiBase, path, { method = 'GET', body, headers, signal } = {}) {
	const url = joinUrl(apiBase, path);
	const res = await fetch(url, {
		method,
		headers: headers || {},
		body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
		signal,
	});
	if (!res.ok) {
		const peek = await res.text().catch(() => '');
		const err = new Error(`HTTP ${res.status} ${url}: ${peek.slice(0, 200)}`);
		err.status = res.status;
		throw err;
	}
	const bytes = Buffer.from(await res.arrayBuffer());
	return { bytes, contentType: res.headers.get('content-type'), headers: res.headers };
}

// POST /api/brain/chat streams Server-Sent Events; a deliverable is one payload,
// so consume the whole stream and collapse the text deltas into a single reply
// (mirrors the brain-mcp client). Free open-weight tiers (gpt-oss-120b) need no
// key; paid flagships read THREE_WS_API_KEY if present.
export async function brainChat(apiBase, { provider = 'gpt-oss-120b', system, messages, maxTokens, signal } = {}) {
	const body = { provider, messages };
	if (system) body.system = system;
	if (Number.isFinite(maxTokens)) body.maxTokens = Math.trunc(maxTokens);

	const res = await fetch(joinUrl(apiBase, '/api/brain/chat'), {
		method: 'POST',
		headers: {
			accept: 'text/event-stream',
			'content-type': 'application/json',
			...(process.env.THREE_WS_API_KEY ? { authorization: `Bearer ${process.env.THREE_WS_API_KEY}` } : {}),
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok || !res.body) {
		const raw = await res.text().catch(() => '');
		let data;
		try {
			data = raw ? JSON.parse(raw) : {};
		} catch {
			data = { raw };
		}
		const err = new Error(data?.message || data?.error || `brain HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let text = '';
	let meta = null;
	let usage = null;

	const handle = (event, data) => {
		if (!data || data === '[DONE]') return;
		if (!event || event === 'message') {
			try {
				const piece = JSON.parse(data);
				if (typeof piece === 'string') text += piece;
			} catch {
				/* keepalive */
			}
			return;
		}
		if (event === 'meta') {
			try {
				meta = JSON.parse(data);
			} catch {
				/* ignore */
			}
		} else if (event === 'done') {
			try {
				usage = JSON.parse(data)?.usage ?? usage;
			} catch {
				/* ignore */
			}
		} else if (event === 'error') {
			let message = 'brain stream error';
			try {
				message = JSON.parse(data)?.message || message;
			} catch {
				/* ignore */
			}
			throw new Error(message);
		}
	};

	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx;
		while ((idx = buf.indexOf('\n\n')) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			let event = null;
			const dataLines = [];
			for (const line of frame.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
			}
			handle(event, dataLines.join('\n'));
		}
	}

	return { text: text.trim(), meta, usage };
}
