// read-an-image.mjs: let an agent actually see an image, end to end.
//
// Spawns this package's own server over stdio, then runs the three tools in the
// order a real client would: probe the lane with get_vision_status, ask
// describe_image for alt text, and ask analyze_image a concrete question (here,
// reading the text off the image, which is OCR through a VLM).
//
//   node examples/read-an-image.mjs
//   IMAGE_URL=https://example.com/photo.png node examples/read-an-image.mjs
//
// Live and free: every answer comes from the three.ws vision pipeline (free
// NVIDIA NIM VLM lanes first). No key, no wallet, nothing is stored, nothing is
// paid. The default image is a public PNG served by three.ws.

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));
const IMAGE_URL = process.env.IMAGE_URL || 'https://three.ws/og-image.png';

// Env this server reads (see src/config.js). getDefaultEnvironment() drops
// everything else, so an example never leaks unrelated secrets to the child.
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS', 'THREE_WS_API_KEY'];

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

// A busy free NIM lane can exceed its deadline; the next call usually lands on a
// healthy one. Retry those three codes, and only those, with a short backoff.
const TRANSIENT = new Set(['upstream_error', 'timeout', 'network_error']);
const MAX_ATTEMPTS = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call a tool and parse the JSON payload its single text block carries. */
async function callTool(client, name, args, attempt = 1) {
	const res = await client.callTool({ name, arguments: args });
	const text = res?.content?.find((part) => part.type === 'text')?.text ?? '{}';
	const payload = JSON.parse(text);
	if (res.isError || payload.ok === false) {
		if (attempt < MAX_ATTEMPTS && TRANSIENT.has(payload.error)) {
			console.log(`  (${payload.error} on attempt ${attempt}, retrying)`);
			await wait(attempt * 1000);
			return callTool(client, name, args, attempt + 1);
		}
		throw Object.assign(new Error(payload.message || `${name} failed`), { tool: name, payload });
	}
	return payload;
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'vision-mcp-read-an-image-example', version: '1.0.0' });

await client.connect(transport);

try {
	console.log('\nget_vision_status: is the lane live?');
	const status = await callTool(client, 'get_vision_status', {});
	console.log(`  configured:  ${status.configured}`);
	console.log(`  image types: ${status.image_types.join(', ')}`);
	console.log(`  max size:    ${status.max_image_mb} MB`);
	if (!status.configured) {
		console.log('\nNo vision provider is configured on this deployment; skipping the image calls.');
		process.exit(0);
	}

	console.log(`\ndescribe_image: alt text for ${IMAGE_URL}`);
	const described = await callTool(client, 'describe_image', { imageUrl: IMAGE_URL, detail: 'brief' });
	console.log(`  served: ${described.model} (${described.provider} lane)`);
	console.log(`  alt:    ${described.description}`);

	console.log('\nanalyze_image: read the text in that same image (OCR through a VLM)');
	const analyzed = await callTool(client, 'analyze_image', {
		imageUrl: IMAGE_URL,
		prompt: 'Transcribe every word of text visible in this image, in reading order. Text only.',
		maxTokens: 256,
	});
	console.log(`  served: ${analyzed.model} (${analyzed.provider} lane)`);
	console.log(`  text:   ${analyzed.text.replace(/\n/g, '\n          ')}`);

	console.log('\nNothing was stored and nothing was paid: all three tools are read-only.');
} catch (err) {
	// The vision lane is rate limited per IP. Surface the tool's own error code
	// instead of a stack trace so the cause is obvious from the output.
	console.error(`\n${err.tool || 'vision'} failed: ${err.message}`);
	if (err.payload?.error) console.error(`error code: ${err.payload.error}`);
	process.exitCode = 1;
} finally {
	await client.close();
}
