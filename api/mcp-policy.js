/**
 * MCP trust policy — GET /api/mcp-policy
 * ---------------------------------------
 * GET /api/mcp-policy?profile=strict|balanced|open&format=json|claude|vscode
 *
 * An MCP client decides whether to run a tool without asking you by reading that
 * tool's `readOnlyHint`. Across the ecosystem that hint is an unverified claim by
 * the tool's own author. three.ws checks every one of its own against what the
 * handler actually does (`npm run audit:mcp-safety`, docs/mcp-safety.md), so the
 * labels here are the rare case where a client can safely automate on them.
 *
 * This endpoint turns that verification into configuration: pick how much you
 * want automated, get back a ready-to-paste allowlist naming exactly the tools
 * that qualify. Regenerated from public/mcp-catalog.json, which is itself
 * generated from the tool sources, so a policy fetched today reflects the tools
 * that exist today rather than a list someone curated once.
 *
 * Free, keyless, CORS-open: a policy is only useful if the client can fetch it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cors, wrap } from './_lib/http.js';

// The catalog is baked into the deployed image next to this handler, so it is
// read once at boot rather than per request.
const catalog = JSON.parse(
	readFileSync(join(process.cwd(), 'public/mcp-catalog.json'), 'utf8'),
);

/**
 * How much a caller wants automated, as a ladder. Each profile answers one
 * question per safety class: run it, ask first, or refuse outright.
 */
const PROFILES = {
	strict: {
		label: 'Strict',
		summary:
			'Automate only what is both verified read-only and free. Every write asks first, and nothing irreversible may run through this client at all.',
		decide: (tool) => {
			if (tool.safety === 'irreversible') return 'deny';
			if (tool.safety === 'read' && tool.price.free) return 'allow';
			return 'confirm';
		},
	},
	balanced: {
		label: 'Balanced',
		summary:
			'Automate every verified read, including the paid ones. Anything that changes state asks first. This is the default.',
		decide: (tool) => (tool.safety === 'read' ? 'allow' : 'confirm'),
	},
	open: {
		label: 'Open',
		summary:
			'Automate reads and reversible writes. Only actions that cannot be undone stop for approval.',
		decide: (tool) => (tool.safety === 'irreversible' ? 'confirm' : 'allow'),
	},
};

const DEFAULT_PROFILE = 'balanced';
const FORMATS = new Set(['json', 'claude', 'vscode']);

/**
 * MCP clients namespace a tool as `mcp__<server>__<tool>` in their permission
 * lists. The server segment is whatever name the user gave the server in their
 * own config, so the policy states the id three.ws publishes and says so.
 */
const permissionId = (tool) => `mcp__${tool.server.id}__${tool.name}`;

function buildPolicy(profileId) {
	const profile = PROFILES[profileId];
	const buckets = { allow: [], confirm: [], deny: [] };

	for (const tool of catalog.tools) {
		buckets[profile.decide(tool)].push({
			name: tool.name,
			permission: permissionId(tool),
			server: tool.server.id,
			safety: tool.safety,
			priceUsd: tool.price.usd,
		});
	}

	return {
		$schema: 'https://three.ws/schemas/mcp-trust-policy.json',
		version: 1,
		profile: profileId,
		profileLabel: profile.label,
		summary: profile.summary,
		issuer: 'https://three.ws',
		source: 'https://three.ws/mcp-catalog.json',
		docs: 'https://three.ws/docs/mcp-safety',
		verification: {
			method: 'static analysis of each tool handler',
			check: 'npm run audit:mcp-safety',
			claim:
				'Every readOnlyHint in this policy was verified against the tool handler that implements it: a tool that writes to the database, signs, sends, or settles cannot be labelled read-only in this repo without failing the build.',
		},
		counts: {
			allow: buckets.allow.length,
			confirm: buckets.confirm.length,
			deny: buckets.deny.length,
			total: catalog.tools.length,
		},
		rules: buckets,
	};
}

/** Claude Code / Claude Desktop settings.json permission block. */
function toClaudeSettings(policy) {
	return {
		$comment: `three.ws MCP trust policy (${policy.profile}). ${policy.summary} Source: ${policy.docs}`,
		permissions: {
			allow: policy.rules.allow.map((t) => t.permission),
			ask: policy.rules.confirm.map((t) => t.permission),
			deny: policy.rules.deny.map((t) => t.permission),
		},
	};
}

/** VS Code / Copilot style: a flat map of tool id to boolean auto-approval. */
function toVsCodeSettings(policy) {
	const tools = {};
	for (const tool of policy.rules.allow) tools[tool.permission] = true;
	for (const tool of [...policy.rules.confirm, ...policy.rules.deny]) {
		tools[tool.permission] = false;
	}
	return {
		$comment: `three.ws MCP trust policy (${policy.profile}). true = may run unattended. Source: ${policy.docs}`,
		'chat.tools.autoApprove': tools,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,HEAD,OPTIONS', origins: '*' })) return;

	const url = new URL(req.url, 'http://x');
	const profileParam = (url.searchParams.get('profile') || DEFAULT_PROFILE).toLowerCase();
	const formatParam = (url.searchParams.get('format') || 'json').toLowerCase();

	if (!PROFILES[profileParam]) {
		res.statusCode = 400;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(
			JSON.stringify({
				error: `unknown profile "${profileParam}"`,
				profiles: Object.entries(PROFILES).map(([id, p]) => ({
					id,
					label: p.label,
					summary: p.summary,
				})),
			}),
		);
		return;
	}

	if (!FORMATS.has(formatParam)) {
		res.statusCode = 400;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.end(
			JSON.stringify({ error: `unknown format "${formatParam}"`, formats: [...FORMATS] }),
		);
		return;
	}

	const policy = buildPolicy(profileParam);
	const body =
		formatParam === 'claude'
			? toClaudeSettings(policy)
			: formatParam === 'vscode'
				? toVsCodeSettings(policy)
				: policy;

	res.statusCode = 200;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	// The policy only changes when the deployed catalog changes, so it caches
	// hard at the edge while staying revalidatable.
	res.setHeader('cache-control', 'public, max-age=300, s-maxage=3600');
	res.setHeader(
		'content-disposition',
		`inline; filename="three-ws-mcp-policy-${profileParam}.json"`,
	);
	res.end(`${JSON.stringify(body, null, 2)}\n`);
});
