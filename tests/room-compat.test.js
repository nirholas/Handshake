// room-compat — the version-skew guard that keeps an unknown message type from
// killing a live session (the 2026-07-13 /play "session expired" kick-loop:
// a newer client sent 'profileReq' to an older room build, Colyseus closed the
// socket with its generic 4002, and the client misread 4002 as a play-pass
// eviction). These tests pin the contract: a '*' fallback is registered, it
// never disconnects the client, it logs each unknown type once per session,
// and the real eviction code stays clear of Colyseus's reserved codes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installUnknownMessageGuard, PLAY_PASS_EVICT_CODE } from '../multiplayer/src/room-compat.js';

function fakeRoom() {
	const handlers = {};
	return { handlers, onMessage: (type, cb) => { handlers[type] = cb; } };
}

function fakeClient(sessionId) {
	return { sessionId, leave: vi.fn(), error: vi.fn() };
}

describe('installUnknownMessageGuard', () => {
	let warn;
	beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
	afterEach(() => { warn.mockRestore(); });

	it("registers the '*' fallback Colyseus consults before its kill-the-connection default", () => {
		const room = fakeRoom();
		installUnknownMessageGuard(room, 'walk_world');
		expect(typeof room.handlers['*']).toBe('function');
	});

	it('never disconnects or errors the client for an unknown type', () => {
		const room = fakeRoom();
		installUnknownMessageGuard(room, 'walk_world');
		const client = fakeClient('abc');
		room.handlers['*'](client, 'profileReq', {});
		expect(client.leave).not.toHaveBeenCalled();
		expect(client.error).not.toHaveBeenCalled();
	});

	it('logs each unknown type once per session, so a chatty skewed client cannot flood the logs', () => {
		const room = fakeRoom();
		installUnknownMessageGuard(room, 'walk_world');
		const client = fakeClient('abc');
		for (let i = 0; i < 5; i++) room.handlers['*'](client, 'profileReq', {});
		room.handlers['*'](client, 'questReq', {});
		expect(warn).toHaveBeenCalledTimes(2);
		// A different session gets its own dedup ledger.
		room.handlers['*'](fakeClient('other'), 'profileReq', {});
		expect(warn).toHaveBeenCalledTimes(3);
	});

	it('caps per-session unknown-type logging at 16 distinct types', () => {
		const room = fakeRoom();
		installUnknownMessageGuard(room, 'walk_world');
		const client = fakeClient('abc');
		for (let i = 0; i < 40; i++) room.handlers['*'](client, `nope-${i}`, {});
		expect(warn.mock.calls.length).toBeLessThanOrEqual(16);
	});
});

describe('PLAY_PASS_EVICT_CODE', () => {
	it("avoids Colyseus's reserved close codes — especially WS_CLOSE_WITH_ERROR (4002)", () => {
		expect([1000, 4000, 4002, 4201, 4202]).not.toContain(PLAY_PASS_EVICT_CODE);
	});
});
