#!/usr/bin/env node
// Build gate: every MCP tool's declared safety annotations must match what its
// handler actually does.
//
// Why this gate exists. MCP `annotations` are not decoration: clients read them
// to decide whether to run a tool without asking the user. `readOnlyHint: true`
// means "this does not modify its environment", and a client that trusts it will
// auto-approve the call. three.ws exposes tools that mint on Solana, settle x402
// payments, and write to the database, so a tool that mutates while advertising
// itself read-only converts a client's auto-approve path into an unattended
// state change. That is the protocol-layer version of the confirm-before-you-
// spend rule the money-moving surfaces already follow.
//
// Until now nothing checked those hints. `audit-mcp-golden.mjs` snapshots them,
// which catches a CHANGE to an annotation but never asks whether it was right:
// a tool born mislabeled stays mislabeled, and `--update` bakes in the next one.
//
// What it checks, per tool, from the AST (never from the tool's name -- a
// name-only heuristic flags `vanity_open` and `link_agent`, which are both
// genuinely read-only, and misses `persona_tip`, which spends):
//   1. readOnlyHint: true + evidence the handler mutates            -> FAIL
//   2. handler moves funds or mints + destructiveHint: false        -> FAIL
//      (an irreversible transfer is the definition of destructive)
//   3. annotations missing entirely                                 -> FAIL
//      (destructiveHint defaults to TRUE when omitted, so an unannotated tool
//      is advertised as destructive; that is safe but always unintended)
//
// Evidence is gathered from the handler's transitive call closure WITHIN its own
// file: `sql` template tags opening with insert/update/delete, and calls to the
// known transaction-signing and payment-settling helpers. Cross-file calls are
// out of scope on purpose -- importing a module that CAN send a transaction is
// not evidence that this handler does, and that inference produced false
// positives on every read-only tool sharing an RPC helper.
//
// Cache and telemetry writes are real writes that are not semantic mutations
// (warming an attestation cache on read, recording usage). Those are exempted
// individually in EXEMPTIONS below, each with a reason, so an exemption is a
// reviewed line in this file rather than a silent hole in the gate.
//
// Run: node scripts/audit-mcp-safety.mjs   (exit 1 on any violation)
//      node scripts/audit-mcp-safety.mjs --list   (print every tool + evidence)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

import { ROOT, allMcpToolSources } from './lib/mcp-tool-sources.mjs';

// ---------------------------------------------------------------------------
// Mutation vocabulary
// ---------------------------------------------------------------------------

// Helper calls that sign, send, or settle. Matched on the callee's final
// identifier, so `conn.sendTransaction(...)` and `sendTransaction(...)` both hit.
const MUTATION_CALLS = new Map([
	['sendTransaction', 'tx-send'],
	['sendRawTransaction', 'tx-send'],
	['sendAndConfirmTransaction', 'tx-send'],
	['sendVersionedTransaction', 'tx-send'],
	['signTransaction', 'tx-sign'],
	['partialSign', 'tx-sign'],
	['hedgedSend', 'tx-send'],
	['settlePayment', 'payment-settle'],
	['transferUsdc', 'funds-transfer'],
	['transferSol', 'funds-transfer'],
	['solanaTransfer', 'funds-transfer'],
	['mintTo', 'mint'],
	['createMint', 'mint'],
	['mintAsset', 'mint'],
]);

// Evidence classes that make an action irreversible, so `destructiveHint: false`
// is wrong for them.
const IRREVERSIBLE = new Set(['tx-send', 'tx-sign', 'payment-settle', 'funds-transfer', 'mint']);

// A `sql` tagged template whose text opens with one of these is a write.
const SQL_WRITE = /^\s*(?:--[^\n]*\n|\s)*(insert|update|delete|truncate|drop|alter)\b/i;

// ---------------------------------------------------------------------------
// Reviewed exemptions
// ---------------------------------------------------------------------------
// A tool listed here keeps `readOnlyHint: true` despite carrying write evidence,
// because the write is a cache fill or telemetry record rather than the effect
// the caller asked for. Keyed `tool:evidence`. Every entry needs a reason.
//
// Empty today: no read-only tool currently writes on the read path. It stays
// because the alternative, when a cache-warming read does appear, is someone
// weakening an annotation or deleting the gate. `tests/mcp-safety-audit.test.js`
// exercises it so it cannot rot unnoticed.
const EXEMPTIONS = new Map();

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
]);

/** Walk every child node, depth-first. */
function walk(node, visit) {
	if (!node || typeof node.type !== 'string') return;
	visit(node);
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const child of value) walk(child, visit);
		} else if (value && typeof value.type === 'string') {
			walk(value, visit);
		}
	}
}

/** The final identifier of a callee: `a.b.c()` -> "c", `c()` -> "c". */
function calleeName(callee) {
	if (!callee) return null;
	if (callee.type === 'Identifier') return callee.name;
	if (callee.type === 'MemberExpression' && !callee.computed) {
		return callee.property?.name ?? null;
	}
	return null;
}

/**
 * Local name -> resolved absolute path, for every relative import in a module.
 * Extension-less specifiers are not used in this repo's ESM sources, so a
 * specifier is resolved as written.
 */
function collectImports(ast, relPath) {
	const dir = dirname(join(ROOT, relPath));
	const bindings = new Map();
	for (const node of ast.body) {
		if (node.type !== 'ImportDeclaration') continue;
		const source = node.source.value;
		if (typeof source !== 'string' || !source.startsWith('.')) continue;
		const target = resolvePath(dir, source);
		if (!existsSync(target)) continue;
		for (const spec of node.specifiers) {
			if (spec.type === 'ImportSpecifier') {
				bindings.set(spec.local.name, { path: target, imported: spec.imported.name });
			}
		}
	}
	return bindings;
}

/** Map of every function declared at any level of a module, by name. */
function collectNamedFunctions(ast) {
	const fns = new Map();
	walk(ast, (node) => {
		if (node.type === 'FunctionDeclaration' && node.id?.name) {
			fns.set(node.id.name, node);
		} else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
			if (node.init && FUNCTION_TYPES.has(node.init.type)) fns.set(node.id.name, node.init);
		} else if (
			node.type === 'Property' &&
			!node.computed &&
			node.key?.name &&
			node.value &&
			FUNCTION_TYPES.has(node.value.type)
		) {
			// Object-literal methods, incl. `async handler(...)` shorthand.
			if (!fns.has(node.key.name)) fns.set(node.key.name, node.value);
		}
	});
	return fns;
}

/**
 * Unwrap the object-literal inside `Object.freeze({...})`, which is how several
 * servers declare their shared annotation constants.
 */
function unwrapObject(node) {
	if (!node) return null;
	if (node.type === 'ObjectExpression') return node;
	if (
		node.type === 'CallExpression' &&
		calleeName(node.callee) === 'freeze' &&
		node.arguments.length === 1
	) {
		return unwrapObject(node.arguments[0]);
	}
	return null;
}

/**
 * Boolean-valued properties of an object literal, resolving `...SPREAD` of a
 * local constant so shared annotation constants compose the way they do at
 * runtime (`{ title: '…', ...LIVE_READ }`).
 */
function objectBooleans(objNode, constObjects, seen = new Set()) {
	const values = {};
	const target = unwrapObject(objNode);
	if (!target || seen.has(target)) return values;
	seen.add(target);
	for (const prop of target.properties) {
		if (prop.type === 'SpreadElement') {
			const source =
				prop.argument.type === 'Identifier'
					? constObjects.get(prop.argument.name)
					: unwrapObject(prop.argument);
			if (source) Object.assign(values, objectBooleans(source, constObjects, seen));
			continue;
		}
		if (prop.type !== 'Property' || prop.computed) continue;
		const key = prop.key?.name ?? prop.key?.value;
		if (prop.value?.type === 'Literal' && typeof prop.value.value === 'boolean') {
			values[key] = prop.value.value;
		}
	}
	return values;
}

/** Resolve an `annotations` property to plain booleans, following a local const. */
function readAnnotations(node, constObjects) {
	if (!node) return { kind: 'missing', values: {} };
	let target = node;
	if (node.type === 'Identifier') {
		target = constObjects.get(node.name);
		if (!target) return { kind: 'unresolved', values: {}, ref: node.name };
	}
	if (!unwrapObject(target)) return { kind: 'dynamic', values: {} };
	return { kind: 'resolved', values: objectBooleans(target, constObjects) };
}

/** Every object literal assigned to a const, by name (Object.freeze unwrapped). */
function collectConstObjects(ast) {
	const out = new Map();
	walk(ast, (node) => {
		if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
		const obj = unwrapObject(node.init);
		if (obj) out.set(node.id.name, obj);
	});
	return out;
}

const HINT_KEYS = new Set([
	'readOnlyHint',
	'destructiveHint',
	'idempotentHint',
	'openWorldHint',
]);

/**
 * Annotations declared in a name-keyed overlay map rather than inline on the
 * tool def. The pump.fun server declares its tool list and its annotations as
 * two separate exports (`TOOLS` + `TOOL_ANNOTATIONS`) and merges them at
 * registration, so an inline-only reader would see 25 unannotated tools.
 * @returns {Map<string, Record<string, boolean>>} tool name -> hints
 */
function collectAnnotationOverlays(constObjects) {
	const overlays = new Map();
	for (const objNode of constObjects.values()) {
		for (const prop of objNode.properties) {
			if (prop.type !== 'Property' || prop.computed) continue;
			const toolName = prop.key?.name ?? prop.key?.value;
			if (typeof toolName !== 'string') continue;
			if (!unwrapObject(prop.value)) continue;
			const values = objectBooleans(prop.value, constObjects);
			if (Object.keys(values).some((key) => HINT_KEYS.has(key))) overlays.set(toolName, values);
		}
	}
	return overlays;
}

/**
 * Mutation evidence inside one function plus every same-file function it calls.
 * @returns {Set<string>} evidence labels
 */
function evidenceFor(fnNode, namedFunctions) {
	const evidence = new Set();
	const seen = new Set();

	const visitFunction = (fn) => {
		if (!fn || seen.has(fn)) return;
		seen.add(fn);
		const nested = [];
		walk(fn, (node) => {
			if (node.type === 'TaggedTemplateExpression') {
				const tag = calleeName(node.tag);
				const text = node.quasi?.quasis?.[0]?.value?.cooked ?? '';
				if (tag === 'sql' && SQL_WRITE.test(text)) evidence.add('db-write');
			}
			if (node.type === 'CallExpression') {
				const name = calleeName(node.callee);
				if (!name) return;
				const label = MUTATION_CALLS.get(name);
				if (label) evidence.add(label);
				const target = namedFunctions.get(name);
				// Do not re-enter the function we are already inside.
				if (target && target !== fn) nested.push(target);
			}
		});
		for (const fn2 of nested) visitFunction(fn2);
	};

	visitFunction(fnNode);
	return evidence;
}

/** Extract every tool definition with a handler from one file. */
function extractTools(relPath) {
	const src = readFileSync(join(ROOT, relPath), 'utf8');
	let ast;
	try {
		ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
	} catch (error) {
		return { parseError: error.message, tools: [] };
	}

	const namedFunctions = collectNamedFunctions(ast);
	const constObjects = collectConstObjects(ast);
	const overlays = collectAnnotationOverlays(constObjects);
	const tools = [];

	walk(ast, (node) => {
		if (node.type !== 'ObjectExpression') return;
		const props = new Map();
		for (const prop of node.properties) {
			if (prop.type === 'Property' && !prop.computed) {
				props.set(prop.key?.name ?? prop.key?.value, prop.value);
			}
		}
		const nameNode = props.get('name');
		const name =
			nameNode?.type === 'Literal' && typeof nameNode.value === 'string' ? nameNode.value : null;
		if (!name) return;
		// A tool definition, as this repo writes them: a wire name plus a
		// description and either a schema or annotations.
		if (!props.has('description') || !(props.has('inputSchema') || props.has('annotations'))) return;

		const handlerNode = props.get('handler');
		const annotations = props.has('annotations')
			? readAnnotations(props.get('annotations'), constObjects)
			: overlays.has(name)
				? { kind: 'resolved', values: overlays.get(name), via: 'overlay' }
				: { kind: 'missing', values: {} };
		const evidence =
			handlerNode && FUNCTION_TYPES.has(handlerNode.type)
				? evidenceFor(handlerNode, namedFunctions)
				: new Set();

		tools.push({
			name,
			annotations,
			evidence: [...evidence].sort(),
			hasHandler: Boolean(handlerNode && FUNCTION_TYPES.has(handlerNode.type)),
		});
	});

	return { tools };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const sources = allMcpToolSources();
const violations = [];
const exempted = [];
const rows = [];

for (const relPath of sources) {
	const { parseError, tools } = extractTools(relPath);
	if (parseError) {
		violations.push(`${relPath}: could not parse (${parseError})`);
		continue;
	}
	for (const tool of tools) {
		rows.push({ file: relPath, ...tool });
		const { name, annotations, evidence } = tool;
		const where = `${relPath}: ${name}`;

		if (annotations.kind === 'missing') {
			violations.push(
				`${where}: no annotations. destructiveHint defaults to TRUE when omitted, so this tool is advertised as destructive. Declare them explicitly.`,
			);
			continue;
		}
		if (annotations.kind === 'unresolved') {
			violations.push(
				`${where}: annotations reference "${annotations.ref}", which is not a local object literal. Declare the constant in this file so the gate can read it.`,
			);
			continue;
		}
		if (annotations.kind === 'dynamic') {
			violations.push(`${where}: annotations are computed at runtime and cannot be verified.`);
			continue;
		}

		const { readOnlyHint, destructiveHint } = annotations.values;
		const unexempted = evidence.filter((label) => !EXEMPTIONS.has(`${name}:${label}`));
		for (const label of evidence) {
			if (EXEMPTIONS.has(`${name}:${label}`)) exempted.push(`${name} (${label})`);
		}

		if (readOnlyHint === true && unexempted.length) {
			violations.push(
				`${where}: declares readOnlyHint:true but its handler shows ${unexempted.join(', ')}. An MCP client may auto-approve this call. Set readOnlyHint:false, or add a reviewed EXEMPTIONS entry if the write is a cache/telemetry fill.`,
			);
		}

		const irreversible = unexempted.filter((label) => IRREVERSIBLE.has(label));
		if (irreversible.length && destructiveHint === false) {
			violations.push(
				`${where}: declares destructiveHint:false but its handler shows ${irreversible.join(', ')}, which cannot be undone. Set destructiveHint:true.`,
			);
		}
	}
}

if (process.argv.includes('--list')) {
	for (const row of rows) {
		const ann = row.annotations.values;
		const flags = `ro=${ann.readOnlyHint ?? '-'} destr=${ann.destructiveHint ?? '-'}`;
		const ev = row.evidence.length ? row.evidence.join(',') : '-';
		const handler = row.hasHandler ? '' : ' (no local handler)';
		console.log(`${row.name.padEnd(30)} ${flags.padEnd(22)} ${ev.padEnd(24)} ${row.file}${handler}`);
	}
}

const toolCount = rows.length;
if (violations.length) {
	for (const violation of violations) console.error(`[audit:mcp-safety] ${violation}`);
	console.error(
		`\n[audit:mcp-safety] ${violations.length} annotation violation(s) across ${toolCount} tools in ${sources.length} files.`,
	);
	process.exit(1);
}

const exemptNote = exempted.length ? `, ${exempted.length} reviewed exemption(s)` : '';
console.log(
	`[audit:mcp-safety] ${toolCount} MCP tool annotations verified against handler behavior across ${sources.length} files${exemptNote}`,
);
