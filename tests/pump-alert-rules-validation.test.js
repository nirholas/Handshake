import { describe, it, expect } from 'vitest';
import {
	createRuleSchema,
	updateRuleSchema,
	validateUpdate,
	normalizeForKind,
	rulesMissingWebhookSecret,
	serializeRule,
} from '../api/alerts/_rules.js';

// $THREE — the only coin the platform references — used here as a valid base58
// mint fixture for validation tests.
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AGENT = '11111111-2222-4333-8444-555555555555';

describe('createRuleSchema', () => {
	it('accepts a valid global graduation rule', () => {
		const r = createRuleSchema.safeParse({ kind: 'graduation' });
		expect(r.success).toBe(true);
	});

	it('requires a target_mint + positive threshold for price rules', () => {
		expect(createRuleSchema.safeParse({ kind: 'price_above' }).success).toBe(false);
		expect(createRuleSchema.safeParse({ kind: 'price_above', target_mint: MINT }).success).toBe(false);
		expect(
			createRuleSchema.safeParse({ kind: 'price_above', target_mint: MINT, threshold: 50000 }).success,
		).toBe(true);
	});

	it('requires a target_agent for new_mint and forbids a mint', () => {
		expect(createRuleSchema.safeParse({ kind: 'new_mint' }).success).toBe(false);
		expect(createRuleSchema.safeParse({ kind: 'new_mint', target_agent: AGENT }).success).toBe(true);
		expect(
			createRuleSchema.safeParse({ kind: 'new_mint', target_agent: AGENT, target_mint: MINT }).success,
		).toBe(false);
	});

	it('rejects whale_buy without mint or threshold', () => {
		expect(createRuleSchema.safeParse({ kind: 'whale_buy', target_mint: MINT }).success).toBe(false);
		expect(
			createRuleSchema.safeParse({ kind: 'whale_buy', target_mint: MINT, threshold: 10 }).success,
		).toBe(true);
	});

	it('rejects non-https webhook URLs', () => {
		expect(
			createRuleSchema.safeParse({ kind: 'graduation', webhook_url: 'http://evil.example' }).success,
		).toBe(false);
		expect(
			createRuleSchema.safeParse({ kind: 'graduation', webhook_url: 'https://ok.example/hook' }).success,
		).toBe(true);
	});

	it('requires at least one delivery channel', () => {
		expect(createRuleSchema.safeParse({ kind: 'graduation', deliver_in_app: false }).success).toBe(false);
		expect(
			createRuleSchema.safeParse({ kind: 'graduation', deliver_in_app: false, telegram_chat: '12345' }).success,
		).toBe(true);
	});

	it('validates telegram chat format', () => {
		expect(
			createRuleSchema.safeParse({ kind: 'graduation', deliver_in_app: false, telegram_chat: 'not a chat!!' }).success,
		).toBe(false);
		expect(
			createRuleSchema.safeParse({ kind: 'graduation', deliver_in_app: false, telegram_chat: '-1001234567890' }).success,
		).toBe(true);
		expect(
			createRuleSchema.safeParse({ kind: 'graduation', deliver_in_app: false, telegram_chat: '@mychannel' }).success,
		).toBe(true);
	});

	it('clamps cooldown to the allowed range', () => {
		expect(createRuleSchema.safeParse({ kind: 'graduation', cooldown_seconds: 1 }).success).toBe(false);
		expect(createRuleSchema.safeParse({ kind: 'graduation', cooldown_seconds: 100000 }).success).toBe(false);
		expect(createRuleSchema.safeParse({ kind: 'graduation', cooldown_seconds: 600 }).success).toBe(true);
	});
});

describe('normalizeForKind', () => {
	it('nulls out threshold + agent for graduation; defaults delivery', () => {
		const out = normalizeForKind({ kind: 'graduation', target_mint: MINT, threshold: 5, target_agent: null });
		expect(out.threshold).toBe(null);
		expect(out.target_mint).toBe(MINT); // graduation may keep a mint scope
		expect(out.deliver_in_app).toBe(true);
		expect(out.cooldown_seconds).toBe(300);
		expect(out.enabled).toBe(true);
	});
	it('drops a stray mint when normalizing a new_mint rule', () => {
		const out = normalizeForKind({ kind: 'new_mint', target_agent: AGENT, target_mint: MINT });
		expect(out.target_mint).toBe(null);
		expect(out.target_agent).toBe(AGENT);
	});
});

describe('validateUpdate (merge + re-validate)', () => {
	const current = {
		kind: 'price_above',
		target_mint: MINT,
		target_agent: null,
		threshold: 50000,
		deliver_in_app: true,
		webhook_url: null,
		telegram_chat: null,
		cooldown_seconds: 300,
		enabled: true,
		label: null,
	};

	it('allows a partial threshold update', () => {
		const r = validateUpdate(current, { threshold: 75000 });
		expect(r.ok).toBe(true);
		expect(r.value.threshold).toBe(75000);
		expect(r.value.target_mint).toBe(MINT);
	});

	it('rejects an update that drops a required field', () => {
		const r = validateUpdate(current, { target_mint: null });
		expect(r.ok).toBe(false);
	});

	it('re-validates when kind changes and clears incompatible targets', () => {
		const r = validateUpdate(current, { kind: 'new_mint', target_agent: AGENT });
		expect(r.ok).toBe(true);
		expect(r.value.target_mint).toBe(null);
		expect(r.value.threshold).toBe(null);
	});

	it('rejects disabling every delivery channel', () => {
		const r = validateUpdate(current, { deliver_in_app: false });
		expect(r.ok).toBe(false);
	});

	// The update path must report failures exactly the way the create path does
	// (api/_lib/validate.js `parse()`): "<field>: <message>", joined by "; ".
	// A bare message here made PATCH and POST disagree on the same rule.
	it('formats issues with the same field prefix the create path uses', () => {
		const r = validateUpdate(current, { kind: 'graduation', target_agent: AGENT });
		expect(r.ok).toBe(false);
		expect(r.message).toBe('target_agent: set either target_mint or target_agent, not both');
	});

	it('joins multiple issues into one message', () => {
		const grad = { ...current, kind: 'graduation', target_mint: null, threshold: null };
		const r = validateUpdate(grad, { kind: 'price_below' });
		expect(r.ok).toBe(false);
		expect(r.message).toBe(
			'target_mint: price_below requires a target_mint; threshold: price_below requires a positive threshold',
		);
	});
});

describe('rulesMissingWebhookSecret', () => {
	const row = (over) => ({ id: 'r', webhook_url: null, webhook_secret: null, ...over });

	it('flags a rule that has a webhook but no signing secret', () => {
		const rows = [row({ id: 'legacy', webhook_url: 'https://example.com/hook' })];
		expect(rulesMissingWebhookSecret(rows).map((r) => r.id)).toEqual(['legacy']);
	});

	it('ignores rules with no webhook and rules already carrying a secret', () => {
		const rows = [
			row({ id: 'in-app-only' }),
			row({ id: 'signed', webhook_url: 'https://example.com/hook', webhook_secret: 'whsec_abc' }),
		];
		expect(rulesMissingWebhookSecret(rows)).toEqual([]);
	});
});

describe('serializeRule', () => {
	it('derives a display label but keeps the raw label separate', () => {
		const row = {
			id: 'r1',
			kind: 'graduation',
			target_mint: null,
			target_agent: null,
			threshold: null,
			deliver_in_app: true,
			webhook_url: null,
			webhook_secret: null,
			telegram_chat: null,
			cooldown_seconds: 300,
			enabled: true,
			label: null,
			created_at: '2026-06-15T00:00:00Z',
			updated_at: '2026-06-15T00:00:00Z',
		};
		const s = serializeRule(row);
		expect(s.label).toBe(null);
		expect(s.label_display).toContain('Graduations');
		expect(s.recent_failures).toBe(0);
		expect(Array.isArray(s.recent_deliveries)).toBe(true);
	});
});
