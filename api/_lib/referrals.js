import { randomBytes } from 'crypto';
import { sql } from './db.js';
import { cacheWrap } from './cache.js';
import { sendReferralCommissionEmail } from './email.js';

/**
 * Generates a random, human-readable referral code.
 * @param {number} length The desired length of the code.
 * @returns {string} A random referral code.
 */
export function generateReferralCode(length = 8) {
  // Using a base32-like alphabet to avoid ambiguous characters (0/O, 1/I/l)
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  const randomValues = randomBytes(length);

  for (let i = 0; i < length; i++) {
    code += alphabet[randomValues[i] % alphabet.length];
  }

  return code;
}

// ── Custom referral codes ────────────────────────────────────────────────────
//
// Auto-generated codes draw from a restricted, unambiguous alphabet, but a
// user-chosen vanity code (e.g. their name) may legitimately contain any letter
// or digit. Codes are stored and matched in a single canonical case (UPPERCASE)
// so the UNIQUE index on users.referral_code doubles as a case-insensitive
// uniqueness guard and every lookup site can match without per-call lowering.

export const REFERRAL_CODE_MIN_LEN = 3;
export const REFERRAL_CODE_MAX_LEN = 20;

// The canonical, storable shape of a referral code: A-Z and 0-9 only. Vanity
// codes accept the full alphanumeric range; the generator stays restricted so
// auto-minted codes remain easy to read aloud off a membership card.
export const REFERRAL_CODE_RE = new RegExp(`^[A-Z0-9]{${REFERRAL_CODE_MIN_LEN},${REFERRAL_CODE_MAX_LEN}}$`);

// Codes that collide with product surfaces, routes, or the brand. Reserving them
// keeps referral links unambiguous and stops a user from minting a code that
// reads like an official endpoint. Compared case-insensitively (canonical upper).
const RESERVED_REFERRAL_CODES = new Set([
  'THREE', 'THREEWS', 'THREE3', 'ADMIN', 'ROOT', 'SUPPORT', 'HELP', 'OFFICIAL',
  'API', 'APP', 'WWW', 'LOGIN', 'REGISTER', 'SIGNUP', 'SIGNIN', 'AUTH', 'OAUTH',
  'DASHBOARD', 'ACCOUNT', 'SETTINGS', 'BILLING', 'WALLET', 'PAY', 'CHECKOUT',
  'REFERRAL', 'REFERRALS', 'REF', 'INVITE', 'NULL', 'NONE', 'TEST', 'SYSTEM',
  'MARKETPLACE', 'FORGE', 'STUDIO', 'AGENT', 'AGENTS', 'CLUB', 'CHANGELOG',
]);

/**
 * Normalize arbitrary user input to a canonical referral code, or null if it
 * can't be one. Trims, uppercases, and validates against the canonical shape :
 * it never strips invalid characters (so "my-code" is rejected, not silently
 * mangled into "MYCODE"); callers surface the rejection to the user.
 *
 * @param {unknown} input
 * @returns {string|null} canonical code, or null when invalid
 */
export function normalizeReferralCode(input) {
  if (input == null) return null;
  const code = String(input).trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

/** True if the canonical code is reserved for the platform. */
export function isReservedReferralCode(code) {
  return RESERVED_REFERRAL_CODES.has(String(code || '').toUpperCase());
}

/**
 * Derive a canonical referral code candidate from a person's name. Strips
 * everything but letters and digits, uppercases, and clamps to the max length.
 * Returns null if nothing usable (≥ MIN_LEN chars) remains: e.g. a name that's
 * all punctuation or an emoji.
 *
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function slugifyReferralName(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, REFERRAL_CODE_MAX_LEN);
  return slug.length >= REFERRAL_CODE_MIN_LEN ? slug : null;
}

/**
 * Ordered candidate codes for a new account: the user's name first (so the
 * default referral code reads like them), then the name plus a short random
 * suffix to ride out collisions while staying recognizable, then pure random
 * fallbacks. Finite: callers loop until an insert/update succeeds.
 *
 * @param {string|null} name  display name or username to seed the default
 * @returns {Generator<string>}
 */
export function* referralCodeCandidates(name) {
  const seen = new Set();
  const offer = function* (code) {
    if (code && !seen.has(code)) { seen.add(code); yield code; }
  };

  const slug = slugifyReferralName(name);
  if (slug && !isReservedReferralCode(slug)) yield* offer(slug);

  if (slug) {
    // Keep room for a 4-char suffix so "ada" → "ADAX7QK" stays under the cap.
    const base = slug.slice(0, REFERRAL_CODE_MAX_LEN - 4);
    for (let i = 0; i < 4; i++) yield* offer(base + generateReferralCode(4));
  }

  for (let i = 0; i < 8; i++) yield* offer(generateReferralCode());
}

// Typed error for referral-code mutations so the endpoint can map a failure to a
// precise HTTP status + machine-readable reason without string-matching.
class ReferralCodeError extends Error {
  constructor(reason, status, message) {
    super(message);
    this.name = 'ReferralCodeError';
    this.reason = reason;
    this.status = status;
  }
}

/**
 * Whether a desired code is available to a given user. Used by the live
 * availability check as the user types in the code editor.
 *
 * @param {string|number} userId
 * @param {unknown} desired  raw user input
 * @returns {Promise<{ available: boolean, reason: string, code: string|null }>}
 *   reason ∈ 'ok' | 'current' | 'invalid' | 'reserved' | 'taken'
 */
export async function getReferralCodeAvailability(userId, desired) {
  const code = normalizeReferralCode(desired);
  if (!code) return { available: false, reason: 'invalid', code: null };
  if (isReservedReferralCode(code)) return { available: false, reason: 'reserved', code };

  const [holder] = await sql`
    SELECT id FROM users
    WHERE UPPER(referral_code) = ${code} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!holder) return { available: true, reason: 'ok', code };
  if (String(holder.id) === String(userId)) return { available: true, reason: 'current', code };
  return { available: false, reason: 'taken', code };
}

/**
 * Set the signed-in user's custom referral code. Validates shape, blocks
 * reserved codes, and relies on the UNIQUE index (plus a pre-check) to keep
 * codes globally unique case-insensitively. Idempotent when the user submits
 * the code they already hold.
 *
 * @param {string|number} userId
 * @param {unknown} desired  raw user input
 * @returns {Promise<{ referral_code: string, changed: boolean }>}
 * @throws {ReferralCodeError} reason ∈ 'invalid' | 'reserved' | 'not_found' | 'taken'
 */
export async function setReferralCode(userId, desired) {
  const code = normalizeReferralCode(desired);
  if (!code) {
    throw new ReferralCodeError('invalid', 400, `Use ${REFERRAL_CODE_MIN_LEN} to ${REFERRAL_CODE_MAX_LEN} letters or numbers (no spaces or symbols).`);
  }
  if (isReservedReferralCode(code)) {
    throw new ReferralCodeError('reserved', 409, 'That code is reserved. Pick another.');
  }

  const [me] = await sql`
    SELECT referral_code FROM users WHERE id = ${userId} AND deleted_at IS NULL
  `;
  if (!me) throw new ReferralCodeError('not_found', 404, 'user not found');

  // No-op when the user re-submits their current code (any case).
  if (me.referral_code && me.referral_code.toUpperCase() === code) {
    return { referral_code: me.referral_code, changed: false };
  }

  const [taken] = await sql`
    SELECT id FROM users
    WHERE UPPER(referral_code) = ${code} AND id <> ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (taken) throw new ReferralCodeError('taken', 409, 'That code is already taken.');

  try {
    const [row] = await sql`
      UPDATE users SET referral_code = ${code} WHERE id = ${userId}
      RETURNING referral_code
    `;
    return { referral_code: row.referral_code, changed: true };
  } catch (err) {
    // Lost a race to a concurrent claim of the same code.
    if (err && err.code === '23505') {
      throw new ReferralCodeError('taken', 409, 'That code is already taken.');
    }
    throw err;
  }
}

// Every user is a potential referrer, but only the email + SAML signup paths
// mint a `referral_code` up front. Privy / SIWS / SIWE sign-ups (and any
// pre-existing account) land with a NULL code. This lazily assigns one the
// first time the user needs it: idempotent and race-safe via the UNIQUE
// constraint + `WHERE referral_code IS NULL` guard.
//
// @param {string|number} userId
// @returns {Promise<string>} the user's referral code
export async function ensureReferralCode(userId) {
  const [existing] = await sql`SELECT referral_code, display_name, username FROM users WHERE id = ${userId} AND deleted_at IS NULL`;
  if (existing?.referral_code) return existing.referral_code;

  // Default the code to the member's name (then name+suffix, then random) so the
  // first code they ever see reads like them: they can customize it later.
  for (const code of referralCodeCandidates(existing?.display_name || existing?.username)) {
    try {
      const [row] = await sql`
        UPDATE users SET referral_code = ${code}
        WHERE id = ${userId} AND referral_code IS NULL
        RETURNING referral_code
      `;
      if (row?.referral_code) return row.referral_code;
      // A concurrent request assigned one first: read it back.
      const [now] = await sql`SELECT referral_code FROM users WHERE id = ${userId}`;
      if (now?.referral_code) return now.referral_code;
    } catch (err) {
      // 23505 = unique_violation: this code collided with another user's.
      // Retry with the next candidate.
      if (err && err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('referral_code_generation_exhausted');
}

/**
 * Credit a confirmed referral commission to the referrer and notify them by
 * email. This is the single write-side home for accruing referral earnings:
 * purchase-confirm.js computes the atomic amount on a confirmed sale and calls
 * here so the ledger write and the "you earned a commission" email live
 * together.
 *
 * `referral_earnings_total` accumulates atomic USDC units (6 decimals), the same
 * unit getMembershipCard / getReferredUsers read back.
 *
 * The DB credit is awaited (it's part of recording the sale); the email is
 * strictly best-effort: a send failure (or missing RESEND_API_KEY) is logged,
 * never thrown, so it can never roll back or block the commission credit.
 *
 * @param {object} args
 * @param {string|number} args.referrerUserId  who earned the commission
 * @param {bigint|number|string} args.amountAtomics  commission in atomic USDC units
 * @param {string} [args.currency]  display currency label (default 'USDC')
 * @param {string|null} [args.fromHandle]  public handle of the buyer who triggered it
 * @param {string|null} [args.skillName]  the skill that was sold
 * @returns {Promise<void>}
 */
export async function creditReferralCommission({
  referrerUserId,
  amountAtomics,
  currency = 'USDC',
  fromHandle = null,
  skillName = null,
}) {
  const amount = BigInt(amountAtomics);
  if (!referrerUserId || amount <= 0n) return;

  await sql`
    UPDATE users
    SET referral_earnings_total = COALESCE(referral_earnings_total, 0) + ${Number(amount)}
    WHERE id = ${referrerUserId}
  `;

  // Email is best-effort and never deliverable to synthetic Privy mailboxes.
  try {
    const [row] = await sql`
      SELECT email FROM users WHERE id = ${referrerUserId} AND deleted_at IS NULL
    `;
    const email = row?.email;
    if (email && !/@privy\.local$/i.test(email)) {
      const usd = (Number(amount) / 1_000_000).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      });
      const date = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      await sendReferralCommissionEmail({
        to: email,
        amount: usd,
        currency,
        fromHandle,
        skillName,
        date,
      }).catch((e) => console.error('[referrals] commission email failed', e?.message));
    }
  } catch (e) {
    console.error('[referrals] commission email lookup failed', e?.message);
  }
}

// Points awarded per confirmed referral and per whole USD of referral earnings.
// Kept here (not inlined) so the score formula has a single, documented home.
const POINTS_PER_REFERRAL = 100;
const POINTS_PER_USD = 1;

// Referral commission, in basis points, applied to a referred user's confirmed
// purchase total to derive what the referrer earned. Mirrors the server default
// in api/_lib/purchase-confirm.js (REFERRAL_COMMISSION_BPS, default 500 = 5%) so
// the dashboard's per-user "commission" column matches what was actually accrued.
function referralBps() {
  const v = parseInt(process.env.REFERRAL_COMMISSION_BPS || '500', 10);
  return Number.isFinite(v) && v >= 0 ? v : 500;
}

// Pagination bounds for the per-referred-user list. Keeps the join cheap and
// the payload small while letting the UI page through large referral networks.
const REFERRALS_PAGE_DEFAULT = 20;
const REFERRALS_PAGE_MAX = 100;

function clampLimit(limit) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return REFERRALS_PAGE_DEFAULT;
  return Math.min(n, REFERRALS_PAGE_MAX);
}

function clampOffset(offset) {
  const n = Number.parseInt(offset, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Real per-referred-user breakdown for an affiliate dashboard: who signed up
 * with this referrer, when, how much confirmed revenue they generated, and the
 * commission the referrer earned on it.
 *
 * Revenue is the sum of every CONFIRMED purchase a referred user made where this
 * user was the attributed referrer: across both monetization tables:
 *   • skill_purchases  (referrer_user_id, user_id, amount, status)
 *   • asset_purchases  (referrer_user_id, buyer_user_id, amount, status)
 * Amounts are atomic USDC units (6 decimals), the same unit purchase-confirm.js
 * accrues into users.referral_earnings_total. Commission is derived from the
 * configured referral BPS so the column matches what was actually credited.
 *
 * Sorted by revenue generated (desc), then most recent signup: the most
 * valuable referrals surface first. Paginated via limit/offset.
 *
 * @param {string|number} userId  the referrer
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<{ items: object[], total: number, limit: number, offset: number, referral_commission_bps: number }>}
 */
export async function getReferredUsers(userId, opts = {}) {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const bps = referralBps();

  // Total referred-user count drives pagination in the UI. Counts every active
  // account attributed to this referrer, regardless of whether they've spent.
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM users
    WHERE referred_by_id = ${userId} AND deleted_at IS NULL
  `;

  if (total === 0) {
    return { items: [], total: 0, limit, offset, referral_commission_bps: bps };
  }

  // Per-referred-user revenue, summed from both purchase tables. Each subquery
  // is correlated on the referred user's id AND keyed to this referrer so a
  // buyer's spend only counts toward the referrer who actually owns it. Only
  // confirmed sales count: pending/expired/failed rows are excluded.
  const rows = await sql`
    SELECT
      ru.id,
      ru.username,
      ru.display_name,
      ru.created_at AS signup_date,
      (
        COALESCE((
          SELECT SUM(sp.amount)::bigint
          FROM skill_purchases sp
          WHERE sp.user_id = ru.id
            AND sp.referrer_user_id = ${userId}
            AND sp.status = 'confirmed'
        ), 0)
        +
        COALESCE((
          SELECT SUM(ap.amount)::bigint
          FROM asset_purchases ap
          WHERE ap.buyer_user_id = ru.id
            AND ap.referrer_user_id = ${userId}
            AND ap.status = 'confirmed'
        ), 0)
      )::bigint AS revenue_generated
    FROM users ru
    WHERE ru.referred_by_id = ${userId} AND ru.deleted_at IS NULL
    ORDER BY revenue_generated DESC, ru.created_at DESC, ru.id
    LIMIT ${limit} OFFSET ${offset}
  `;

  const items = rows.map((r) => {
    const revenueAtomics = Math.max(0, Math.round(Number(r.revenue_generated || 0)));
    // Commission credited to the referrer = revenue * bps / 10000, floored to a
    // whole atomic unit to match the integer math in purchase-confirm.js.
    const commissionAtomics = Math.floor((revenueAtomics * bps) / 10000);
    return {
      user_id: r.id,
      username: r.username || null,
      display_name: r.display_name || r.username || null,
      signup_date: r.signup_date,
      revenue_generated: revenueAtomics,
      revenue_generated_usd: revenueAtomics / 1_000_000,
      commission_earned: commissionAtomics,
      commission_earned_usd: commissionAtomics / 1_000_000,
    };
  });

  return { items, total: Number(total || 0), limit, offset, referral_commission_bps: bps };
}

// Funnel lookback bounds. 30 days matches the activation-reward cap window in
// api/_lib/referral-rewards.js, so "this month" means the same thing on both
// sides of the referral system.
const FUNNEL_DAYS_DEFAULT = 30;
const FUNNEL_DAYS_MAX = 365;

function clampFunnelDays(days) {
  const n = Number.parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) return FUNNEL_DAYS_DEFAULT;
  return Math.min(n, FUNNEL_DAYS_MAX);
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * The referrer's viral funnel over a trailing window: link visits, signups, and
 * activations, plus the two conversion rates between them.
 *
 * Each stage is counted from the event that actually happened, in its own time:
 *   • visits     : rows POST /api/referral/visit wrote into referral_visits,
 *                   already deduped to one per (code, visitor, UTC day).
 *   • signups    : accounts attributed to this referrer that were created in
 *                   the window.
 *   • activations: referred users who reached their first win in the window,
 *                   counted from the referred-side activation grant in
 *                   credit_ledger. Counting the referred side (not the
 *                   referrer's own grant) keeps the number honest when the
 *                   referrer has hit the 30-day reward cap and stopped being
 *                   credited, and avoids miscounting the referrer's own welcome
 *                   credit as one of their referrals.
 *
 * Conversion rates are null rather than 0 when the prior stage is empty, so the
 * UI can say "no data yet" instead of showing a fake 0%.
 *
 * @param {string|number} userId  the referrer
 * @param {{ days?: number|string }} [opts]
 * @returns {Promise<{ days: number, visits: number, signups: number, activations: number, visit_to_signup_pct: number|null, signup_to_activation_pct: number|null }>}
 */
export async function getReferralFunnel(userId, opts = {}) {
  const days = clampFunnelDays(opts.days);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [visitRow] = await sql`
    SELECT COUNT(*)::int AS count FROM referral_visits
    WHERE referrer_user_id = ${userId} AND created_at >= ${since}
  `;
  const [signupRow] = await sql`
    SELECT COUNT(*)::int AS count FROM users
    WHERE referred_by_id = ${userId} AND deleted_at IS NULL AND created_at >= ${since}
  `;
  const [activationRow] = await sql`
    SELECT COUNT(*)::int AS count
    FROM users ru
    WHERE ru.referred_by_id = ${userId}
      AND ru.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM credit_ledger cl
        WHERE cl.user_id = ru.id
          AND cl.ref_type = 'referral_activation'
          AND cl.kind = 'grant'
          AND cl.created_at >= ${since}
      )
  `;

  const visits = Number(visitRow?.count || 0);
  const signups = Number(signupRow?.count || 0);
  const activations = Number(activationRow?.count || 0);

  return {
    days,
    visits,
    signups,
    activations,
    visit_to_signup_pct: pct(signups, visits),
    signup_to_activation_pct: pct(activations, signups),
  };
}

/**
 * Assemble the full membership-card payload for a user: signup position,
 * referral code + count, lifetime referral earnings, and a derived score.
 *
 * `position` is the account's 1-based signup ordinal ("member #N"), a real,
 * monotonic number: not a synthetic rank. `score` is derived purely from
 * real referral activity so it can never drift from the underlying ledger.
 *
 * @param {string|number} userId
 * @returns {Promise<object|null>} card payload, or null if the user is gone
 */
export async function getMembershipCard(userId) {
  const [user] = await sql`
    SELECT id, display_name, username, created_at, referral_code, referral_earnings_total
    FROM users
    WHERE id = ${userId} AND deleted_at IS NULL
  `;
  if (!user) return null;

  const referralCode = user.referral_code || (await ensureReferralCode(userId));

  const [{ count: referralCount }] = await sql`
    SELECT COUNT(*)::int AS count FROM users
    WHERE referred_by_id = ${userId} AND deleted_at IS NULL
  `;
  const [{ position }] = await sql`
    SELECT COUNT(*)::int AS position FROM users
    WHERE created_at <= (SELECT created_at FROM users WHERE id = ${userId})
      AND deleted_at IS NULL
  `;
  // Platform-wide member count: a full-table COUNT(*) that is identical for
  // every viewer and grows monotonically: cache for 60s instead of scanning
  // users on every member-card render.
  const total = await cacheWrap('users:total:active', 60, async () => {
    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total FROM users WHERE deleted_at IS NULL
    `;
    return total;
  });

  // `referral_earnings_total` accumulates atomic USDC units (6 decimals),
  // written by api/_lib/purchase-confirm.js.
  const earningsAtomics = Math.max(0, Math.round(Number(user.referral_earnings_total || 0)));
  const earningsUsd = earningsAtomics / 1_000_000;
  const referrals = Number(referralCount || 0);

  // Activation-reward credits: the two-sided "first win" bonus, paid as platform
  // credits (api/_lib/referral-rewards.js). Summed live from the credit ledger so
  // the card reflects the full referral payoff: purchase commission AND the
  // activation credits both sides earn.
  const [rewardRow] = await sql`
    SELECT COALESCE(SUM(amount_usd), 0)::float AS reward_usd, COUNT(*)::int AS reward_count
    FROM credit_ledger
    WHERE user_id = ${userId} AND ref_type = 'referral_activation' AND kind = 'grant'
  `;
  const rewardCreditsUsd = Math.max(0, Number(rewardRow?.reward_usd || 0));

  const score = referrals * POINTS_PER_REFERRAL + Math.floor(earningsUsd) * POINTS_PER_USD;

  return {
    referral_code: referralCode,
    referred_users_count: referrals,
    referral_earnings_total: earningsAtomics,
    referral_earnings_usd: earningsUsd,
    reward_credits_usd: rewardCreditsUsd,
    reward_credits_count: Number(rewardRow?.reward_count || 0),
    position,
    total_members: Number(total || 0),
    score,
    display_name: user.display_name || user.username || null,
    username: user.username || null,
    member_since: user.created_at,
  };
}
