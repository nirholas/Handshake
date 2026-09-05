// three-ws-assets CLI tests.
//
// A local HTTP server stands in for three.ws: it answers /api/catalog with the
// same response shape the real endpoint returns and serves asset bytes from a
// CDN-shaped path. Nothing here reaches the network, and every command runs
// through main() exactly as the shell invokes it.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, parseArgs } from '../src/cli.js';
import { defaultDir, webPathFor, writeAsset } from '../src/commands/add.js';

const CHAIR_BYTES = Buffer.from('glTF-pretend-chair-bytes');
const THUMB_BYTES = Buffer.from('png-pretend-thumb');

function chair(origin) {
	return {
		id: 'object:wooden_chair',
		kind: 'object',
		name: 'wooden_chair',
		title: 'Wooden Chair',
		categories: ['furniture'],
		tags: ['wood', 'seating'],
		license: 'CC0',
		format: 'glb',
		url: `${origin}/cdn/wooden_chair.glb`,
		thumb: `${origin}/cdn/wooden_chair.png`,
		bytes: CHAIR_BYTES.length,
	};
}

function detail(origin) {
	const item = chair(origin);
	return {
		ok: true,
		item,
		links: { browse: 'https://three.ws/objects', preview: 'https://three.ws/app#model=x' },
		related: [{ id: 'object:bar_stool', title: 'Bar Stool' }],
		frameworks: ['model-viewer', 'three', 'agent-3d', 'react'],
		snippets: {
			'model-viewer': {
				language: 'html',
				code: `<model-viewer src="${item.url}"></model-viewer>`,
				notes: ['This is the renderer the browse grids use.'],
			},
			three: { language: 'javascript', code: `loadAsync("${item.url}")`, notes: [] },
			'agent-3d': { language: 'html', code: `<agent-3d body="${item.url}"></agent-3d>`, notes: [] },
			react: { language: 'jsx', code: `const url = "${item.url}";`, notes: [] },
		},
	};
}

let server;
let origin;
let cwd;
let out;
let err;

/** Run the CLI with stdout/stderr captured, returning { code, out, err }. */
async function run(...argv) {
	out = '';
	err = '';
	const realOut = process.stdout.write.bind(process.stdout);
	const realErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = (chunk) => {
		out += chunk;
		return true;
	};
	process.stderr.write = (chunk) => {
		err += chunk;
		return true;
	};
	try {
		const code = await main([...argv, '--api', origin, '--no-color']);
		return { code, out, err };
	} finally {
		process.stdout.write = realOut;
		process.stderr.write = realErr;
	}
}

before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		if (url.pathname === '/cdn/wooden_chair.glb') {
			res.writeHead(200, { 'content-type': 'model/gltf-binary' }).end(CHAIR_BYTES);
			return;
		}
		if (url.pathname === '/cdn/wooden_chair.png') {
			res.writeHead(200, { 'content-type': 'image/png' }).end(THUMB_BYTES);
			return;
		}
		if (url.pathname !== '/api/catalog') {
			res.writeHead(404).end('{}');
			return;
		}
		const id = url.searchParams.get('id');
		if (id) {
			if (id !== 'object:wooden_chair') {
				res
					.writeHead(404, { 'content-type': 'application/json' })
					.end(JSON.stringify({ error: 'not_found', message: `no catalog item with id "${id}"` }));
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(detail(origin)));
			return;
		}
		const q = url.searchParams.get('q') || '';
		const matches = q.includes('nothing') ? [] : [chair(origin)];
		res.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				ok: true,
				items: matches,
				matched: matches.length,
				relaxed: q.includes('partial'),
				total: 3492,
				offset: 0,
				next_offset: matches.length ? 1 : null,
				facets: { kinds: { object: matches.length }, categories: [{ value: 'furniture', count: 1 }], tags: [] },
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'three-ws-assets-'));
	process.chdir(cwd);
});

describe('argument parsing', () => {
	it('separates positionals from flags and value flags from booleans', () => {
		const args = parseArgs(['add', 'object:x', '--dir', 'assets', '--force', '--json']);
		assert.deepEqual(args._, ['add', 'object:x']);
		assert.equal(args.flags.dir, 'assets');
		assert.equal(args.flags.force, true);
		assert.equal(args.flags.json, true);
	});
});

describe('help and unknown commands', () => {
	it('prints help and exits non-zero when called with no command', async () => {
		const r = await run();
		assert.equal(r.code, 1);
		assert.match(r.out, /three-ws-assets <command>/);
	});

	it('exits 0 for an explicit --help', async () => {
		const r = await run('--help');
		assert.equal(r.code, 0);
	});

	it('suggests the closest command for a typo', async () => {
		const r = await run('serach', 'chair');
		assert.equal(r.code, 1);
		assert.match(r.err, /did you mean "search"/);
	});
});

describe('search', () => {
	it('lists ids and points at the next step', async () => {
		const r = await run('search', 'wooden', 'chair');
		assert.equal(r.code, 0);
		assert.match(r.out, /object:wooden_chair/);
		assert.match(r.out, /three-ws-assets add object:wooden_chair/);
	});

	it('exits non-zero and says what to try when nothing matches', async () => {
		const r = await run('search', 'nothing');
		assert.equal(r.code, 1);
		assert.match(r.err, /nothing in the catalog matches/);
	});

	it('warns when the catalog fell back to a partial match', async () => {
		const r = await run('search', 'partial', 'match');
		assert.equal(r.code, 0);
		assert.match(r.err, /nothing matches every word/);
	});

	it('rejects an unknown --kind before making a request', async () => {
		const r = await run('search', 'chair', '--kind', 'furniture');
		assert.equal(r.code, 1);
		assert.match(r.err, /--kind must be one of/);
	});

	it('emits raw JSON with --json', async () => {
		const r = await run('search', 'chair', '--json');
		assert.equal(JSON.parse(r.out).items[0].id, 'object:wooden_chair');
	});
});

describe('show', () => {
	it('prints the recommended framework and names the others', async () => {
		const r = await run('show', 'object:wooden_chair');
		assert.equal(r.code, 0);
		assert.match(r.out, /<model-viewer/);
		assert.match(r.out, /other frameworks: three, agent-3d, react/);
	});

	it('prints only the requested framework so the output pipes cleanly', async () => {
		const r = await run('show', 'object:wooden_chair', '--framework', 'three');
		assert.match(r.out, /loadAsync/);
		assert.doesNotMatch(r.out, /other frameworks/);
	});

	it('rejects a framework the item does not have', async () => {
		const r = await run('show', 'object:wooden_chair', '--framework', 'svelte');
		assert.equal(r.code, 1);
		assert.match(r.err, /available: model-viewer/);
	});

	it('explains an unknown id instead of throwing', async () => {
		const r = await run('show', 'object:missing');
		assert.equal(r.code, 1);
		assert.match(r.err, /no catalog item/);
	});
});

describe('add', () => {
	it('writes the asset under public/ and rewrites the snippet to the local path', async () => {
		await mkdir(join(cwd, 'public'), { recursive: true });
		const r = await run('add', 'object:wooden_chair');
		assert.equal(r.code, 0);
		const written = await readFile(join(cwd, 'public', 'three-ws', 'wooden_chair.glb'));
		assert.deepEqual(written, CHAIR_BYTES);
		assert.match(r.out, /src="\/three-ws\/wooden_chair\.glb"/);
		assert.doesNotMatch(r.out, /cdn\/wooden_chair\.glb"/);
	});

	it('falls back to a plain directory and warns that it is not served', async () => {
		const r = await run('add', 'object:wooden_chair');
		assert.equal(r.code, 0);
		assert.ok(existsSync(join(cwd, 'three-ws-assets', 'wooden_chair.glb')));
		assert.match(r.err, /not under a public\/ directory/);
		assert.match(r.out, /\.\/three-ws-assets\/wooden_chair\.glb/);
	});

	it('takes the thumbnail only when asked', async () => {
		await run('add', 'object:wooden_chair');
		assert.ok(!existsSync(join(cwd, 'three-ws-assets', 'wooden_chair.png')));
		await run('add', 'object:wooden_chair', '--thumb');
		assert.ok(existsSync(join(cwd, 'three-ws-assets', 'wooden_chair.png')));
	});

	it('reports an unchanged file on a re-run instead of rewriting it', async () => {
		await run('add', 'object:wooden_chair');
		const r = await run('add', 'object:wooden_chair');
		assert.equal(r.code, 0);
		assert.match(r.out, /already up to date/);
	});

	it('refuses to clobber an edited file, and obeys --force', async () => {
		await run('add', 'object:wooden_chair');
		const target = join(cwd, 'three-ws-assets', 'wooden_chair.glb');
		await writeFile(target, 'edited by hand');
		const refused = await run('add', 'object:wooden_chair');
		assert.equal(refused.code, 1);
		assert.match(refused.err, /exists with different contents/);
		assert.equal(await readFile(target, 'utf8'), 'edited by hand');

		const forced = await run('add', 'object:wooden_chair', '--force');
		assert.equal(forced.code, 0);
		assert.deepEqual(await readFile(target), CHAIR_BYTES);
	});

	it('honors --dir', async () => {
		await run('add', 'object:wooden_chair', '--dir', 'src/models');
		assert.ok(existsSync(join(cwd, 'src', 'models', 'wooden_chair.glb')));
	});

	it('reports written paths, the local url, and the snippet with --json', async () => {
		await mkdir(join(cwd, 'public'), { recursive: true });
		const r = await run('add', 'object:wooden_chair', '--json');
		const payload = JSON.parse(r.out);
		assert.equal(payload.files[0].path, join('public', 'three-ws', 'wooden_chair.glb'));
		assert.equal(payload.url, '/three-ws/wooden_chair.glb');
		assert.equal(payload.served, true);
		assert.match(payload.snippet, /\/three-ws\/wooden_chair\.glb/);
	});
});

describe('path helpers', () => {
	it('prefers public/three-ws when the project has a public directory', async () => {
		assert.equal(defaultDir(cwd), join(cwd, 'three-ws-assets'));
		await mkdir(join(cwd, 'public'), { recursive: true });
		assert.equal(defaultDir(cwd), join(cwd, 'public', 'three-ws'));
	});

	it('maps a path under public/ to a served root url', () => {
		assert.deepEqual(webPathFor('/proj', '/proj/public/three-ws/a.glb'), {
			url: '/three-ws/a.glb',
			served: true,
		});
		assert.deepEqual(webPathFor('/proj', '/proj/assets/a.glb'), {
			url: './assets/a.glb',
			served: false,
		});
	});

	it('creates missing parent directories on write', async () => {
		const target = join(cwd, 'deep', 'nested', 'a.glb');
		assert.equal(await writeAsset(target, CHAIR_BYTES), 'written');
		assert.equal(await writeAsset(target, CHAIR_BYTES), 'unchanged');
		assert.equal(await writeAsset(target, Buffer.from('other')), 'conflict');
		assert.equal(await writeAsset(target, Buffer.from('other'), { force: true }), 'written');
	});
});
