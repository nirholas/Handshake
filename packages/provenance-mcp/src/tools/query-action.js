// `query_action` — fetch one action from an agent's provenance trail by id and
// independently verify its signature. Read-only.
//
// The ledger exposes a cursor-paginated list (id DESC, `id < cursor`). To pull a
// single record we request the window starting just above the target id with
// limit 1, which returns exactly that action when it exists and belongs to the
// agent. The signature is then recovered and checked offline.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { verifyAction } from '../lib/signing.js';

export const def = {
	name: 'query_action',
	title: 'Fetch + verify one provenance action',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		"Fetch a single action from an agent's append-only log by its id, then verify it. Returns the action (type, payload, source_skill, created_at, signature, signer_address) plus a `verification` block: `signed`, `valid`, `reason` (`ok` | `unsigned` | `signer_mismatch` | `malformed_signature`), the `recovered` signer address, and the recomputed `digest`. `valid:true` means the ERC-191 signature recovers to the claimed signer over the canonical action form — cryptographic proof the named agent authored this exact action and it was not altered. The ledger is owner-scoped: THREE_WS_TOKEN must own `agent_id`. Returns ok:false / not_found when the id is absent from this agent's log. Read-only.",
	inputSchema: {
		agent_id: z
			.string()
			.min(1)
			.describe('The agent identity uuid that owns the action. Your token must own this agent.'),
		id: z
			.string()
			.regex(/^\d+$/)
			.describe('The numeric action id to fetch (the `id` field from list_agent_actions).'),
	},
	async handler(args) {
		const agent_id = String(args?.agent_id ?? '').trim();
		const id = String(args?.id ?? '').trim();
		if (!/^\d+$/.test(id)) {
			return { ok: false, error: 'validation_error', message: 'id must be a numeric action id' };
		}

		// `id < cursor` is strict, so the window above (id+1) makes the target the
		// first row returned. BigInt keeps bigserial ids exact.
		const cursor = (BigInt(id) + 1n).toString();
		const data = await apiRequest('/api/agent-actions', {
			query: { agent_id, limit: 1, cursor },
		});

		const actions = Array.isArray(data?.actions) ? data.actions : [];
		const action = actions.find((a) => String(a?.id) === id) || null;
		if (!action) {
			return {
				ok: false,
				error: 'not_found',
				message: `action ${id} not found in agent ${agent_id}'s log`,
			};
		}

		const v = verifyAction(action);
		return {
			ok: true,
			action,
			verification: {
				signed: Boolean(action.signature && action.signer_address),
				valid: v.valid,
				reason: v.reason,
				recovered: v.recovered,
				digest: v.digest,
			},
		};
	},
};
