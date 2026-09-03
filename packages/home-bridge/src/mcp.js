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
 *
 * Two transports, tried in that order, because Home Assistant moved this
 * endpoint: `/api/mcp` (Streamable HTTP) on current releases, `/mcp_server/sse`
 * (SSE) on the older ones still in wide use. Which one a house speaks is
 * discovered by asking it, never by reading its version number.
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
 * @param {Function} [options.fetchImpl] a pinned fetch, for a server dialling a
 *   user-supplied URL. See api/_lib/home-url-guard.js.
 * @returns {Promise<{ client: object, tools: Array, callTool: Function, close: () => Promise<void> }>}
 */
export async function connectHomeMcp({ baseUrl, token, api, clientName = 'three.ws', entities, isAllowed, fetchImpl } = {}) {
	const { http } = normalizeBaseUrl(baseUrl);
	if (!token) throw new HomeBridgeError(ERR.AUTH, 'A Home Assistant long-lived access token is required.');

	let Client;
	let StreamableHTTPClientTransport;
	let SSEClientTransport;
	try {
		({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
		({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
		({ SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js'));
	} catch (cause) {
		throw new HomeBridgeError(ERR.NO_MCP, 'The MCP channel needs @modelcontextprotocol/sdk installed alongside this package.', cause);
	}

	const client = new Client({ name: clientName, version: '0.1.0' }, { capabilities: {} });
	const attempts = [
		{ transport: 'streamable-http', url: new URL(`${http}/api/mcp${api ? `/${api}` : ''}`) },
		{ transport: 'sse', url: new URL(`${http}/mcp_server/sse`) },
	];

	let connected = null;
	let lastCause = null;
	for (const attempt of attempts) {
		const transport =
			attempt.transport === 'streamable-http'
				? new StreamableHTTPClientTransport(attempt.url, {
					requestInit: { headers: authHeaders(token) },
					// A server dialling a user-supplied URL passes a fetch pinned to
					// the addresses its SSRF guard validated; the browser has nothing
					// to pin.
					...(fetchImpl ? { fetch: fetchImpl } : {}),
				})
				: new SSEClientTransport(attempt.url, {
					requestInit: { headers: authHeaders(token) },
					// The SSE transport opens its stream with a plain GET that carries
					// no requestInit, so the token has to be attached to that fetch
					// too or Home Assistant answers 401 on the stream alone.
					eventSourceInit: {
						fetch: (input, init) =>
							(fetchImpl || fetch)(input, { ...init, headers: { ...(init?.headers || {}), ...authHeaders(token) } }),
					},
				});

		try {
			await client.connect(transport);
			connected = attempt;
			break;
		} catch (cause) {
			lastCause = cause;
			const status = cause?.code ?? cause?.status;
			if (status === 401 || status === 403) {
				throw new HomeBridgeError(ERR.AUTH, 'Home Assistant rejected that token on the MCP endpoint.', cause);
			}
			// Only a 404 means "not here, try the other transport". Anything else is
			// a real outage and must not be retried into a misleading NO_MCP.
			if (!isNotFound(cause)) {
				throw new HomeBridgeError(ERR.UNREACHABLE, `Could not open the MCP channel at ${attempt.url.href}.`, cause);
			}
		}
	}

	if (!connected) {
		// Both transports 404: the integration really is not set up. That is the
		// ordinary case, not a fault, so say which one it is and offer the step.
		throw new HomeBridgeError(
			ERR.NO_MCP,
			'This home does not have the Model Context Protocol Server integration enabled. Add it in Settings, Devices and services, to give your agent your own curated tools.',
			lastCause,
		);
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
		/** Which transport this house answered on: 'streamable-http' or 'sse'. */
		transport: connected.transport,
		endpoint: connected.url.href,
		callTool,
		close: () => client.close(),
	};
}

function authHeaders(token) {
	return { authorization: `Bearer ${token}` };
}

/**
 * A 404 from either transport, however the SDK chose to report it.
 *
 * Home Assistant moved the MCP endpoint between releases: through 2025.10 the
 * integration served only the SSE transport at `/mcp_server/sse`, and the
 * Streamable HTTP endpoint at `/api/mcp` arrived later. Asking for `/api/mcp`
 * on an older house therefore 404s even though its MCP server is running and
 * exposing real tools, which is how a working house came to be reported as
 * having no MCP at all. We try both and let the house answer, rather than
 * parsing its version string and deciding for it.
 */
function isNotFound(cause) {
	const status = cause?.code ?? cause?.status;
	if (status === 404) return true;
	return /\b404\b|not found/i.test(String(cause?.message || ''));
}
