/**
 * The optional capability channel.
 *
 * Home Assistant's first-party `mcp_server` integration exposes the exact set of
 * tools the user chose to give their own LLM, at `/api/mcp`, over streamable
 * HTTP. When a home has it enabled, an agent gets the user's curated tool
 * surface (with the user's own exposure rules) for free, and we do not have to
 * derive tools from the entity list ourselves.
 *
 * It is optional on purpose: `mcp_server` needs setting up, while the WebSocket
 * API in bridge.js works on every instance with nothing but a token. This is an
 * upgrade, never a requirement.
 */

import { ERR, HomeBridgeError } from './errors.js';
import { classifyMcpCall } from './safety.js';
import { normalizeBaseUrl } from './url.js';

/**
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.token long-lived access token
 * @param {string} [options.api] which Home Assistant LLM API to attach to. The
 *   built-in Assist API lives at /api/mcp/assist; the bare /api/mcp uses the
 *   instance default.
 * @param {string} [options.clientName] reported to Home Assistant in the handshake
 * @param {() => Array} [options.entities] live entity list, normally
 *   `() => flattenEntities(bridge.graph)`. Supplying it turns on the physical
 *   action gate for tool calls, which is the only way an agent driving these
 *   tools is safe: see classifyMcpCall for why the tool names do not tell you.
 * @param {(entityId: string) => boolean} [options.isAllowed] standing per-entity approvals
 * @returns {Promise<{ client: object, tools: Array, callTool: Function, close: () => Promise<void> }>}
 */
export async function connectHomeMcp({ baseUrl, token, api, clientName = 'three.ws', entities, isAllowed } = {}) {
	const { http } = normalizeBaseUrl(baseUrl);
	if (!token) throw new HomeBridgeError(ERR.AUTH, 'A Home Assistant long-lived access token is required.');

	let Client;
	let StreamableHTTPClientTransport;
	try {
		({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
		({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
	} catch (cause) {
		throw new HomeBridgeError(ERR.NO_MCP, 'The MCP channel needs @modelcontextprotocol/sdk installed alongside this package.', cause);
	}

	const url = new URL(`${http}/api/mcp${api ? `/${api}` : ''}`);
	const transport = new StreamableHTTPClientTransport(url, {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: clientName, version: '0.1.0' }, { capabilities: {} });

	try {
		await client.connect(transport);
	} catch (cause) {
		// A 404 here is the ordinary case, not a fault: the integration is simply
		// not set up. Say which one it is so the UI can offer the right next step.
		const status = cause?.code ?? cause?.status;
		if (status === 404 || /404/.test(String(cause?.message || ''))) {
			throw new HomeBridgeError(ERR.NO_MCP, 'This home does not have the Model Context Protocol Server integration enabled. Add it in Settings, Devices and services, to give your agent your own curated tools.', cause);
		}
		if (status === 401 || status === 403) {
			throw new HomeBridgeError(ERR.AUTH, 'Home Assistant rejected that token on the MCP endpoint.', cause);
		}
		throw new HomeBridgeError(ERR.UNREACHABLE, `Could not open the MCP channel at ${url.href}.`, cause);
	}

	const { tools } = await client.listTools();

	/**
	 * Call a home tool through the gate.
	 *
	 * @param {{ name: string, arguments?: object }} call
	 * @param {{ confirmed?: boolean }} [options] confirmed:true is the user's
	 *   explicit yes. Never set it from model output.
	 */
	const callTool = async (call, options = {}) => {
		if (typeof entities === 'function' && !options.confirmed) {
			const verdict = classifyMcpCall(call.name, call.arguments || {}, entities());
			const cleared = verdict.guarded && verdict.targets.every((id) => isAllowed?.(id));
			if (verdict.guarded && !cleared) {
				const err = new HomeBridgeError(ERR.NEEDS_CONFIRMATION, verdict.reason);
				err.pending = { tool: call.name, arguments: call.arguments, risk: verdict.risk, targets: verdict.targets };
				throw err;
			}
		}
		return client.callTool(call);
	};

	return {
		client,
		tools,
		callTool,
		close: () => client.close(),
	};
}
