#!/usr/bin/env node
// Connector-review gate: drive the published stdio server (@three-ws/mcp-server)
// exactly the way a Claude Connectors reviewer's host does, and prove two things
// the directory review turns on.
//
//   1. Every paid tool answers an UNPAID call with a clean, machine-readable
//      x402 PaymentRequired: `isError: true` (the x402 contract the @x402/mcp
//      client keys on, not a crash), x402Version 2, at least one `accepts`
//      entry carrying scheme/network/amount/asset/payTo, and a second
//      plain-language content block so a human reviewer reading the transcript
//      is not left staring at a JSON blob. A reviewer who hits a stack trace or
//      a hang reads it as a broken connector.
//   2. The reviewer entitlement works. With MCP_REVIEW_SECRET on the server and
//      a matching MCP_REVIEW_MODE on the caller, a paid tool runs its REAL
//      handler and returns a real result with no charge.
//
// This existed only as hand-run curl transcripts pasted into the submission
// evidence, which went stale the moment a tool landed. Running it is now one
// command, and the evidence it prints is reproducible.
//
// Run: npm run audit:mcp-reviewer      (exit 1 on any malformed challenge)
//      npm run audit:mcp-reviewer -- --json    (machine-readable report)

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(ROOT, 'mcp-server', 'src', 'index.js');
const JSON_OUT = process.argv.includes('--json');

// forge_free runs a real multi-stage generation (minutes, no payment involved).
// It is verified end to end by its own live smoke test; calling it here would
// turn a fast gate into a coffee break without testing anything about payment.
const SKIP = new Set(['forge_free']);

/** Smallest argument object that satisfies a tool's declared input schema. */
function minimalArgs(schema) {
	const out = {};
	const props = schema?.properties ?? {};
	for (const key of schema?.required ?? []) {
		const spec = props[key] ?? {};
		out[key] = sampleForSpec(spec, key);
	}
	return out;
}

// Placeholders that satisfy the shapes our schemas actually constrain. A value
// the schema rejects never reaches the payment wrapper: the MCP SDK answers
// -32602 first, and the tool would be miscounted as free.
const SAMPLE_GLB_URL = 'https://three.ws/avatars/cesium-man.glb';
const SAMPLE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

function sampleForSpec(spec, key) {
	if (Array.isArray(spec.enum) && spec.enum.length) return spec.enum[0];
	const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
	if (type === 'string' || type === undefined) {
		if (spec.format === 'uri' || spec.format === 'url' || /url$/i.test(key)) return SAMPLE_GLB_URL;
		// A base58 pubkey field: the only 32-character-plus string constraint our
		// schemas use. Uses the platform's own mint, never a third-party one.
		if (typeof spec.minLength === 'number' && spec.minLength >= 32) return SAMPLE_MINT;
	}
	switch (type) {
		case 'number':
		case 'integer':
			return typeof spec.minimum === 'number' ? spec.minimum : 1;
		case 'boolean':
			return false;
		case 'array':
			return spec.minItems ? [sampleForSpec(spec.items ?? {}, key)] : [];
		case 'object':
			return minimalArgs(spec);
		default: {
			// A string long enough to clear a minLength bound, short enough to
			// clear a maxLength one. The value is never used by a paid tool: the
			// payment wrapper answers before the handler ever sees it.
			const min = typeof spec.minLength === 'number' ? spec.minLength : 1;
			const base = 'three'.repeat(Math.ceil(Math.max(min, 5) / 5));
			const max = typeof spec.maxLength === 'number' ? spec.maxLength : base.length;
			return base.slice(0, Math.max(min, Math.min(base.length, max)));
		}
	}
}

/** The x402 envelope a paid tool returns unpaid, or null when there is none. */
function paymentChallenge(result) {
	const structured = result?.structuredContent;
	if (structured && structured.x402Version && Array.isArray(structured.accepts)) return structured;
	const text = result?.content?.find((c) => c?.type === 'text')?.text;
	if (typeof text !== 'string') return null;
	try {
		const parsed = JSON.parse(text);
		return parsed?.x402Version && Array.isArray(parsed.accepts) ? parsed : null;
	} catch {
		return null;
	}
}

async function connect(extraEnv = {}) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [SERVER_ENTRY],
		env: { ...process.env, ...extraEnv },
	});
	const client = new Client({ name: 'audit-mcp-reviewer-path', version: '1.0.0' }, { capabilities: {} });
	await client.connect(transport);
	return client;
}

const problems = [];
const rows = [];

const client = await connect();
const { tools } = await client.listTools();

for (const tool of tools) {
	if (SKIP.has(tool.name)) {
		rows.push({ tool: tool.name, kind: 'skipped', note: 'long-running free generation, verified by its own smoke test' });
		continue;
	}
	let result;
	try {
		result = await client.callTool({ name: tool.name, arguments: minimalArgs(tool.inputSchema) });
	} catch (err) {
		problems.push(`${tool.name}: the call threw instead of answering (${err.message})`);
		rows.push({ tool: tool.name, kind: 'threw', note: err.message });
		continue;
	}

	const challenge = paymentChallenge(result);
	if (!challenge) {
		rows.push({ tool: tool.name, kind: 'free', isError: Boolean(result?.isError) });
		continue;
	}

	const accept = challenge.accepts[0];
	const missing = ['scheme', 'network', 'amount', 'asset', 'payTo'].filter((f) => !accept?.[f]);
	if (challenge.x402Version !== 2) problems.push(`${tool.name}: x402Version is ${challenge.x402Version}, expected 2`);
	if (!result.isError) problems.push(`${tool.name}: the challenge must set isError so an x402 client detects it`);
	if (missing.length) problems.push(`${tool.name}: accepts[0] is missing ${missing.join(', ')}`);
	if (String(accept?.payTo ?? '').includes('${')) problems.push(`${tool.name}: payTo still holds an unsubstituted placeholder`);
	const human = result.content?.filter((c) => c?.type === 'text') ?? [];
	if (human.length < 2 || !/payment required/i.test(human[human.length - 1].text ?? '')) {
		problems.push(`${tool.name}: the challenge carries no plain-language explanation for a human reviewer`);
	}

	rows.push({
		tool: tool.name,
		kind: 'paid',
		amount: accept.amount,
		asset: accept.asset,
		network: accept.network,
		payTo: accept.payTo,
	});
}
await client.close();

// The reviewer entitlement: a fresh secret proves the gate, not a leftover env.
const secret = randomBytes(16).toString('hex');
const reviewClient = await connect({ MCP_REVIEW_SECRET: secret, MCP_REVIEW_MODE: secret });
const probe = rows.find((r) => r.kind === 'paid' && r.tool === 'get_pose_seed') ?? rows.find((r) => r.kind === 'paid');
let reviewOutcome = 'no paid tool to probe';
if (probe) {
	const tool = tools.find((t) => t.name === probe.tool);
	const result = await reviewClient.callTool({ name: probe.tool, arguments: minimalArgs(tool.inputSchema) });
	if (paymentChallenge(result)) {
		problems.push(`${probe.tool}: review mode did not lift the paywall`);
		reviewOutcome = 'still charged';
	} else {
		reviewOutcome = `${probe.tool} ran its real handler, no charge`;
	}
}
await reviewClient.close();

// A wrong secret must NOT lift the paywall, or the entitlement is not a gate.
const wrongClient = await connect({ MCP_REVIEW_SECRET: secret, MCP_REVIEW_MODE: 'not-the-secret' });
if (probe) {
	const tool = tools.find((t) => t.name === probe.tool);
	const result = await wrongClient.callTool({ name: probe.tool, arguments: minimalArgs(tool.inputSchema) });
	if (!paymentChallenge(result)) problems.push(`${probe.tool}: a mismatched MCP_REVIEW_MODE lifted the paywall`);
}
await wrongClient.close();

const paid = rows.filter((r) => r.kind === 'paid');
const free = rows.filter((r) => r.kind === 'free');

if (JSON_OUT) {
	console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows, reviewOutcome, problems }, null, 2));
} else {
	for (const row of rows) {
		if (row.kind === 'paid') console.log(`  402  ${row.tool.padEnd(24)} ${row.amount.padStart(9)} atomic  ${row.network}`);
		else console.log(`  ${row.kind.padEnd(4)} ${row.tool}`);
	}
	console.log(`\n[audit:mcp-reviewer] ${paid.length} paid tools answered a clean PaymentRequired, ${free.length} free tools ran`);
	console.log(`[audit:mcp-reviewer] review entitlement: ${reviewOutcome}`);
}

if (problems.length) {
	for (const p of problems) console.error(`[audit:mcp-reviewer] ${p}`);
	process.exit(1);
}
