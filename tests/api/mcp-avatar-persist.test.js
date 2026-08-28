import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Env (lazy env.* access in shared helpers) ───────────────────────────────
process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';
process.env.JWT_SECRET ||= 'test-secret-persist';
process.env.UPSTASH_REDIS_REST_URL ||= 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN ||= 'redis-token';
process.env.S3_PUBLIC_DOMAIN ||= 'https://cdn.test';
process.env.S3_BUCKET ||= 'test-bucket';

// ── SSRF guard (DNS resolution breaks on fake test hostnames) ───────────────
// save_avatar downloads the GLB through the guard's pinned fetch, which resolves
// the hostname and opens a raw socket: neither works for `cdn.test` in a unit
// test. Both entry points are stubbed to keep the guard's CONTRACT (https only,
// no private hosts) while the transport falls through to the stubbed global
// fetch below.
vi.mock('../../api/_lib/ssrf-guard.js', async (importOriginal) => {
	const mod = await importOriginal();
	const { SsrfBlockedError } = mod;
	const assertSafePublicUrl = vi.fn(async (url, opts = {}) => {
		const parsed = new URL(url);
		if (parsed.protocol === 'http:' && !opts.allowHttp)
			throw new SsrfBlockedError('http:// not allowed, use https://');
		if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
			throw new SsrfBlockedError('host resolves to a blocked range');
		return parsed;
	});
	return {
		...mod,
		assertSafePublicUrl,
		fetchSafePublicUrlPinned: vi.fn(async (url, init = {}, opts = {}) => {
			await assertSafePublicUrl(String(url), opts);
			return fetch(String(url), init);
		}),
	};
});

// ── DB (no Postgres in unit tests) ──────────────────────────────────────────
vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

// ── Rate limits ─────────────────────────────────────────────────────────────
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: {
		mcp3dGenerate: vi.fn(async () => ({ success: true, reset: Date.now() + 3600000 })),
		mcp3dStatus: vi.fn(async () => ({ success: true })),
		mcpInspect: vi.fn(async () => ({ success: true })),
		mcpOptimize: vi.fn(async () => ({ success: true })),
		mcpIp: vi.fn(async () => ({ success: true })),
		mcpUser: vi.fn(async () => ({ success: true })),
		mcpValidate: vi.fn(async () => ({ success: true })),
	},
	clientIp: vi.fn(() => '203.0.113.9'),
}));

// ── Usage (no DB) ───────────────────────────────────────────────────────────
vi.mock('../../api/_lib/usage.js', () => ({
	recordEvent: vi.fn(),
	logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

// ── Object storage ──────────────────────────────────────────────────────────
const r2State = { put: vi.fn(async () => {}) };
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...a) => r2State.put(...a),
	headObject: vi.fn(async () => null),
	publicUrl: (key) => `https://cdn.test/${key}`,
	presignGet: vi.fn(async ({ key }) => `https://cdn.test/signed/${key}`),
}));

// ── GLB inspection (avoid parsing a real binary in unit tests) ──────────────
const glbState = { valid: true };
vi.mock('../../api/_lib/glb-inspect.js', () => ({
	isValidGlbHeader: () => glbState.valid,
	inspectGlb: () => ({
		isRigged: false,
		meshCount: 1,
		animationCount: 0,
		skinCount: 0,
		skeletonJointCount: 0,
		nodeCount: 1,
		generator: 'test',
	}),
}));

// ── Avatar service (DB-backed CRUD) ─────────────────────────────────────────
const avState = { avatar: null };
const createAvatar = vi.fn(async ({ input }) => ({
	id: 'avatar-uuid-0001',
	slug: input.slug,
	name: input.name,
	visibility: input.visibility,
	size_bytes: input.size_bytes,
	source: input.source,
	model_url: input.visibility === 'private' ? null : `https://cdn.test/u/user-1/${input.slug}.glb`,
}));
vi.mock('../../api/_lib/avatars.js', () => ({
	createAvatar,
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}/x.glb`,
	getAvatar: vi.fn(async () => avState.avatar),
	getAvatarBySlug: vi.fn(async () => avState.avatar),
	searchPublicAvatars: vi.fn(async () => ({ avatars: [] })),
	listAvatars: vi.fn(async () => ({ avatars: [] })),
	resolveAvatarUrl: vi.fn(async () => ({ url: 'https://cdn.test/m.glb', cdn: true })),
	deleteAvatar: vi.fn(async () => true),
}));

// ── Render layer (mock the chromium pipeline; keep resolveRenderParams real) ─
const renderState = {
	fn: vi.fn(async ({ params }) => ({
		cached: false,
		key: 'renders/avatar-uuid-0001/abc.png',
		imageUrl: 'https://cdn.test/renders/avatar-uuid-0001/abc.png',
		buffer: Buffer.from([0x89]),
		contentType: `image/${params.format}`,
	})),
};
vi.mock('../../api/_lib/avatar-render.js', async (importOriginal) => {
	const mod = await importOriginal();
	return { ...mod, renderAvatarImage: (...a) => renderState.fn(...a) };
});

// ── Global fetch (save_avatar copies the provider GLB) ──────────────────────
vi.stubGlobal(
	'fetch',
	vi.fn(async () => ({
		ok: true,
		status: 200,
		headers: { get: () => '512' },
		arrayBuffer: async () => new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer,
	})),
);

const { toolDefs: studioDefs } = await import('../../api/_mcp3d/tools/studio.js');
const { toolDefs: avatarDefs } = await import('../../api/_mcp/tools/avatars.js');
const { TOOL_CATALOG: studioCatalog } = await import('../../api/_mcp3d/catalog.js');
const { TOOL_CATALOG: mainCatalog } = await import('../../api/_mcp/catalog.js');

const studioTool = (name) => studioDefs.find((d) => d.name === name);
const avatarTool = (name) => avatarDefs.find((d) => d.name === name);

beforeEach(() => {
	r2State.put.mockClear();
	createAvatar.mockClear();
	renderState.fn.mockClear();
	glbState.valid = true;
	avState.avatar = null;
});

describe('catalog assembly', () => {
	it('lists save_avatar on the 3D Studio server', () => {
		expect(studioCatalog.map((t) => t.name)).toContain('save_avatar');
	});
	it('lists render_avatar_image on the main server', () => {
		expect(mainCatalog.map((t) => t.name)).toContain('render_avatar_image');
	});
	it('keeps each tool on its own server (save on 3D Studio, render on main)', () => {
		expect(mainCatalog.map((t) => t.name)).not.toContain('save_avatar');
		expect(studioCatalog.map((t) => t.name)).not.toContain('render_avatar_image');
	});
});

describe('save_avatar', () => {
	const AUTH = { userId: 'user-1', scope: 'avatars:write', source: 'session' };

	it('persists a public GLB as a durable avatar (happy path)', async () => {
		const r = await studioTool('save_avatar').handler(
			{ glb_url: 'https://cdn.test/gen.glb', name: 'My Hero', visibility: 'unlisted' },
			AUTH,
		);
		// Copied into our own storage under the caller's namespace.
		expect(r2State.put).toHaveBeenCalledTimes(1);
		expect(r2State.put.mock.calls[0][0].key).toMatch(/^u\/user-1\//);
		// Registered as a studio-sourced avatar owned by the caller.
		expect(createAvatar).toHaveBeenCalledTimes(1);
		expect(createAvatar.mock.calls[0][0].userId).toBe('user-1');
		expect(createAvatar.mock.calls[0][0].input.source).toBe('studio');
		expect(createAvatar.mock.calls[0][0].input.visibility).toBe('unlisted');
		// Returns the bridge fields.
		expect(r.structuredContent).toMatchObject({
			avatar_id: 'avatar-uuid-0001',
			slug: expect.stringMatching(/^studio-/),
			model_url: expect.stringContaining('https://cdn.test/'),
			view_url: 'https://three.ws/avatars/avatar-uuid-0001',
		});
		expect(r.isError).toBeUndefined();
	});

	it('rejects an unauthenticated (pay-per-call) caller with a sign-in error', async () => {
		const r = await studioTool('save_avatar').handler(
			{ glb_url: 'https://cdn.test/gen.glb', name: 'My Hero' },
			{ userId: null, scope: '', source: 'x402' },
		);
		expect(r.isError).toBe(true);
		expect(r.structuredContent.status).toBe('sign_in_required');
		expect(r2State.put).not.toHaveBeenCalled();
		expect(createAvatar).not.toHaveBeenCalled();
	});

	it('rejects a non-public glb_url (SSRF guard)', async () => {
		const r = await studioTool('save_avatar').handler(
			{ glb_url: 'http://localhost/secret.glb', name: 'Hero' },
			AUTH,
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/public https url/i);
		expect(r2State.put).not.toHaveBeenCalled();
		expect(createAvatar).not.toHaveBeenCalled();
	});

	it('rejects a URL that is not a valid GLB', async () => {
		glbState.valid = false;
		const r = await studioTool('save_avatar').handler(
			{ glb_url: 'https://cdn.test/not-a-model.glb', name: 'Hero' },
			AUTH,
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/valid GLB/i);
		expect(createAvatar).not.toHaveBeenCalled();
	});
});

describe('render_avatar_image', () => {
	const AUTH = { userId: 'user-1', scope: 'avatars:read', source: 'session' };

	it('renders a stored avatar and returns the image URL (happy path)', async () => {
		avState.avatar = {
			id: 'avatar-uuid-0001',
			name: 'Hero',
			visibility: 'public',
			updated_at: '2026-01-01T00:00:00Z',
			model_url: 'https://cdn.test/m.glb',
		};
		const r = await avatarTool('render_avatar_image').handler(
			{ avatar_id: 'avatar-uuid-0001', scene: 'portrait' },
			AUTH,
		);
		expect(renderState.fn).toHaveBeenCalledTimes(1);
		// Renders from the resolved (signed/public) URL, awaiting the upload so the URL is live.
		expect(renderState.fn.mock.calls[0][0].awaitUpload).toBe(true);
		expect(renderState.fn.mock.calls[0][0].params.scene).toBe('portrait');
		expect(r.structuredContent).toEqual({
			image_url: 'https://cdn.test/renders/avatar-uuid-0001/abc.png',
			scene: 'portrait',
			cached: false,
		});
		expect(r.isError).toBeUndefined();
	});

	it('rejects an unknown pose without invoking the render pipeline', async () => {
		avState.avatar = {
			id: 'avatar-uuid-0001',
			name: 'Hero',
			visibility: 'public',
			updated_at: '2026-01-01T00:00:00Z',
			model_url: 'https://cdn.test/m.glb',
		};
		const r = await avatarTool('render_avatar_image').handler(
			{ avatar_id: 'avatar-uuid-0001', pose: 'definitely-not-a-pose' },
			AUTH,
		);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/unknown pose/i);
		expect(renderState.fn).not.toHaveBeenCalled();
	});

	it('reports a missing / inaccessible avatar as not found', async () => {
		avState.avatar = null;
		await expect(
			avatarTool('render_avatar_image').handler({ avatar_id: 'avatar-uuid-9999' }, AUTH),
		).rejects.toThrow(/not found/i);
		expect(renderState.fn).not.toHaveBeenCalled();
	});
});

describe('render_avatar', () => {
	const AUTH = { userId: 'user-1', scope: 'avatars:read', source: 'session' };
	const AVATAR = {
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Hero',
		visibility: 'public',
		model_url: 'https://cdn.test/m.glb',
	};

	it('returns viewer HTML as an inline text/html resource, not as chat text', async () => {
		avState.avatar = AVATAR;
		const r = await avatarTool('render_avatar').handler({ id: AVATAR.id }, AUTH);

		expect(r.isError).toBeUndefined();
		// Chat text stays short; the document rides in the resource entry.
		expect(r.content[0].type).toBe('text');
		expect(r.content[0].text).not.toContain('<model-viewer');
		const resource = r.content[1];
		expect(resource.type).toBe('resource');
		expect(resource.resource.mimeType).toBe('text/html');
		expect(resource.resource.uri).toBe(`avatar://${AVATAR.id}`);
		expect(resource.resource.text).toContain('<model-viewer');
		expect(resource.resource.text).toContain('src="https://cdn.test/m.glb"');
		expect(r.structuredContent.html).toBe(resource.resource.text);
	});

	it('drops CSS and poster arguments that could break out of the document', async () => {
		avState.avatar = AVATAR;
		const r = await avatarTool('render_avatar').handler(
			{
				id: AVATAR.id,
				background: 'red;}body{background:url(https://evil.test/beacon)}',
				poster: 'javascript:alert(1)',
			},
			AUTH,
		);
		const html = r.structuredContent.html;
		expect(html).not.toContain('evil.test');
		expect(html).not.toContain('javascript:alert(1)');
		expect(html).toContain('background:transparent');
	});

	// The surfaces.mcp gate: an agent that has switched the MCP surface off must
	// get a machine-readable slug AND a reason a client can show its user.
	it('refuses an avatar whose agent disallows the MCP surface', async () => {
		avState.avatar = AVATAR;
		const { sql } = await import('../../api/_lib/db.js');
		sql.mockResolvedValueOnce([{ embed_policy: { surfaces: { mcp: false } } }]);

		await expect(
			avatarTool('render_avatar').handler({ id: AVATAR.id }, AUTH),
		).rejects.toMatchObject({
			code: -32000,
			message: 'embed_denied_surface',
			data: { reason: expect.stringContaining('MCP surface'), avatar_id: AVATAR.id },
		});
	});

	it('renders normally when the owning agent leaves the MCP surface enabled', async () => {
		avState.avatar = AVATAR;
		const { sql } = await import('../../api/_lib/db.js');
		sql.mockResolvedValueOnce([{ embed_policy: { surfaces: { mcp: true } } }]);

		const r = await avatarTool('render_avatar').handler({ id: AVATAR.id }, AUTH);
		expect(r.structuredContent.html).toContain('<model-viewer');
	});

	it('reports a missing avatar as not found', async () => {
		avState.avatar = null;
		await expect(avatarTool('render_avatar').handler({ id: AVATAR.id }, AUTH)).rejects.toThrow(
			/not found/i,
		);
	});
});
