#!/usr/bin/env node
// Golden-snapshot tripwire for hosted MCP tool contracts (roadmap 01, task 2).
//
// The public contract of every hosted MCP server — tool names, descriptions,
// annotations, input schemas — is what external agents integrate against. An
// accidental rename, deletion, or schema change breaks those integrations
// silently. This audit catches that drift OFFLINE by statically parsing the
// tool-definition sources with acorn and comparing against a committed golden
// fixture. It never imports the catalog modules: project doctrine (see
// prompts/finish/roadmap-00-README.md) forbids that — importing a hosted catalog pulls
// in DB/RPC clients that block without live credentials.
//
// What it captures per statically-declared tool def (an object literal with
// `name` + `description` + `inputSchema`/`annotations` properties):
//   - name (the wire-visible tool identifier)
//   - descHead + descHash (first line fragment + sha256-12 of the full text)
//   - annotations (boolean hints when literal, or the referenced const's name)
//   - schemaHash (sha256-12 of the whitespace-normalized inputSchema source)
// Tools built dynamically (e.g. buildGettingStartedTool) are invisible to
// static parsing and are intentionally out of scope — verify those against a
// running server (`npm run test:mcp` / `smoke:mcp`).
//
// Run:  node scripts/audit-mcp-golden.mjs           → compare, exit 1 on drift
//       node scripts/audit-mcp-golden.mjs --update  → regenerate the fixture
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse } from 'acorn';

import { ROOT, mcpToolSources } from './lib/mcp-tool-sources.mjs';

const FIXTURE = join(ROOT, 'tests', 'fixtures', 'mcp-golden-tools.json');

// Every hosted + published MCP server's tool-definition sources, discovered by
// scripts/lib/mcp-tool-sources.mjs so this gate and the safety gate can never
// diverge on which files are guarded. Tools built dynamically (e.g.
// buildGettingStartedTool) are invisible to static parsing and out of scope --
// verify those against a running server (`npm run test:mcp` / `smoke:mcp`).
const SOURCES = mcpToolSources();

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function templateText(node) {
	// Cooked template text with `${…}` marking interpolations — stable across
	// formatting changes, sensitive to wording changes.
	return node.quasis.map((q) => q.value.cooked ?? '').join('${…}');
}

function stringValue(node) {
	if (!node) return null;
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral') return templateText(node);
	return null;
}

function annotationsValue(node) {
	if (!node) return undefined;
	if (node.type === 'Identifier') return `ref:${node.name}`;
	if (node.type !== 'ObjectExpression') return 'dynamic';
	const out = {};
	for (const p of node.properties) {
		if (p.type !== 'Property' || p.computed) { out['…'] = 'dynamic'; continue; }
		const key = p.key.name ?? p.key.value;
		out[key] = p.value.type === 'Literal' ? p.value.value
			: p.value.type === 'Identifier' ? `ref:${p.value.name}`
			: 'dynamic';
	}
	return out;
}

function extractTools(file) {
	const src = readFileSync(join(ROOT, file), 'utf8');
	const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
	const tools = [];

	(function walk(node) {
		if (!node || typeof node.type !== 'string') return;
		if (node.type === 'ObjectExpression') {
			const props = new Map();
			for (const p of node.properties) {
				if (p.type === 'Property' && !p.computed) props.set(p.key.name ?? p.key.value, p.value);
			}
			const name = stringValue(props.get('name'));
			const hasContract = props.has('description') && (props.has('inputSchema') || props.has('annotations'));
			if (name && hasContract) {
				const desc = stringValue(props.get('description'));
				const schemaNode = props.get('inputSchema');
				const title = stringValue(props.get('title'));
				tools.push({
					name,
					...(title ? { title } : {}),
					descHead: desc ? desc.split('\n')[0].slice(0, 72) : 'dynamic',
					descHash: desc ? sha12(desc) : 'dynamic',
					annotations: annotationsValue(props.get('annotations')),
					schemaHash: !schemaNode ? undefined
						: schemaNode.type === 'Identifier' ? `ref:${schemaNode.name}`
						: sha12(src.slice(schemaNode.start, schemaNode.end).replace(/\s+/g, ' ')),
				});
			}
		}
		for (const key of Object.keys(node)) {
			const v = node[key];
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v.type === 'string') walk(v);
		}
	})(ast);

	tools.sort((a, b) => a.name.localeCompare(b.name));
	return tools;
}

const current = {};
for (const file of SOURCES) {
	const tools = extractTools(file);
	if (tools.length) current[file] = tools;
}

if (process.argv.includes('--update')) {
	writeFileSync(FIXTURE, `${JSON.stringify(current, null, '\t')}\n`);
	const count = Object.values(current).reduce((n, t) => n + t.length, 0);
	console.log(`[audit:mcp-golden] fixture updated: ${count} tool contracts across ${Object.keys(current).length} files`);
	process.exit(0);
}

let golden;
try {
	golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
} catch {
	console.error(`[audit:mcp-golden] missing/unreadable fixture ${FIXTURE}`);
	console.error('  bootstrap it: node scripts/audit-mcp-golden.mjs --update');
	process.exit(1);
}

let drift = 0;
const complain = (msg) => { drift += 1; console.error(`[audit:mcp-golden] ${msg}`); };

for (const file of new Set([...Object.keys(golden), ...Object.keys(current)])) {
	const before = new Map((golden[file] ?? []).map((t) => [t.name, t]));
	const after = new Map((current[file] ?? []).map((t) => [t.name, t]));
	for (const name of before.keys()) {
		if (!after.has(name)) complain(`${file}: tool REMOVED or renamed: ${name}`);
	}
	for (const [name, tool] of after) {
		const prev = before.get(name);
		if (!prev) { complain(`${file}: tool ADDED: ${name}`); continue; }
		for (const field of ['title', 'descHash', 'schemaHash']) {
			if (JSON.stringify(prev[field]) !== JSON.stringify(tool[field])) {
				complain(`${file}: ${name}.${field.replace('Hash', '')} changed (was "${prev.descHead}")`);
			}
		}
		if (JSON.stringify(prev.annotations) !== JSON.stringify(tool.annotations)) {
			complain(`${file}: ${name}.annotations changed`);
		}
	}
}

const count = Object.values(current).reduce((n, t) => n + t.length, 0);
if (drift) {
	console.error(`\n[audit:mcp-golden] ${drift} contract change(s) vs golden fixture.`);
	console.error('  If every change above is INTENTIONAL (reviewed as a public-contract change),');
	console.error('  refresh the fixture:  node scripts/audit-mcp-golden.mjs --update');
	process.exit(1);
}
console.log(`[audit:mcp-golden] ${count} hosted MCP tool contracts match the golden fixture`);
