import { describe, it, expect } from 'vitest';
import { normalize } from '../../src/manifest.js';

describe('normalize — full AGENT_MANIFEST', () => {
	it('passes through a manifest whose spec is agent-manifest/0.1', () => {
		const json = {
			spec: 'agent-manifest/0.1',
			name: 'Ada',
			body: { uri: 'model.glb', format: 'gltf-binary' },
			brain: { provider: 'anthropic' },
		};
		const m = normalize(json, { baseURI: 'https://example.com/' });
		expect(m.spec).toBe('agent-manifest/0.1');
		expect(m.name).toBe('Ada');
		expect(m._baseURI).toBe('https://example.com/');
		expect(m.body.uri).toBe('model.glb');
	});

	it('accepts any agent-manifest/* version prefix', () => {
		const json = { spec: 'agent-manifest/0.9', name: 'X' };
		const m = normalize(json);
		expect(m.spec).toBe('agent-manifest/0.9');
	});

	it('defaults empty body and backfills body.uri from image', () => {
		const json = {
			spec: 'agent-manifest/0.1',
			name: 'A',
			image: 'https://example.com/ada.glb',
		};
		const m = normalize(json);
		expect(m.body.uri).toBe('https://example.com/ada.glb');
	});

	it('does not overwrite body.uri when already set', () => {
		const json = {
			spec: 'agent-manifest/0.1',
			name: 'A',
			image: 'https://example.com/thumb.png',
			body: { uri: 'model.glb' },
		};
		const m = normalize(json);
		expect(m.body.uri).toBe('model.glb');
	});

	it('defaults baseURI to empty string when not passed', () => {
		const m = normalize({ spec: 'agent-manifest/0.1', name: 'A' });
		expect(m._baseURI).toBe('');
	});
});

describe('normalize — ERC-8004 registration JSON', () => {
	it('adapts eip-8004 type into a manifest', () => {
		const json = {
			type: ['eip-8004', 'agent-registration'],
			name: 'Bob',
			description: 'a bot',
			image: 'https://example.com/thumb.png',
			registrations: [{ agentId: 42 }],
			services: [{ name: 'something', uri: 'x' }],
		};
		const m = normalize(json);
		expect(m.spec).toBe('agent-manifest/0.1');
		expect(m._source).toBe('erc8004-registration');
		expect(m.name).toBe('Bob');
		expect(m.description).toBe('a bot');
		expect(m.id.agentId).toBe('42');
		expect(m.brain.provider).toBe('none');
		expect(m.memory.mode).toBe('local');
		expect(m.tools).toEqual(['wave', 'lookAt', 'play_clip', 'setExpression', 'speak', 'remember']);
		expect(m.services).toEqual([{ name: 'something', uri: 'x' }]);
	});

	it('prefers avatar3D service URI over top-level image for body.uri', () => {
		const json = {
			type: ['eip-8004'],
			name: 'C',
			image: 'https://example.com/thumb.png',
			registrations: [{ agentId: 1 }],
			services: [
				{
					name: 'avatar',
					type: 'avatar-3d',
					endpoint: 'https://example.com/ada.glb',
				},
			],
		};
		const m = normalize(json);
		expect(m.body.uri).toBe('https://example.com/ada.glb');
	});

	it('falls back to image when no 3D avatar service declared', () => {
		const json = {
			type: ['eip-8004'],
			name: 'D',
			image: 'https://example.com/thumb.png',
			registrations: [{ agentId: 2 }],
			services: [],
		};
		const m = normalize(json);
		// image may itself be a 2D thumbnail; we still use it as the last-resort
		// body URI so the viewer has something to try.
		expect(m.body.uri).toBe('https://example.com/thumb.png');
	});

	it('coerces registrations array missing to empty-id result', () => {
		const json = {
			type: ['eip-8004'],
			name: 'E',
			image: '',
		};
		const m = normalize(json);
		expect(m.id.agentId).toBeUndefined();
	});

	it('preserves x402Support and embedPolicy passthroughs', () => {
		const json = {
			type: ['eip-8004'],
			name: 'F',
			registrations: [{ agentId: 1 }],
			x402Support: true,
			embedPolicy: { allowOrigins: ['https://good.example'] },
		};
		const m = normalize(json);
		expect(m.x402Support).toBe(true);
		expect(m.embedPolicy).toEqual({ allowOrigins: ['https://good.example'] });
	});

	it('defaults services to empty array when not an array', () => {
		const json = {
			type: ['eip-8004'],
			name: 'G',
			registrations: [{ agentId: 1 }],
			services: 'not-an-array',
		};
		const m = normalize(json);
		expect(m.services).toEqual([]);
	});

	it('resolves ipfs:// URI on the avatar body', () => {
		const json = {
			type: ['eip-8004'],
			name: 'H',
			registrations: [{ agentId: 1 }],
			services: [
				{
					name: 'avatar',
					type: 'avatar-3d',
					endpoint: 'ipfs://QmTestCID',
				},
			],
		};
		const m = normalize(json);
		expect(m.body.uri).toMatch(/^https:\/\/.+\/ipfs\/QmTestCID$/);
	});
});

describe('normalize — unknown / partial JSON (best effort)', () => {
	it('returns a manifest shape with safe defaults', () => {
		const m = normalize({});
		expect(m.spec).toBe('agent-manifest/0.1');
		expect(m.name).toBe('Unnamed agent');
		expect(m.description).toBe('');
		expect(m.body.uri).toBe('');
		expect(m.body.format).toBe('gltf-binary');
		expect(m.brain).toEqual({ provider: 'none' });
		expect(m.memory).toEqual({ mode: 'local' });
		expect(m.tools).toEqual(['wave', 'lookAt', 'play_clip', 'setExpression', 'speak', 'remember']);
		expect(m.version).toBe('0.1.0');
	});

	it('uses json.model when body.uri missing', () => {
		const m = normalize({ model: 'custom.glb' });
		expect(m.body.uri).toBe('custom.glb');
	});

	it('prefers body.uri over json.image and json.model', () => {
		const m = normalize({
			body: { uri: 'body.glb' },
			image: 'image.glb',
			model: 'model.glb',
		});
		expect(m.body.uri).toBe('body.glb');
	});

	it('passes through custom skills/tools/version', () => {
		const m = normalize({
			name: 'Custom',
			skills: [{ name: 'greet' }],
			tools: ['wave'],
			version: '2.0.0',
		});
		expect(m.skills).toEqual([{ name: 'greet' }]);
		expect(m.tools).toEqual(['wave']);
		expect(m.version).toBe('2.0.0');
	});
});
