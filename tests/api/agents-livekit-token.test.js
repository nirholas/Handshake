// Tests for GET /api/agents/:id/livekit-token (api/agents/_id/livekit-token.js).
//
// The handler mints a short-lived LiveKit room JWT with jose. What this pins:
// the unconfigured state is a designed 503 (never a crash), auth is required,
// only the agent's owner may mint a publish-capable token for the agent's room
// (any signed-in stranger must not get one), and the minted JWT actually
// verifies against the configured secret with the right room, issuer, and
// grants.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { jwtVerify } from 'jose';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const OWNER_ID = 'user-owner';
const KEY = 'audit-livekit-key';
const SECRET = 'audit-livekit-secret-0123456789abcdef';

let agentRow = { id: AGENT_ID };
const sqlMock = vi.fn(async () => (agentRow ? [agentRow] : []));
vi.mock('../../api/_lib/db.js', () => ({
	sql: (...a) => sqlMock(...a),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

let sessionUser = { id: OWNER_ID };
vi.mock('../../api/_lib/auth.js', () => ({
	getSessionUser: vi.fn(async () => sessionUser),
	authenticateBearer: vi.fn(async () => null),
	extractBearer: vi.fn(() => null),
}));

function setLiveKitEnv() {
	process.env.LIVEKIT_API_KEY = KEY;
	process.env.LIVEKIT_API_SECRET = SECRET;
	process.env.LIVEKIT_SERVER_URL = 'wss://livekit.example.test';
}

// The handler snapshots env at module load, so set it before import.
setLiveKitEnv();
const { handleLiveKitToken } = await import('../../api/agents/_id/livekit-token.js');

async function invoke(id = AGENT_ID) {
	const req = makeReq({ method: 'GET', url: `/api/agents/${id}/livekit-token` });
	const res = makeRes();
	await handleLiveKitToken(req, res, id);
	return res;
}

beforeEach(() => {
	sessionUser = { id: OWNER_ID };
	agentRow = { id: AGENT_ID };
	vi.clearAllMocks();
});

afterAll(() => {
	delete process.env.LIVEKIT_API_KEY;
	delete process.env.LIVEKIT_API_SECRET;
	delete process.env.LIVEKIT_SERVER_URL;
});

describe('GET /api/agents/:id/livekit-token', () => {
	it('mints a verifiable room JWT for the owner', async () => {
		const res = await invoke();
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.serverUrl).toBe('wss://livekit.example.test');

		const { payload } = await jwtVerify(
			body.token,
			new TextEncoder().encode(SECRET),
			{ issuer: KEY },
		);
		expect(payload.sub).toBe(`user-${OWNER_ID}`);
		expect(payload.video.room).toBe(`agent-${AGENT_ID}`);
		expect(payload.video.roomJoin).toBe(true);
		expect(payload.video.canPublish).toBe(true);
		expect(payload.exp - payload.nbf).toBe(3600);
	});

	it('401s without auth', async () => {
		sessionUser = null;
		const res = await invoke();
		expect(res.statusCode).toBe(401);
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('404s for an agent the caller does not own (no token leaks)', async () => {
		sessionUser = { id: 'user-stranger' };
		agentRow = null;
		const res = await invoke();
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body).token).toBeUndefined();
	});

	it('404s on a non-uuid agent id', async () => {
		const res = await invoke('not-a-uuid');
		expect(res.statusCode).toBe(404);
	});

	it('503s by design when LiveKit is not configured', async () => {
		delete process.env.LIVEKIT_API_SECRET;
		// The handler reads the module-level snapshot, so re-import with env unset.
		vi.resetModules();
		const { handleLiveKitToken: fresh } = await import('../../api/agents/_id/livekit-token.js');
		const req = makeReq({ method: 'GET', url: `/api/agents/${AGENT_ID}/livekit-token` });
		const res = makeRes();
		await fresh(req, res, AGENT_ID);
		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body).error).toBe('livekit_not_configured');
		setLiveKitEnv();
	});
});
