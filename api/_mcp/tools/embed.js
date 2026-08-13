// MCP tool: get_embed_code. Hands an agent a copy-paste embed snippet for a
// three.ws 3D avatar, on-chain agent, or Forge creation. "As easy as embedding a
// YouTube video": one call returns the <iframe> HTML, the shareable URL, the
// oEmbed discovery URL, and a social-card thumbnail.
//
// The iframe markup + canonical URL shapes come from the shared builder in
// api/_lib/embed.js (the same one the /api/oembed provider uses), so embed
// output never drifts between the oEmbed surface and this tool.

import { sql } from '../../_lib/db.js';
import { isUuid } from '../../_lib/validate.js';
import { resolveOrigin } from '../origin.js';
import { resolveOnChainAgent, SERVER_CHAIN_META } from '../../_lib/onchain.js';
import { readEmbedPolicy } from '../../_lib/embed-policy.js';
import {
	buildEmbedIframe,
	clampEmbedDim,
	agentEmbedTarget,
	onchainEmbedTarget,
	forgeEmbedTarget,
	oembedUrl,
} from '../../_lib/embed.js';
import { isEmbedAssetRef, resolveEmbedAsset } from '../../_lib/embed-asset.js';
import { DEFAULT_GATE_MINT, createEmbedGate, checkAssetOwnership } from '../../_lib/embed-gate.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

// A designed, actionable error a chat client renders as text (not a thrown
// JSON-RPC fault), used for "make it public first" style guidance.
function designedError(text, structured) {
	return {
		content: [{ type: 'text', text }],
		isError: true,
		structuredContent: { ok: false, ...structured },
	};
}

// Resolve the embed target (one of agent / on-chain agent / forge creation),
// enforcing visibility/ownership. Returns { target, title, oembed } on success,
// or a `{ error }` envelope (a designed isError result) the handler returns as-is.
async function resolveTarget({ kind, args, auth, origin }) {
	if (kind === 'agent') {
		if (!isUuid(args.agent_id)) throw rpcError(-32602, 'agent_id must be a uuid');
		const [agent] = await sql`
			SELECT id, user_id, name, is_public
			FROM agent_identities
			WHERE id = ${args.agent_id} AND deleted_at IS NULL
			LIMIT 1
		`;
		if (!agent) throw new Error('agent not found');
		// Mirror get_avatar's visibility check: a private item is embeddable only
		// by its owner. Everyone else must publish (public/unlisted) it first.
		if (agent.is_public === false && agent.user_id !== auth.userId) {
			return {
				error: designedError(
					'This agent is private, so its embed can\'t be shared publicly yet. ' +
						'Make it public (or unlisted) in your three.ws dashboard, then call get_embed_code again.',
					{ reason: 'private', share_url: agentEmbedTarget(origin, agent.id).shareUrl },
				),
			};
		}
		// Honor an explicit iframe-surface opt-out in the agent's embed policy.
		const policy = await readEmbedPolicy(agent.id);
		if (policy && policy.surfaces?.iframe === false) {
			return {
				error: designedError(
					'This agent has disabled iframe embedding in its embed policy. ' +
						'Re-enable the iframe surface in the dashboard to share an embed snippet.',
					{ reason: 'iframe_disabled' },
				),
			};
		}
		const target = agentEmbedTarget(origin, agent.id);
		return { target, title: agent.name || 'three.ws avatar', oembed: oembedUrl(origin, target.shareUrl) };
	}

	if (kind === 'onchain') {
		const chainId = Number(args.chain_id);
		if (!Number.isInteger(chainId) || !SERVER_CHAIN_META[chainId]) {
			throw rpcError(-32602, `unsupported chain_id: ${args.chain_id}`);
		}
		const agentId = String(args.onchain_agent_id);
		if (!/^\d+$/.test(agentId)) {
			throw rpcError(-32602, 'onchain_agent_id must be a numeric token id');
		}
		const resolved = await resolveOnChainAgent({ chainId, agentId });
		if (resolved.error && resolved.error.startsWith('chain_read')) {
			throw new Error(`on-chain agent #${agentId} not found on chain ${chainId}`);
		}
		const target = onchainEmbedTarget(origin, chainId, agentId);
		return {
			target,
			title: resolved.name || `Agent #${agentId}`,
			oembed: oembedUrl(origin, target.shareUrl),
		};
	}

	// Forge creation: Forge share pages are public by id (no per-user
	// visibility), so the only gate is that the mesh actually finished rendering.
	if (!isUuid(args.creation_id)) throw rpcError(-32602, 'creation_id must be a uuid');
	const [creation] = await sql`
		SELECT id, status, glb_url, prompt FROM forge_creations
		WHERE id = ${args.creation_id} LIMIT 1
	`;
	if (!creation) throw new Error('forge creation not found');
	if (creation.status !== 'done' || !creation.glb_url) {
		return {
			error: designedError(
				'This Forge creation hasn\'t finished generating yet, so there\'s nothing to embed. ' +
					'Wait for it to complete, then call get_embed_code again.',
				{ reason: 'not_ready', status: creation.status },
			),
		};
	}
	const title = creation.prompt ? String(creation.prompt).slice(0, 80) : 'three.ws Forge creation';
	const target = forgeEmbedTarget(origin, creation.id, creation.glb_url, title);
	// /api/oembed resolves /forge/share/:id (extractForgeId in api/agent-oembed.js),
	// so Forge creations get a real oEmbed URL like every other embeddable target.
	return { target, title, oembed: oembedUrl(origin, target.shareUrl) };
}

export const toolDefs = [
	{
		name: 'get_embed_code',
		title: 'Get embed code',
		// Pure read: builds the iframe snippet from existing records, mutates
		// nothing, and the same target yields the same snippet.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		description:
			'Return a ready-to-paste <iframe> embed snippet (plus shareable URL, oEmbed URL, and OG thumbnail) for a three.ws avatar, on-chain agent, or Forge creation. Embed a persistent 3D avatar into Notion, Webflow, Framer, a blog, or any site as easily as a YouTube video. Provide exactly one target: agent_id, OR chain_id + onchain_agent_id, OR creation_id.',
		inputSchema: {
			type: 'object',
			properties: {
				agent_id: { type: 'string', format: 'uuid', description: 'Embed a regular three.ws agent.' },
				chain_id: { type: 'integer', description: 'EVM chain id of an on-chain (ERC-8004) agent.' },
				onchain_agent_id: {
					type: 'string',
					description: 'Token id of the on-chain agent (pair with chain_id).',
				},
				creation_id: { type: 'string', format: 'uuid', description: 'Embed a Forge 3D creation.' },
				// Bounds are clamped in the handler, not enforced by the schema, so an
				// out-of-range number yields a usable snippet instead of a hard error.
				width: { type: 'integer', default: 480, description: 'Iframe width in px (clamped 240-1920).' },
				height: { type: 'integer', default: 360, description: 'Iframe height in px (clamped 180-1080).' },
				autorotate: { type: 'boolean', default: true, description: 'Slowly auto-rotate the avatar.' },
				ar: { type: 'boolean', default: true, description: 'Offer an AR / view-in-room button on mobile.' },
			},
			additionalProperties: false,
		},
		scope: 'avatars:read',
		async handler(args, auth, req) {
			const origin = resolveOrigin(req);

			// Exactly one target must be supplied.
			const hasAgent = Boolean(args.agent_id);
			const hasOnchain = args.chain_id != null && args.onchain_agent_id != null;
			const hasCreation = Boolean(args.creation_id);
			const supplied = [hasAgent, hasOnchain, hasCreation].filter(Boolean).length;
			if (supplied !== 1) {
				throw rpcError(
					-32602,
					'provide exactly one target: agent_id, OR chain_id + onchain_agent_id, OR creation_id',
				);
			}

			const width = clampEmbedDim(args.width, 480, 240, 1920);
			const height = clampEmbedDim(args.height, 360, 180, 1080);
			const autorotate = args.autorotate !== false;
			const ar = args.ar !== false;

			const kind = hasAgent ? 'agent' : hasOnchain ? 'onchain' : 'forge';
			const resolved = await resolveTarget({ kind, args, auth, origin });
			if (resolved.error) return resolved.error;
			const { target, title, oembed } = resolved;

			const embedHtml = buildEmbedIframe({
				src: target.embedUrl,
				width,
				height,
				title,
				autorotate,
				ar,
			});

			const structuredContent = {
				ok: true,
				embed_html: embedHtml,
				share_url: target.shareUrl,
				oembed_url: oembed,
				thumbnail_url: target.thumbnailUrl,
				width,
				height,
			};

			return {
				content: [
					{
						type: 'text',
						text: `Embed snippet for "${title}". Paste it anywhere HTML is allowed:\n\n${embedHtml}\n\nShare URL: ${target.shareUrl}`,
					},
					// A self-contained text/html artifact so MCP clients that render HTML
					// show a live preview of the embed (mirrors render_avatar / preview_3d).
					{
						type: 'resource',
						resource: {
							uri: target.shareUrl,
							mimeType: 'text/html',
							text: `<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent">${embedHtml}</body>`,
						},
					},
				],
				structuredContent,
			};
		},
	},
	{
		name: 'create_gated_embed',
		title: 'Create a token-gated embed',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		description:
			'Turn an avatar or on-chain agent you own into a holder-only interactive 3D embed. Visitors must prove, with a real, server-verified Solana SPL token balance and never a client-reported number, that they hold at least min_amount of mint before the live scene renders; below that they see a designed locked teaser with a connect-wallet CTA. mint defaults to $THREE but accepts any SPL mint at runtime. Returns a ready-to-paste <three-d> embed snippet.',
		inputSchema: {
			type: 'object',
			properties: {
				asset_id: {
					type: 'string',
					description: 'The embed asset to gate: "avatar:<uuid>" or "<chainId>:<agentId>" (on-chain agent you own).',
				},
				mint: {
					type: 'string',
					description: `SPL token mint holders must have a balance of. Defaults to $THREE (${DEFAULT_GATE_MINT}). Pass a different mint to gate with another community's token.`,
				},
				min_amount: {
					type: 'number',
					exclusiveMinimum: 0,
					description: 'Minimum token balance a visitor must hold to unlock the embed.',
				},
			},
			required: ['asset_id', 'min_amount'],
			additionalProperties: false,
		},
		scope: 'avatars:write',
		async handler(args, auth, req) {
			if (!isEmbedAssetRef(args.asset_id)) {
				throw rpcError(-32602, 'asset_id must be "<chainId>:<agentId>" or "avatar:<uuid>"');
			}
			const asset = await resolveEmbedAsset(args.asset_id);
			if (!asset) throw new Error(`embed asset "${args.asset_id}" not found`);

			const ownership = await checkAssetOwnership(args.asset_id, auth.userId);
			if (!ownership.ok) {
				if (ownership.reason === 'not_owner') {
					throw new Error(
						'you do not own this asset: link the owning wallet (or account) to gate it',
					);
				}
				throw new Error(`embed asset "${args.asset_id}" not found`);
			}

			let gate;
			try {
				gate = await createEmbedGate({
					assetId: args.asset_id,
					ownerUserId: auth.userId,
					mint: args.mint || DEFAULT_GATE_MINT,
					minAmount: args.min_amount,
					chain: 'solana',
				});
			} catch (err) {
				throw rpcError(-32602, err.message);
			}

			const origin = resolveOrigin(req);
			const scriptSrc = `${origin}/embed/v1.js`;
			const snippet =
				`<script src="${scriptSrc}" async></script>\n` +
				`<three-d agent="${args.asset_id}" interactive></three-d>`;
			const symbol = gate.mint === DEFAULT_GATE_MINT ? '$THREE' : gate.mint;

			const structuredContent = {
				ok: true,
				gate_id: gate.gateId,
				asset_id: gate.assetId,
				gate: { mint: gate.mint, min_amount: gate.minAmount, chain: gate.chain },
				embed_snippet: snippet,
			};

			return {
				content: [
					{
						type: 'text',
						text:
							`Gated "${asset.name || args.asset_id}": visitors need ≥ ${gate.minAmount} ${symbol} to unlock it. ` +
							`Paste this anywhere HTML is allowed:\n\n${snippet}`,
					},
				],
				structuredContent,
			};
		},
	},
];
