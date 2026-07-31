// Static materializer for MCP tool input schemas.
//
// Why this exists. scripts/build-mcp-catalog.mjs advertises the catalog as
// carrying "name, description, input schema, price, safety" in one request, but
// it shipped every tool without a schema: 272 tools an agent could discover and
// none it could actually call, because nothing said what arguments to pass.
// This module recovers the schema from source so the catalog delivers what it
// claims.
//
// Everything is read statically with acorn, for the same reason the rest of the
// MCP tooling is: importing a hosted catalog pulls in DB and RPC clients that
// block without live credentials, and a docs build must never depend on
// production.
//
// Two declaration styles exist in this repo and both are handled:
//
//   1. `inputSchema: { type: 'object', properties: { … } }` — a JSON Schema
//      literal, which 262 of the 272 tools use. Read by `jsonValue`.
//   2. `inputSchema: inputJsonSchema` where `const inputJsonSchema =
//      jsonSchemaFromZod(inputZodShape)` — built at import time from a zod
//      shape (the IBM Granite and vanity-grinder tools). Read by `zodShape`,
//      which re-derives what zod-to-json-schema would have produced.
//
// The hard rule for both readers: anything not recognized is reported as
// dynamic and omitted, never guessed. A catalog that is silently wrong about a
// tool's arguments is worse than one that says it does not know.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

import { ROOT } from './mcp-tool-sources.mjs';

/* ── AST helpers ─────────────────────────────────────────────────────────── */

function walk(node, visit) {
	if (!node || typeof node.type !== 'string') return;
	visit(node);
	for (const key of Object.keys(node)) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		const value = node[key];
		if (Array.isArray(value)) for (const child of value) walk(child, visit);
		else if (value && typeof value.type === 'string') walk(value, visit);
	}
}

/** `Object.freeze(x)` and `x` alike resolve to x. */
function unwrapFreeze(node) {
	if (
		node?.type === 'CallExpression' &&
		node.callee?.type === 'MemberExpression' &&
		node.callee.property?.name === 'freeze' &&
		node.arguments.length === 1
	) {
		return unwrapFreeze(node.arguments[0]);
	}
	return node;
}

/** Every `const x = …` in the module, by name. */
function collectConsts(ast) {
	const out = new Map();
	walk(ast, (node) => {
		if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
		if (node.init) out.set(node.id.name, unwrapFreeze(node.init));
	});
	return out;
}

const propKey = (prop) => prop.key?.name ?? prop.key?.value;

/* ── JSON Schema literals ────────────────────────────────────────────────── */

/**
 * Materialize an expression as a plain JSON value.
 *
 * Records every expression it cannot resolve on `ctx.dynamic` (as a dotted path
 * into the schema) and returns `undefined` for it, so the caller drops the key
 * rather than emitting a placeholder.
 *
 * @param {object} node   acorn expression node
 * @param {{consts: Map<string, object>, dynamic: string[], seen: Set<object>}} ctx
 * @param {string} path   dotted path, for the dynamic report
 * @returns {*} the value, or undefined when it is not statically knowable
 */
function jsonValue(node, ctx, path) {
	if (!node) return undefined;

	switch (node.type) {
		case 'Literal':
			// Regex literals carry no JSON value (`value` is a RegExp object).
			if (node.regex) return node.raw;
			return node.value;

		case 'TemplateLiteral': {
			// An interpolated description is still worth showing; `${…}` marks the
			// hole, matching how the safety and golden readers render one.
			const cooked = node.quasis.map((q) => q.value.cooked ?? '');
			return node.expressions.length ? cooked.join('${…}') : cooked.join('');
		}

		case 'BinaryExpression': {
			// Long descriptions are routinely written as `'part one ' + 'part two'`.
			if (node.operator !== '+') break;
			const left = jsonValue(node.left, ctx, path);
			const right = jsonValue(node.right, ctx, path);
			if (left === undefined || right === undefined) return undefined;
			if (typeof left === 'number' && typeof right === 'number') return left + right;
			return `${left}${right}`;
		}

		case 'UnaryExpression': {
			const inner = jsonValue(node.argument, ctx, path);
			if (typeof inner !== 'number') break;
			if (node.operator === '-') return -inner;
			if (node.operator === '+') return inner;
			break;
		}

		case 'ArrayExpression': {
			const out = [];
			node.elements.forEach((element, i) => {
				if (!element) return; // a hole
				if (element.type === 'SpreadElement') {
					const spread = jsonValue(element.argument, ctx, `${path}[${i}]`);
					if (Array.isArray(spread)) out.push(...spread);
					else ctx.dynamic.push(`${path}[${i}]`);
					return;
				}
				const value = jsonValue(element, ctx, `${path}[${i}]`);
				if (value === undefined) ctx.dynamic.push(`${path}[${i}]`);
				else out.push(value);
			});
			return out;
		}

		case 'ObjectExpression': {
			const out = {};
			for (const prop of node.properties) {
				if (prop.type === 'SpreadElement') {
					const spread = jsonValue(prop.argument, ctx, path);
					if (spread && typeof spread === 'object' && !Array.isArray(spread)) {
						Object.assign(out, spread);
					} else {
						ctx.dynamic.push(`${path}.…spread`);
					}
					continue;
				}
				if (prop.type !== 'Property' || prop.computed) {
					ctx.dynamic.push(`${path}.…computed`);
					continue;
				}
				const key = propKey(prop);
				if (typeof key !== 'string') {
					ctx.dynamic.push(`${path}.…computed`);
					continue;
				}
				const child = `${path}.${key}`;
				// A method or getter in a schema position is code, not data.
				if (prop.value.type === 'FunctionExpression' || prop.value.type === 'ArrowFunctionExpression') {
					ctx.dynamic.push(child);
					continue;
				}
				const value = jsonValue(prop.value, ctx, child);
				if (value === undefined) ctx.dynamic.push(child);
				else out[key] = value;
			}
			return out;
		}

		case 'Identifier': {
			const target = ctx.consts.get(node.name);
			if (!target || ctx.seen.has(target)) return undefined;
			ctx.seen.add(target);
			try {
				return jsonValue(target, ctx, path);
			} finally {
				ctx.seen.delete(target);
			}
		}

		case 'MemberExpression': {
			if (node.computed) break;
			const object = jsonValue(node.object, ctx, path);
			if (!object || typeof object !== 'object') break;
			return object[node.property?.name];
		}

		default:
			break;
	}
	return undefined;
}

/* ── zod shapes ──────────────────────────────────────────────────────────── */

// The zod vocabulary these tool files actually use. Anything outside it makes
// the whole schema dynamic rather than a partially-invented one: an argument
// list that is subtly wrong costs an integrator more than one that is absent.
const ZOD_BASES = new Set(['string', 'number', 'boolean', 'array', 'object', 'enum', 'literal']);
const ZOD_MODIFIERS = new Set(['min', 'max', 'int', 'optional', 'describe', 'default', 'nullable']);

/**
 * Unwind a chained zod expression into its base call plus the modifiers applied
 * to it, outermost last: `z.string().min(1).optional()` becomes
 * `{ base: z.string() call, chain: [min, optional] }`.
 * @returns {{base: object, chain: {name: string, args: object[]}[]}|null}
 */
function unwindZodChain(node) {
	const chain = [];
	let cursor = node;
	while (cursor?.type === 'CallExpression' && cursor.callee?.type === 'MemberExpression' && !cursor.callee.computed) {
		const name = cursor.callee.property?.name;
		const receiver = cursor.callee.object;
		// `z.string()` is the base: its receiver is the zod namespace itself.
		if (receiver?.type === 'Identifier' && receiver.name === 'z') {
			if (!ZOD_BASES.has(name)) return null;
			return { base: { name, args: cursor.arguments }, chain: chain.reverse() };
		}
		if (!ZOD_MODIFIERS.has(name)) return null;
		chain.push({ name, args: cursor.arguments });
		cursor = receiver;
	}
	return null;
}

/**
 * A single zod field as JSON Schema, mirroring what zod-to-json-schema emits
 * for the constructs in use.
 * @returns {{schema: object, required: boolean}|null} null when unreadable
 */
function zodField(node, ctx, path) {
	const unwound = unwindZodChain(node);
	if (!unwound) return null;
	const { base, chain } = unwound;

	let schema;
	switch (base.name) {
		case 'string':
			schema = { type: 'string' };
			break;
		case 'number':
			schema = { type: 'number' };
			break;
		case 'boolean':
			schema = { type: 'boolean' };
			break;
		case 'array': {
			const items = base.args[0] ? zodField(base.args[0], ctx, `${path}[]`) : null;
			if (!items) return null;
			schema = { type: 'array', items: items.schema };
			break;
		}
		case 'object': {
			const inner = base.args[0];
			if (inner?.type !== 'ObjectExpression') return null;
			const built = zodShapeObject(inner, ctx, path);
			if (!built) return null;
			schema = built;
			break;
		}
		case 'enum': {
			const values = jsonValue(base.args[0], ctx, `${path}.enum`);
			if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) return null;
			schema = { type: 'string', enum: values };
			break;
		}
		case 'literal': {
			const value = jsonValue(base.args[0], ctx, `${path}.const`);
			if (value === undefined) return null;
			schema = { type: typeof value === 'number' ? 'number' : typeof value, const: value };
			break;
		}
		default:
			return null;
	}

	// zod-to-json-schema drops a field from `required` for both `.optional()` and
	// `.default()`; a defaulted field is satisfiable without the caller sending it.
	let required = true;
	for (const step of chain) {
		switch (step.name) {
			case 'optional':
			case 'nullable':
				required = false;
				break;
			case 'int':
				schema.type = 'integer';
				break;
			case 'describe': {
				const text = jsonValue(step.args[0], ctx, `${path}.description`);
				if (typeof text !== 'string') return null;
				schema.description = text;
				break;
			}
			case 'default': {
				const value = jsonValue(step.args[0], ctx, `${path}.default`);
				if (value === undefined) return null;
				schema.default = value;
				required = false;
				break;
			}
			case 'min':
			case 'max': {
				const bound = jsonValue(step.args[0], ctx, `${path}.${step.name}`);
				if (typeof bound !== 'number') return null;
				const key = {
					string: step.name === 'min' ? 'minLength' : 'maxLength',
					array: step.name === 'min' ? 'minItems' : 'maxItems',
				}[base.name] ?? (step.name === 'min' ? 'minimum' : 'maximum');
				schema[key] = bound;
				break;
			}
			default:
				return null;
		}
	}
	return { schema, required };
}

/**
 * A `{ field: z.… }` shape object as a JSON Schema object node.
 * @returns {object|null} null when any field is unreadable
 */
function zodShapeObject(node, ctx, path) {
	const properties = {};
	const required = [];
	for (const prop of node.properties) {
		if (prop.type !== 'Property' || prop.computed) return null;
		const key = propKey(prop);
		if (typeof key !== 'string') return null;
		const field = zodField(prop.value, ctx, `${path}.${key}`);
		if (!field) return null;
		properties[key] = field.schema;
		if (field.required) required.push(key);
	}
	// `.strict()` on the outer object and zod's default strip on inner ones both
	// render as `additionalProperties: false`.
	const schema = { type: 'object', properties };
	if (required.length) schema.required = required;
	schema.additionalProperties = false;
	return schema;
}

/* ── entry points ────────────────────────────────────────────────────────── */

/**
 * Resolve one `inputSchema:` property value to a JSON Schema.
 *
 * @param {object} node  the expression assigned to `inputSchema`
 * @param {Map<string, object>} consts  the module's const initializers
 * @returns {{schema: object|null, dynamic: string[], reason: string|null}}
 */
export function materializeSchema(node, consts) {
	const ctx = { consts, dynamic: [], seen: new Set() };

	// `const inputJsonSchema = jsonSchemaFromZod(inputZodShape)` — follow the
	// identifier to the call, then read the zod shape it was built from.
	let target = node;
	if (target?.type === 'Identifier') {
		const resolved = consts.get(target.name);
		if (resolved) target = resolved;
	}

	if (target?.type === 'CallExpression') {
		const callee = target.callee?.name ?? target.callee?.property?.name;
		if (callee === 'jsonSchemaFromZod' && target.arguments.length === 1) {
			let shape = target.arguments[0];
			if (shape.type === 'Identifier') shape = consts.get(shape.name) ?? shape;
			if (shape?.type === 'ObjectExpression') {
				const schema = zodShapeObject(shape, ctx, 'inputSchema');
				if (schema) return { schema, dynamic: [], reason: null };
			}
			return { schema: null, dynamic: [], reason: 'zod shape uses a construct this reader does not model' };
		}
		return { schema: null, dynamic: [], reason: 'built by a call at import time' };
	}

	if (target?.type !== 'ObjectExpression') {
		return { schema: null, dynamic: [], reason: 'not a statically-declared object' };
	}

	const schema = jsonValue(target, ctx, 'inputSchema');
	if (!schema || typeof schema !== 'object') {
		return { schema: null, dynamic: ctx.dynamic, reason: 'did not resolve to an object' };
	}
	return { schema, dynamic: ctx.dynamic, reason: null };
}

/**
 * Every statically-declared tool input schema in one tool-definition file,
 * keyed by wire tool name.
 *
 * The tool predicate here is deliberately looser than the safety gate's (a
 * string `name` plus an `inputSchema` is enough): callers correlate by name, so
 * a superset costs nothing, while a stricter predicate that drifted from the
 * gate's would silently drop a tool's arguments.
 *
 * @param {string} relPath  repo-relative path to a tool-definition file
 * @returns {Map<string, {schema: object|null, dynamic: string[], reason: string|null}>}
 */
export function extractInputSchemas(relPath) {
	const src = readFileSync(join(ROOT, relPath), 'utf8');
	let ast;
	try {
		ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
	} catch {
		return new Map();
	}
	const consts = collectConsts(ast);
	const out = new Map();

	walk(ast, (node) => {
		if (node.type !== 'ObjectExpression') return;
		let name = null;
		let schemaNode = null;
		for (const prop of node.properties) {
			if (prop.type !== 'Property' || prop.computed) continue;
			const key = propKey(prop);
			if (key === 'name' && prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
				name = prop.value.value;
			} else if (key === 'inputSchema') {
				schemaNode = prop.value;
			}
		}
		if (!name || !schemaNode || out.has(name)) return;
		out.set(name, materializeSchema(schemaNode, consts));
	});

	return out;
}

/**
 * Argument rows for one schema, in declaration order: what a reference table or
 * a generated form needs, without either having to re-walk JSON Schema.
 *
 * @param {object|null} schema
 * @returns {{name: string, type: string, required: boolean, description: string|null,
 *            enum: string[]|null, default: *, format: string|null}[]}
 */
export function schemaArguments(schema) {
	const properties = schema?.properties;
	if (!properties || typeof properties !== 'object') return [];
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	return Object.entries(properties).map(([name, spec]) => ({
		name,
		type: Array.isArray(spec?.type) ? spec.type.join(' | ') : (spec?.type ?? 'any'),
		required: required.has(name),
		description: typeof spec?.description === 'string' ? spec.description : null,
		enum: Array.isArray(spec?.enum) ? spec.enum.map(String) : null,
		default: spec?.default,
		format: typeof spec?.format === 'string' ? spec.format : null,
	}));
}
