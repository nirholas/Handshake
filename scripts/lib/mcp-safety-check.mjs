// AST analysis behind the MCP annotation-safety gate.
//
// Separated from scripts/audit-mcp-safety.mjs so the rules can be exercised
// against fixture sources in tests/mcp-safety-audit.test.js: a gate nobody has
// watched fail is a gate nobody knows works.
//
// See the CLI for why this check exists and what each rule means.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { parse } from 'acorn';

import { ROOT } from './mcp-tool-sources.mjs';

// ---------------------------------------------------------------------------
// Mutation vocabulary
// ---------------------------------------------------------------------------

// Helper calls that sign, send, or settle. Matched on the callee's final
// identifier, so `conn.sendTransaction(...)` and `sendTransaction(...)` both hit.
export const MUTATION_CALLS = new Map([
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
export const IRREVERSIBLE = new Set(['tx-send', 'tx-sign', 'payment-settle', 'funds-transfer', 'mint']);

// A `sql` tagged template whose text opens with one of these is a write.
const SQL_WRITE = /^\s*(?:--[^\n]*\n|\s)*(insert|update|delete|truncate|drop|alter)\b/i;

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

/**
 * A string-literal or template-literal property value, with `${…}` standing in
 * for interpolations so a description stays readable and stable.
 */
function stringValue(node, constStrings = new Map(), seen = new Set()) {
	if (!node) return null;
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral') {
		return node.quasis.map((q) => q.value.cooked ?? '').join('${…}');
	}
	// Long descriptions are routinely written as `'part one ' + 'part two'`.
	if (node.type === 'BinaryExpression' && node.operator === '+') {
		const left = stringValue(node.left, constStrings, seen);
		const right = stringValue(node.right, constStrings, seen);
		if (left !== null && right !== null) return left + right;
	}
	// `description: DESCRIPTION`, where the text is a module-level constant.
	if (node.type === 'Identifier' && constStrings.has(node.name) && !seen.has(node.name)) {
		return stringValue(constStrings.get(node.name), constStrings, new Set([...seen, node.name]));
	}
	// `… + ALLOWED_HOSTS.join(', ') + …`: a literal list rendered into the copy.
	if (
		node.type === 'CallExpression' &&
		node.callee.type === 'MemberExpression' &&
		node.callee.property?.name === 'join' &&
		node.callee.object?.type === 'Identifier' &&
		constStrings.has(node.callee.object.name)
	) {
		const array = constStrings.get(node.callee.object.name);
		if (array?.type === 'ArrayExpression') {
			const parts = array.elements.map((el) => stringValue(el, constStrings, seen));
			if (parts.every((part) => part !== null)) {
				const sep = stringValue(node.arguments[0], constStrings, seen) ?? ',';
				return parts.join(sep);
			}
		}
	}
	return null;
}

const STRINGY_NODES = ['Literal', 'TemplateLiteral', 'BinaryExpression', 'Identifier'];

/**
 * Every const in a module whose value could resolve to a string, plus the same
 * from each module it imports a name out of. One hop is enough: descriptions
 * reference shared constants (`… + THREE_MINT + …`), they do not chain.
 */
function collectConstStrings(ast, relPath, depth = 1) {
	const out = new Map();
	walk(ast, (node) => {
		if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
		if (node.init && (STRINGY_NODES.includes(node.init.type) || node.init.type === 'ArrayExpression')) {
			out.set(node.id.name, node.init);
		}
	});
	if (depth <= 0) return out;

	for (const [local, binding] of collectImports(ast, relPath)) {
		if (out.has(local)) continue;
		const dep = loadModule(binding.path);
		if (!dep) continue;
		const value = dep.constStrings.get(binding.imported);
		if (value) out.set(local, value);
	}
	return out;
}

/**
 * The value a property holds, including `get description() { return '…' }`,
 * which a few tools use to compose a description from other constants.
 */
function propertyValue(prop) {
	if (!prop) return null;
	if (prop.kind !== 'get') return prop.value;
	const body = prop.value?.body?.body ?? [];
	const returned = body.find((s) => s.type === 'ReturnStatement');
	return returned?.argument ?? null;
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

/** Parsed module cache: absolute path -> { namedFunctions, imports } or null. */
const moduleCache = new Map();

function loadModule(absPath) {
	if (moduleCache.has(absPath)) return moduleCache.get(absPath);
	let parsed = null;
	try {
		const ast = parse(readFileSync(absPath, 'utf8'), {
			ecmaVersion: 'latest',
			sourceType: 'module',
		});
		const rel = relative(ROOT, absPath);
		parsed = {
			namedFunctions: collectNamedFunctions(ast),
			imports: collectImports(ast, rel),
			constStrings: collectConstStrings(ast, rel, 0),
		};
	} catch {
		parsed = null; // unparseable dependency: nothing to inspect
	}
	moduleCache.set(absPath, parsed);
	return parsed;
}

/**
 * Mutation evidence for one handler: every function it actually calls, following
 * same-module calls to any depth and calls into an imported function for
 * `maxHops` module crossings.
 *
 * Following a CALL into an imported function is evidence; merely importing a
 * module that could mutate is not. That distinction matters: a dozen read-only
 * tools import the same Solana RPC helper, and treating the import as evidence
 * flagged every one of them.
 *
 * @returns {Set<string>} evidence labels
 */
function evidenceFor(fnNode, namedFunctions, imports, maxHops = 1) {
	const evidence = new Set();
	const seen = new Set();

	const visitFunction = (fn, scope, hops) => {
		if (!fn || seen.has(fn)) return;
		seen.add(fn);
		const nextSameModule = [];
		const nextImported = [];

		walk(fn, (node) => {
			if (node.type === 'TaggedTemplateExpression') {
				const tag = calleeName(node.tag);
				const text = node.quasi?.quasis?.[0]?.value?.cooked ?? '';
				if (tag === 'sql' && SQL_WRITE.test(text)) evidence.add('db-write');
			}
			if (node.type !== 'CallExpression') return;
			const name = calleeName(node.callee);
			if (!name) return;
			const label = MUTATION_CALLS.get(name);
			if (label) evidence.add(label);

			const local = scope.namedFunctions.get(name);
			if (local && local !== fn) {
				nextSameModule.push(local);
				return;
			}
			const binding = scope.imports.get(name);
			if (binding && hops < maxHops) nextImported.push(binding);
		});

		for (const next of nextSameModule) visitFunction(next, scope, hops);
		for (const binding of nextImported) {
			const dep = loadModule(binding.path);
			if (!dep) continue;
			const target = dep.namedFunctions.get(binding.imported);
			if (target) visitFunction(target, dep, hops + 1);
		}
	};

	visitFunction(fnNode, { namedFunctions, imports }, 0);
	return evidence;
}

/** Extract every tool definition with a handler from one file. */
export function extractTools(relPath) {
	const src = readFileSync(join(ROOT, relPath), 'utf8');
	let ast;
	try {
		ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
	} catch (error) {
		return { parseError: error.message, tools: [] };
	}

	const namedFunctions = collectNamedFunctions(ast);
	const imports = collectImports(ast, relPath);
	const constObjects = collectConstObjects(ast);
	const overlays = collectAnnotationOverlays(constObjects);
	const constStrings = collectConstStrings(ast, relPath);
	const tools = [];

	walk(ast, (node) => {
		if (node.type !== 'ObjectExpression') return;
		const props = new Map();
		// Getters (`get description() { return … }`) keep their Property node so
		// the returned expression can be read; everything else maps to its value.
		const propNodes = new Map();
		for (const prop of node.properties) {
			if (prop.type === 'Property' && !prop.computed) {
				const key = prop.key?.name ?? prop.key?.value;
				props.set(key, prop.value);
				propNodes.set(key, prop);
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
				? evidenceFor(handlerNode, namedFunctions, imports)
				: new Set();

		tools.push({
			name,
			title: stringValue(propertyValue(propNodes.get('title')), constStrings),
			description: stringValue(propertyValue(propNodes.get('description')), constStrings),
			annotations,
			evidence: [...evidence].sort(),
			hasHandler: Boolean(handlerNode && FUNCTION_TYPES.has(handlerNode.type)),
		});
	});

	return { tools };
}


// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Violations for one extracted tool.
 * @param {{name: string, annotations: object, evidence: string[]}} tool
 * @param {string} where  label prefixed to each message
 * @param {Map<string, string>} exemptions  `tool:evidence` -> reason
 * @returns {{violations: string[], exempted: string[]}}
 */
export function checkTool(tool, where, exemptions) {
	const { name, annotations, evidence } = tool;
	const violations = [];
	const exempted = [];

	if (annotations.kind === 'missing') {
		violations.push(
			`${where}: no annotations. destructiveHint defaults to TRUE when omitted, so this tool is advertised as destructive. Declare them explicitly.`,
		);
		return { violations, exempted };
	}
	if (annotations.kind === 'unresolved') {
		violations.push(
			`${where}: annotations reference "${annotations.ref}", which is not a local object literal. Declare the constant in this file so the gate can read it.`,
		);
		return { violations, exempted };
	}
	if (annotations.kind === 'dynamic') {
		violations.push(`${where}: annotations are computed at runtime and cannot be verified.`);
		return { violations, exempted };
	}

	const { readOnlyHint, destructiveHint } = annotations.values;
	const unexempted = [];
	for (const label of evidence) {
		if (exemptions.has(`${name}:${label}`)) exempted.push(`${name} (${label})`);
		else unexempted.push(label);
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

	return { violations, exempted };
}
