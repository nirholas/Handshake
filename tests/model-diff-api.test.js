// Tests for the free 3D Diff endpoint (/api/3d/diff), its catalog descriptor,
// and the diff_models MCP tool.
//
// The engine itself is covered exhaustively in packages/glb-diff/tests; what is
// under test here is the HTTP contract around it, which is where a caller gets
// hurt. Every one of these cases is a 4xx a CI job has to be able to tell apart
// from a real regression, so they are asserted individually rather than as
// "does not 500".

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import diffHandler from '../api/3d/diff.js';
import diffEntry from '../api/_lib/3d-catalog/diff.js';
import { loadCatalog, normalizeEntry } from '../api/_lib/3d-catalog/index.js';
import { toolDefs } from '../api/_mcp/tools/models.js';
import { describeModel, diffDescriptions } from '@three-ws/glb-diff';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mockRes() {
	return {
		statusCode: 200,
		_headers: {},
		_body: '',
		setHeader(k, v) {
			this._headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._headers[k.toLowerCase()];
		},
		end(b) {
			this._body = b || '';
		},
		get headersSent() {
			return false;
		},
		get writableEnded() {
			return false;
		},
		get json() {
			try {
				return JSON.parse(this._body);
			} catch {
				return null;
			}
		},
	};
}

function mockReq({ method = 'GET', query = {}, headers = {} } = {}) {
	return {
		method,
		url: '/api/3d/diff',
		query,
		headers: { accept: 'application/json', origin: 'http://localhost:3000', ...headers },
		socket: { remoteAddress: '127.0.0.1' },
	};
}

async function call(query, method = 'GET') {
	const res = mockRes();
	await diffHandler(mockReq({ method, query }), res);
	return res;
}

describe('GET /api/3d/diff contract', () => {
	it('rejects a method it does not serve and advertises what it does', async () => {
		const res = mockRes();
		await diffHandler(mockReq({ method: 'DELETE' }), res);
		expect(res.statusCode).toBe(405);
		expect(res.getHeader('allow')).toContain('GET');
	});

	it('names which side is missing rather than saying "missing url"', async () => {
		const res = await call({ a: 'https://three.ws/avatars/xbot.glb' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('missing_url');
		expect(res.json.error_description).toContain('"b"');
	});

	it('refuses a private address without reaching for it', async () => {
		const res = await call({ a: 'http://127.0.0.1/model.glb', b: 'https://three.ws/avatars/xbot.glb' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_url');
		expect(res.json.error_description).toContain('"a"');
	});

	it('refuses a scheme that is not http(s)', async () => {
		const res = await call({ a: 'file:///etc/passwd', b: 'https://three.ws/avatars/xbot.glb' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_url');
	});

	it('rejects an output format it cannot produce', async () => {
		const res = await call({ a: 'https://three.ws/avatars/xbot.glb', b: 'https://three.ws/avatars/xbot.glb', format: 'yaml' });
		expect(res.statusCode).toBe(400);
		expect(res.json.error).toBe('invalid_format');
		expect(res.json.error_description).toContain('markdown');
	});
});

describe('catalog registration', () => {
	it('publishes a descriptor the assembler accepts', () => {
		const normalized = normalizeEntry(diffEntry, 'diff.js');
		expect(normalized).toBeTruthy();
		expect(normalized.path).toBe('/api/3d/diff');
		expect(normalized.methods).toContain('GET');
		expect(diffEntry.free).toBe(true);
		expect(diffEntry.keyless).toBe(true);
	});

	it('appears in the assembled free-3D-API catalog', async () => {
		const entries = await loadCatalog({ fresh: true });
		expect(entries.map((e) => e.path)).toContain('/api/3d/diff');
	});

	it('documents both inputs and the severity field callers gate on', () => {
		expect(diffEntry.inputSchema.required).toEqual(['a', 'b']);
		expect(diffEntry.outputSchema.properties.severity.enum).toEqual([
			'none',
			'cosmetic',
			'minor',
			'major',
			'breaking',
		]);
	});
});

describe('diff_models MCP tool', () => {
	const tool = toolDefs.find((t) => t.name === 'diff_models');

	it('is registered beside the other model tools', () => {
		expect(tool).toBeTruthy();
		expect(tool.inputSchema.required).toEqual(['before', 'after']);
		expect(tool.inputSchema.additionalProperties).toBe(false);
	});

	it('declares itself read-only and non-destructive so a client may auto-approve it', () => {
		expect(tool.annotations.readOnlyHint).toBe(true);
		expect(tool.annotations.destructiveHint).toBe(false);
	});
});

// One end-to-end pass over real rigged assets in this repo. The endpoint above
// is covered without network; this proves the engine the endpoint calls agrees
// with what the page and the CLI would report for the same two files.
describe('the engine behind the endpoint, on real avatars', () => {
	it('finds only the clip difference between two exports of one rig', async () => {
		const [a, b] = await Promise.all([
			readFile(path.join(REPO_ROOT, 'animation-sources/xbot-idle.glb')),
			readFile(path.join(REPO_ROOT, 'animation-sources/xbot-walk.glb')),
		]);
		const changes = diffDescriptions(
			await describeModel(new Uint8Array(a), { name: 'xbot-idle.glb' }),
			await describeModel(new Uint8Array(b), { name: 'xbot-walk.glb' }),
		);
		expect(changes.sections.meshes.changed).toBe(0);
		expect(changes.sections.skins.changed).toBe(0);
		expect(changes.sections.animations.renamed).toEqual([{ from: 'idle', to: 'walk', name: 'walk' }]);
	});

	it('calls a model compared with itself identical', async () => {
		const bytes = new Uint8Array(await readFile(path.join(REPO_ROOT, 'animation-sources/xbot-idle.glb')));
		const description = await describeModel(bytes, { name: 'xbot-idle.glb' });
		const changes = diffDescriptions(description, description);
		expect(changes.identical).toBe(true);
		expect(changes.severity).toBe('none');
	});
});
