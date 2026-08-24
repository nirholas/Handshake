// three.ws Forge on OKX.AI: the A2MCP surface a buying agent calls to turn a
// prompt (or reference images) into a real, downloadable 3D model.
//
// This is the rebuilt marketplace listing (owner directive 2026-08-22). It
// gives an OKX.AI agent exactly what the "three.ws 3D Studio" custom GPT gives
// a ChatGPT user, over the marketplace's own payment rail instead of a free
// ChatGPT Action: describe a thing, get a GLB, a concept image, a browser
// viewer link, and a device-aware AR link that puts it in a real room.
//
// Why A2MCP and not plain REST: OKX lists a service as `serviceType: A2MCP`,
// and the 2026-07-04 rejection was "your A2MCP service has not been integrated
// with the OKX Agent Payments Protocol standard". A reviewer probing a listed
// endpoint speaks MCP Streamable HTTP JSON-RPC and expects an unpaid paid-tool
// call to answer a 402 whose accepts[] leads with eip155:196. So every listed
// row is a genuine MCP server, and the paid tool is genuinely x402-gated on the
// X Layer rail. api/okx/3d/[service].js owns the transport; this module owns
// the tools, the prices, and the discovery metadata.
//
// One surface per catalog row, built from the row itself:
//
//   forge-draft / forge-standard / forge-hd   forge_3d (paid) over a text prompt
//   forge-image                               forge_3d (paid) over image links
//   forge-status                              forge_status only, always free
//
// Every endpoint carries the free forge_status and getting_started tools too,
// so an agent polls the job where it paid for it and never has to discover a
// second host mid-flight.
//
// It is a front, not a pipeline: generation runs through the same
// gpt-forge-client → /api/gpt-forge lane the GPT uses, and the response is
// shaped by the same api/_mcp-studio/studio-shape.js. The marketplace and the
// GPT cannot drift into two different contracts over one generator.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { makeDispatcher, PROTOCOL_VERSION } from '../_lib/mcp-dispatch.js';
import { buildGettingStartedTool, GETTING_STARTED_TOOL } from '../_lib/mcp-getting-started.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { catalogEntry, FORGE_TOOL, FORGE_STATUS_TOOL } from '../_lib/okx-catalog.js';
import { startForge, pollOnce, originFromReq } from '../_mcp-studio/gpt-forge-client.js';
import { shapeSubmit, shapePoll } from '../_mcp-studio/studio-shape.js';
import { checkPromptSafety } from '../_mcp-studio/safety.js';

export { PROTOCOL_VERSION, FORGE_TOOL, FORGE_STATUS_TOOL };

const BASE = 'https://three.ws';
const STATUS_ENDPOINT = `${BASE}/api/okx/3d/forge-status`;
const DOCS_URL = `${BASE}/docs/okx-marketplace`;

// Every listed forge row. A row not in this set is not servable here.
export const FORGE_SERVICE_IDS = Object.freeze([
	'forge-draft',
	'forge-standard',
	'forge-hd',
	'forge-image',
	'forge-status',
]);

export function isForgeService(id) {
	return FORGE_SERVICE_IDS.includes(id);
}

function toolError(code, message, extra = {}) {
	return {
		isError: true,
		content: [{ type: 'text', text: `${code}: ${message}` }],
		structuredContent: { ok: false, error: code, message, ...extra },
	};
}

function toolOk(text, structured) {
	return { content: [{ type: 'text', text }], structuredContent: structured };
}

// Lane failures already carry a designed code + caller-facing message from
// gpt-forge-client. Map them to an MCP tool error the buyer can act on rather
// than letting a generic throw become a -32603 with no recovery advice.
function laneError(err) {
	switch (err?.code) {
		case 'not_configured':
			return toolError('unavailable', '3D generation is temporarily unavailable, try again later.');
		case 'busy':
			return toolError('busy', err.message || 'The generator is saturated, try again shortly.', {
				retry_after: err.retryAfter || 10,
			});
		case 'timeout':
			return toolError('timeout', err.message || 'The generator took too long to accept the job, try again.', {
				retry_after: 10,
			});
		case 'unknown_job':
			return toolError('unknown_job', err.message || 'That job id is not recognized.');
		default:
			return toolError('generation_failed', err?.message || 'The generator could not start this job.');
	}
}

// A pending job is polled at the free forge-status endpoint, so `poll` is a
// real URL an agent can hit, and `poll_tool` names the JSON-RPC tool to call
// there. Both, because buyers in this marketplace read either.
const POLL_OPTS = { pollPath: STATUS_ENDPOINT };

function withPollTool(shaped) {
	return shaped.status === 'pending' ? { ...shaped, poll_tool: FORGE_STATUS_TOOL, poll_endpoint: STATUS_ENDPOINT } : shaped;
}

function summarize(shaped) {
	if (shaped.status === 'done') return `Model ready. GLB: ${shaped.glbUrl}`;
	if (shaped.status === 'error') return shaped.error;
	const eta = shaped.etaSeconds ? ` ETA ~${shaped.etaSeconds}s.` : '';
	return `Job accepted.${eta} Call ${FORGE_STATUS_TOOL} with job_id ${shaped.job} until status is "done".`;
}

function buildForgeTool(entry) {
	const isImageLane = entry.lane?.mode === 'image_to_3d';
	const priceLine = `$${entry.priceUsd} per call, charged only when the job is accepted.`;
	return {
		name: FORGE_TOOL,
		title: `Forge a 3D model (paid, $${entry.priceUsd})`,
		description:
			`${priceLine} ${entry.describes.capability} ` +
			`Async: returns a job_id immediately, then poll ${FORGE_STATUS_TOOL} (free) every few ` +
			'seconds until status is "done". Invalid input fails before settlement, so a rejected ' +
			'call costs nothing.',
		annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
		inputSchema: entry.inputSchema,
		async handler(args, _auth, req) {
			const base = originFromReq(req);
			const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';

			// Age-13+ content gate BEFORE any GPU work or settlement. The same
			// gate the GPT Store surface runs; a refused prompt never settles.
			if (prompt) {
				const safety = checkPromptSafety(prompt);
				if (!safety.allowed) return toolError('prompt_rejected', safety.message);
			}
			if (!isImageLane && !prompt) {
				return toolError('invalid_input', 'prompt is required: describe one subject in 3 to 1000 characters.');
			}

			let job;
			try {
				job = await startForge(base, {
					prompt: prompt || undefined,
					imageUrls: isImageLane ? args.image_urls : undefined,
					aspect: isImageLane ? '1:1' : args.aspect_ratio,
					...(entry.lane?.tier ? { tier: entry.lane.tier } : {}),
					...(entry.lane?.path ? { path: entry.lane.path } : {}),
				});
			} catch (err) {
				return laneError(err);
			}

			const shaped = withPollTool(shapeSubmit(job, base, prompt, POLL_OPTS));
			return toolOk(summarize(shaped), { ok: true, service: entry.id, ...shaped });
		},
	};
}

function buildStatusTool() {
	const entry = catalogEntry('forge-status');
	return {
		name: FORGE_STATUS_TOOL,
		title: 'Check a forge job (free)',
		description:
			'FREE. Reports the live state of a three.ws forge job and returns the finished GLB, the ' +
			'concept image, a browser viewer link and an augmented-reality link once it is done. ' +
			'Poll every few seconds. No payment, account, or key required.',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		inputSchema: entry.inputSchema,
		async handler(args, _auth, req) {
			const base = originFromReq(req);
			const jobId = String(args.job_id || '').trim();
			const title = typeof args.title === 'string' ? args.title : '';
			let data;
			try {
				data = await pollOnce(base, jobId);
			} catch (err) {
				return laneError(err);
			}
			const shaped = withPollTool(shapePoll(data, base, jobId, title, POLL_OPTS));
			const body = { ok: shaped.status !== 'error', ...shaped };
			return shaped.status === 'error'
				? { isError: true, content: [{ type: 'text', text: shaped.error }], structuredContent: body }
				: toolOk(summarize(shaped), body);
		},
	};
}

// Endpoint-level v2 bazaar discovery entry, in the shape agentic.market's
// validator expects. Describes a JSON-RPC 2.0 tools/call against THIS server's
// tools and the job handle that comes back. Without it the 402 envelope
// inherits the default that describes a different server's tools, and an agent
// that followed it would pay and then send a call this dispatcher rejects.
function forgeBazaarExtension(entry, paidTool) {
	const exampleArguments = paidTool
		? entry.lane?.mode === 'image_to_3d'
			? { image_urls: [`${BASE}/og/three-ws.png`] }
			: { prompt: 'a low-poly orange fox sitting down' }
		: { job_id: 'f1.abc123' };
	const exampleBody = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: paidTool ? FORGE_TOOL : FORGE_STATUS_TOOL, arguments: exampleArguments },
	};
	const exampleResponse = {
		jsonrpc: '2.0',
		id: 1,
		result: {
			content: [{ type: 'text', text: `Job accepted. Call ${FORGE_STATUS_TOOL} with job_id f1.abc123 until status is "done".` }],
			structuredContent: {
				ok: true,
				status: 'pending',
				job: 'f1.abc123',
				poll_tool: FORGE_STATUS_TOOL,
				poll_endpoint: STATUS_ENDPOINT,
				format: 'glb',
				etaSeconds: 45,
			},
		},
	};
	const toolLine = paidTool
		? `Tool names: ${FORGE_TOOL} (paid, $${entry.priceUsd}), ${FORGE_STATUS_TOOL} (free job polling), ${GETTING_STARTED_TOOL} (free overview).`
		: `Tool names: ${FORGE_STATUS_TOOL} (free job polling), ${GETTING_STARTED_TOOL} (free overview).`;
	const requestBodySchema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		required: ['jsonrpc', 'method'],
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { type: ['string', 'number'] },
			method: {
				type: 'string',
				enum: ['initialize', 'tools/list', 'tools/call', 'ping'],
				description: 'MCP JSON-RPC method.',
			},
			params: {
				type: 'object',
				description: `For tools/call: { name, arguments }. ${toolLine} See tools/list.`,
			},
		},
	};
	const responseBodySchema = {
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: {
			jsonrpc: { type: 'string', const: '2.0' },
			id: { type: ['string', 'number'] },
			result: {
				type: 'object',
				properties: {
					content: {
						type: 'array',
						items: {
							type: 'object',
							required: ['type', 'text'],
							properties: { type: { type: 'string', enum: ['text'] }, text: { type: 'string' } },
						},
					},
				},
			},
			error: { type: 'object', properties: { code: { type: 'number' }, message: { type: 'string' } } },
		},
	};
	return {
		discoverable: true,
		info: {
			input: { type: 'http', method: 'POST', body: exampleBody, bodyType: 'json' },
			output: { type: 'json', example: exampleResponse },
		},
		schema: buildBazaarSchema({
			method: 'POST',
			bodyType: 'json',
			bodySchema: requestBodySchema,
			outputSchema: responseBodySchema,
		}),
	};
}

const ajv = new Ajv({ allErrors: false, strict: false });
addFormats(ajv);

function buildSurface(id) {
	const entry = catalogEntry(id);
	if (!entry) throw new Error(`okx forge: no catalog entry "${id}"`);
	const paid = entry.priceUsd !== '0';
	const paidTool = paid ? buildForgeTool(entry) : null;
	const statusTool = buildStatusTool();

	const gettingStarted = buildGettingStartedTool({
		server: `three.ws Forge, ${entry.name}`,
		tagline:
			'Text or images to a real, downloadable 3D model (GLB), with a browser preview and an ' +
			'augmented-reality link that places it in a real room.',
		tools: [paidTool, statusTool].filter(Boolean),
		priceFor: (name) => (paid && name === FORGE_TOOL ? { amount_usdc: Number(entry.priceUsd) } : null),
		access: paid
			? [
					`Pay per call with x402 on X Layer (chain 196): $${entry.priceUsd} per ${FORGE_TOOL} call.`,
					`${FORGE_STATUS_TOOL} and this tool are free: no payment, account, or key.`,
					'Full service index (free): https://three.ws/api/okx/3d/catalog',
				]
			: [
					'Free: no payment, account, or key. Poll any three.ws forge job here.',
					'Full service index (free): https://three.ws/api/okx/3d/catalog',
				],
		links: { docs: DOCS_URL, catalog: `${BASE}/api/okx/3d/catalog`, health: `${BASE}/api/okx/3d/health` },
	});

	const toolDefs = [gettingStarted, ...(paidTool ? [paidTool] : []), statusTool];
	const TOOL_CATALOG = toolDefs.map(({ handler, scope, ...pub }) => pub);
	const TOOLS = Object.fromEntries(
		toolDefs.map((d) => [
			d.name,
			{ scope: d.scope, handler: d.handler, validate: d.inputSchema ? ajv.compile(d.inputSchema) : null },
		]),
	);

	const description = paid
		? `three.ws Forge, ${entry.name}: A2MCP service that turns ${entry.lane?.mode === 'image_to_3d' ? 'reference images' : 'a text description'} ` +
			`into a downloadable 3D model (GLB) with a browser viewer and an augmented-reality link. ` +
			`$${entry.priceUsd} per call on X Layer via x402; job polling is free. Operated by three.ws.`
		: 'three.ws Forge job status: free A2MCP service that reports the live state of any three.ws ' +
			'forge job and returns the finished model, viewer and augmented-reality links. Operated by three.ws.';

	const challenge = {
		description,
		bazaar: forgeBazaarExtension(entry, paidTool),
		...withService({
			serviceName: `three.ws Forge, ${entry.name}`,
			tags: ['x402', 'mcp', '3d', 'forge', 'okx'],
		}),
	};

	return {
		entry,
		challenge,
		TOOL_CATALOG,
		TOOLS,
		// Free tools servable to the anonymous principal with no OAuth/x402:
		// discovery plus status polling. The paid tool is deliberately not here.
		isPublicTool: (name) => name === GETTING_STARTED_TOOL || name === FORGE_STATUS_TOOL,
		// x402 price (atomic USDC string) for one tools/call, or null when free.
		x402Amount: (toolName) => (paid && toolName === FORGE_TOOL ? entry.amountAtomics : null),
		dispatch: makeDispatcher({
			serverInfo: { name: `three-ws-forge-${id}`, version: '1.0.0' },
			instructions: paid
				? `Call ${FORGE_TOOL} (paid, $${entry.priceUsd}) with your description, then poll ` +
					`${FORGE_STATUS_TOOL} (free) with the returned job_id until status is "done". Call ` +
					`${GETTING_STARTED_TOOL} (free) for the full overview.`
				: `Call ${FORGE_STATUS_TOOL} (free) with a job_id from any three.ws forge service until ` +
					`status is "done". Call ${GETTING_STARTED_TOOL} (free) for the full overview.`,
			catalog: TOOL_CATALOG,
			tools: TOOLS,
			logName: `mcp-okx-${id}`,
		}),
	};
}

// One surface per listed row, built on first use and reused after: the
// dispatcher and its compiled validators are per-endpoint immutable state.
const surfaces = new Map();

export function forgeSurface(id) {
	if (!isForgeService(id)) return null;
	if (!surfaces.has(id)) surfaces.set(id, buildSurface(id));
	return surfaces.get(id);
}
