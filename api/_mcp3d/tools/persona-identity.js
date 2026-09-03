// three.ws 3D Studio MCP — embodied on-chain identity.
//
// Binds a persona (api/_lib/persona-store.js) to a real, deterministic Solana
// wallet (api/_lib/persona-wallet.js): the SAME persona_id always re-derives
// the SAME address, no private key is ever stored, and none is ever returned
// in a tool response or written to a log. Three tools:
//
//   persona_identity(persona_id)         — read wallet address, live SOL/USDC
//     balance, ERC-8004-style reputation, token holdings, and a resolved SNS
//     nameplate, plus the derived visual tiers the embodiment viewer renders.
//   persona_tip(persona_id, to, usdc)    — a small, social value transfer FROM
//     the persona's own wallet, e.g. tipping another agent's wallet.
//   persona_send(persona_id, to, usdc)   — the general-purpose USDC send.
//
// persona_tip and persona_send share one guarded settlement path
// (sendPersonaUsdc): a hard per-call cap, a hard cumulative per-session cap,
// and a confirmation threshold above which the call must carry confirm:true.
// Real settlement rides the same MEV-aware execution engine every other
// outbound transfer on the platform uses — no mocked transfer, ever.
//
// Claude/paid-track only: NOT reused by the free studio (api/_mcp-studio),
// which asserts zero wallet/crypto surface in its own catalog test.

import { limits } from '../../_lib/rate-limit.js';
import { getPersona, isPersonaId, personaPublicView } from '../../_lib/persona-store.js';
import {
	getPersonaIdentity,
	sendPersonaUsdc,
	personaWalletAddress,
} from '../../_lib/persona-wallet.js';
import { PERSONA_SPEND_CAPS } from '../../_lib/persona-spend-ledger.js';
import { embodimentArtifact } from '../../_lib/embodiment-artifact.js';
import { buildIdentityCard, summarizeIdentityCard } from '../../_lib/persona-identity-card.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}
function rateKey(auth) {
	return auth.userId || auth.rateKey || 'anon';
}
async function enforce(limiter, auth) {
	const rl = await limiter(rateKey(auth));
	if (!rl.success) {
		throw rpcError(-32000, 'rate_limited', { retry_after: Math.ceil((rl.reset - Date.now()) / 1000) });
	}
}

function toolError(text, structuredContent = { ok: false }) {
	return { content: [{ type: 'text', text }], structuredContent, isError: true };
}

async function loadPersonaOrError(personaId) {
	if (!isPersonaId(personaId)) {
		return { error: toolError('That is not a valid persona_id.', { status: 'invalid_id' }) };
	}
	const record = await getPersona(personaId);
	if (!record) {
		return { error: toolError('No persona found for that id. Create one with create_agent_persona first.', { status: 'not_found' }) };
	}
	return { record };
}

// Gate an irreversible value transfer on an explicit confirm flag once its
// amount clears PERSONA_SPEND_CAPS.confirmAboveUsdc — same shape as the SOL
// wallet_send confirmation gate (packages/avatar-agent-mcp), reused here inline
// since USDC amount + persona name are needed in the message.
function confirmationGate({ confirm, usdc, personaName, action }) {
	if (Number(usdc) <= PERSONA_SPEND_CAPS.confirmAboveUsdc) return null;
	if (confirm === true) return null;
	return toolError(
		`${action}: sending $${usdc} USDC from ${personaName} is above the $${PERSONA_SPEND_CAPS.confirmAboveUsdc} confirmation threshold. ` +
			'Re-issue the call with confirm:true to proceed.',
		{ status: 'confirmation_required', threshold_usdc: PERSONA_SPEND_CAPS.confirmAboveUsdc },
	);
}

const NETWORK_PROP = { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' };

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const VALUE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

async function handlePersonaIdentity(args, auth) {
	await enforce(limits.mcp3dPersonaIdentity, auth);
	const { record, error } = await loadPersonaOrError(args.persona_id);
	if (error) return error;

	const identity = await getPersonaIdentity(args.persona_id, { network: args.network || 'mainnet' });
	const persona = personaPublicView(record);
	const v = identity.visual;
	const card = buildIdentityCard({ persona, identity });

	const lines = [
		`${persona.name}'s on-chain identity — ${summarizeIdentityCard(card)}`,
		`Wallet: ${identity.address} (${identity.network})`,
		`Balance: ${identity.balances.sol.toFixed(4)} SOL, ${identity.balances.usdc.toFixed(2)} USDC` +
			(identity.balances.total_usd != null ? ` (~$${identity.balances.total_usd})` : ''),
		`Reputation: ${v.reputation_tier} (${identity.reputation.feedback.verified} verified / ${identity.reputation.feedback.total} total feedback)`,
		`Holdings: ${identity.holdings.count} asset(s), ~$${identity.holdings.total_usd} — tier ${v.holdings_tier}`,
		v.verified_name ? `Verified name: ${v.verified_name}` : 'No verified SNS name resolved.',
		v.muted ? 'Balance is at/near zero — the body renders in its muted state.' : null,
	].filter(Boolean);

	return {
		content: [
			{ type: 'text', text: lines.join('\n') },
			embodimentArtifact({ persona, state: 'idle', wallet: true, network: identity.network }),
		],
		structuredContent: { ...identity, identity_card: card, status: 'ok' },
	};
}

async function handlePersonaValueOp(args, auth, { tool, verb }) {
	await enforce(limits.mcp3dPersonaSpend, auth);
	const { record, error } = await loadPersonaOrError(args.persona_id);
	if (error) return error;
	const persona = personaPublicView(record);

	const usdc = Number(args.usdc);
	// Hard per-call cap is checked FIRST — an amount that is already over the cap
	// must reject with over_call_cap, never confirmation_required (which would
	// wrongly imply confirm:true is enough to make it succeed). The cumulative
	// per-session cap still gets its own authoritative check inside
	// sendPersonaUsdc (it needs the durable session-spend total), but the
	// per-call ceiling is a pure, immediate comparison — no reason to make a
	// caller round-trip through the confirmation gate first.
	if (usdc > PERSONA_SPEND_CAPS.maxPerCallUsdc) {
		return toolError(
			`${verb} blocked: $${usdc} exceeds the per-call cap of $${PERSONA_SPEND_CAPS.maxPerCallUsdc} USDC.`,
			{ status: 'blocked', code: 'over_call_cap', cap_usdc: PERSONA_SPEND_CAPS.maxPerCallUsdc },
		);
	}
	const gateResult = confirmationGate({ confirm: args.confirm, usdc, personaName: persona.name, action: verb });
	if (gateResult) return gateResult;

	const result = await sendPersonaUsdc({
		personaId: args.persona_id,
		sessionId: args.session_id || null,
		to: args.to,
		usdc,
		tool,
		network: args.network || 'mainnet',
		memo: args.memo || null,
	});

	if (result.status === 'blocked') {
		return toolError(
			`${verb} blocked: ${result.message}`,
			{ status: 'blocked', code: result.code, ...result },
		);
	}
	if (result.status === 'failed') {
		return toolError(
			`${verb} failed: ${result.message || result.code}`,
			{ status: 'failed', code: result.code, ...result },
		);
	}

	return {
		content: [
			{
				type: 'text',
				text:
					`${persona.name} sent $${result.usdc} USDC to ${result.to}.\n` +
					`Signature: ${result.signature}\nExplorer: ${result.explorer}\n` +
					`Session spend: $${result.session_spent_usdc} / $${result.session_cap_usdc} USDC cap.`,
			},
		],
		structuredContent: { ...result, persona_id: persona.persona_id, persona_name: persona.name },
	};
}

const VALUE_INPUT_PROPS = {
	persona_id: { type: 'string', minLength: 8, maxLength: 64, description: 'The persona whose wallet pays.' },
	to: { type: 'string', minLength: 32, maxLength: 64, description: 'Destination Solana address (USDC associated token account is created if needed).' },
	usdc: { type: 'number', exclusiveMinimum: 0, description: `Amount in USDC. Hard per-call cap: $${PERSONA_SPEND_CAPS.maxPerCallUsdc}.` },
	session_id: {
		type: 'string',
		maxLength: 128,
		description: 'Groups calls under one cumulative session spend cap (default $' + PERSONA_SPEND_CAPS.maxPerSessionUsdc + '). Omit to bucket by persona + UTC day.',
	},
	memo: { type: 'string', maxLength: 180, description: 'Optional note stamped alongside the transfer in the returned receipt.' },
	network: NETWORK_PROP,
	confirm: {
		type: 'boolean',
		description: `Must be true when usdc exceeds $${PERSONA_SPEND_CAPS.confirmAboveUsdc} — the irreversible-transfer confirmation gate.`,
	},
};

export const toolDefs = [
	{
		name: 'persona_identity',
		title: "Read a persona's on-chain identity: wallet, reputation, holdings",
		annotations: READ_ANNOTATIONS,
		description:
			"Read a persona's real on-chain identity: its deterministic Solana wallet address, live SOL/USDC balance, " +
			'ERC-8004-style reputation (verified feedback + validation record), token holdings, and a resolved SNS ' +
			'nameplate if it holds a verified .sol name. Also returns the visual tiers (reputation tier, holdings tier, ' +
			'muted-balance flag, verified name) the embodiment viewer maps onto the body — aura, cosmetic, muted state, ' +
			'nameplate. Every persona has a wallet the moment it exists; a fresh persona legitimately reads as zero ' +
			'balance / unranked reputation until it is funded or interacted with. No sign-in required.',
		inputSchema: {
			type: 'object',
			properties: {
				persona_id: { type: 'string', minLength: 8, maxLength: 64, description: 'The persona to read.' },
				network: NETWORK_PROP,
			},
			required: ['persona_id'],
			additionalProperties: false,
		},
		handler: handlePersonaIdentity,
	},
	{
		name: 'persona_tip',
		title: "Tip USDC from a persona's own wallet",
		annotations: VALUE_ANNOTATIONS,
		description:
			"Send a small USDC tip FROM a persona's own wallet to a destination Solana address — e.g. tipping " +
			'another agent for a good answer or hiring result. Real, irreversible on-chain settlement, hard-capped ' +
			`at $${PERSONA_SPEND_CAPS.maxPerCallUsdc}/call and $${PERSONA_SPEND_CAPS.maxPerSessionUsdc} cumulative per session. ` +
			`Amounts over $${PERSONA_SPEND_CAPS.confirmAboveUsdc} require confirm:true. Fails cleanly with the exact reason ` +
			'(insufficient balance, over cap, confirmation required) — never a silent no-op.',
		inputSchema: { type: 'object', properties: VALUE_INPUT_PROPS, required: ['persona_id', 'to', 'usdc'], additionalProperties: false },
		async handler(args, auth) {
			return handlePersonaValueOp(args, auth, { tool: 'persona_tip', verb: 'Tip' });
		},
	},
	{
		name: 'persona_send',
		title: "Send USDC from a persona's own wallet",
		annotations: VALUE_ANNOTATIONS,
		description:
			"Send USDC FROM a persona's own wallet to a destination Solana address — the general-purpose value op " +
			'behind persona-initiated payments (settling a hire, paying an invoice, funding another wallet). Real, ' +
			`irreversible on-chain settlement, hard-capped at $${PERSONA_SPEND_CAPS.maxPerCallUsdc}/call and ` +
			`$${PERSONA_SPEND_CAPS.maxPerSessionUsdc} cumulative per session. Amounts over $${PERSONA_SPEND_CAPS.confirmAboveUsdc} ` +
			'require confirm:true. USDC is the only settlement asset here — any other mint is out of scope for this tool.',
		inputSchema: { type: 'object', properties: VALUE_INPUT_PROPS, required: ['persona_id', 'to', 'usdc'], additionalProperties: false },
		async handler(args, auth) {
			return handlePersonaValueOp(args, auth, { tool: 'persona_send', verb: 'Send' });
		},
	},
];

// Exposed for tests that want the raw address without a full identity read.
export { personaWalletAddress };
