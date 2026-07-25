import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '../src/shared/log.js';

// localStorage shim — the file-based Memory persists synchronously to
// localStorage for `local` mode, so the Node test env needs a stand-in.
class LocalStorageStub {
	constructor() { this.store = new Map(); }
	getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
	setItem(k, v) { this.store.set(k, String(v)); }
	removeItem(k) { this.store.delete(k); }
	clear() { this.store.clear(); }
}

// crypto.subtle.decrypt is not used here, but importing crypto.js pulls in
// the global; node's webcrypto is fine for what these tests touch.
beforeEach(() => {
	globalThis.localStorage = new LocalStorageStub();
});

afterEach(() => {
	vi.restoreAllMocks();
	delete globalThis.localStorage;
});

const { Memory } = await import('../src/memory/index.js');

// ── none ────────────────────────────────────────────────────────────────────

describe('Memory.load — none', () => {
	it('returns an empty memory and never touches storage', async () => {
		const mem = await Memory.load({ mode: 'none', namespace: 'test' });
		expect(mem.mode).toBe('none');
		expect(mem.files.size).toBe(0);
		mem.write('user_role', { name: 'r', description: 'd', type: 'user', body: 'hi' });
		// `_persist` is a no-op for non-local modes — localStorage stays empty.
		expect(globalThis.localStorage.store.size).toBe(0);
	});
});

// ── local ───────────────────────────────────────────────────────────────────

describe('Memory.load — local', () => {
	it('round-trips a write through localStorage', async () => {
		const mem1 = await Memory.load({ mode: 'local', namespace: 'agent-1' });
		mem1.write('user_role', { name: 'role', description: 'who', type: 'user', body: 'hello' });
		expect(globalThis.localStorage.getItem('agent:agent-1:memory')).toBeTruthy();

		const mem2 = await Memory.load({ mode: 'local', namespace: 'agent-1' });
		expect(mem2.mode).toBe('local');
		expect(mem2.read('user_role')?.body.trim()).toBe('hello');
	});

	it('survives malformed localStorage by starting fresh', async () => {
		globalThis.localStorage.setItem('agent:agent-1:memory', '{not-json');
		const mem = await Memory.load({ mode: 'local', namespace: 'agent-1' });
		expect(mem.mode).toBe('local');
		expect(mem.files.size).toBe(0);
	});
});

// ── remote ──────────────────────────────────────────────────────────────────

describe('Memory.load — remote', () => {
	it('hydrates files from /api/agent-memory', async () => {
		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				entries: [
					{
						id: 'remote-id-1',
						type: 'user',
						content: '---\nname: role\ntype: user\n---\n\nremote body',
						context: { filename: 'user_role.md' },
					},
				],
			}),
		});

		const mem = await Memory.load({ mode: 'remote', namespace: 'agent-uuid', fetchFn });
		expect(mem.mode).toBe('remote');
		expect(fetchFn).toHaveBeenCalledOnce();
		const url = fetchFn.mock.calls[0][0];
		expect(url).toContain('/api/agent-memory?agentId=agent-uuid');
		expect(mem.read('user_role')?.body.trim()).toBe('remote body');
		expect(mem._remoteIds.get('user_role.md')).toBe('remote-id-1');
		// Index gets rebuilt so MEMORY.md reflects the hydrated files.
		expect(mem.indexText).toContain('user_role.md');
	});

	it('falls back to an empty store when the endpoint is unreachable', async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
		const mem = await Memory.load({ mode: 'remote', namespace: 'agent-uuid', fetchFn });
		expect(mem.mode).toBe('remote');
		expect(mem.files.size).toBe(0);
	});

	it('upserts on write — sends agentId + entry, captures returned id', async () => {
		// Initial load: empty backend
		const fetchFn = vi.fn()
			.mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [] }) });
		const mem = await Memory.load({ mode: 'remote', namespace: 'agent-uuid', fetchFn });

		// Subsequent write goes through apiFetch on the global fetch: first a
		// single-use CSRF token issue, then the upsert carrying that token.
		const upsert = vi.fn(async (url) => {
			if (String(url).startsWith('/api/csrf-token')) {
				return { ok: true, json: async () => ({ data: { token: 'tok-1' } }) };
			}
			return { ok: true, json: async () => ({ entry: { id: 'srv-id-1' } }) };
		});
		globalThis.fetch = upsert;

		mem.write('feedback_testing', {
			name: 'testing',
			description: 'how to test',
			type: 'feedback',
			body: 'hit a real DB',
		});

		// _remoteUpsert is fire-and-forget; flush it (token fetch + upsert are
		// two chained awaits, so drain the timer queue twice).
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));

		expect(upsert).toHaveBeenCalledTimes(2);
		expect(upsert.mock.calls[0][0]).toBe('/api/csrf-token');
		const [url, init] = upsert.mock.calls[1];
		expect(url).toBe('/api/agent-memory');
		expect(init.method).toBe('POST');
		expect(new Headers(init.headers).get('x-csrf-token')).toBe('tok-1');
		const sent = JSON.parse(init.body);
		expect(sent.agentId).toBe('agent-uuid');
		expect(sent.entry.type).toBe('feedback');
		expect(sent.entry.context.filename).toBe('feedback_testing.md');
		// First write has no prior id — backend returns one we cache.
		expect(sent.entry.id).toBeUndefined();
		expect(mem._remoteIds.get('feedback_testing.md')).toBe('srv-id-1');
	});
});

// ── unknown mode → fallback ─────────────────────────────────────────────────

describe('Memory.load — unknown mode fallback', () => {
	it('warns once and returns a usable local-mode memory', async () => {
		const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
		const mem = await Memory.load({ mode: 'who-knows', namespace: 'agent-uuid' });
		expect(mem.mode).toBe('local');
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toMatch(/unknown mode "who-knows"/);
		// Critically: the returned instance is fully functional. This is the
		// `_boot` resilience guarantee — a typo in the manifest can never break
		// the embed.
		mem.write('x', { name: 'x', description: '', type: 'user', body: 'ok' });
		expect(mem.read('x')?.body.trim()).toBe('ok');
	});
});

// ── custom backend registry ──────────────────────────────────────────────────

describe('Memory.registerBackend', () => {
	afterEach(() => {
		Memory.unregisterBackend('vector');
	});

	it('refuses to shadow a built-in mode and validates the backend shape', () => {
		expect(() => Memory.registerBackend('local', { load() {} })).toThrow(/built-in/);
		expect(() => Memory.registerBackend('vector', {})).toThrow(/load/);
		expect(Memory.backends()).not.toContain('vector');
	});

	it('hydrates via the backend load hook and reports the custom mode', async () => {
		const load = vi.fn().mockResolvedValue({
			files: { 'user_role.md': '---\nname: role\ntype: user\n---\n\nseeded' },
		});
		Memory.registerBackend('vector', { load });

		const mem = await Memory.load({ mode: 'vector', namespace: 'agent-9', extra: 'passed' });
		expect(mem.mode).toBe('vector');
		expect(Memory.backends()).toContain('vector');
		// Full opts object reaches the backend (namespace + arbitrary extras).
		expect(load.mock.calls[0][0]).toMatchObject({ namespace: 'agent-9', extra: 'passed' });
		expect(mem.read('user_role')?.body.trim()).toBe('seeded');
		// Index is derived from hydrated files when the backend omits one.
		expect(mem.indexText).toContain('user_role.md');
	});

	it('routes writes and notes through the persist hook', async () => {
		const persist = vi.fn();
		Memory.registerBackend('vector', { load: () => ({}), persist });

		const mem = await Memory.load({ mode: 'vector', namespace: 'agent-9' });
		mem.write('feedback_tone', { name: 't', description: 'd', type: 'feedback', body: 'b' });
		mem.note('waved', { style: 'casual' });
		await new Promise((r) => setTimeout(r, 0)); // flush fire-and-forget persist

		expect(persist).toHaveBeenCalledTimes(2);
		expect(persist.mock.calls[0][0]).toBe(mem); // receives the live Memory
		// localStorage is never touched for a custom backend.
		expect(globalThis.localStorage.store.size).toBe(0);
	});

	it('delegates recall to the backend and falls back on error', async () => {
		const recall = vi.fn().mockResolvedValue([{ file: 'x.md', score: 1 }]);
		Memory.registerBackend('vector', { load: () => ({}), recall });

		const mem = await Memory.load({ mode: 'vector', namespace: 'agent-9' });
		const hits = await mem.recall('how does the user prefer feedback', { limit: 3 });
		expect(recall).toHaveBeenCalledWith('how does the user prefer feedback', mem, { limit: 3 });
		expect(hits).toEqual([{ file: 'x.md', score: 1 }]);

		// A throwing backend recall must not break the agent — substring fallback.
		recall.mockRejectedValueOnce(new Error('vector store down'));
		vi.spyOn(log, 'warn').mockImplementation(() => {});
		mem.write('feedback_tone', { name: 't', description: 'direct critique', type: 'feedback', body: 'direct' });
		const fallback = await mem.recall('direct');
		expect(fallback[0]?.file).toBe('feedback_tone.md');
	});
});

// ── snapshot contract ────────────────────────────────────────────────────────

describe('Memory snapshot/fromSnapshot', () => {
	it('round-trips files, timeline, and the index through a JSON snapshot', async () => {
		const mem = await Memory.load({ mode: 'local', namespace: 'agent-snap' });
		mem.write('user_role', { name: 'role', description: 'who', type: 'user', body: 'hello' });
		mem.note('waved', { style: 'casual' });

		// Snapshot must survive a real JSON serialization (embed/postMessage path).
		const snap = JSON.parse(JSON.stringify(mem.snapshot()));
		expect(snap.version).toBe('memory/0.1');
		expect(snap.index).toContain('user_role.md');

		const restored = Memory.fromSnapshot(snap);
		expect(restored.mode).toBe('local');
		expect(restored.namespace).toBe('agent-snap');
		expect(restored.read('user_role')?.body.trim()).toBe('hello');
		expect(restored.indexText).toContain('user_role.md');
		expect(restored.timeline.at(-1)?.type).toBe('waved');
	});

	it('rebuilds the index when the snapshot omits it, and honors overrides', () => {
		const restored = Memory.fromSnapshot(
			{ files: { 'user_role.md': '---\nname: role\ntype: user\n---\n\nbody' } },
			{ mode: 'none', namespace: 'fresh-id' },
		);
		expect(restored.mode).toBe('none');
		expect(restored.namespace).toBe('fresh-id');
		expect(restored.indexText).toContain('user_role.md');
	});
});
