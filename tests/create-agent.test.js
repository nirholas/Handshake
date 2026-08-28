// @three-ws/create-agent: the one-command path from a sentence to a rigged 3D
// character.
//
// The network half is exercised through an injected fetch (the real free lane
// takes minutes and costs GPU time); the file half runs against a real temp
// directory, because "it wrote a project you can open" is the whole promise.

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../packages/create-agent/src/args.js';
import { readForgeResult, callForge, ForgeError } from '../packages/create-agent/src/forge.js';
import {
	slugify,
	titleFrom,
	embedSnippet,
	demoPage,
	projectFiles,
	LOADER_URL,
} from '../packages/create-agent/src/scaffold.js';
import { createAgent } from '../packages/create-agent/src/index.js';

const RESULT = {
	kind: 'avatar',
	glbUrl: 'https://three.ws/cdn/creations/abc/rigged.glb',
	viewerUrl: 'https://three.ws/viewer?src=abc',
	studioUrl: 'https://three.ws/studio/abc',
	rigged: true,
	backend: 'hunyuan3d',
	durationMs: 84_000,
};

function rpcOk(structured = RESULT) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ jsonrpc: '2.0', id: 1, result: { structuredContent: structured } }),
	};
}

describe('parseArgs', () => {
	it('takes the description as bare words, so quoting is optional', () => {
		expect(parseArgs(['a', 'friendly', 'astronaut']).prompt).toBe('a friendly astronaut');
	});

	it('defaults to a rigged humanoid with a local model file', () => {
		const opts = parseArgs(['a knight']);
		expect(opts.rig).toBe(true);
		expect(opts.download).toBe(true);
	});

	it('reads every documented flag', () => {
		const opts = parseArgs([
			'a knight',
			'--out',
			'./k',
			'--name',
			'Sir',
			'--object',
			'--no-download',
			'--json',
			'--origin',
			'http://localhost:3000',
		]);
		expect(opts).toMatchObject({
			prompt: 'a knight',
			out: './k',
			name: 'Sir',
			rig: false,
			download: false,
			json: true,
			origin: 'http://localhost:3000',
		});
	});

	it('flags an unknown option rather than silently ignoring it', () => {
		expect(parseArgs(['a knight', '--turbo']).unknown).toBe('--turbo');
	});

	it('accepts a reference image instead of a description', () => {
		expect(parseArgs(['--photo', 'https://example.com/me.jpg']).imageUrl).toBe(
			'https://example.com/me.jpg',
		);
	});
});

describe('readForgeResult', () => {
	it('normalizes the tool payload into one shape', () => {
		const body = { result: { structuredContent: RESULT } };
		expect(readForgeResult(body, { kind: 'avatar' })).toMatchObject({
			glbUrl: RESULT.glbUrl,
			rigged: true,
			backend: 'hunyuan3d',
		});
	});

	it('accepts riggedGlbUrl, which the avatar lane returns instead', () => {
		const body = { result: { riggedGlbUrl: 'https://three.ws/x.glb' } };
		expect(readForgeResult(body, { kind: 'avatar' }).glbUrl).toBe('https://three.ws/x.glb');
	});

	it('synthesizes a viewer link when the tool did not send one', () => {
		const body = { result: { glbUrl: 'https://three.ws/x.glb' } };
		expect(readForgeResult(body, { kind: 'model' }).viewerUrl).toBe(
			'https://three.ws/viewer?src=https%3A%2F%2Fthree.ws%2Fx.glb',
		);
	});

	it('surfaces a JSON-RPC error as a readable failure', () => {
		expect(() => readForgeResult({ error: { message: 'prompt rejected' } }, { kind: 'avatar' })).toThrow(
			/prompt rejected/,
		);
	});

	it('refuses a response with no model rather than scaffolding an empty project', () => {
		expect(() => readForgeResult({ result: {} }, { kind: 'avatar' })).toThrow(/without a model URL/);
	});
});

describe('callForge', () => {
	it('calls the public JSON-RPC endpoint with the tool and arguments', async () => {
		const fetchImpl = vi.fn(async () => rpcOk());
		await callForge({ tool: 'forge_avatar', args: { prompt: 'a knight' }, fetchImpl });
		const [url, init] = fetchImpl.mock.calls[0];
		expect(String(url)).toBe('https://three.ws/api/mcp-studio');
		expect(JSON.parse(init.body)).toMatchObject({
			method: 'tools/call',
			params: { name: 'forge_avatar', arguments: { prompt: 'a knight' } },
		});
		expect(init.signal).toBeDefined();
	});

	it('reports the phases a caller can actually show', async () => {
		const seen = [];
		await callForge({
			tool: 'forge_avatar',
			args: { prompt: 'a knight' },
			fetchImpl: async () => rpcOk(),
			onProgress: (e) => seen.push(e.phase),
		});
		expect(seen).toEqual(['submitted', 'done']);
	});

	it('turns an HTTP failure into a ForgeError carrying the status', async () => {
		const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
		await expect(callForge({ tool: 'forge_free', args: {}, fetchImpl })).rejects.toMatchObject({
			name: 'ForgeError',
			code: 'http_503',
		});
	});

	it('explains an unreachable host instead of leaking a socket error', async () => {
		const fetchImpl = async () => {
			throw new Error('ENOTFOUND');
		};
		await expect(callForge({ tool: 'forge_free', args: {}, fetchImpl })).rejects.toThrow(
			/could not reach three\.ws/,
		);
	});
});

describe('scaffold', () => {
	it('derives a short directory name and a display name from the prompt', () => {
		expect(slugify('a friendly cartoon astronaut in a glossy white suit')).toBe(
			'a-friendly-cartoon-astronaut',
		);
		expect(titleFrom('a friendly cartoon astronaut')).toBe('Friendly Cartoon Astronaut');
		// A name is the subject, not the first four words of the sentence: the
		// real runs produced "Friendly Cartoon Astronaut In" and
		// "Knight With Worn Steel" before this cut at the first preposition.
		expect(titleFrom('a friendly cartoon astronaut in a glossy white suit')).toBe(
			'Friendly Cartoon Astronaut',
		);
		expect(titleFrom('a knight with worn steel armor')).toBe('Knight');
		expect(slugify('!!!')).toBe('agent');
		expect(titleFrom('')).toBe('Agent');
	});

	it('emits an embed snippet that is the whole integration', () => {
		const snippet = embedSnippet({ name: 'Astro', glbUrl: 'https://three.ws/a.glb' });
		expect(snippet).toContain(LOADER_URL);
		expect(snippet).toContain('body="https://three.ws/a.glb"');
		expect(snippet).toContain('name="Astro"');
	});

	it('escapes a prompt that would otherwise break the generated page', () => {
		const page = demoPage({
			name: '<img onerror=alert(1)>',
			prompt: 'a "quoted" & dangerous <script>',
			glbUrl: 'https://three.ws/a.glb',
			viewerUrl: 'https://three.ws/viewer',
			rigged: true,
		});
		expect(page).not.toContain('<script>a');
		expect(page).toContain('&lt;img onerror=alert(1)&gt;');
		expect(page).toContain('&amp;');
	});

	it('points the demo page at the hosted model so a double click still works', () => {
		const page = demoPage({
			name: 'Astro',
			prompt: 'astronaut',
			glbUrl: 'https://three.ws/a.glb',
			viewerUrl: 'https://three.ws/viewer',
			rigged: true,
		});
		expect(page).toContain('body="https://three.ws/a.glb"');
		expect(page).not.toContain('body="agent.glb"');
	});

	it('writes three files, and says in the README which is which', () => {
		const files = projectFiles({ name: 'Astro', prompt: 'astronaut', result: RESULT, dir: 'astro' });
		expect(Object.keys(files).sort()).toEqual(['README.md', 'agent.json', 'index.html']);
		expect(JSON.parse(files['agent.json'])).toMatchObject({
			name: 'Astro',
			prompt: 'astronaut',
			glbUrl: RESULT.glbUrl,
			rigged: true,
			madeWith: '@three-ws/create-agent',
		});
		expect(files['README.md']).toContain('agent.glb');
	});
});

describe('createAgent', () => {
	it('refuses to call the forge with nothing to make', async () => {
		await expect(createAgent({})).rejects.toThrow(/describe what to make/);
		await expect(createAgent({ prompt: 'ab' })).rejects.toThrow(/at least 3 characters/);
		await expect(createAgent({ imageUrl: 'http://example.com/x.jpg' })).rejects.toThrow(
			/public https url/,
		);
	});

	it('writes a runnable project, model included', async () => {
		const out = join(await mkdtemp(join(tmpdir(), 'create-agent-')), 'astro');
		const glb = Buffer.from('glTF binary bytes');
		const fetchImpl = vi.fn(async (url) =>
			String(url).endsWith('.glb')
				? { ok: true, status: 200, arrayBuffer: async () => glb }
				: rpcOk(),
		);

		const made = await createAgent({ prompt: 'a friendly astronaut', out, fetchImpl });

		expect(made.name).toBe('Friendly Astronaut');
		expect(made.bytes).toBe(glb.length);
		expect((await readdir(out)).sort()).toEqual(['README.md', 'agent.glb', 'agent.json', 'index.html']);
		expect(await readFile(join(out, 'agent.glb'))).toEqual(glb);
		expect(await readFile(join(out, 'index.html'), 'utf8')).toContain(RESULT.glbUrl);
	});

	it('skips the download when asked, and still writes the project', async () => {
		const out = join(await mkdtemp(join(tmpdir(), 'create-agent-')), 'astro');
		const fetchImpl = vi.fn(async () => rpcOk());
		const made = await createAgent({ prompt: 'a knight', out, download: false, fetchImpl });
		expect(made.bytes).toBe(0);
		expect(await readdir(out)).not.toContain('agent.glb');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('routes an object to the free mesh lane instead of the rigging lane', async () => {
		const out = join(await mkdtemp(join(tmpdir(), 'create-agent-')), 'frog');
		const fetchImpl = vi.fn(async () => rpcOk({ ...RESULT, kind: 'model', rigged: false }));
		await createAgent({ prompt: 'a ceramic frog', out, rig: false, download: false, fetchImpl });
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params).toMatchObject({
			name: 'forge_free',
			arguments: { prompt: 'a ceramic frog', tier: 'draft' },
		});
	});

	it('sends a reference image as image_url on the avatar lane', async () => {
		const out = join(await mkdtemp(join(tmpdir(), 'create-agent-')), 'me');
		const fetchImpl = vi.fn(async () => rpcOk());
		await createAgent({
			imageUrl: 'https://example.com/me.jpg',
			out,
			download: false,
			fetchImpl,
		});
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params.arguments).toEqual({
			image_url: 'https://example.com/me.jpg',
		});
	});

	it('propagates a forge failure instead of leaving half a project', async () => {
		const out = join(await mkdtemp(join(tmpdir(), 'create-agent-')), 'nope');
		const fetchImpl = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ error: { message: 'safety filter' } }),
		});
		await expect(createAgent({ prompt: 'a knight', out, fetchImpl })).rejects.toBeInstanceOf(
			ForgeError,
		);
		await expect(readdir(out)).rejects.toThrow();
	});
});

describe('a job that outlives the inline wait', () => {
	// The normal path for a rigged character: the endpoint hands back a public
	// poll handle instead of a model, and the client has to collect it.
	function pendingRpc(stage, jobId = 'job_1') {
		return {
			ok: true,
			status: 200,
			json: async () => ({
				result: {
					structuredContent: {
						status: 'pending',
						jobId,
						pollUrl: `https://three.ws/api/gpt-forge?job=${jobId}`,
						stage,
						etaRemainingSeconds: 40,
					},
				},
			}),
		};
	}
	const jobDone = (glb) => ({ ok: true, status: 200, json: async () => ({ status: 'done', glb_url: glb }) });
	const jobQueued = { ok: true, status: 200, json: async () => ({ status: 'queued' }) };

	it('reads a pending answer as a job to collect, not as a failure', () => {
		const body = { result: { structuredContent: { status: 'pending', jobId: 'j', pollUrl: 'p', stage: 'rig' } } };
		expect(readForgeResult(body, { kind: 'avatar' })).toMatchObject({
			pending: true,
			jobId: 'j',
			stage: 'rig',
		});
	});

	it('polls the job until it is done, through a queued tick', async () => {
		const calls = [];
		const fetchImpl = vi.fn(async (url) => {
			calls.push(String(url));
			if (String(url).includes('mcp-studio')) return pendingRpc('rig');
			return calls.filter((c) => c.includes('gpt-forge')).length === 1
				? jobQueued
				: jobDone('https://three.ws/cdn/x/rigged.glb');
		});
		const made = await callForge({ tool: 'forge_avatar', args: { prompt: 'a knight' }, fetchImpl });
		expect(made).toMatchObject({ glbUrl: 'https://three.ws/cdn/x/rigged.glb', rigged: true });
	}, 20_000);

	it('rigs a collected mesh instead of handing back a T-posed figure', async () => {
		const tools = [];
		const fetchImpl = vi.fn(async (url, init) => {
			if (String(url).includes('mcp-studio')) {
				const name = JSON.parse(init.body).params.name;
				tools.push(name);
				return name === 'forge_avatar'
					? pendingRpc('mesh')
					: {
							ok: true,
							status: 200,
							json: async () => ({
								result: { structuredContent: { glbUrl: 'https://three.ws/cdn/x/rigged.glb', kind: 'avatar', rigged: true } },
							}),
						};
			}
			return jobDone('https://three.ws/cdn/x/mesh.glb');
		});
		const made = await callForge({ tool: 'forge_avatar', args: { prompt: 'a knight' }, fetchImpl });
		expect(tools).toEqual(['forge_avatar', 'rig_mesh']);
		expect(made).toMatchObject({ glbUrl: 'https://three.ws/cdn/x/rigged.glb', rigged: true });
	}, 20_000);

	it('surfaces a failed job with its reason', async () => {
		const fetchImpl = vi.fn(async (url) =>
			String(url).includes('mcp-studio')
				? pendingRpc('rig')
				: { ok: true, status: 200, json: async () => ({ status: 'failed', error: 'the rigger could not find a spine' }) },
		);
		await expect(callForge({ tool: 'forge_avatar', args: {}, fetchImpl })).rejects.toThrow(
			/could not find a spine/,
		);
	}, 20_000);
});
