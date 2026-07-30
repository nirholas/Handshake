-- skill_purchases.kind: allow 'bundle' alongside 'purchase' | 'trial' | 'time_pass'.
--
-- Why this migration exists. A paid bundle purchase never unlocked anything. The
-- unlock loop in api/marketplace/purchase-bundle.js inserted one skill_purchases
-- row per bundled skill, but supplied only (user_id, agent_id, skill, status,
-- confirmed_at, tx_signature) while `reference`, `amount` and `currency_mint` are
-- all NOT NULL with no default. Every one of those inserts raised SQLSTATE 23502.
-- The loop sits AFTER the bundle_purchases row is claimed as 'confirmed' and is
-- not wrapped in a catch, so the buyer paid on-chain, the purchase was recorded
-- as confirmed, the request 500'd, and the retry answered 409 already_processed.
-- Access was lost permanently. Verified against the live schema on 2026-07-30 by
-- replaying the exact statement inside a rolled-back transaction.
--
-- A second defect sat behind the first: tx_signature is UNIQUE, and the loop wrote
-- the SAME settlement signature to every row in the bundle. Even with the NOT NULL
-- columns supplied, rows 2..N would have collided and been swallowed by
-- ON CONFLICT DO NOTHING, unlocking only the first skill of the bundle. The
-- settlement tx is recorded once on bundle_purchases, which is where it belongs.
--
-- Why a new kind rather than reusing 'purchase'. These rows are ACCESS records,
-- not sales: the bundle's revenue is already counted once on bundle_purchases.
-- Filing them as 'purchase' would report a single bundle sale as N marketplace
-- purchases and drag avg_ticket_three toward zero on the public /pulse page, which
-- is the exact class of accounting error just removed from that page (money and
-- party aggregates there now filter to paid kinds via one shared predicate).
-- 'bundle' is deliberately NOT in MARKET_PAID_KINDS, so these rows unlock the
-- skill without ever being counted as marketplace revenue or as a purchase.
--
-- hasSkillAccess() (api/_lib/skill-access.js) resolves a one-time purchase from
-- skill_purchases on status IN ('confirmed','trial') and does not read `kind`, so
-- widening the constraint grants access without any change to the read path.
--
-- Widening a CHECK is backward compatible: every row that satisfied the old
-- constraint satisfies the new one, so this is safe to apply ahead of the deploy
-- that starts writing 'bundle'.

ALTER TABLE skill_purchases
	DROP CONSTRAINT IF EXISTS skill_purchases_kind_check;

ALTER TABLE skill_purchases
	ADD CONSTRAINT skill_purchases_kind_check
	CHECK (kind = ANY (ARRAY['purchase'::text, 'trial'::text, 'time_pass'::text, 'bundle'::text]));
