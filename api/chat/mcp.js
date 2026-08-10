// ─────────────────────────────────────────────────────────────────────────────
// MCP server — viewer-control tools for three.ws.
//
// Exposes the same tool catalog as POST /api/chat (setWireframe, loadModel,
// takeScreenshot, …) but over MCP 2025-06-18 JSON-RPC so external agents
// (Claude Desktop, LobeHub, Cursor) can drive the viewer without going through
// our chat UI.
//
// Execution model: tool calls return an "action intent" — { action, input,
// resource } — that the MCP client is expected to relay to the live three.ws
// viewer (via the LobeHub iframe postMessage bridge or a future WS channel).
// We do NOT execute against a browser viewer from the server: there is none.
//
// Auth: Bearer token (OAuth/API key) — same as /api/mcp.
// ─────────────────────────────────────────────────────────────────────────────

import { env } from '../_lib/env.js';
import { authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, method, readJson, wrap } from '../_lib/http.js';
import { recordEvent, logger } from '../_lib/usage.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'three-ws-viewer-mcp', version: '0.1.0' };
const log = logger('chat-mcp');

const VIEWER_TOOLS = [
	{
		name: 'setWireframe',
		description: 'Toggle wireframe rendering on the currently loaded model.',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setSkeleton',
		description: 'Toggle the skeleton helper for rigged models.',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setGrid',
		description: 'Toggle the reference grid and axes helper.',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setAutoRotate',
		description: 'Toggle camera auto-rotation around the model.',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setBgColor',
		description: 'Set the viewer background color (CSS hex like "#001133").',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'string', pattern: '^#[0-9a-fA-F]{3,8}$' } },
			required: ['value'],
		},
	},
	{
		name: 'setTransparentBg',
		description: 'Toggle transparent background.',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'boolean' } },
			required: ['value'],
		},
	},
	{
		name: 'setEnvironment',
		description:
			'Change the HDRI lighting. Known values: "None", "Neutral", "Venice Sunset", "Footprint Court (HDR Labs)".',
		inputSchema: {
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
		},
	},
	{
		name: 'takeScreenshot',
		description: 'Capture a PNG screenshot of the viewport.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'loadModel',
		description: 'Load a glTF or GLB model by URL.',
		inputSchema: {
			type: 'object',
			properties: { url: { type: 'string', format: 'uri' } },
			required: ['url'],
		},
	},
	{
		name: 'runValidation',
		description: 'Run glTF validation on the loaded model.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'showMaterialEditor',
		description: 'Open the material editor panel in the viewer.',
		inputSchema: { type: 'object', properties: {} },
	},
];

const TOOL_NAMES = new Set(VIEWER_TOOLS.map((t) => t.name));

export default wrap(async (req, res) => {
	// `origins: '*'` matches every other MCP server in this repo (api/mcp.js,
	// mcp-3d, mcp-studio, mcp-agent, mcp-bazaar, ibm-mcp, pump-fun-mcp). This one
	// exists so browser-hosted MCP clients (the LobeHub plugin iframe) can drive
	// the viewer, and the default APP_ORIGIN allowlist blocked exactly those.
	// Safe because the endpoint is Bearer-only: no credentials flag is set, so a
	// cross-origin page still cannot ride a signed-in user's session, it can only
	// spend a token it already holds.
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	// A wrong method is a 405 with an Allow header, NOT a 401. Answering GET with
	// "unauthorized" sent MCP clients into a re-auth loop over what was only ever
	// a method mismatch, and hid the real contract from anyone probing the URL.
	if (!method(req, res, ['POST'])) return;

	const auth = await authenticateBearer(extractBearer(req), { audience: env.MCP_RESOURCE });
	if (!auth) return send401(res, 'missing or invalid access token');

	const body = await readJson(req);
	const result = await dispatch(body, auth);
	res.setHeader('mcp-protocol-version', PROTOCOL_VERSION);
	// JSON-RPC notifications (a message with no `id`) must never be answered.
	// dispatch() returns null for those; every real MCP client sends
	// `notifications/initialized` straight after initialize, and replying to it
	// with a -32601 error made the handshake look broken to the client.
	if (result === null) {
		res.statusCode = 202;
		res.end();
		return;
	}
	res.statusCode = 200;
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(result));
});

async function dispatch(msg, auth) {
	if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
		return rpcErr(msg?.id ?? null, -32600, 'invalid request');
	}

	// A message without an `id` is a notification: the caller expects no reply at
	// all, not even an error one. Handled before the switch so an unknown
	// notification stays silent instead of drawing a -32601 the client can only
	// read as a failed handshake.
	const isNotification = msg.id === undefined || msg.id === null;
	if (isNotification) {
		if (msg.method === 'notifications/initialized') {
			log.info('client-initialized', { actor: auth.userId ?? auth.payer ?? 'anonymous' });
		}
		return null;
	}

	switch (msg.method) {
		case 'initialize':
			return rpcOk(msg.id, {
				protocolVersion: PROTOCOL_VERSION,
				serverInfo: SERVER_INFO,
				capabilities: { tools: { listChanged: false } },
			});

		case 'tools/list':
			return rpcOk(msg.id, { tools: VIEWER_TOOLS });

		case 'tools/call': {
			const name = msg.params?.name;
			const input = msg.params?.arguments ?? {};
			if (!TOOL_NAMES.has(name)) {
				return rpcErr(msg.id, -32601, `unknown tool: ${name}`);
			}
			const intent = {
				action: name,
				input,
				resource: 'three.ws/viewer',
				hint:
					'Relay this intent to the live three.ws viewer via the LobeHub plugin postMessage bridge or a session WS. The MCP server has no direct viewer handle.',
				issuedAt: new Date().toISOString(),
				actor: auth.userId ?? auth.payer ?? 'anonymous',
			};
			recordEvent({
				userId: auth.userId,
				apiKeyId: auth.apiKeyId,
				clientId: auth.clientId,
				kind: 'chat-mcp',
				tool: name,
				meta: { input },
			});
			log.info('viewer-intent', { tool: name, actor: intent.actor });
			return rpcOk(msg.id, {
				content: [{ type: 'text', text: JSON.stringify(intent) }],
				structuredContent: intent,
			});
		}

		case 'ping':
			return rpcOk(msg.id, {});

		default:
			return rpcErr(msg.id, -32601, `method not found: ${msg.method}`);
	}
}

function rpcOk(id, result) {
	return { jsonrpc: '2.0', id, result };
}
function rpcErr(id, code, message) {
	return { jsonrpc: '2.0', id, error: { code, message } };
}
function send401(res, message) {
	res.statusCode = 401;
	res.setHeader(
		'www-authenticate',
		`Bearer realm="three.ws", resource_metadata="${env.ISSUER}/.well-known/oauth-protected-resource"`,
	);
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify({ error: 'unauthorized', error_description: message }));
}
