// `append_agent_action` — record one action in an agent's append-only
// provenance ledger. WRITE tool.
//
// Wraps POST /api/agent-actions. The ledger is immutable: this only ever adds a
// row, never overwrites or deletes (so destructiveHint:false), and the same
// call appends a new distinct record every time (idempotentHint:false). When an
// EVM signer key is configured (THREE_WS_SIGNER_KEY env or the `signer_key`
// arg) the action is ERC-191-signed before it is sent, so anyone can later
// `ecrecover` the signer and verify authorship on-chain. With no key the action
// is appended unsigned — honestly reported, never a fake signature.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { signerKey } from '../config.js';
import { signAction } from '../lib/signing.js';

export const def = {
	name: 'append_agent_action',
	title: 'Append a signed action to the provenance ledger',
	// MCP ToolAnnotations — WRITE: appends to an immutable, append-only ledger.
	// Never overwrites or deletes (destructiveHint:false). Each call records a
	// new distinct row (idempotentHint:false).
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	description:
		"Record an action in an agent's append-only provenance ledger — the permanent, auditable trail of what the agent did. Provide `agent_id` (THREE_WS_TOKEN must own it), a short `type` (≤64 chars, e.g. launch, buy, post, reflect), an optional structured `payload`, and an optional `source_skill`. WRITE ACTION: this APPENDS a new immutable record — it can never be edited or deleted, and calling it twice records two distinct actions, so don't retry blindly. When an EVM signer is configured (THREE_WS_SIGNER_KEY env or the `signer_key` arg) the action is ERC-191-signed before sending, making its authorship publicly verifiable; with no key it is appended unsigned. Returns the stored record (with id + created_at) and a `signing` block reporting whether it was signed and by which address.",
	inputSchema: {
		agent_id: z
			.string()
			.min(1)
			.describe('The agent identity uuid to record the action under. Your token must own it.'),
		type: z
			.string()
			.min(1)
			.max(64)
			.describe('Short action type, e.g. launch, buy, sell, post, reflect, follow. Truncated to 64 chars server-side.'),
		payload: z
			.record(z.any())
			.optional()
			.describe('Structured details of the action (any JSON object) — e.g. { mint, amount_sol, signature }. Stored verbatim and covered by the signature.'),
		source_skill: z
			.string()
			.max(200)
			.optional()
			.describe('Identifier of the skill/tool that produced this action, for attribution in the trail.'),
		signer_key: z
			.string()
			.optional()
			.describe('Optional 0x-prefixed EVM private key to ERC-191-sign this action. Overrides THREE_WS_SIGNER_KEY for this call. Omit to use the env key, or sign nothing if none is set.'),
	},
	async handler(args) {
		const agent_id = String(args?.agent_id ?? '').trim();
		const type = String(args?.type ?? '').trim();
		if (!agent_id) return { ok: false, error: 'validation_error', message: 'agent_id is required' };
		if (!type) return { ok: false, error: 'validation_error', message: 'type is required' };

		const payload = args?.payload && typeof args.payload === 'object' ? args.payload : {};
		const source_skill = args?.source_skill ? String(args.source_skill) : null;

		const body = { agent_id, type, payload, source_skill };

		// Sign before sending when a key is available. A bad key is a caller
		// error worth surfacing — don't silently downgrade to unsigned.
		const key = (args?.signer_key && String(args.signer_key).trim()) || signerKey();
		let signing = { signed: false, signer_address: null };
		if (key) {
			let signed;
			try {
				signed = await signAction(key, body);
			} catch (err) {
				return {
					ok: false,
					error: err?.code || 'signing_failed',
					message: `could not sign action: ${err?.message || err}`,
				};
			}
			body.signature = signed.signature;
			body.signer_address = signed.signer_address;
			signing = { signed: true, signer_address: signed.signer_address, digest: signed.digest };
		}

		const data = await apiRequest('/api/agent-actions', { method: 'POST', body });
		const action = data?.action ?? data;

		return {
			ok: true,
			action,
			signing,
		};
	},
};
