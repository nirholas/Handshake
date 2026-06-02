// Shared JSON-RPC 2.0 dispatcher for the focused, payment-free MCP servers
// (3D Studio, x402 Bazaar). The main /api/mcp server keeps its own dispatch
// because it layers pump-agent-payments gating on top; these servers don't, so
// they share this slim core: method routing, scope checks, Ajv arg validation,
// usage accounting, and the MCP error conventions.
import { hasScope } from './auth.js';
import { recordEvent, logger } from './usage.js';

export const PROTOCOL_VERSION = '2025-06-18';

function ok(id, result) {
	return { jsonrpc: '2.0', id, result };
}

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

function summarize(args) {
	const o = {};
	for (const [k, v] of Object.entries(args || {})) {
		o[k] = typeof v === 'string' && v.length > 64 ? v.slice(0, 64) + '…' : v;
	}
	return o;
}

// Build a dispatch(msg, auth, req) function bound to one server's catalog.
//   serverInfo   { name, version }
//   instructions string shown to clients on initialize
//   catalog      tools/list array (schemas, no handlers)
//   tools        { [name]: { scope?, handler, validate? } }
//   logName      logger namespace + usage `server` tag
export function makeDispatcher({ serverInfo, instructions, catalog, tools, logName }) {
	const log = logger(logName);

	async function onToolCall(params, auth, started) {
		const { name, arguments: args = {} } = params || {};
		const tool = tools[name];
		if (!tool) throw rpcError(-32602, `unknown tool: ${name}`);
		if (tool.scope && !hasScope(auth.scope, tool.scope)) {
			throw rpcError(-32002, `insufficient scope, requires ${tool.scope}`);
		}
		if (tool.validate && !tool.validate(args)) {
			const first = tool.validate.errors?.[0];
			const detail = first
				? `${first.instancePath || '(root)'} ${first.message || 'invalid'}`
				: 'invalid arguments';
			throw rpcError(-32602, `invalid params for ${name}: ${detail}`);
		}

		const event = {
			userId: auth.userId,
			apiKeyId: auth.apiKeyId,
			clientId: auth.clientId,
			kind: 'tool_call',
			tool: name,
		};
		try {
			const result = await tool.handler(args, auth);
			recordEvent({
				...event,
				latencyMs: Date.now() - started,
				meta: { args_summary: summarize(args), server: logName },
			});
			return result;
		} catch (err) {
			recordEvent({
				...event,
				status: 'error',
				latencyMs: Date.now() - started,
				meta: { error: err.message, server: logName },
			});
			if (err.code && typeof err.code === 'number') throw err;
			return {
				content: [{ type: 'text', text: `Error: ${err.message || 'tool call failed'}` }],
				isError: true,
			};
		}
	}

	return async function dispatch(msg, auth, _req) {
		const started = Date.now();
		const id = msg.id;
		const isNotification = id === undefined;

		try {
			if (msg.jsonrpc !== '2.0') throw rpcError(-32600, 'invalid Request');
			const method = msg.method;

			if (method === 'initialize') {
				return ok(id, {
					protocolVersion: PROTOCOL_VERSION,
					serverInfo,
					capabilities: {
						tools: { listChanged: false },
						resources: { listChanged: false, subscribe: false },
						logging: {},
					},
					instructions,
				});
			}
			if (method === 'ping') return ok(id, {});
			if (method === 'notifications/initialized') return null;
			if (method === 'tools/list') return ok(id, { tools: catalog });
			if (method === 'tools/call') return ok(id, await onToolCall(msg.params, auth, started));
			if (method === 'resources/list') return ok(id, { resources: [] });
			if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
			if (method === 'prompts/list') return ok(id, { prompts: [] });
			if (method === 'logging/setLevel') return ok(id, {});

			throw rpcError(-32601, `method not found: ${method}`);
		} catch (err) {
			log.warn('rpc_error', { method: msg.method, code: err.code, message: err.message });
			if (isNotification) return null;
			return {
				jsonrpc: '2.0',
				id,
				error: { code: err.code || -32603, message: err.message || 'internal error', data: err.data },
			};
		}
	};
}
