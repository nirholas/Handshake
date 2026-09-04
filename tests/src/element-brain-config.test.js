// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same mock set as element-boot-race.test.js — only exercising manifest
// resolution here, not rendering.
vi.mock('../../src/viewer.js', () => ({
	Viewer: class {
		constructor(stage) {
			this.stage = stage;
			this.scene = { background: null };
			this.renderer = { setClearAlpha() {} };
		}
		async load() {}
		dispose() {}
	},
}));
vi.mock('../../src/runtime/index.js', () => ({
	Runtime: class extends EventTarget {
		constructor() { super(); }
		destroy() {}
	},
}));
vi.mock('../../src/runtime/scene.js', () => ({ SceneController: class {} }));
vi.mock('../../src/skills/index.js', () => ({
	SkillRegistry: class { async install() { return { name: 'x', uri: 'x' }; } all() { return []; } },
}));
vi.mock('../../src/memory/index.js', () => ({
	Memory: { async load() { return { recall() { return []; } }; } },
}));
vi.mock('../../src/manifest.js', () => ({
	loadManifest: vi.fn(async () => ({
		spec: 'agent-manifest/0.1',
		_baseURI: '',
		name: 'Test',
		body: { uri: '' },
		brain: { provider: 'none' },
		voice: {},
		skills: [],
	})),
	fetchRelative: vi.fn(async () => ''),
}));
vi.mock('../../src/ipfs.js', () => ({ resolveURI: (u) => u }));
vi.mock('../../src/agent-resolver.js', () => ({
	resolveAgentById: vi.fn(),
	resolveByAgentId: vi.fn(async () => null),
	resolveByAvatarId: vi.fn(),
	AgentResolveError: class extends Error {},
}));
vi.mock('../../src/erc8004/resolver.js', () => ({
	parseAgentRef: () => null,
	resolveOnchainAgent: vi.fn(),
	toManifest: vi.fn(),
}));
vi.mock('../../src/pump/trade-reactions.js', () => ({
	attachTradeReactions: () => () => {},
}));
vi.mock('../../src/embed-action-bridge.js', () => ({ EmbedActionBridge: class { start() {} stop() {} } }));
vi.mock('../../src/agent-protocol.js', () => ({
	protocol: { emit() {}, on() {} },
	ACTION_TYPES: {},
}));

globalThis.fetch = vi.fn(async () => ({
	ok: false,
	status: 404,
	json: async () => ({}),
}));

const FREE_MODEL = 'google/gemma-4-31b-it:free';

beforeEach(async () => {
	if (!customElements.get('agent-3d')) {
		await import('../../src/element.js');
	}
	document.body.innerHTML = '';
});

describe('<agent-3d> brain resolution', () => {
	it('defaults to a silent brain when no brain attribute is set (body=)', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('body', 'https://example.com/avatar.glb');
		const manifest = await el._resolveManifest();
		expect(manifest.brain).toEqual({ provider: 'none' });
	});

	it('resolves brain="free" to the host-paid free model (body=)', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('body', 'https://example.com/avatar.glb');
		el.setAttribute('brain', 'free');
		const manifest = await el._resolveManifest();
		expect(manifest.brain.provider).toBe('anthropic');
		expect(manifest.brain.model).toBe(FREE_MODEL);
	});

	it('is case-insensitive and trims whitespace for the free alias', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('body', 'https://example.com/avatar.glb');
		el.setAttribute('brain', '  FREE  ');
		const manifest = await el._resolveManifest();
		expect(manifest.brain.model).toBe(FREE_MODEL);
	});

	it('passes through an explicit model id unchanged (body=)', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('body', 'https://example.com/avatar.glb');
		el.setAttribute('brain', 'claude-sonnet-4-6');
		const manifest = await el._resolveManifest();
		expect(manifest.brain.provider).toBe('anthropic');
		expect(manifest.brain.model).toBe('claude-sonnet-4-6');
	});

	it('carries the instructions attribute into brain.instructions (body=)', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('body', 'https://example.com/avatar.glb');
		el.setAttribute('brain', 'free');
		el.setAttribute('instructions', 'You are Maya.');
		const manifest = await el._resolveManifest();
		expect(manifest.brain.instructions).toBe('You are Maya.');
	});

	it('honors brain="free" on a bare .glb src= too', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('src', 'https://example.com/avatar.glb');
		el.setAttribute('brain', 'free');
		const manifest = await el._resolveManifest();
		expect(manifest.brain.provider).toBe('anthropic');
		expect(manifest.brain.model).toBe(FREE_MODEL);
	});

	it('keeps a bare .glb src= silent with no brain attribute', async () => {
		const el = document.createElement('agent-3d');
		el.setAttribute('src', 'https://example.com/avatar.glb');
		const manifest = await el._resolveManifest();
		expect(manifest.brain).toEqual({ provider: 'none' });
	});
});
