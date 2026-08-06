// End-to-end tests for the World Lines completion ceremony (api/irl/world-lines.js).
//
// Drives the real handler against an in-memory fake `sql` and a mocked agent signer,
// exercising the anti-cheat surface the moonshot requires: challenge → complete →
// independent verify, replay rejection (the same nonce/visitor never mints twice),
// forged-nonce rejection, not-co-located rejection, and the completion cap. The
// signing + nonce + co-location logic itself is REAL (only the DB and key recovery are
// stubbed), so a regression in the cryptography fails these tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

// ── Agent signer: a fixed ed25519 keypair the handler "recovers" and signs with ──
const AGENT_SEED = new Uint8Array(32).fill(7);
const AGENT_PUB = bs58.encode(ed25519.getPublicKey(AGENT_SEED));
const AGENT_SK = (() => {
	const sk = new Uint8Array(64);
	sk.set(AGENT_SEED, 0);
	sk.set(ed25519.getPublicKey(AGENT_SEED), 32);
	return sk;
})();

const PIN = { lat: 40.7484, lng: -73.9857 };
const WL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

// In-memory database the fake sql closes over. Reset before each test.
let db;
function resetDb(overrides = {}) {
	db = {
		worldLine: {
			id: WL_ID, creator_user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
			agent_id: AGENT_ID, signer_pubkey: AGENT_PUB, pin_id: PIN_ID,
			coarse_cell: null, title: 'Find the lobby agent', prompt: 'Say hello',
			challenge_spec: { kind: 'tap', prompt: 'Say hello' },
			reward_kind: 'collectible', reward_ref: null, difficulty: 'easy',
			max_completions: null, completion_count: 0, hidden_at: null, expires_at: null,
			...overrides,
		},
		pin: { ...PIN },
		proofs: [],
		proofSeq: 0,
	};
	// Derive the real coarse cell from the pin so nonce binding matches the handler.
	const { coarseCell } = wlLib;
	db.worldLine.coarse_cell = coarseCell(PIN.lat, PIN.lng);
}

let wlLib;

// Fake Neon sql — pattern-matches the handler's queries against the template text.
const fakeSql = vi.fn(async (strings, ...values) => {
	const q = strings.join('§').replace(/\s+/g, ' ');
	const has = (s) => q.includes(s);

	if (has('CREATE TABLE') || has('CREATE INDEX') || has('CREATE UNIQUE INDEX')) return [];

	// loadWorldLine
	if (has('SELECT id, creator_user_id, agent_id, signer_pubkey, pin_id, coarse_cell')) {
		return values[0] === db.worldLine.id && !db.worldLine.hidden_at ? [db.worldLine] : [];
	}
	// resolveColocation — pin coords
	if (has('SELECT lat, lng FROM irl_pins WHERE id =')) {
		return values[0] === db.worldLine.pin_id ? [db.pin] : [];
	}
	// challenge "already completed?" probe
	if (has('SELECT id, collectible_mint FROM irl_presence_proofs')) {
		const p = db.proofs.find((x) => x.world_line_id === values[0] && x.completer_hash === values[1]);
		return p ? [{ id: p.id, collectible_mint: p.collectible_mint }] : [];
	}
	// complete "already / dupe" probe + verify-by-nonce probe
	if (has('SELECT * FROM irl_presence_proofs WHERE world_line_id =')) {
		const p = db.proofs.find((x) => x.world_line_id === values[0] && x.completer_hash === values[1]);
		return p ? [p] : [];
	}
	if (has('SELECT * FROM irl_presence_proofs WHERE nonce_id =')) {
		const p = db.proofs.find((x) => x.nonce_id === values[0]);
		return p ? [p] : [];
	}
	// agent signing key
	if (has('SELECT meta FROM agent_identities')) {
		return [{ meta: { encrypted_solana_secret: 'ciphertext' } }];
	}
	// INSERT proof
	if (has('INSERT INTO irl_presence_proofs')) {
		const [world_line_id, agent_id, signer_pubkey, coarse_cell, nonce_id, completer_hash,
			completer_user_id, completer_device, signature, signed_message, challenge_kind,
			collectible_name, reward_kind] = values;
		if (db.proofs.some((x) => x.nonce_id === nonce_id)) return []; // ON CONFLICT (nonce_id) DO NOTHING
		if (db.proofs.some((x) => x.world_line_id === world_line_id && x.completer_hash === completer_hash)) {
			throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
		}
		const row = {
			id: `00000000-0000-4000-8000-00000000000${db.proofSeq++}`,
			world_line_id, agent_id, signer_pubkey, coarse_cell, nonce_id, completer_hash,
			completer_user_id, completer_device, signature, signed_message, challenge_kind,
			collectible_name, reward_kind, collectible_mint: null, created_at: new Date().toISOString(),
		};
		db.proofs.push(row);
		return [row];
	}
	if (has('UPDATE irl_presence_proofs SET collectible_mint')) {
		const p = db.proofs.find((x) => x.id === values[1]);
		if (p) p.collectible_mint = values[0];
		return [];
	}
	if (has('UPDATE irl_world_lines SET completion_count')) {
		if (db.worldLine.max_completions == null || db.worldLine.completion_count < db.worldLine.max_completions) {
			db.worldLine.completion_count += 1;
		}
		return [];
	}
	// verify lookup (LEFT JOIN world line title)
	if (has('SELECT pr.*, w.title FROM irl_presence_proofs pr')) {
		const p = db.proofs.find((x) => x.id === values[0]);
		return p ? [{ ...p, title: db.worldLine.title }] : [];
	}
	return [];
});

vi.mock('../../api/_lib/db.js', () => ({ sql: fakeSql, isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/env.js', () => ({ env: {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: vi.fn() }));
vi.mock('../../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn() }));
vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => false, drain: vi.fn() }));
vi.mock('../../api/_lib/notify.js', () => ({ insertNotification: vi.fn() }));
vi.mock('../../api/_lib/csrf.js', () => ({ requireCsrf: vi.fn(async () => true) }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: new Proxy({}, { get: () => async () => ({ success: true }) }),
	// The coordinate reads call their limiter through the fail-closed wrapper; its
	// own behaviour is covered by tests/api/irl-nearby-limit.test.js.
	limitFailClosedRead: async (_name, fn, ...args) => {
		try { return await fn(...args); }
		catch { return { success: false, reason: 'rate_limiter_unavailable', reset: Date.now() + 60_000 }; }
	},
	clientIp: () => '1.2.3.4',
}));
vi.mock('../../api/_lib/agent-wallet.js', () => ({
	ensureAgentWallet: vi.fn(async () => ({ address: AGENT_PUB, created: false })),
	recoverSolanaAgentKeypair: vi.fn(async () => ({ secretKey: AGENT_SK })),
}));
// getSessionUser → anonymous (device-token visitor). The signer is the agent, not the
// caller, so completion needs no login.
vi.mock('../../api/_lib/auth.js', () => ({ getSessionUser: vi.fn(async () => null) }));

const handler = (await import('../../api/irl/world-lines.js')).default;
wlLib = await import('../../api/_lib/world-lines.js');

function makeReq({ method, url, body, device = 'visitor-device-1' }) {
	const json = body ? JSON.stringify(body) : '';
	const stream = body ? Readable.from([Buffer.from(json, 'utf8')]) : Readable.from([]);
	stream.method = method;
	stream.url = url;
	stream.query = {};
	stream.socket = { remoteAddress: '1.2.3.4' };
	stream.headers = {
		'content-type': 'application/json',
		...(device ? { 'x-irl-device': device } : {}),
	};
	return stream;
}
function makeRes() {
	return {
		statusCode: 0, _body: null, _h: {},
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this._body = b ?? null; },
		get headersSent() { return this._body !== null; },
		get writableEnded() { return this._body !== null; },
	};
}
async function call(reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, body: res._body ? JSON.parse(res._body) : null };
}

async function getNonce(device = 'visitor-device-1', claim = PIN) {
	const r = await call({
		method: 'POST', url: '/api/irl/world-lines/challenge', device,
		body: { world_line_id: WL_ID, lat: claim.lat, lng: claim.lng },
	});
	return r;
}

beforeEach(() => {
	resetDb();
	fakeSql.mockClear();
});

describe('challenge', () => {
	it('issues a single-use nonce to a co-located visitor', async () => {
		const r = await getNonce();
		expect(r.status).toBe(200);
		expect(typeof r.body.nonce).toBe('string');
		expect(r.body.challenge.kind).toBe('tap');
	});

	it('refuses a visitor who is not co-located', async () => {
		const r = await getNonce('visitor-device-1', { lat: 0, lng: 0 });
		expect(r.status).toBe(403);
		expect(r.body.error).toBe('not_colocated');
	});

	it('reports capacity reached', async () => {
		resetDb({ max_completions: 1, completion_count: 1 });
		const r = await getNonce();
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('capacity_reached');
	});
});

describe('complete → verify → replay', () => {
	it('mints an agent-signed proof that verifies independently, and rejects replay', async () => {
		const { body: ch } = await getNonce();
		const done = await call({
			method: 'POST', url: '/api/irl/world-lines/complete',
			body: { world_line_id: WL_ID, nonce: ch.nonce, lat: PIN.lat, lng: PIN.lng },
		});
		expect(done.status).toBe(201);
		expect(done.body.ok).toBe(true);
		expect(done.body.proof.signer_pubkey).toBe(AGENT_PUB);
		expect(done.body.collectible.mint).toMatch(/^presence:/);
		expect(db.proofs).toHaveLength(1);
		expect(db.worldLine.completion_count).toBe(1);

		// Independent verification re-checks the agent signature over the stored message.
		const proofId = done.body.proof.id;
		const v = await call({ method: 'GET', url: `/api/irl/world-lines/verify/${proofId}`, device: null });
		expect(v.status).toBe(200);
		expect(v.body.verified).toBe(true);
		expect(v.body.proof.coarse_cell).toBe(db.worldLine.coarse_cell);
		// The proof exposes nothing finer than the ~1.1 km cell — no lat/lng anywhere.
		expect(JSON.stringify(v.body)).not.toContain(String(PIN.lat));

		// Replay: the SAME nonce + visitor must not mint a second collectible.
		const replay = await call({
			method: 'POST', url: '/api/irl/world-lines/complete',
			body: { world_line_id: WL_ID, nonce: ch.nonce, lat: PIN.lat, lng: PIN.lng },
		});
		expect(replay.status).toBe(200);
		expect(replay.body.already_completed).toBe(true);
		expect(db.proofs).toHaveLength(1);
		expect(db.worldLine.completion_count).toBe(1);
	});

	it('rejects a forged / garbage nonce', async () => {
		const r = await call({
			method: 'POST', url: '/api/irl/world-lines/complete', device: 'fresh-device',
			body: { world_line_id: WL_ID, nonce: 'totally.forged', lat: PIN.lat, lng: PIN.lng },
		});
		expect(r.status).toBe(403);
		expect(r.body.error).toBe('invalid_nonce');
		expect(db.proofs).toHaveLength(0);
	});

	it('rejects completion from a non-co-located point even with a valid nonce', async () => {
		const { body: ch } = await getNonce();
		const r = await call({
			method: 'POST', url: '/api/irl/world-lines/complete',
			body: { world_line_id: WL_ID, nonce: ch.nonce, lat: 0, lng: 0 },
		});
		expect(r.status).toBe(403);
		expect(r.body.error).toBe('not_colocated');
		expect(db.proofs).toHaveLength(0);
	});

	it('refuses to mint once the completion cap is reached', async () => {
		const { body: ch } = await getNonce();
		db.worldLine.max_completions = 1;
		db.worldLine.completion_count = 1; // someone else just filled the last slot
		const r = await call({
			method: 'POST', url: '/api/irl/world-lines/complete',
			body: { world_line_id: WL_ID, nonce: ch.nonce, lat: PIN.lat, lng: PIN.lng },
		});
		expect(r.status).toBe(409);
		expect(r.body.error).toBe('capacity_reached');
		expect(db.proofs).toHaveLength(0);
	});
});

describe('quiz challenge grading', () => {
	it('rejects a wrong quiz answer and accepts the right one', async () => {
		resetDb({ challenge_spec: { kind: 'quiz', question: 'Year?', choices: ['24', '25', '26'], answer: 2 } });
		const { body: ch } = await getNonce();
		const wrong = await call({
			method: 'POST', url: '/api/irl/world-lines/complete',
			body: { world_line_id: WL_ID, nonce: ch.nonce, lat: PIN.lat, lng: PIN.lng, answer: 0 },
		});
		expect(wrong.status).toBe(422);
		expect(wrong.body.error).toBe('challenge_failed');
		expect(db.proofs).toHaveLength(0);

		const { body: ch2 } = await getNonce();
		const right = await call({
			method: 'POST', url: '/api/irl/world-lines/complete',
			body: { world_line_id: WL_ID, nonce: ch2.nonce, lat: PIN.lat, lng: PIN.lng, answer: 2 },
		});
		expect(right.status).toBe(201);
		expect(db.proofs).toHaveLength(1);
	});
});
