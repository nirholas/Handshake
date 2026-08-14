// Agent Identity Studio, MCP tool catalog, dispatcher, and pricing for the
// /api/okx/3d/identity-studio A2MCP endpoint. Prices and descriptions come from
// api/_lib/okx-catalog.js (single source of truth shared with the free catalog
// service and the OKX listing); the 402 challenge metadata lives next door in
// ./discovery.js.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { makeDispatcher, PROTOCOL_VERSION } from '../_lib/mcp-dispatch.js';
import { buildGettingStartedTool, GETTING_STARTED_TOOL } from '../_lib/mcp-getting-started.js';
import { catalogEntry } from '../_lib/okx-catalog.js';
import {
	createIdentityJob,
	advanceIdentityJob,
	describeIdentityJob,
	decodeIdentityJobToken,
	MAX_BRIEF_CHARS,
} from './identity.js';

export { PROTOCOL_VERSION };

const ENTRY = catalogEntry('identity-studio');
const STATUS_TOOL = 'identity_status';

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

const createIdentityDef = {
	name: ENTRY.tool, // create_identity
	title: 'Create Agent Identity (paid)',
	description:
		`$${ENTRY.priceUsd} per identity, ${ENTRY.describes.capability} ` +
		`Async: returns a job_id immediately; poll ${STATUS_TOOL} (free) every few seconds until ` +
		'status is "done" (typically 3-6 minutes). You are charged only when the job is accepted: ' +
		'invalid input or an unreachable reference image fails before settlement, and failed ' +
		'pipeline stages retry free.',
	annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
	inputSchema: ENTRY.inputSchema,
	async handler(args) {
		try {
			const { jobId, state } = await createIdentityJob({
				agentName: args.agent_name,
				brief: args.brief,
				styleHints: args.style_hints,
				referenceImageUrl: args.reference_image_url,
			});
			const status = describeIdentityJob(state);
			return toolOk(
				`Identity job accepted. Poll ${STATUS_TOOL} with this job_id until status is "done" ` +
					`(ETA ~3-6 min). job_id: ${jobId}`,
				{
					ok: true,
					job_id: jobId,
					status: status.status,
					stage: status.stage,
					eta_seconds: 300,
					poll_tool: STATUS_TOOL,
					brief_truncated: state.input.briefTruncated,
					...(state.input.briefTruncated
						? { note: `brief exceeded ${MAX_BRIEF_CHARS} characters and was truncated` }
						: {}),
				},
			);
		} catch (err) {
			return toolError(err?.code || 'identity_failed', String(err?.message || err));
		}
	},
};

const identityStatusDef = {
	name: STATUS_TOOL,
	title: 'Identity Job Status (free)',
	description:
		'FREE, poll an Agent Identity Studio job. Each call advances the pipeline one step ' +
		'(generation → rig → renders) and reports progress; when status is "done" it returns the ' +
		'deliverables: PFP PNG (1024 + 128 preview), full-body render set, rigged GLB, and a ' +
		'three.ws viewer link. No payment or account required.',
	annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
	inputSchema: {
		type: 'object',
		required: ['job_id'],
		additionalProperties: false,
		properties: {
			job_id: { type: 'string', description: 'The job_id returned by create_identity.' },
		},
	},
	async handler(args) {
		const id = decodeIdentityJobToken(args.job_id);
		if (!id) {
			return toolError('invalid_job_id', 'job_id is not a valid identity job token.');
		}
		const state = await advanceIdentityJob(id);
		if (!state) return toolError('job_not_found', 'No job with that id. Jobs persist ~30 days.');
		const body = describeIdentityJob(state);
		const line =
			body.status === 'done'
				? `Identity ready: PFP ${body.deliverables.pfp?.url} · rigged GLB ${body.deliverables.rigged_glb_url}`
				: body.status === 'failed'
					? `Job failed at ${body.last_error?.stage}: ${body.last_error?.message}`
					: `Job ${body.stage} (${body.progress.renders_done}/${body.progress.renders_total} renders). Poll again in ~5s.`;
		return { ...(body.status === 'failed' ? { isError: true } : {}), content: [{ type: 'text', text: line }], structuredContent: body };
	},
};

const gettingStarted = buildGettingStartedTool({
	server: 'three.ws Agent Identity Studio',
	tagline:
		'3D identities for AI agents: brand brief → rigged GLB avatar + posed studio renders sized ' +
		'for the OKX.AI avatar slot.',
	tools: [createIdentityDef, identityStatusDef],
	priceFor: (name) => (name === ENTRY.tool ? { amount_usdc: Number(ENTRY.priceUsd) } : null),
	access: [
		`Pay per identity with x402 (USDC): $${ENTRY.priceUsd} per create_identity call.`,
		`${STATUS_TOOL} and this tool are free, no payment, account, or key.`,
		'Full service index (free): https://three.ws/api/okx/3d/catalog',
	],
	links: {
		docs: 'https://three.ws/docs/okx-marketplace',
		showcase: 'https://three.ws/agent-identities',
		catalog: 'https://three.ws/api/okx/3d/catalog',
	},
});

const toolDefs = [gettingStarted, createIdentityDef, identityStatusDef];

const ajv = new Ajv({ allErrors: false, strict: false });
addFormats(ajv);
export const TOOL_CATALOG = toolDefs.map(({ handler, scope, ...pub }) => pub);
export const TOOLS = Object.fromEntries(
	toolDefs.map((d) => [
		d.name,
		{ scope: d.scope, handler: d.handler, validate: d.inputSchema ? ajv.compile(d.inputSchema) : null },
	]),
);

// Free tools servable to the anonymous principal with no OAuth/x402: discovery
// plus status polling, the "status/preview free" half of the service promise.
// The paid tool is deliberately NOT here.
export function isPublicIdentityTool(name) {
	return name === GETTING_STARTED_TOOL || name === STATUS_TOOL;
}

// x402 price (atomic USDC string) for one tools/call, or null when free.
export function identityX402Amount(toolName) {
	return toolName === ENTRY.tool ? ENTRY.amountAtomics : null;
}

export const dispatch = makeDispatcher({
	serverInfo: { name: 'three-ws-agent-identity-studio', version: '1.0.0' },
	instructions:
		'Agent Identity Studio: call create_identity (paid) with an agent name + brand brief, then ' +
		`poll ${STATUS_TOOL} (free) until the rigged avatar and renders are ready. Call ` +
		'getting_started (free) for the full overview.',
	catalog: TOOL_CATALOG,
	tools: TOOLS,
	logName: 'mcp-okx-identity',
});
