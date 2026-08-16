// browse-loom.mjs: walk the public Loom gallery with this server's two read
// tools, and print an embed you can paste straight into a page.
//
//   1. get_loom_feed   the newest community-forged creations, with a cursor
//   2. get_creation    one creation expanded, with its viewer URL + iframe
//
// Every call hits the live public /api/loom endpoint. No key, no account, no
// payment. Deliberately read-only: submit_creation writes to a world-readable
// gallery, so an example never posts on your behalf.
//
//   node examples/browse-loom.mjs
//   node examples/browse-loom.mjs 5     # page size (1-120, default 3)

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS'];

const limit = Math.min(120, Math.max(1, Number(process.argv[2]) || 3));

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** Unwrap an MCP tool result's JSON payload from its text content block. */
function payload(result) {
	const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
	try {
		return JSON.parse(text);
	} catch {
		return { ok: false, raw: text };
	}
}

/** Call a tool and fail loudly rather than continuing on half-data. */
async function call(client, name, args) {
	const data = payload(await client.callTool({ name, arguments: args }));
	if (!data.ok) {
		throw new Error(`${name} failed: ${data.message || data.error || data.raw || 'unknown error'}`);
	}
	return data;
}

function truncate(text, max) {
	const one = String(text ?? '').replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'loom-mcp-browse-example', version: '1.0.0' });
await client.connect(transport);

try {
	// -- 1. get_loom_feed --------------------------------------------------
	const page = await call(client, 'get_loom_feed', { limit });
	console.log(`\nget_loom_feed: ${page.count} creation(s), nextBefore=${page.nextBefore ?? 'null'}`);
	if (page.count === 0) {
		console.log('  the gallery is empty right now: forge something and submit it with submit_creation');
	}
	for (const creation of page.creations) {
		const when = new Date(Number(creation.createdAt)).toISOString().slice(0, 10);
		console.log(`  - ${truncate(creation.prompt, 70)}`);
		console.log(`      by ${creation.author ?? 'anon'} on ${when}${creation.backend ? ` via ${creation.backend}` : ''}`);
	}

	// A full page hands back a cursor; feed it straight back as `before` to walk
	// older items. A null cursor means you reached the end of the gallery.
	if (page.has_more) {
		const older = await call(client, 'get_loom_feed', { limit, before: page.nextBefore });
		console.log(`\nnext page (before=${page.nextBefore}): ${older.count} older creation(s)`);
	}

	// -- 2. get_creation ---------------------------------------------------
	const first = page.creations[0];
	if (!first) {
		console.log('\nget_creation: skipped, the feed returned nothing to expand');
	} else {
		const { creation } = await call(client, 'get_creation', { id: first.id });
		console.log(`\nget_creation: ${creation.id}`);
		console.log(`  prompt: ${truncate(creation.prompt, 70)}`);
		console.log(`  glb:    ${creation.glbUrl}`);
		console.log(`  viewer: ${creation.viewer_url}`);
		console.log(`  card:   ${creation.og_image_url}`);
		console.log(`\n  paste this anywhere:\n  ${creation.iframe_snippet}`);
	}

	console.log('\nEvery call was read-only. Nothing was submitted to the public gallery.');
} finally {
	await client.close();
}
