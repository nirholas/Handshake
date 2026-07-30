// Bundle purchase unlock — the insert that grants the skills has to satisfy the
// real skill_purchases constraints, or a paid bundle silently grants nothing.
//
// What happened: the unlock loop supplied only (user_id, agent_id, skill, status,
// confirmed_at, tx_signature). `reference`, `amount` and `currency_mint` are all
// NOT NULL with no default, so every insert raised SQLSTATE 23502. The loop runs
// AFTER bundle_purchases is claimed 'confirmed' and is not wrapped in a catch, so
// the buyer paid on-chain, the row was marked confirmed, the request 500'd, and
// the retry answered 409 already_processed. Access was lost permanently.
//
// A second defect sat behind it: tx_signature is UNIQUE and the loop wrote the
// same settlement signature to every skill in the bundle, so even with the NOT
// NULL columns supplied, rows 2..N would collide and be swallowed by
// ON CONFLICT DO NOTHING, unlocking only the first skill.
//
// Verified against the live schema by replaying both statements inside a
// rolled-back transaction: the fixed insert unlocked 3 of 3 skills, the old one
// failed 23502.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../api/marketplace/purchase-bundle.js', import.meta.url)), 'utf8');

// The unlock statement: the INSERT INTO skill_purchases inside the confirm path.
const UNLOCK = (() => {
	const at = SRC.indexOf('INSERT INTO skill_purchases');
	expect(at, 'bundle confirm must insert the unlock rows').toBeGreaterThan(-1);
	return SRC.slice(at, SRC.indexOf('`', SRC.indexOf('ON CONFLICT', at)));
})();

describe('bundle unlock insert', () => {
	it('supplies every NOT NULL column that has no default', () => {
		// Read off skill_purchases: these six are NOT NULL with no default, so an
		// insert omitting any one of them cannot succeed.
		for (const col of ['user_id', 'agent_id', 'skill', 'reference', 'amount', 'currency_mint']) {
			expect(UNLOCK, `unlock insert must supply ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
		}
	});

	it('gives each skill its own reference, because reference is UNIQUE', () => {
		// Interpolating the skill name is what keeps N rows in one bundle distinct.
		expect(UNLOCK).toMatch(/bundle_\$\{purchaseId\}_\$\{skillName\}/);
	});

	it('does not reuse the settlement signature across the bundle rows', () => {
		// tx_signature is UNIQUE: repeating it would let ON CONFLICT DO NOTHING
		// silently drop every skill after the first. It belongs on bundle_purchases.
		expect(UNLOCK).not.toMatch(/tx_signature/);
	});

	it('files the rows as a non-paid kind so /pulse revenue stays honest', () => {
		// The bundle's revenue is counted once on bundle_purchases. 'bundle' is
		// deliberately absent from MARKET_PAID_KINDS, so these access records never
		// count as marketplace GMV or as N separate purchases.
		expect(UNLOCK).toMatch(/'bundle'/);
		expect(UNLOCK).toMatch(/\b0\b/);
	});

	it('still absorbs an already-owned skill', () => {
		// The partial unique index on a confirmed (user, agent, skill) fires when the
		// buyer already owns one of the bundled skills. That is not an error.
		expect(UNLOCK).toMatch(/ON CONFLICT DO NOTHING/);
	});
});

describe('skill_purchases kind constraint', () => {
	it('has a migration widening the CHECK to accept the bundle kind', () => {
		const mig = readFileSync(
			fileURLToPath(new URL('../api/_lib/migrations/20260730230000_skill_purchases_bundle_kind.sql', import.meta.url)),
			'utf8',
		);
		expect(mig).toMatch(/skill_purchases_kind_check/);
		expect(mig).toMatch(/'bundle'::text/);
		// Every previously valid kind must survive the widening.
		for (const kind of ['purchase', 'trial', 'time_pass']) expect(mig).toMatch(new RegExp(`'${kind}'::text`));
	});
});
