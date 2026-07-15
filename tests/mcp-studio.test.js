import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { TOOL_CATALOG, TOOL_NAMES } from '../api/_mcp-studio/tools.js';
import { PERSONA_TOOL_CATALOG, PERSONA_TOOL_NAMES } from '../api/_mcp-studio/persona-tools.js';
import { dispatch } from '../api/_mcp-studio/dispatch.js';
import { COMPONENT_URI, PERSONA_COMPONENT_URI, componentCsp } from '../api/_mcp-studio/component.js';

// The generation tools (render the model-viewer widget) + the three embodiment /
// persona tools (render the living-body embed).
const ALLOWED = ['forge_free', 'text_to_avatar', 'mesh_forge', 'rig_mesh', 'forge_avatar', 'refine_model'];
const PERSONA = ['create_agent_persona', 'get_agent_persona', 'persona_say'];
const ALL = [...ALLOWED, ...PERSONA];

// Anything that would signal a crypto / payment surface. The whole point of the
// free studio app is that NONE of this appears anywhere in its contract — the
// embodiment tools are held to the same bar (a persona is a name and a body).
const FORBIDDEN = /x402|payment|paymentrequired|wallet|usdc|solana|\$three|pump\.fun|pumpfun|token|coin|credit|price|\bpaid\b|crypto|onchain|web3|mint/i;

function mkReq() {
	return { headers: { host: 'three.ws', 'x-forwarded-proto': 'https' } };
}
const auth = { userId: null, rateKey: '127.0.0.1', scope: '' };

describe('mcp-studio catalog', () => {
	it('exposes exactly the five allowed generation tools', () => {
		const names = TOOL_CATALOG.map((t) => t.name).sort();
		expect(names).toEqual([...ALLOWED].sort());
		expect(TOOL_NAMES.sort()).toEqual([...ALLOWED].sort());
	});

	it('every tool has a title and correct generation annotations', () => {
		for (const t of TOOL_CATALOG) {
			expect(typeof t.title).toBe('string');
			expect(t.title.length).toBeGreaterThan(0);
			expect(t.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			});
		}
	});

	it('every tool links the Apps SDK widget template', () => {
		for (const t of TOOL_CATALOG) {
			expect(t._meta?.['openai/outputTemplate']).toBe(COMPONENT_URI);
		}
	});

	it('inputs are minimal — no chat-history or "just in case" fields', () => {
		for (const t of TOOL_CATALOG) {
			const props = Object.keys(t.inputSchema?.properties || {});
			expect(t.inputSchema.additionalProperties).toBe(false);
			// no history / context / session / user fields
			expect(props.some((p) => /history|context|session|user|messages|conversation/i.test(p))).toBe(false);
		}
	});

	it('exposes ZERO crypto / payment surface anywhere in the catalog', () => {
		expect(FORBIDDEN.test(JSON.stringify([...TOOL_CATALOG, ...PERSONA_TOOL_CATALOG]))).toBe(false);
	});
});

describe('mcp-studio embodiment (persona) tools', () => {
	it('exposes exactly the three persona tools', () => {
		const names = PERSONA_TOOL_CATALOG.map((t) => t.name).sort();
		expect(names).toEqual([...PERSONA].sort());
		expect(PERSONA_TOOL_NAMES.sort()).toEqual([...PERSONA].sort());
	});

	it('each persona tool has a title, a minimal closed input schema, and no leaky fields', () => {
		for (const t of PERSONA_TOOL_CATALOG) {
			expect(typeof t.title).toBe('string');
			expect(t.title.length).toBeGreaterThan(0);
			expect(t.inputSchema.additionalProperties).toBe(false);
			const props = Object.keys(t.inputSchema?.properties || {});
			expect(props.some((p) => /history|context|session|messages|conversation/i.test(p))).toBe(false);
		}
	});

	it('annotations mark create/say as writes and get as a pure read', () => {
		const byName = Object.fromEntries(PERSONA_TOOL_CATALOG.map((t) => [t.name, t]));
		expect(byName.create_agent_persona.annotations.readOnlyHint).toBe(false);
		expect(byName.persona_say.annotations.readOnlyHint).toBe(false);
		expect(byName.get_agent_persona.annotations.readOnlyHint).toBe(true);
	});

	it('carries ZERO crypto / payment surface', () => {
		expect(FORBIDDEN.test(JSON.stringify(PERSONA_TOOL_CATALOG))).toBe(false);
	});

	it('every persona tool links the persona widget template (ChatGPT only renders tool-level templates)', () => {
		for (const t of PERSONA_TOOL_CATALOG) {
			expect(t._meta?.['openai/outputTemplate']).toBe(PERSONA_COMPONENT_URI);
		}
	});
});

describe('mcp-studio dispatch', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('initialize works with no auth and advertises resources', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }, auth, mkReq());
		expect(r.result.serverInfo.name).toBe('three-ws-3d-studio-free');
		expect(r.result.capabilities.resources).toBeTruthy();
		expect(FORBIDDEN.test(JSON.stringify(r))).toBe(false);
	});

	it('tools/list returns the generation + persona tools', async () => {
		const r = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth, mkReq());
		expect(r.result.tools.map((t) => t.name).sort()).toEqual([...ALL].sort());
	});

	it('serves both Apps SDK widget resources', async () => {
		const list = await dispatch({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, auth, mkReq());
		const uris = list.result.resources.map((r) => r.uri);
		expect(uris).toEqual([COMPONENT_URI, PERSONA_COMPONENT_URI]);
		// resources/list is metadata only; the HTML body ships via resources/read.
		for (const r of list.result.resources) expect(r.text).toBeUndefined();
		const read = await dispatch(
			{ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: COMPONENT_URI } },
			auth,
			mkReq(),
		);
		expect(read.result.contents[0].text).toContain('model-viewer');
		const readPersona = await dispatch(
			{ jsonrpc: '2.0', id: 14, method: 'resources/read', params: { uri: PERSONA_COMPONENT_URI } },
			auth,
			mkReq(),
		);
		expect(readPersona.result.contents[0].text).toContain('embed_url');
		expect(readPersona.result.contents[0]._meta['openai/widgetCSP'].frame_domains).toContain('https://three.ws');
	});

	it('widget CSP allowlists the GLB storage origin (ChatGPT enforces it in the sandbox)', () => {
		const prev = process.env.S3_PUBLIC_DOMAIN;
		process.env.S3_PUBLIC_DOMAIN = 'https://pub-abc123.r2.dev';
		try {
			const csp = componentCsp();
			expect(csp.connect_domains).toContain('https://pub-abc123.r2.dev');
			expect(csp.resource_domains).toContain('https://pub-abc123.r2.dev');
		} finally {
			if (prev === undefined) delete process.env.S3_PUBLIC_DOMAIN;
			else process.env.S3_PUBLIC_DOMAIN = prev;
		}
	});

	it('widget CSP stays valid when storage is unconfigured', () => {
		const prev = process.env.S3_PUBLIC_DOMAIN;
		delete process.env.S3_PUBLIC_DOMAIN;
		try {
			const csp = componentCsp();
			expect(csp.connect_domains).toContain('https://three.ws');
			expect(csp.connect_domains.every((d) => d.startsWith('https://'))).toBe(true);
		} finally {
			if (prev !== undefined) process.env.S3_PUBLIC_DOMAIN = prev;
		}
	});

	it('unknown tool returns an error', async () => {
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pump_snapshot', arguments: {} } },
			auth,
			mkReq(),
		);
		expect(r.error).toBeTruthy();
	});

	it('forge_free returns a clean, identifier-free model with no internal fields', async () => {
		// Mock the /api/forge pipeline: a synchronous-done generation.
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				status: 'done',
				glb_url: 'https://three.ws/cdn/creations/model.glb',
				job_id: 'JOBID_K7M2Q9X4',
				creation_id: 'CREATIONID_555',
				backend: 'nvidia-internal',
			}),
		}));
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'forge_free', arguments: { prompt: 'a friendly round robot mascot' } } },
			auth,
			mkReq(),
		);
		const sc = r.result.structuredContent;
		expect(sc.glbUrl).toBe('https://three.ws/cdn/creations/model.glb');
		expect(sc.viewerUrl).toContain('/viewer?src=');
		// data minimization: no job/creation/prediction/backend/trace ids leak.
		const serialized = JSON.stringify(r.result);
		expect(serialized).not.toContain('JOBID_K7M2Q9X4');
		expect(serialized).not.toContain('CREATIONID_555');
		expect(serialized).not.toContain('nvidia-internal');
		expect(serialized).not.toContain('creation_id');
	});

	it('avatar results carry the IRL living-agent handoff; props stay static (AR bridges agents into the real world)', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'done', glb_url: 'https://three.ws/cdn/creations/scout.glb' }),
		}));
		const avatar = await dispatch(
			{ jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'text_to_avatar', arguments: { prompt: 'a friendly robot scout' } } },
			auth,
			mkReq(),
		);
		const sc = avatar.result.structuredContent;
		expect(sc.irlUrl).toBe(`https://three.ws/irl?avatar=${encodeURIComponent('https://three.ws/cdn/creations/scout.glb')}`);
		expect(sc.arUrl).toContain('kind=avatar');
		// The narration offers the living experience, not just static placement.
		expect(avatar.result.content[0].text).toContain(sc.irlUrl);

		const model = await dispatch(
			{ jsonrpc: '2.0', id: 64, method: 'tools/call', params: { name: 'forge_free', arguments: { prompt: 'a ceramic vase' } } },
			auth,
			mkReq(),
		);
		expect(model.result.structuredContent.irlUrl).toBeUndefined();
		expect(model.result.structuredContent.arUrl).not.toContain('kind=avatar');
	});

	it('rewrites bucket-domain GLB URLs to the first-party /cdn proxy (sandboxed widgets need open CORS)', async () => {
		// The public r2.dev domain only answers CORS for our own origin; ChatGPT's
		// widget iframe is cross-origin, so tool results must carry the /cdn form.
		const prev = process.env.S3_PUBLIC_DOMAIN;
		process.env.S3_PUBLIC_DOMAIN = 'https://pub-test.r2.dev';
		try {
			globalThis.fetch = vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({ status: 'done', glb_url: 'https://pub-test.r2.dev/forge/anon/abc.glb' }),
			}));
			const r = await dispatch(
				{ jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'forge_free', arguments: { prompt: 'a friendly round robot mascot' } } },
				auth,
				mkReq(),
			);
			const sc = r.result.structuredContent;
			expect(sc.glbUrl).toBe('https://three.ws/cdn/forge/anon/abc.glb');
			expect(sc.viewerUrl).toContain(encodeURIComponent('https://three.ws/cdn/forge/anon/abc.glb'));
		} finally {
			if (prev === undefined) delete process.env.S3_PUBLIC_DOMAIN;
			else process.env.S3_PUBLIC_DOMAIN = prev;
		}
	});

	it('widget veils the model-viewer with opacity, never display:none (display:none defers load forever)', async () => {
		const read = await dispatch(
			{ jsonrpc: '2.0', id: 62, method: 'resources/read', params: { uri: COMPONENT_URI } },
			auth,
			mkReq(),
		);
		const html = read.result.contents[0].text;
		const mvTag = html.match(/<model-viewer[^>]*>/)[0];
		expect(mvTag).toContain('class="veiled"');
		expect(mvTag).not.toContain('hidden');
		expect(html).toMatch(/model-viewer\.veiled\s*\{[^}]*opacity:\s*0/);
	});

	it('refuses age-inappropriate prompts before any generation', async () => {
		const spy = vi.fn();
		globalThis.fetch = spy;
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'forge_free', arguments: { prompt: 'a nude figure' } } },
			auth,
			mkReq(),
		);
		expect(r.result.isError).toBe(true);
		expect(spy).not.toHaveBeenCalled();
	});

	it('validates inputs — forge_free requires a prompt', async () => {
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'forge_free', arguments: {} } },
			auth,
			mkReq(),
		);
		expect(r.error).toBeTruthy();
		expect(r.error.message).toMatch(/invalid params/i);
	});

	it('refine_model anchors to the parent and returns a correct, growing lineage', async () => {
		// Mock /api/forge to complete synchronously with a distinct refined GLB.
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'done', glb_url: 'https://three.ws/cdn/creations/v1.glb', job_id: 'J1', creation_id: 'C1', backend: 'nvidia-internal' }),
		}));
		const r = await dispatch(
			{
				jsonrpc: '2.0',
				id: 9,
				method: 'tools/call',
				params: {
					name: 'refine_model',
					arguments: {
						glb_url: 'https://three.ws/cdn/creations/origin.glb',
						instruction: 'make it metallic',
						parent_prompt: 'a round robot mascot',
					},
				},
			},
			auth,
			mkReq(),
		);
		const sc = r.result.structuredContent;
		expect(sc.glbUrl).toBe('https://three.ws/cdn/creations/v1.glb');
		expect(sc.kind).toBe('refined model');
		// Lineage: origin (index 0) → refined (index 1), the refined one active.
		expect(sc.lineage).toHaveLength(2);
		expect(sc.lineage[0].label).toBe('Original');
		expect(sc.lineage[0].glbUrl).toBe('https://three.ws/cdn/creations/origin.glb');
		expect(sc.lineage[1].instruction).toBe('make it metallic');
		expect(sc.lineage[1].active).toBe(true);
		expect(sc.activeIndex).toBe(1);
		// The prompt the generator actually ran carries the parent forward.
		expect(sc.prompt).toBe('a round robot mascot, metallic');
		// No internal identifiers leak.
		const serialized = JSON.stringify(r.result);
		expect(serialized).not.toContain('nvidia-internal');
		expect(serialized).not.toContain('creation_id');
	});

	it('refine_model extends a passed-in lineage to three versions', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'done', glb_url: 'https://three.ws/cdn/creations/v2.glb', job_id: 'J2' }),
		}));
		const parentLineage = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/cdn/creations/origin.glb', prompt: 'a round robot mascot', instruction: null, refKind: 'origin', label: 'Original' },
			{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/cdn/creations/v1.glb', prompt: 'a round robot mascot, metallic', instruction: 'make it metallic', refKind: 'text', label: 'make it metallic' },
		];
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'refine_model', arguments: { glb_url: 'https://three.ws/cdn/creations/v1.glb', instruction: 'add wings', parent_prompt: 'a round robot mascot, metallic', parent_lineage: parentLineage } } },
			auth,
			mkReq(),
		);
		const sc = r.result.structuredContent;
		expect(sc.lineage).toHaveLength(3);
		expect(sc.lineage[2].instruction).toBe('add wings');
		expect(sc.lineage[2].parentIndex).toBe(1);
		expect(sc.activeIndex).toBe(2);
	});

	it('refine_model rejects a malformed parent_lineage and falls back to a fresh lineage', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'done', glb_url: 'https://three.ws/cdn/creations/vX.glb', job_id: 'JX' }),
		}));
		// A structurally broken lineage: two roots, non-contiguous indices — must NOT
		// be trusted/extended. The handler seeds fresh from glb_url instead.
		const broken = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/a.glb' },
			{ index: 5, parentIndex: null, glbUrl: 'https://three.ws/b.glb' },
		];
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'refine_model', arguments: { glb_url: 'https://three.ws/cdn/creations/origin.glb', instruction: 'make it red', parent_lineage: broken } } },
			auth,
			mkReq(),
		);
		const sc = r.result.structuredContent;
		// Fresh lineage rooted at glb_url → exactly 2 clean versions, single root.
		expect(sc.lineage).toHaveLength(2);
		expect(sc.lineage[0].label).toBe('Original');
		expect(sc.lineage[0].glbUrl).toBe('https://three.ws/cdn/creations/origin.glb');
		expect(sc.activeIndex).toBe(1);
	});

	it('refine_model honors a valid parent_index to branch off an earlier version', async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ status: 'done', glb_url: 'https://three.ws/cdn/creations/branch.glb', job_id: 'JB' }),
		}));
		const lineage = [
			{ index: 0, parentIndex: null, glbUrl: 'https://three.ws/o.glb', prompt: 'a robot', refKind: 'origin', label: 'Original' },
			{ index: 1, parentIndex: 0, glbUrl: 'https://three.ws/v1.glb', prompt: 'a robot, gold', instruction: 'gold', refKind: 'text', label: 'gold' },
		];
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'refine_model', arguments: { glb_url: 'https://three.ws/v1.glb', instruction: 'silver instead', parent_prompt: 'a robot', parent_lineage: lineage, parent_index: 0 } } },
			auth,
			mkReq(),
		);
		const sc = r.result.structuredContent;
		expect(sc.lineage).toHaveLength(3);
		// New version branches off the ORIGINAL (index 0), not the leaf (index 1).
		expect(sc.lineage[2].parentIndex).toBe(0);
	});

	it('refine_model requires both glb_url and instruction', async () => {
		const spy = vi.fn();
		globalThis.fetch = spy;
		const r = await dispatch(
			{ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'refine_model', arguments: { glb_url: 'https://three.ws/x.glb' } } },
			auth,
			mkReq(),
		);
		expect(r.error).toBeTruthy();
		expect(spy).not.toHaveBeenCalled();
	});
});
