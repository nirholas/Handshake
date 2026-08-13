import { pumpfunMcp, pumpfunBotEnabled } from '../../_lib/pumpfun-mcp.js';

function clamp(n, lo, hi, fallback) {
	const x = Number(n);
	if (!Number.isFinite(x)) return fallback;
	return Math.max(lo, Math.min(hi, x));
}

// MCP tool annotations (2025-06-18 spec): every pump.fun intel tool is a
// read-only view of a live upstream feed, never idempotent (the market moves),
// never destructive. destructiveHint defaults to TRUE when omitted, so it is
// set explicitly.
const LIVE_FEED_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

function pumpfunToolResult(r) {
	if (!pumpfunBotEnabled()) {
		return {
			content: [{ type: 'text', text: 'pump.fun feed is not configured on this server.' }],
			isError: true,
		};
	}
	if (!r.ok) {
		return {
			content: [{ type: 'text', text: `pump.fun upstream error: ${r.error}` }],
			isError: true,
		};
	}
	const payload = Array.isArray(r.data) ? { items: r.data } : r.data;
	return {
		content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
		structuredContent: payload,
	};
}

export const toolDefs = [
	{
		name: 'pumpfun_recent_claims',
		title: 'Recent pump.fun claims',
		annotations: LIVE_FEED_ANNOTATIONS,
		description:
			"Fetch the most recent pump.fun GitHub social-fee claim events with full enrichment: GitHub profile, X/Twitter follower data, influencer tier, first-time-claim flag, fake-claim detection, and AI summary. Use to answer 'what's happening on pump.fun right now?'.",
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
			},
			additionalProperties: false,
		},
		async handler(args) {
			return pumpfunToolResult(
				await pumpfunMcp.recentClaims({ limit: clamp(args?.limit, 1, 50, 10) }),
			);
		},
	},
	{
		name: 'pumpfun_token_intel',
		title: 'Pump.fun token intel',
		annotations: LIVE_FEED_ANNOTATIONS,
		description:
			'Full intel on a pump.fun token: graduation status, bonding-curve progress, creator profile, top holders, volume, bundle detection, and trust signals.',
		inputSchema: {
			type: 'object',
			properties: {
				mint: { type: 'string', description: 'SPL mint pubkey (base58).' },
			},
			required: ['mint'],
			additionalProperties: false,
		},
		async handler(args) {
			if (!args?.mint) throw Object.assign(new Error('mint required'), { status: 400 });
			return pumpfunToolResult(await pumpfunMcp.tokenIntel({ mint: args.mint }));
		},
	},
	{
		name: 'pumpfun_creator_intel',
		title: 'Pump.fun creator intel',
		annotations: LIVE_FEED_ANNOTATIONS,
		description:
			'Reputation profile for a pump.fun creator wallet: prior launches, graduation rate, claim activity, and behavioural trust signals.',
		inputSchema: {
			type: 'object',
			properties: {
				wallet: { type: 'string', description: 'Solana wallet pubkey (base58).' },
			},
			required: ['wallet'],
			additionalProperties: false,
		},
		async handler(args) {
			if (!args?.wallet) throw Object.assign(new Error('wallet required'), { status: 400 });
			return pumpfunToolResult(await pumpfunMcp.creatorIntel({ wallet: args.wallet }));
		},
	},
	{
		name: 'pumpfun_recent_graduations',
		title: 'Recent pump.fun graduations',
		annotations: LIVE_FEED_ANNOTATIONS,
		description:
			'Tokens that recently graduated from the bonding curve to PumpAMM, with creator + holder analysis.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
			},
			additionalProperties: false,
		},
		async handler(args) {
			return pumpfunToolResult(
				await pumpfunMcp.graduations({ limit: clamp(args?.limit, 1, 50, 10) }),
			);
		},
	},
];
