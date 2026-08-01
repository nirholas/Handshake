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
import { dirname, join, normalize } from 'node:path';
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
function collectLocalConsts(ast) {
	const out = new Map();
	walk(ast, (node) => {
		if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
		if (node.init) out.set(node.id.name, unwrapFreeze(node.init));
	});
	return out;
}

const moduleCache = new Map();

/** Parsed consts of a repo-relative module, or null when it cannot be read. */
function localConstsOf(relPath) {
	if (moduleCache.has(relPath)) return moduleCache.get(relPath);
	let consts = null;
	try {
		const ast = parse(readFileSync(join(ROOT, relPath), 'utf8'), {
			ecmaVersion: 'latest',
			sourceType: 'module',
		});
		consts = collectLocalConsts(ast);
	} catch {
		consts = null; // missing or unparseable: nothing to inherit
	}
	moduleCache.set(relPath, consts);
	return consts;
}

/**
 * Every const a tool file can see by name: its own, plus one level of
 * relative imports.
 *
 * Schema bounds and enum member lists are routinely hoisted into a shared
 * module (`maximum: TOKENIZE_3D_ROYALTY_CAP_BPS`, `z.enum(ACCEPTED_IMAGE_TYPES)`),
 * and a reader that stopped at the file boundary dropped exactly those
 * constraints. One level is enough for every case in this repo and keeps the
 * read bounded; a bare package specifier is never followed.
 */
function collectConsts(ast, relPath) {
	const out = collectLocalConsts(ast);
	const dir = dirname(relPath);

	for (const node of ast.body) {
		if (node.type !== 'ImportDeclaration') continue;
		const spec = node.source?.value;
		if (typeof spec !== 'string' || !spec.startsWith('.')) continue;
		const imported = localConstsOf(normalize(join(dir, spec)));
		if (!imported) continue;
		for (const s of node.specifiers) {
			if (s.type !== 'ImportSpecifier') continue;
			const local = s.local.name;
			// A local declaration always wins over an import of the same name.
			if (out.has(local)) continue;
			const value = imported.get(s.imported.name ?? s.imported.value);
			if (value) out.set(local, value);
		}
	}
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
			if (left === undefined && right === undefined) return undefined;
			if (typeof left === 'number' && typeof right === 'number') return left + right;
			// One side is an env-driven or computed value (`'cap: $' + CAPS.max`).
			// Mark the hole the way a template literal's is marked rather than
			// dropping a whole sentence of documentation over one number.
			const text = (side) => (side === undefined ? '${…}' : String(side));
			return `${text(left)}${text(right)}`;
		}

		case 'UnaryExpression': {
			const inner = jsonValue(node.argument, ctx, path);
			if (typeof inner !== 'number') break;
			if (node.operator === '-') return -inner;
			if (node.operator === '+') return inner;
			break;
		}

		case 'ArrayExpression': {
			// All or nothing. A truncated array is a lie in every position a schema
			// puts one: a short `enum` rejects values the tool accepts, and a short
			// `required` tells a caller an argument is optional when it is not.
			const out = [];
			for (let i = 0; i < node.elements.length; i++) {
				const element = node.elements[i];
				if (!element) continue; // a hole
				if (element.type === 'SpreadElement') {
					const spread = jsonValue(element.argument, ctx, `${path}[${i}]`);
					if (!Array.isArray(spread)) return undefined;
					out.push(...spread);
					continue;
				}
				const value = jsonValue(element, ctx, `${path}[${i}]`);
				if (value === undefined) return undefined;
				out.push(value);
			}
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

		case 'CallExpression': {
			// `Object.keys(SOME_CONST)` is how several enums are declared, and the
			// const it reads is right here in the module.
			const callee = node.callee;
			if (
				callee?.type === 'MemberExpression' &&
				callee.object?.name === 'Object' &&
				callee.property?.name === 'keys' &&
				node.arguments.length === 1
			) {
				const source = jsonValue(node.arguments[0], ctx, path);
				if (source && typeof source === 'object' && !Array.isArray(source)) return Object.keys(source);
			}
			break;
		}

		default:
			break;
	}
	return undefined;
}

/* ── zod shapes ──────────────────────────────────────────────────────────── */

// The zod vocabulary these tool files actually use, surveyed across every
// source in mcpToolSources(). Anything outside it makes the whole schema
// dynamic rather than a partially-invented one: an argument list that is subtly
// wrong costs an integrator more than one that is absent.
const ZOD_BASES = new Set([
	'string',
	'number',
	'boolean',
	'array',
	'object',
	'enum',
	'literal',
	'record',
	'union',
	'any',
]);
const ZOD_MODIFIERS = new Set([
	'min',
	'max',
	'gt',
	'int',
	'positive',
	'nonnegative',
	'optional',
	'nullable',
	'describe',
	'default',
	'catch',
	'trim',
	'refine',
	'partial',
	'strict',
	'url',
	'uuid',
	'email',
	'regex',
	'nonempty',
]);

/**
 * Unwind a chained zod expression into its base call plus the modifiers applied
 * to it, outermost last: `z.string().min(1).optional()` becomes
 * `{ base: z.string() call, chain: [min, optional] }`.
 * @returns {{base: object, chain: {name: string, args: object[]}[]}|null}
 */
function unwindZodChain(node, consts) {
	const chain = [];
	// A field is as often hoisted to a const as written inline
	// (`inputSchema: { subscription }`), so follow the name before giving up.
	let cursor = node?.type === 'Identifier' && consts?.has(node.name) ? consts.get(node.name) : node;
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
	const unwound = unwindZodChain(node, ctx.consts);
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
			if (Array.isArray(values) && values.every((v) => typeof v === 'string')) {
				schema = { type: 'string', enum: values };
			} else {
				// The member list lives behind an import or a computed expression. The
				// argument itself is still real and still a string; keeping it without
				// the enum beats dropping a documented argument over a missing list.
				ctx.dynamic.push(`${path}.enum`);
				schema = { type: 'string' };
			}
			break;
		}
		case 'literal': {
			const value = jsonValue(base.args[0], ctx, `${path}.const`);
			if (value === undefined) return null;
			schema = { type: typeof value === 'number' ? 'number' : typeof value, const: value };
			break;
		}
		case 'record': {
			// z.record(value) and z.record(key, value) both constrain the values.
			const valueNode = base.args.length > 1 ? base.args[1] : base.args[0];
			if (!valueNode) {
				schema = { type: 'object' };
				break;
			}
			const values = zodField(valueNode, ctx, `${path}.*`);
			if (!values) return null;
			schema = { type: 'object', additionalProperties: values.schema };
			break;
		}
		case 'union': {
			const members = base.args[0];
			if (members?.type !== 'ArrayExpression') return null;
			const built = [];
			for (const member of members.elements) {
				const field = member ? zodField(member, ctx, `${path}|`) : null;
				if (!field) return null;
				built.push(field.schema);
			}
			schema = { anyOf: built };
			break;
		}
		case 'any':
			// No constraint at all. An empty schema is what that means in JSON
			// Schema, and it is the honest answer rather than inventing a type.
			schema = {};
			break;
		default:
			return null;
	}

	// zod-to-json-schema drops a field from `required` for both `.optional()` and
	// `.default()`; a defaulted field is satisfiable without the caller sending it.
	let required = true;
	for (const step of chain) {
		switch (step.name) {
			case 'optional':
				required = false;
				break;
			case 'nullable':
				// A nullable field still has to be sent; it may just be null. Widening
				// the type says exactly that, where treating it as optional would tell
				// an integrator they can omit a required argument.
				if (typeof schema.type === 'string') schema.type = [schema.type, 'null'];
				else if (!schema.type) schema.anyOf = [{ ...schema }, { type: 'null' }];
				break;
			case 'int':
				schema.type = 'integer';
				break;
			// Parse-time only: `.trim()` normalizes the value, `.catch()` swaps in a
			// fallback on failure, `.refine()` runs a predicate. None of the three
			// narrows the accepted shape, so none of them changes the schema.
			case 'trim':
			case 'catch':
			case 'refine':
				break;
			case 'strict':
				schema.additionalProperties = false;
				break;
			case 'partial':
				delete schema.required;
				break;
			case 'positive':
				schema.exclusiveMinimum = 0;
				break;
			case 'nonnegative':
				schema.minimum = 0;
				break;
			case 'nonempty':
				schema[base.name === 'array' ? 'minItems' : 'minLength'] = 1;
				break;
			case 'url':
				schema.format = 'uri';
				break;
			case 'uuid':
				schema.format = 'uuid';
				break;
			case 'email':
				schema.format = 'email';
				break;
			case 'regex': {
				// Inline literal, or a named const like `BASE58_RE` declared above.
				let node = step.args[0];
				if (node?.type === 'Identifier') node = ctx.consts.get(node.name) ?? node;
				const source = node?.regex?.pattern;
				if (typeof source !== 'string') {
					ctx.dynamic.push(`${path}.pattern`);
					break;
				}
				schema.pattern = source;
				break;
			}
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
			case 'gt': {
				const bound = jsonValue(step.args[0], ctx, `${path}.gt`);
				if (typeof bound !== 'number') return null;
				schema.exclusiveMinimum = bound;
				break;
			}
			case 'min':
			case 'max': {
				const bound = jsonValue(step.args[0], ctx, `${path}.${step.name}`);
				if (typeof bound !== 'number') return null;
				const key =
					{
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
	let readable = 0;
	for (const prop of node.properties) {
		if (prop.type !== 'Property' || prop.computed) {
			ctx.dynamic.push(`${path}.…computed`);
			continue;
		}
		const key = propKey(prop);
		if (typeof key !== 'string') {
			ctx.dynamic.push(`${path}.…computed`);
			continue;
		}
		const field = zodField(prop.value, ctx, `${path}.${key}`);
		// One field built with a construct this reader does not model must not cost
		// the caller the other six. Report it and keep going.
		if (!field) {
			ctx.dynamic.push(`${path}.${key}`);
			continue;
		}
		readable++;
		properties[key] = field.schema;
		if (field.required) required.push(key);
	}
	if (node.properties.length && !readable) return null;
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
	const unreadable = 'declared with a zod construct this reader does not model';

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
			return { schema: null, dynamic: [], reason: unreadable };
		}
		// `parameters: z.object({ … })`: the tool-SDK style. Read the zod chain
		// directly; a bare `z.object()` is already the whole argument schema.
		const field = zodField(target, ctx, 'inputSchema');
		if (field?.schema?.type === 'object') return { schema: field.schema, dynamic: [], reason: null };
		return { schema: null, dynamic: [], reason: 'built by a call at import time' };
	}

	if (target?.type !== 'ObjectExpression') {
		return { schema: null, dynamic: [], reason: 'not a statically-declared object' };
	}

	// Two object shapes are legal here and they are not interchangeable: a JSON
	// Schema (`{ type: 'object', properties: { … } }`) and a raw zod shape
	// (`{ field: z.string() }`, which the MCP SDK converts itself). Reading a raw
	// shape with the JSON reader is what dropped the arguments of 33 tools: every
	// value was a call expression it could not resolve, so every property was
	// discarded and the tool shipped an empty `properties` object.
	if (isRawZodShape(target, consts)) {
		const schema = zodShapeObject(target, ctx, 'inputSchema');
		if (schema) return { schema, dynamic: [], reason: null };
		return { schema: null, dynamic: [], reason: unreadable };
	}

	const schema = jsonValue(target, ctx, 'inputSchema');
	if (!schema || typeof schema !== 'object') {
		return { schema: null, dynamic: ctx.dynamic, reason: 'did not resolve to an object' };
	}
	return { schema, dynamic: ctx.dynamic, reason: null };
}

/**
 * True when an object literal is a zod raw shape rather than a JSON Schema.
 * A JSON Schema always announces itself with `type` or `properties`; a raw
 * shape's values are all zod chains.
 */
function isRawZodShape(node, consts) {
	// Decided on the values, never the keys: a shape whose first field happens to
	// be named `type` (`{ type: z.enum(['http','mcp']) }`) is still a zod shape,
	// and a key-based test read six of those as JSON Schema and emitted them with
	// no arguments at all. A JSON Schema literal can never hold a `z.…()` chain
	// in a property position, so one is proof.
	return node.properties.some(
		(prop) => prop.type === 'Property' && !prop.computed && Boolean(unwindZodChain(prop.value, consts)),
	);
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
	const consts = collectConsts(ast, relPath);
	const out = new Map();

	walk(ast, (node) => {
		if (node.type !== 'ObjectExpression') return;
		let name = null;
		let schemaNode = null;
		let parametersNode = null;
		for (const prop of node.properties) {
			if (prop.type !== 'Property' || prop.computed) continue;
			const key = propKey(prop);
			if (key === 'name') {
				// A wire name is as often `name: TOOL_NAME` as a literal; resolving it
				// through the module's consts is what keeps @three-ws/tool-sdk tools
				// (which always name themselves that way) from vanishing.
				const value = jsonValue(prop.value, { consts, dynamic: [], seen: new Set() }, 'name');
				if (typeof value === 'string') name = value;
			} else if (key === 'inputSchema') {
				schemaNode = prop.value;
			} else if (key === 'parameters') {
				// @three-ws/tool-sdk names the same field `parameters` and converts it
				// to `inputSchema` when it emits MCP tools (defineTool → toMcpTools).
				parametersNode = prop.value;
			}
		}
		const source = schemaNode ?? parametersNode;
		if (!name || !source || out.has(name)) return;
		out.set(name, materializeSchema(source, consts));
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
