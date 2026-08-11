#!/usr/bin/env node
/**
 * Model Context Protocol server over stdio.
 *
 * The dashboard answers "what is broken?" for a person. This answers it for an
 * agent, which is the more useful half: an agent that can read the fleet's
 * measured state can be told to go fix the worst of it without a human first
 * pasting a list of URLs into the prompt.
 *
 * It reads the same snapshot the HTTP service writes, either from a running
 * console (FLEET_CONSOLE_URL) or straight from disk (FLEET_DATA_DIR).
 *
 * Register it with any MCP client:
 *   { "mcpServers": { "fleet": { "command": "node", "args": ["src/mcp.js"],
 *     "env": { "FLEET_CONSOLE_URL": "https://fleet-console.example.com" } } } }
 */

import { createInterface } from 'node:readline';
import { config } from './config.js';
import * as store from './store.js';
import { attention } from './server.js';
import { partialReasons } from './scan.js';

const PROTOCOL_VERSION = '2024-11-05';
const consoleUrl = (process.env.FLEET_CONSOLE_URL || '').replace(/\/+$/, '');

/** Snapshot source: a running console if one is configured, otherwise the local store. */
async function loadSnapshot() {
	if (consoleUrl) {
		const res = await fetch(`${consoleUrl}/api/fleet?full=1`, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`fleet console responded ${res.status}`);
		return res.json();
	}
	await store.load();
	const snapshot = store.getSnapshot();
	if (!snapshot) throw new Error(`no snapshot in ${config.dataDir}. Run "npm run scan" first, or set FLEET_CONSOLE_URL.`);
	return snapshot;
}

const TOOLS = [
	{
		name: 'fleet_summary',
		description:
			'Fleet-wide health rollup for the configured GitHub owner: repository count, median and mean health score, how many advertised deployment URLs actually respond, dead README links, and npm packages that are advertised for install but were never published.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	},
	{
		name: 'fleet_attention',
		description:
			'Everything measurably broken across the fleet, ranked worst first: down deployments, unpublished packages, dead links and failing checks. Use this to pick what to fix next.',
		inputSchema: {
			type: 'object',
			properties: {
				severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Only return items at this severity.' },
				limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum items to return. Defaults to 50.' }
			},
			additionalProperties: false
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	},
	{
		name: 'fleet_repo',
		description:
			'Full measured detail for one repository: its score, every health check with the evidence behind it, every probed URL with status and latency, and its npm registry verification.',
		inputSchema: {
			type: 'object',
			properties: { name: { type: 'string', description: 'Repository name, without the owner prefix.' } },
			required: ['name'],
			additionalProperties: false
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	},
	{
		name: 'fleet_search',
		description: 'Find repositories by name, description, language or topic, returning each one with its current health score and any broken deployment.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Free text matched against name, description, language and topics.' },
				max_score: { type: 'integer', minimum: 0, maximum: 100, description: 'Only return repositories scoring at or below this.' },
				limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum results. Defaults to 25.' }
			},
			additionalProperties: false
		},
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
	}
];

const textResult = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const slimRepo = (repo) => ({
	name: repo.name,
	description: repo.description,
	url: repo.htmlUrl,
	stars: repo.stars,
	language: repo.language,
	score: repo.score,
	grade: repo.grade?.grade || null,
	failingChecks: (repo.checks || []).filter((check) => check.status === 'fail').map((check) => ({ id: check.id, evidence: check.evidence, fix: check.fix })),
	brokenDeployments: (repo.deployments || []).filter((entry) => entry.state !== 'live' && entry.state !== 'redirected').map((entry) => ({ url: entry.url, state: entry.state })),
	unpublishedPackages: repo.packages?.missing || []
});

async function callTool(name, args = {}) {
	const snapshot = await loadSnapshot();

	if (name === 'fleet_summary') {
		return textResult({
			owner: snapshot.owner,
			generatedAt: snapshot.generatedAt,
			partial: snapshot.partial,
			// An agent acting on this needs to know whether it is looking at the
			// whole fleet, and if not, why not: a capped scan is a configuration
			// choice, an exhausted budget means the numbers themselves are shaky.
			partialReason: snapshot.partialReason || '',
			partialDetail: partialReasons(snapshot),
			...snapshot.summary
		});
	}

	if (name === 'fleet_attention') {
		const report = attention(snapshot);
		let items = report.items;
		if (args.severity) items = items.filter((item) => item.severity === args.severity);
		const limit = Math.min(args.limit || 50, 500);
		return textResult({ owner: snapshot.owner, generatedAt: snapshot.generatedAt, total: items.length, returned: Math.min(items.length, limit), items: items.slice(0, limit) });
	}

	if (name === 'fleet_repo') {
		const target = String(args.name || '').toLowerCase();
		const repo = snapshot.repos.find((entry) => entry.name.toLowerCase() === target);
		if (!repo) {
			const near = snapshot.repos.filter((entry) => entry.name.toLowerCase().includes(target)).slice(0, 8).map((entry) => entry.name);
			throw new Error(`no repository "${args.name}" in the snapshot${near.length ? `. Did you mean: ${near.join(', ')}` : ''}`);
		}
		return textResult(repo);
	}

	if (name === 'fleet_search') {
		const query = String(args.query || '').toLowerCase();
		const limit = Math.min(args.limit || 25, 200);
		const matches = snapshot.repos
			.filter((repo) => {
				if (typeof args.max_score === 'number' && !(typeof repo.score === 'number' && repo.score <= args.max_score)) return false;
				if (!query) return true;
				return [repo.name, repo.description, repo.language, ...(repo.topics || [])].join(' ').toLowerCase().includes(query);
			})
			.sort((a, b) => (a.score ?? 101) - (b.score ?? 101));
		return textResult({ total: matches.length, returned: Math.min(matches.length, limit), repos: matches.slice(0, limit).map(slimRepo) });
	}

	throw new Error(`unknown tool: ${name}`);
}

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

async function handleMessage(message) {
	const { id, method, params } = message;

	if (method === 'initialize') {
		return respond(id, {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: 'fleet-console', version: '1.0.0' }
		});
	}
	if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
	if (method === 'ping') return respond(id, {});
	if (method === 'tools/list') return respond(id, { tools: TOOLS });
	if (method === 'tools/call') {
		try {
			return respond(id, await callTool(params?.name, params?.arguments || {}));
		} catch (error) {
			return respond(id, { content: [{ type: 'text', text: `Error: ${error?.message || error}` }], isError: true });
		}
	}
	if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on('line', (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return fail(null, -32700, 'parse error');
	}
	handleMessage(message).catch((error) => {
		if (message?.id !== undefined) fail(message.id, -32603, String(error?.message || error));
	});
});
rl.on('close', () => process.exit(0));

export { TOOLS, callTool };
