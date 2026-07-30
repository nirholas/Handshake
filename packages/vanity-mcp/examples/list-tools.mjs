// list-tools.mjs: print every tool @three-ws/vanity-mcp advertises, with its
// input schema.
//
// Spawns this package's own MCP server over stdio the way the README runs it
// (`node src/index.js`), performs the MCP initialize handshake, calls
// tools/list, and prints each tool's title, annotation hints, and parameters.
//
//   node examples/list-tools.mjs
//
// Read-only: no key, no signer, no payment.

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

// The README's "Run standalone" entry point. Swap for
// { command: 'npx', args: ['-y', '@three-ws/vanity-mcp'] } to exercise the
// published package instead of this checkout.
const SERVER_PATH = fileURLToPath(new URL('../src/index.js', import.meta.url));

// Env this server reads (see src/config.js). getDefaultEnvironment() drops
// everything else, so an example never leaks unrelated secrets to the child.
const FORWARDED_ENV = ['THREE_WS_BASE', 'THREE_WS_TIMEOUT_MS'];

function childEnv() {
	const env = getDefaultEnvironment();
	for (const key of FORWARDED_ENV) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	return env;
}

/** One-line summary of a tool's MCP annotation hints. */
function hints(annotations) {
	if (!annotations) return 'no hints';
	const flags = [];
	if (annotations.readOnlyHint) flags.push('read-only');
	if (annotations.destructiveHint) flags.push('destructive');
	if (annotations.idempotentHint) flags.push('idempotent');
	if (annotations.openWorldHint) flags.push('open-world');
	return flags.length ? flags.join(', ') : 'no hints';
}

/** Render a JSON Schema property as one readable constraint string. */
function constraints(prop) {
	const parts = [prop.type ?? 'any'];
	if (Array.isArray(prop.enum)) parts.push(`one of ${prop.enum.join(' | ')}`);
	if (prop.default !== undefined) parts.push(`default ${JSON.stringify(prop.default)}`);
	if (prop.minimum !== undefined) parts.push(`min ${prop.minimum}`);
	if (prop.maximum !== undefined) parts.push(`max ${prop.maximum}`);
	if (prop.minLength !== undefined) parts.push(`minLength ${prop.minLength}`);
	if (prop.maxLength !== undefined) parts.push(`maxLength ${prop.maxLength}`);
	return parts.join(', ');
}

function printTool(tool, index) {
	const schema = tool.inputSchema ?? {};
	const properties = schema.properties ?? {};
	const required = new Set(schema.required ?? []);
	const names = Object.keys(properties);

	console.log(`\n${index}. ${tool.name}`);
	if (tool.title) console.log(`   title: ${tool.title}`);
	console.log(`   hints: ${hints(tool.annotations)}`);
	if (tool.description) console.log(`   ${tool.description}`);
	if (names.length === 0) {
		console.log('   params: none');
		return;
	}
	console.log('   params:');
	for (const name of names) {
		const prop = properties[name];
		const flag = required.has(name) ? 'required' : 'optional';
		console.log(`     - ${name} (${flag}; ${constraints(prop)})`);
		if (prop.description) console.log(`       ${prop.description}`);
	}
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER_PATH],
	env: childEnv(),
	stderr: 'inherit',
});
const client = new Client({ name: 'vanity-mcp-list-tools-example', version: '1.0.0' });

await client.connect(transport);

const server = client.getServerVersion();
console.log(`server:       ${server?.name} v${server?.version} (stdio)`);
console.log(`capabilities: ${Object.keys(client.getServerCapabilities() ?? {}).join(', ') || 'none'}`);

const { tools } = await client.listTools();
console.log(`tools:        ${tools.length}`);

tools.forEach((tool, i) => printTool(tool, i + 1));

await client.close();
