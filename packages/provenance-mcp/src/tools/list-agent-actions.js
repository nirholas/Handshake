// `list_agent_actions` — read one agent's append-only provenance trail,
// newest-first, cursor-paginated. Read-only.
//
// Wraps GET /api/agent-actions?agent_id=&limit=&cursor=. The ledger is
// owner-scoped: the THREE_WS_TOKEN must own the agent (else 403/404). Each
// record carries an ERC-191 signature + signer_address when the action was
// signed at append time, so the trail is independently verifiable.

import { z } from 'zod';

import { apiRequest } from '../lib/api.js';
import { verifyAction } from '../lib/signing.js';

export const def = {
	name: 'list_agent_actions',
	title: 'List an agent\'s action-provenance trail',
	annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
	description:
		"Read an agent's append-only action log, newest-first, cursor-paginated. Returns each action's id, type (e.g. launch, buy, post, reflect), payload, source_skill, created_at, and — when the action was signed — its ERC-191 signature + signer_address. Each record is checked against its own signature: `verification.reason` is `ok` (recovered signer matches the claimed address), `unsigned`, `signer_mismatch` (recovered a different address — tampering OR an action signed under a different canonical scheme; treat as unverified, not trusted), or `malformed_signature`. Pass the returned `next_cursor` back as `cursor` to page further. The ledger is owner-scoped: THREE_WS_TOKEN must own `agent_id`. Read-only; the log is immutable so older pages never change.",
	inputSchema: {
		agent_id: z
			.string()
			.min(1)
			.describe('The agent identity uuid whose provenance trail to read. Your token must own it.'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.default(50)
			.describe('Max actions to return (1–200, default 50).'),
		cursor: z
			.string()
			.regex(/^\d+$/)
			.optional()
			.describe('Pagination cursor — pass the `next_cursor` from a previous call to fetch the next (older) page.'),
	},
	async handler(args) {
		const agent_id = String(args?.agent_id ?? '').trim();
		const limit = clampLimit(args?.limit);
		const cursor = args?.cursor != null ? String(args.cursor) : undefined;

		const data = await apiRequest('/api/agent-actions', {
			query: { agent_id, limit, cursor },
		});

		const actions = Array.isArray(data?.actions) ? data.actions : [];
		return {
			ok: true,
			agent_id,
			count: actions.length,
			next_cursor: data?.next_cursor ?? null,
			has_more: Boolean(data?.next_cursor),
			actions: actions.map(decorateWithVerification),
		};
	},
};

export function clampLimit(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 50;
	return Math.min(Math.max(Math.trunc(n), 1), 200);
}

// Attach an offline verification verdict to each record. The verdict is the raw
// recover-and-compare result — never softened. A `signer_mismatch` (recovered a
// different address than claimed) stays a mismatch: it could be tampering or a
// foreign signing scheme, and either way the record is not trustable as-is.
export function decorateWithVerification(action) {
	if (!action || typeof action !== 'object') return action;
	if (!action.signature || !action.signer_address) {
		return { ...action, verification: { signed: false, valid: false, reason: 'unsigned' } };
	}
	const v = verifyAction(action);
	return {
		...action,
		verification: { signed: true, valid: v.valid, reason: v.reason, recovered: v.recovered },
	};
}
