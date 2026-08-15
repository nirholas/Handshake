import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

// Strip ANSI color codes so assertions are independent of TTY/FORCE_COLOR state.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function captured(fn) {
	const out = [];
	const err = [];
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	const origLog = console.log;
	process.stdout.write = (chunk) => {
		out.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		return true;
	};
	process.stderr.write = (chunk) => {
		err.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
		return true;
	};
	console.log = (...args) => {
		out.push(args.map(String).join(' ') + '\n');
	};
	return fn()
		.then((code) => ({ code, stdout: stripAnsi(out.join('')), stderr: stripAnsi(err.join('')) }))
		.finally(() => {
			process.stdout.write = origOut;
			process.stderr.write = origErr;
			console.log = origLog;
		});
}

let workDir;
let meshPath;
const FAKE_GLB_BYTES = Buffer.from('glTF\x02\x00\x00\x00fake-binary-payload-for-tests');

test.before(() => {
	workDir = mkdtempSync(join(tmpdir(), 'avatar-cli-test-'));
	meshPath = join(workDir, 'avatar.glb');
	writeFileSync(meshPath, FAKE_GLB_BYTES);
});

test.after(() => {
	rmSync(workDir, { recursive: true, force: true });
});

test('help is shown when no command given', async () => {
	const { code, stdout } = await captured(() => main([]));
	assert.equal(code, 1);
	assert.ok(stdout.includes('three-ws-avatar'));
	assert.ok(stdout.includes('init'));
});

test('explicit --help exits 0', async () => {
	const { code, stdout } = await captured(() => main(['--help']));
	assert.equal(code, 0);
	assert.ok(stdout.includes('commands'));
});

test('per-command --help prints command usage and exits 0', async () => {
	const { code, stdout } = await captured(() => main(['init', '--help']));
	assert.equal(code, 0);
	assert.ok(stdout.includes('three-ws-avatar init'));
	assert.ok(stdout.includes('--owner'));
});

test('unknown command returns 1 and suggests a close match', async () => {
	const { code, stderr } = await captured(() => main(['vlaidate']));
	assert.equal(code, 1);
	assert.ok(stderr.includes('unknown command'));
	assert.ok(stderr.includes('did you mean "validate"?'));
});

test('--version prints the package version', async () => {
	const { code, stdout } = await captured(() => main(['--version']));
	assert.equal(code, 0);
	assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('hash command returns sha256 of file', async () => {
	const { code, stdout } = await captured(() => main(['hash', meshPath]));
	assert.equal(code, 0);
	assert.match(stdout.trim(), /^[a-f0-9]{64}$/);
});

test('hash --json returns structured output', async () => {
	const { code, stdout } = await captured(() => main(['hash', meshPath, '--json']));
	assert.equal(code, 0);
	const obj = JSON.parse(stdout);
	assert.match(obj.sha256, /^[a-f0-9]{64}$/);
	assert.equal(obj.bytes, FAKE_GLB_BYTES.length);
});

test('hash on missing file errors', async () => {
	const { code, stderr } = await captured(() =>
		main(['hash', join(workDir, 'missing.glb')]),
	).catch((e) => ({ code: 1, stderr: e.message }));
	assert.equal(code, 1);
});

test('init scaffolds a valid manifest with shorthand 0x owner', async () => {
	const outPath = join(workDir, 'manifest.json');
	const { code } = await captured(() =>
		main([
			'init',
			'--owner',
			'0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
			'--name',
			'Nicholas',
			'--mesh',
			meshPath,
			'--out',
			outPath,
		]),
	);
	assert.equal(code, 0);
	const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.name, 'Nicholas');
	assert.equal(manifest.owner.chain, 'eip155:1');
	assert.equal(manifest.owner.address, '0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
	assert.equal(manifest.mesh.format, 'glb');
	assert.match(manifest.mesh.sha256, /^[a-f0-9]{64}$/);
	assert.equal(manifest.skeleton, 'avaturn');
});

test('init with CAIP-10 owner parses chain correctly', async () => {
	const { code, stdout } = await captured(() =>
		main([
			'init',
			'--owner',
			'solana:mainnet-beta:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
			'--name',
			'sol-agent',
			'--mesh',
			meshPath,
		]),
	);
	assert.equal(code, 0);
	const manifest = JSON.parse(stdout);
	assert.equal(manifest.owner.chain, 'solana:mainnet-beta');
	assert.equal(manifest.owner.address, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
});

test('init with a bare Solana address defaults to solana:mainnet-beta', async () => {
	const { code, stdout } = await captured(() =>
		main([
			'init',
			'--owner',
			'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			'--name',
			'sol-agent',
			'--mesh',
			meshPath,
		]),
	);
	assert.equal(code, 0);
	const manifest = JSON.parse(stdout);
	assert.equal(manifest.owner.chain, 'solana:mainnet-beta');
	assert.equal(manifest.owner.address, 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	assert.equal(manifest.id, 'solana:mainnet-beta:FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
});

test('init still rejects an owner that is neither an address nor CAIP-10', async () => {
	const { code } = await captured(() =>
		main(['init', '--owner', 'not an address', '--name', 'x', '--mesh', meshPath]),
	);
	assert.equal(code, 1);
});

test('init with ENS name uses it as id', async () => {
	const { code, stdout } = await captured(() =>
		main(['init', '--owner', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', '--name', 'nicholas.eth', '--mesh', meshPath]),
	);
	assert.equal(code, 0);
	const manifest = JSON.parse(stdout);
	assert.equal(manifest.id, 'nicholas.eth');
});

test('init fails without required flags', async () => {
	const { code, stderr } = await captured(() => main(['init', '--name', 'x']));
	assert.equal(code, 1);
	assert.ok(stderr.includes('--owner') || stderr.includes('--mesh'));
});

test('init fails on unsupported mesh extension', async () => {
	const badPath = join(workDir, 'avatar.obj');
	writeFileSync(badPath, 'not-glb');
	const { code, stderr } = await captured(() =>
		main(['init', '--owner', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', '--name', 'x', '--mesh', badPath]),
	);
	assert.equal(code, 1);
	assert.ok(stderr.includes('unsupported') || stderr.includes('extension'));
});

test('validate passes for a freshly generated manifest', async () => {
	const outPath = join(workDir, 'm-valid.json');
	await captured(() =>
		main(['init', '--owner', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--name', 'a.eth', '--mesh', meshPath, '--out', outPath]),
	);
	const { code, stdout } = await captured(() => main(['validate', outPath]));
	assert.equal(code, 0);
	assert.ok(stdout.includes('valid'));
});

test('validate fails for malformed manifest', async () => {
	const badPath = join(workDir, 'm-bad.json');
	writeFileSync(badPath, JSON.stringify({ schemaVersion: 1 }));
	const { code, stderr } = await captured(() => main(['validate', badPath]));
	assert.equal(code, 1);
	assert.ok(stderr.includes('invalid'));
});

test('preview outputs resolver url and embed snippet', async () => {
	const outPath = join(workDir, 'm-preview.json');
	await captured(() =>
		main(['init', '--owner', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '--name', 'b.eth', '--mesh', meshPath, '--out', outPath]),
	);
	const { code, stdout } = await captured(() => main(['preview', outPath]));
	assert.equal(code, 0);
	assert.ok(stdout.includes('https://three.ws/a/b.eth'));
	assert.ok(stdout.includes('<agent-3d'));
	assert.ok(stdout.includes('<iframe'));
	// The element does nothing until the loader registers it, so a snippet
	// without the script is a snippet that renders an empty box.
	assert.ok(stdout.includes('/agent-3d/latest/agent-3d.js'));
});

test('preview never emits an element the platform does not register', async () => {
	const outPath = join(workDir, 'm-preview-element.json');
	await captured(() =>
		main(['init', '--owner', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '--name', 'b.eth', '--mesh', meshPath, '--out', outPath]),
	);
	const { stdout } = await captured(() => main(['preview', outPath]));
	// `three-ws-avatar` is the binary name, not a custom element: nothing in the
	// codebase calls customElements.define('three-ws-avatar'), so emitting it
	// produced markup that silently rendered nothing.
	assert.ok(!stdout.includes('<three-ws-avatar'));
});

test('preview warns when the mesh uri is still a local path', async () => {
	const outPath = join(workDir, 'm-preview-local.json');
	await captured(() =>
		main(['init', '--owner', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '--name', 'e.eth', '--mesh', meshPath, '--out', outPath]),
	);
	const { code, stderr } = await captured(() => main(['preview', outPath]));
	assert.equal(code, 0);
	assert.match(stderr, /local path/);
	assert.match(stderr, /--mesh-uri/);
});

test('preview stays quiet when the mesh uri is public', async () => {
	const outPath = join(workDir, 'm-preview-public.json');
	await captured(() =>
		main([
			'init',
			'--owner', '0xffffffffffffffffffffffffffffffffffffffff',
			'--name', 'f.eth',
			'--mesh', meshPath,
			'--mesh-uri', 'https://three.ws/avatars/michelle.glb',
			'--out', outPath,
		]),
	);
	const { code, stdout, stderr } = await captured(() => main(['preview', outPath]));
	assert.equal(code, 0);
	assert.ok(!stderr.includes('local path'));
	assert.ok(stdout.includes('src="https://three.ws/avatars/michelle.glb"'));
});

test('preview --json emits structured output', async () => {
	const outPath = join(workDir, 'm-preview-json.json');
	await captured(() =>
		main(['init', '--owner', '0xcccccccccccccccccccccccccccccccccccccccc', '--name', 'c.eth', '--mesh', meshPath, '--out', outPath]),
	);
	const { code, stdout } = await captured(() => main(['preview', outPath, '--json']));
	assert.equal(code, 0);
	const obj = JSON.parse(stdout);
	assert.equal(obj.id, 'c.eth');
	assert.match(obj.resolverUrl, /three\.ws\/a\/c\.eth/);
	assert.match(obj.loader, /<script type="module" src="https:\/\/three\.ws\/agent-3d\/latest\/agent-3d\.js"><\/script>/);
	assert.match(obj.element, /^<agent-3d /);
	assert.equal(obj.meshIsLocal, true);
	assert.ok(obj.meshUri.startsWith('file://'));
});

test('preview honors custom --viewer flag', async () => {
	const outPath = join(workDir, 'm-preview-viewer.json');
	await captured(() =>
		main(['init', '--owner', '0xdddddddddddddddddddddddddddddddddddddddd', '--name', 'd.eth', '--mesh', meshPath, '--out', outPath]),
	);
	const { code, stdout } = await captured(() =>
		main(['preview', outPath, '--viewer', 'https://localhost:3000', '--json']),
	);
	assert.equal(code, 0);
	const obj = JSON.parse(stdout);
	assert.match(obj.resolverUrl, /localhost:3000/);
	// --viewer has to move the loader too, or a staging page pulls the element
	// registration from production while everything else points at staging.
	assert.match(obj.loader, /localhost:3000\/agent-3d\/latest\/agent-3d\.js/);
	assert.match(obj.iframe, /localhost:3000/);
});
