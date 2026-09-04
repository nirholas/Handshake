/**
 * Forge generation webhooks (`forge.completed` / `forge.failed`).
 *
 * Two properties matter more than "an event is emitted", and both are easy to
 * regress:
 *
 *   1. `forge.completed` rides materializeCreation, the one writer every lane
 *      finishes through, and that writer is idempotent (a repeat poll after
 *      completion returns the durable copy early). A subscriber must therefore
 *      see exactly one event per job, not one per poll.
 *   2. `forge.failed` must NOT fire for a job the platform is still retrying.
 *      A lane failure that gets redispatched calls markFailed and is then
 *      superseded, so hanging the event off markFailed would report a live job
 *      as dead. It hangs off notifyForgeFailed instead, which the finalizer
 *      calls only when nothing is left to try.
 *
 * Only the network / db / object-storage boundaries are stubbed, matching the
 * conventions in tests/forge-store-materialize.test.js.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FOX_GLB = readFileSync(resolve(process.cwd(), 'public/avatars/fox.glb'));

beforeAll(() => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://test:test@localhost:5432/test',
		S3_ENDPOINT: 'https://s3.example.com',
		S3_BUCKET: 'test-bucket',
		S3_PUBLIC_DOMAIN: 'https://cdn.example.com',
		S3_ACCESS_KEY_ID: 'test-key',
		S3_SECRET_ACCESS_KEY: 'test-secret',
	});
});

// The row starts pending and flips to done, so a second materialize call takes
// the idempotent early-return branch exactly as production does.
const row = {
	id: 'creation-hook',
	status: 'pending',
	glb_url: null,
	glb_key: null,
	user_id: 'user-42',
	prompt: 'a low poly fox',
	preview_image_url: null,
	views_requested: 0,
	views_used: null,
	multiview: false,
	backend: 'trellis_selfhost',
	tier: 'draft',
	path: 'image',
	model_category: null,
	created_at: new Date(Date.now() - 5_000).toISOString(),
};

const sqlMock = vi.fn(async (strings) => {
	const text = strings.join(' ');
	if (text.includes('select')) return [row];
	if (text.includes('update forge_creations') && text.includes("status = 'done'")) {
		row.status = 'done';
		row.glb_url = `https://cdn.example.com/forge/client-1/${row.id}.glb`;
		return [];
	}
	return [];
});

vi.mock('../api/_lib/db.js', () => ({
	sql: (...args) => sqlMock(...args),
	isDbUnavailableError: () => false,
}));

vi.mock('../api/_lib/r2.js', () => ({
	putObject: vi.fn(async ({ key }) => ({ key })),
	objectStorageConfigured: () => true,
	publicUrl: (key) => `https://cdn.example.com/${key}`,
}));

vi.mock('../api/_lib/forge-events.js', () => ({
	recordGenerationEvent: vi.fn(async () => {}),
}));

// Streak/badge side effects are unrelated fire-and-forget writes on the same
// signed-in branch; stub them so they cannot reach the db mock.
vi.mock('../api/_lib/streaks.js', () => ({
	recordDailyActivity: vi.fn(async () => {}),
	maybeAwardFirstCreation: vi.fn(async () => {}),
}));

const dispatchWebhooks = vi.fn(async () => {});
vi.mock('../api/_lib/webhook-dispatch.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, dispatchWebhooks: (...args) => dispatchWebhooks(...args) };
});

const insertNotification = vi.fn(async () => {});
vi.mock('../api/_lib/notify.js', () => ({
	insertNotification: (...args) => insertNotification(...args),
	emailAllowedForType: vi.fn(async () => false),
}));

vi.mock('../api/_lib/email.js', () => ({
	sendForgeCompleteEmail: vi.fn(async () => {}),
}));

const { materializeCreation } = await import('../api/_lib/forge-store.js');
const { notifyForgeFailed } = await import('../api/_lib/forge-notify.js');
const { EVENT_TYPES, selectEventTypes } = await import('../api/_lib/webhook-dispatch.js');

function stubFetch(buf) {
	global.fetch = vi.fn(async () => ({
		ok: true,
		headers: { get: () => 'model/gltf-binary' },
		arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	}));
}

afterEach(() => {
	dispatchWebhooks.mockClear();
	insertNotification.mockClear();
	delete global.fetch;
});

describe('forge generation webhooks', () => {
	it('advertises both generation events, so a developer can subscribe to them', () => {
		expect(EVENT_TYPES).toContain('forge.completed');
		expect(EVENT_TYPES).toContain('forge.failed');
		// An explicit subscription to just these two must be accepted, not
		// filtered down to nothing by the unknown-event guard.
		expect(selectEventTypes(['forge.completed', 'forge.failed'])).toEqual({
			events: ['forge.completed', 'forge.failed'],
		});
	});

	it('fires forge.completed exactly once per job, with the artifact a subscriber needs', async () => {
		row.status = 'pending';
		row.glb_url = null;
		stubFetch(FOX_GLB);
		const out = await materializeCreation({
			replicateJobId: 'job-hook',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/fox.glb',
		});
		expect(out.glbUrl).toContain(row.id);

		const calls = dispatchWebhooks.mock.calls.filter((c) => c[0].eventType === 'forge.completed');
		expect(calls).toHaveLength(1);
		const { userId, data } = calls[0][0];
		expect(userId).toBe('user-42');
		expect(data.id).toBe(row.id);
		expect(data.status).toBe('done');
		expect(data.glb_url).toBe(out.glbUrl);
		expect(data.backend).toBe('trellis_selfhost');
		expect(data.tier).toBe('draft');
		expect(data.size_bytes).toBeGreaterThan(0);

		// A second poll hits the idempotent early return: no duplicate delivery.
		stubFetch(FOX_GLB);
		await materializeCreation({
			replicateJobId: 'job-hook',
			clientKey: 'client-1',
			glbUrl: 'https://provider.example/fox.glb',
		});
		expect(
			dispatchWebhooks.mock.calls.filter((c) => c[0].eventType === 'forge.completed'),
		).toHaveLength(1);
	});

	it('fires forge.failed from the terminal-failure path, carrying the id and the lane', async () => {
		await notifyForgeFailed({
			userId: 'user-42',
			creationId: 'creation-dead',
			prompt: 'a low poly fox',
			error: 'generation timed out after 45 minutes',
			backend: 'trellis_selfhost',
			tier: 'draft',
		});
		const calls = dispatchWebhooks.mock.calls.filter((c) => c[0].eventType === 'forge.failed');
		expect(calls).toHaveLength(1);
		expect(calls[0][0].data).toMatchObject({
			id: 'creation-dead',
			status: 'failed',
			error: 'generation timed out after 45 minutes',
			backend: 'trellis_selfhost',
		});
		// The human-facing notification still goes out alongside it.
		expect(insertNotification).toHaveBeenCalledWith('user-42', 'forge_failed', expect.any(Object));
	});

	it('stays silent for an anonymous generation, which has no account to deliver to', async () => {
		await notifyForgeFailed({ userId: null, creationId: 'creation-anon', error: 'boom' });
		expect(dispatchWebhooks).not.toHaveBeenCalled();
		expect(insertNotification).not.toHaveBeenCalled();
	});
});
