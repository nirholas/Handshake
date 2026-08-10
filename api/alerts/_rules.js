// Shared validation + serialization for the pump alert rules CRUD endpoints.
// Underscore-prefixed → not routed by Vercel; imported by rules.js and
// rules/[id].js so the create and update paths can't drift apart.

import { z } from 'zod';
import { isValidSolanaAddress, isUuid } from '../_lib/validate.js';
import { MINT_TARGETED_KINDS, AGENT_TARGETED_KINDS, THRESHOLD_KINDS, deriveRuleLabel } from '../_lib/pump-alert-eval.js';

export const RULE_KINDS = ['graduation', 'price_above', 'price_below', 'whale_buy', 'new_mint'];

const telegramChat = z
	.string()
	.trim()
	.max(64)
	.refine(
		(v) => /^-?\d{1,32}$/.test(v) || /^@[a-zA-Z0-9_]{4,64}$/.test(v),
		'telegram_chat must be a numeric chat id or @username',
	);

const webhookUrl = z
	.string()
	.trim()
	.max(2048)
	.url()
	.refine((u) => /^https:\/\//i.test(u), 'webhook_url must be https');

const nullableUrl = webhookUrl.nullable().or(z.literal('').transform(() => null));
const nullableTelegram = telegramChat.nullable().or(z.literal('').transform(() => null));

// Base shape — refinements that depend on `kind` run in superRefine below.
const baseShape = {
	kind: z.enum(RULE_KINDS),
	target_mint: z
		.string()
		.trim()
		.max(64)
		.refine((v) => isValidSolanaAddress(v), 'target_mint is not a valid Solana address')
		.nullable()
		.optional(),
	target_agent: z
		.string()
		.trim()
		.refine((v) => isUuid(v), 'target_agent must be a UUID')
		.nullable()
		.optional(),
	threshold: z.coerce.number().positive().max(1e15).nullable().optional(),
	deliver_in_app: z.boolean().optional(),
	webhook_url: nullableUrl.optional(),
	telegram_chat: nullableTelegram.optional(),
	cooldown_seconds: z.coerce.number().int().min(5).max(86_400).optional(),
	enabled: z.boolean().optional(),
	label: z.string().trim().max(80).nullable().optional(),
};

/** Cross-field rules shared by create (strict) and update (after merge). */
function refineRule(v, ctx) {
	const mintTargeted = MINT_TARGETED_KINDS.includes(v.kind);
	const agentTargeted = AGENT_TARGETED_KINDS.includes(v.kind);

	if (mintTargeted) {
		if (!v.target_mint) {
			ctx.addIssue({ code: 'custom', path: ['target_mint'], message: `${v.kind} requires a target_mint` });
		}
		if (v.target_agent) {
			ctx.addIssue({ code: 'custom', path: ['target_agent'], message: `${v.kind} cannot have a target_agent` });
		}
	}
	if (agentTargeted) {
		if (!v.target_agent) {
			ctx.addIssue({ code: 'custom', path: ['target_agent'], message: `${v.kind} requires a target_agent` });
		}
		if (v.target_mint) {
			ctx.addIssue({ code: 'custom', path: ['target_mint'], message: `${v.kind} cannot have a target_mint` });
		}
	}
	if (v.kind === 'graduation' && v.target_mint && v.target_agent) {
		ctx.addIssue({ code: 'custom', path: ['target_agent'], message: 'set either target_mint or target_agent, not both' });
	}
	if (THRESHOLD_KINDS.includes(v.kind) && !(Number(v.threshold) > 0)) {
		ctx.addIssue({ code: 'custom', path: ['threshold'], message: `${v.kind} requires a positive threshold` });
	}

	// At least one delivery channel must be active. deliver_in_app defaults true.
	const inApp = v.deliver_in_app !== false;
	if (!inApp && !v.webhook_url && !v.telegram_chat) {
		ctx.addIssue({ code: 'custom', path: ['deliver_in_app'], message: 'enable at least one delivery channel' });
	}
}

export const createRuleSchema = z.object(baseShape).superRefine(refineRule);

// Update: every field optional; cross-field validation happens after merging
// with the existing row (see validateUpdate).
export const updateRuleSchema = z
	.object({ ...baseShape, kind: baseShape.kind.optional() })
	.refine((v) => Object.keys(v).length > 0, 'no fields to update');

/**
 * Render zod-style issues into one message, using the exact convention
 * api/_lib/validate.js `parse()` uses on the create path. Both paths validate
 * through this module, so both must also *report* identically: without this the
 * update path returned a bare "price_below requires a target_mint" while create
 * returned "target_mint: price_below requires a target_mint", and a client
 * parsing the prefix off one envelope mis-read the other.
 */
function formatIssues(issues) {
	return issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

/**
 * Merge a partial update over the current row, normalize targeting/threshold to
 * the effective kind, then run the shared cross-field validation.
 * @returns {{ ok: true, value: object } | { ok: false, issues: any[], message: string }}
 */
export function validateUpdate(current, patch) {
	const merged = {
		kind: patch.kind ?? current.kind,
		target_mint: 'target_mint' in patch ? patch.target_mint : current.target_mint,
		target_agent: 'target_agent' in patch ? patch.target_agent : current.target_agent,
		threshold: 'threshold' in patch ? patch.threshold : current.threshold,
		deliver_in_app: 'deliver_in_app' in patch ? patch.deliver_in_app : current.deliver_in_app,
		webhook_url: 'webhook_url' in patch ? patch.webhook_url : current.webhook_url,
		telegram_chat: 'telegram_chat' in patch ? patch.telegram_chat : current.telegram_chat,
		cooldown_seconds: 'cooldown_seconds' in patch ? patch.cooldown_seconds : current.cooldown_seconds,
		enabled: 'enabled' in patch ? patch.enabled : current.enabled,
		label: 'label' in patch ? patch.label : current.label,
	};
	// Normalize first so fields incompatible with the (possibly new) kind are
	// cleared before validation — e.g. switching to new_mint drops a stale
	// target_mint instead of failing on it.
	const normalized = normalizeForKind(merged);
	const issues = [];
	refineRule(normalized, { addIssue: (i) => issues.push(i) });
	if (issues.length) return { ok: false, issues, message: formatIssues(issues) };
	return { ok: true, value: normalized };
}

/**
 * Rules that have a live webhook but no signing secret. Such a rule delivers
 * UNSIGNED webhooks (api/_lib/alert-delivery.js only sets the
 * `webhook-signature` header when a secret exists), leaving the receiver with
 * no way to verify the payload came from us. The create and update paths both
 * mint a secret alongside the URL, but the legacy backfill in
 * 2026-06-15-pump-alert-rules.sql copies `user_alert_configs.webhook_url`
 * without one, so any DB carrying those rows can still hold the combination.
 */
export function rulesMissingWebhookSecret(rows) {
	return rows.filter((r) => r.webhook_url && !r.webhook_secret);
}

/** Null out fields that don't apply to the rule's kind so stale values can't leak. */
export function normalizeForKind(v) {
	const out = { ...v };
	if (!THRESHOLD_KINDS.includes(out.kind)) out.threshold = null;
	if (!MINT_TARGETED_KINDS.includes(out.kind) && out.kind !== 'graduation') out.target_mint = null;
	if (!AGENT_TARGETED_KINDS.includes(out.kind) && out.kind !== 'graduation') out.target_agent = null;
	if (out.deliver_in_app === undefined) out.deliver_in_app = true;
	if (out.cooldown_seconds === undefined) out.cooldown_seconds = 300;
	if (out.enabled === undefined) out.enabled = true;
	return out;
}

/** Shape a DB row for the API response (includes the user's own webhook secret). */
export function serializeRule(row) {
	return {
		id: row.id,
		kind: row.kind,
		target_mint: row.target_mint || null,
		target_agent: row.target_agent || null,
		threshold: row.threshold != null ? Number(row.threshold) : null,
		deliver_in_app: row.deliver_in_app,
		webhook_url: row.webhook_url || null,
		webhook_secret: row.webhook_secret || null,
		telegram_chat: row.telegram_chat || null,
		cooldown_seconds: row.cooldown_seconds,
		enabled: row.enabled,
		// `label` is the raw user value (null when auto); `label_display` is what
		// the UI shows — a derived default when the user didn't name the rule.
		label: row.label || null,
		label_display: row.label || deriveRuleLabel(row),
		last_fired_at: row.last_fired_at || null,
		recent_failures: row.recent_failures != null ? Number(row.recent_failures) : 0,
		recent_deliveries: row.recent_deliveries || [],
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}
