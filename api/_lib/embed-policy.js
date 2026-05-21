// Per-agent embed policy: one JSONB column on agent_identities holding
// origins + surfaces + brain + storage config. See prompts/embed-hardening/.

import { z } from 'zod';
import { sql } from './db.js';

const hostPattern =
	/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const POLICY_VERSION = 1;

export const policySchema = z.object({
	version: z.literal(1).optional(),
	origins: z.object({
		mode: z.enum(['allowlist', 'denylist']),
		hosts: z.array(z.string().trim().toLowerCase().min(1).max(253).regex(hostPattern)).max(100),
	}),
	surfaces: z.object({
		script: z.boolean(),
		iframe: z.boolean(),
		widget: z.boolean(),
		mcp: z.boolean(),
	}),
	brain: z
		.object({
			mode: z.enum(['we-pay', 'key-proxy', 'wallet-gated', 'none']),
			proxy_url: z.string().url().nullable(),
			monthly_quota: z.number().int().nonnegative().nullable(),
			rate_limit_per_min: z.number().int().nonnegative().nullable(),
			model: z.string().min(1).max(100),
		})
		.refine((b) => b.mode !== 'key-proxy' || !!b.proxy_url, {
			message: 'proxy_url is required when brain.mode === "key-proxy"',
			path: ['proxy_url'],
		}),
	storage: z.object({
		primary: z.enum(['r2', 'ipfs']),
		pinned_ipfs: z.boolean(),
		onchain_attested: z.boolean(),
	}),
});

export function defaultEmbedPolicy() {
	return {
		version: POLICY_VERSION,
		origins: { mode: 'allowlist', hosts: [] },
		surfaces: { script: true, iframe: true, widget: true, mcp: false },
		brain: {
			// Default to free OpenRouter Llama 3.3 70B: tool-call capable, no
			// per-token cost to the host, daily rate cap shared across the org
			// key. Owners can switch to a paid Claude model from the dashboard.
			mode: 'we-pay',
			proxy_url: null,
			monthly_quota: 1000,
			rate_limit_per_min: 10,
			model: 'meta-llama/llama-3.3-70b-instruct:free',
		},
		storage: { primary: 'r2', pinned_ipfs: false, onchain_attested: false },
	};
}

export function normalizeLegacyPolicy(input) {
	if (!input) return defaultEmbedPolicy();
	const isLegacy =
		!('version' in input) && !('origins' in input) && 'mode' in input && 'hosts' in input;
	if (isLegacy) {
		const d = defaultEmbedPolicy();
		return { ...d, origins: { mode: input.mode, hosts: input.hosts ?? [] } };
	}
	const d = defaultEmbedPolicy();
	return {
		version: POLICY_VERSION,
		origins: { ...d.origins, ...(input.origins || {}) },
		surfaces: { ...d.surfaces, ...(input.surfaces || {}) },
		brain: { ...d.brain, ...(input.brain || {}) },
		storage: { ...d.storage, ...(input.storage || {}) },
	};
}

export async function readEmbedPolicy(agentId) {
	let row;
	try {
		[row] = await sql`
			SELECT embed_policy FROM agent_identities
			WHERE id = ${agentId} AND deleted_at IS NULL
		`;
	} catch (err) {
		if (
			err.message &&
			err.message.includes('column') &&
			err.message.includes('does not exist')
		) {
			return null;
		}
		throw err;
	}
	if (!row) return null;
	return normalizeLegacyPolicy(row.embed_policy);
}

export function validateEmbedPolicy(input) {
	return policySchema.parse(normalizeLegacyPolicy(input));
}
