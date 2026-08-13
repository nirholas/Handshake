// Hermetic tests for the bridge's core path: Bazaar tool naming and the
// stdio boot of the main export (src/index.js).
//
// Tool naming exercises the pure functions in bazaar-discover.js directly.
// The boot test spawns the real server with a throwaway in-process EVM key and
// MCP_BRIDGE_DISCOVER_LIMIT=0, so no network request leaves the process and no
// real keys or funds are ever involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';

import { deriveToolName, specsFromItems } from '../src/bazaar-discover.js';

const pkg = createRequire(import.meta.url)('../package.json');
const SERVER_PATH = join(import.meta.dirname, '..', 'src', 'index.js');

// Synthetic accepts entry, well under the default per-call cap. No real
// mints, payees, or networks-with-funds appear anywhere in these fixtures.
const CHEAP_ACCEPT = {
	scheme: 'exact',
	network: 'eip155:8453',
	amount: '1000',
	asset: `0x${'a'.repeat(40)}`,
	payTo: `0x${'b'.repeat(40)}`,
};

test('deriveToolName: URL path, generic-segment skipping, description fallback', () => {
	assert.equal(
		deriveToolName({ resource: 'https://api.vendor.example/api/v1/weather-report' }),
		'paid_weather_report',
		'uses the last meaningful path segment, snake_cased',
	);
	assert.equal(
		deriveToolName({ resource: 'https://vendor.example/x402/api/v2/quote/tools' }),
		'paid_quote',
		'skips generic segments (api, tools, vN, x402) from the right',
	);
	assert.equal(
		deriveToolName({ resource: 'not a url', description: 'Vendor · get quote' }),
		'paid_get_quote',
		'falls back to the description after the publisher prefix',
	);
	assert.equal(
		deriveToolName({ resource: 'not a url', description: '' }),
		'paid_tool',
		'falls back to a generic name when nothing usable exists',
	);
	const long = deriveToolName({ resource: `https://vendor.example/${'segment'.repeat(20)}` });
	assert.ok(long.length <= 'paid_'.length + 48, 'sanitized names are length-capped');
});

test('specsFromItems: dedupe suffixes, affordability filter, malformed-item resilience', () => {
	const items = [
		{ resource: 'https://a.example/quote', description: 'quote A', accepts: [CHEAP_ACCEPT] },
		{ resource: 'https://b.example/quote', description: 'quote B', accepts: [CHEAP_ACCEPT] },
		{ resource: 'https://c.example/quote', description: 'quote C', accepts: [CHEAP_ACCEPT] },
		// Every accepts entry above the default 100000 cap: filtered out.
		{
			resource: 'https://d.example/pricey',
			description: 'too expensive',
			accepts: [{ ...CHEAP_ACCEPT, amount: '100001' }],
		},
		// No accepts at all: filtered out.
		{ resource: 'https://e.example/free', description: 'no accepts' },
		// Malformed entry must not take the whole discovery down.
		null,
	];
	const specs = specsFromItems(items);
	assert.deepEqual(
		specs.map((s) => s.name),
		['paid_quote', 'paid_quote_1', 'paid_quote_2'],
		'name collisions get numeric suffixes; unaffordable and accept-less items are dropped',
	);
	const first = specs[0];
	assert.equal(first.resource, 'https://a.example/quote');
	assert.equal(first.method, 'GET');
	assert.match(first.description, /Auto-paid via x402/);
	assert.match(first.acceptSummary, /exact@eip155:8453 1000/);
});

// Minimal JSON-RPC-over-stdio client for the boot test.
function bootBridge(env) {
	const child = spawn('node', [SERVER_PATH], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env,
	});
	let buf = '';
	let stderr = '';
	let nextId = 1;
	const pending = new Map();
	child.stdout.on('data', (chunk) => {
		buf += chunk.toString('utf8');
		let nl;
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString('utf8');
	});
	const send = (method, params) => {
		const id = nextId++;
		const p = new Promise((resolve, reject) => {
			pending.set(id, resolve);
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error(`timeout waiting for ${method}#${id}; stderr:\n${stderr}`));
				}
			}, 15_000);
		});
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
		return p;
	};
	const stop = () => {
		child.kill('SIGTERM');
		return new Promise((r) => child.once('exit', r));
	};
	return { child, send, stop, getStderr: () => stderr };
}

// Strip any key/cap material inherited from the invoking shell so the boot is
// deterministic regardless of the developer's environment.
function hermeticEnv(extra) {
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (k.startsWith('MCP_BRIDGE_') || k.startsWith('RPC_URL_')) continue;
		if (k === 'EVM_PRIVATE_KEY' || k === 'SVM_PRIVATE_KEY') continue;
		env[k] = v;
	}
	return { ...env, ...extra };
}

test('stdio boot: static tools registered with honest annotations, version matches package.json', async () => {
	const tmpRoot = mkdtempSync(join(tmpdir(), 'x402-bridge-boot-'));
	const bridge = bootBridge(
		hermeticEnv({
			MCP_BRIDGE_EVM_PRIVATE_KEY: generatePrivateKey(),
			MCP_BRIDGE_DISCOVER_LIMIT: '0',
			X402_MCP_BRIDGE_CHANNELS_DIR: join(tmpRoot, 'channels'),
		}),
	);
	try {
		const init = await bridge.send('initialize', {
			protocolVersion: '2025-03-26',
			clientInfo: { name: 'bridge-boot-test', version: '0.0.1' },
			capabilities: {},
		});
		assert.equal(init.result.serverInfo.name, 'three-ws-x402-bridge');
		assert.equal(
			init.result.serverInfo.version,
			pkg.version,
			'serverInfo.version must track package.json, never a hardcoded copy',
		);
		bridge.child.stdin.write(
			JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
		);

		const listed = await bridge.send('tools/list', {});
		const byName = new Map(listed.result.tools.map((t) => [t.name, t]));
		assert.deepEqual(
			[...byName.keys()].sort(),
			['call_paid_endpoint', 'list_bazaar_tools', 'refresh_bazaar'],
			'with discovery disabled, exactly the three static tools are registered',
		);

		const paid = byName.get('call_paid_endpoint');
		assert.equal(paid.annotations.readOnlyHint, false);
		assert.equal(paid.annotations.idempotentHint, false);
		assert.equal(paid.annotations.openWorldHint, true);
		assert.match(paid.description, /SPENDS REAL MONEY/);

		const list = byName.get('list_bazaar_tools');
		assert.equal(list.annotations.readOnlyHint, true);
		assert.equal(list.annotations.idempotentHint, true);
		assert.equal(list.annotations.openWorldHint, false);

		const call = await bridge.send('tools/call', { name: 'list_bazaar_tools', arguments: {} });
		assert.equal(call.result.isError, undefined, 'cache read must not error');
		assert.deepEqual(
			JSON.parse(call.result.content[0].text),
			[],
			'discovery disabled leaves an empty bazaar cache',
		);
	} finally {
		await bridge.stop();
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test('stdio boot: refuses to start without any signer, naming both key env vars', async () => {
	const child = spawn('node', [SERVER_PATH], {
		stdio: ['ignore', 'ignore', 'pipe'],
		env: hermeticEnv({}),
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString('utf8');
	});
	const code = await new Promise((r) => child.once('exit', r));
	assert.equal(code, 1, 'boot without keys must exit non-zero');
	assert.match(stderr, /MCP_BRIDGE_EVM_PRIVATE_KEY/);
	assert.match(stderr, /MCP_BRIDGE_SVM_PRIVATE_KEY/);
});
