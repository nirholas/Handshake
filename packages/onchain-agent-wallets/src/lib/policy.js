// The guardrail engine.
//
// Two layers protect the owner, and they are independent on purpose:
//
//   1. On-chain. The SPL Token program caps the agent's delegated amount on the
//      vault account. Nothing this file does can raise that ceiling, and the
//      owner can drop it to zero with a single revoke.
//   2. Local. This file decides whether a spend that WOULD be allowed on-chain
//      is allowed by the owner's rules: per-transaction cap, rolling daily cap,
//      recipient allowlist, x402 host allowlist, expiry, pause, and a
//      confirm-above threshold that forces a human yes.
//
// Every decision, allow or deny, is returned with the full list of checks so
// the caller can show its work and so the ledger records why.

import { fromBaseUnits, toBaseUnits, toPublicKey } from './solana.js';

export const DEFAULT_POLICY = {
	per_tx: null,
	daily: null,
	allow_recipients: [],
	allow_hosts: [],
	expires_at: null,
	confirm_over: null,
	paused: false,
};

/** Normalize and validate a partial policy patch. Throws on anything malformed. */
export function normalizePolicy(patch = {}, base = DEFAULT_POLICY) {
	const next = { ...DEFAULT_POLICY, ...base };

	for (const key of ['per_tx', 'daily', 'confirm_over']) {
		if (!(key in patch)) continue;
		const raw = patch[key];
		if (raw === null || raw === '' || raw === undefined) {
			next[key] = null;
			continue;
		}
		const s = String(raw).trim();
		if (!/^\d*(\.\d+)?$/.test(s) || s === '') {
			throw Object.assign(new Error(`${key} must be a positive decimal amount (got "${raw}")`), {
				code: 'bad_policy',
			});
		}
		next[key] = s;
	}

	if ('allow_recipients' in patch) {
		const list = patch.allow_recipients ?? [];
		if (!Array.isArray(list)) {
			throw Object.assign(new Error('allow_recipients must be an array of Solana addresses'), { code: 'bad_policy' });
		}
		next.allow_recipients = list.map((a) => toPublicKey(a, 'allow_recipients entry').toBase58());
	}

	if ('allow_hosts' in patch) {
		const list = patch.allow_hosts ?? [];
		if (!Array.isArray(list)) {
			throw Object.assign(new Error('allow_hosts must be an array of hostnames'), { code: 'bad_policy' });
		}
		next.allow_hosts = list.map((h) => normalizeHost(h));
	}

	if ('expires_at' in patch) {
		const raw = patch.expires_at;
		if (raw === null || raw === '' || raw === undefined) {
			next.expires_at = null;
		} else {
			const t = new Date(raw);
			if (Number.isNaN(t.getTime())) {
				throw Object.assign(new Error(`expires_at must be an ISO timestamp (got "${raw}")`), { code: 'bad_policy' });
			}
			next.expires_at = t.toISOString();
		}
	}

	if ('paused' in patch) next.paused = Boolean(patch.paused);

	if (next.per_tx && next.daily && Number(next.per_tx) > Number(next.daily)) {
		throw Object.assign(
			new Error(`per_tx (${next.per_tx}) cannot exceed daily (${next.daily}): the daily cap would never be reachable`),
			{ code: 'bad_policy' },
		);
	}

	return next;
}

/** Accept a bare hostname or any URL and return the lowercase hostname. */
export function normalizeHost(value) {
	const raw = String(value || '').trim().toLowerCase();
	if (!raw) throw Object.assign(new Error('host cannot be empty'), { code: 'bad_policy' });
	const withScheme = raw.includes('://') ? raw : `https://${raw}`;
	let u;
	try {
		u = new URL(withScheme);
	} catch {
		throw Object.assign(new Error(`not a valid host or URL: "${value}"`), { code: 'bad_policy' });
	}
	if (!u.hostname) throw Object.assign(new Error(`not a valid host or URL: "${value}"`), { code: 'bad_policy' });
	return u.hostname;
}

/** An allowlisted host covers its subdomains: "example.com" matches "api.example.com". */
function hostAllowed(list, host) {
	return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Decide a single spend.
 *
 * @param {object} input
 * @param {object} input.policy            normalized policy
 * @param {bigint} input.amount            spend amount in base units
 * @param {number} input.decimals          mint decimals
 * @param {bigint} input.spentToday        base units already spent in the rolling window
 * @param {bigint} input.remainingAllowance live on-chain delegated amount left
 * @param {string} [input.recipient]       destination address, for direct transfers
 * @param {string} [input.host]            resource hostname, for x402 calls
 * @param {boolean} [input.confirm]        the caller passed confirm:true
 * @param {Date}   [input.now]
 * @returns {{allowed: boolean, requires_confirm: boolean, code: string|null, reason: string|null, checks: object[]}}
 */
export function evaluateSpend({
	policy,
	amount,
	decimals,
	spentToday = 0n,
	remainingAllowance = null,
	recipient,
	host,
	confirm = false,
	now = new Date(),
}) {
	const checks = [];
	const human = (units) => fromBaseUnits(units, decimals);
	let denial = null;

	const check = (name, ok, detail, code) => {
		checks.push({ check: name, ok, detail });
		if (!ok && !denial) denial = { code, reason: detail };
	};

	check('paused', !policy.paused, policy.paused ? 'the wallet is paused by the owner' : 'wallet is active', 'paused');

	const expired = policy.expires_at ? new Date(policy.expires_at).getTime() <= now.getTime() : false;
	check(
		'expiry',
		!expired,
		policy.expires_at
			? expired
				? `the delegation expired at ${policy.expires_at}`
				: `valid until ${policy.expires_at}`
			: 'no expiry set',
		'expired',
	);

	check('amount', amount > 0n, amount > 0n ? `spending ${human(amount)}` : 'amount must be greater than zero', 'bad_amount');

	if (policy.per_tx) {
		const cap = toBaseUnits(policy.per_tx, decimals);
		check(
			'per_tx',
			amount <= cap,
			amount <= cap
				? `${human(amount)} is within the ${policy.per_tx} per-transaction cap`
				: `${human(amount)} exceeds the ${policy.per_tx} per-transaction cap`,
			'over_per_tx',
		);
	} else {
		checks.push({ check: 'per_tx', ok: true, detail: 'no per-transaction cap set' });
	}

	if (policy.daily) {
		const cap = toBaseUnits(policy.daily, decimals);
		const after = spentToday + amount;
		check(
			'daily',
			after <= cap,
			after <= cap
				? `${human(after)} of ${policy.daily} used in the last 24h after this spend`
				: `${human(after)} would exceed the ${policy.daily} daily cap (${human(spentToday)} already spent)`,
			'over_daily',
		);
	} else {
		checks.push({ check: 'daily', ok: true, detail: 'no daily cap set' });
	}

	if (remainingAllowance !== null) {
		check(
			'onchain_allowance',
			amount <= remainingAllowance,
			amount <= remainingAllowance
				? `${human(remainingAllowance)} of on-chain allowance remains`
				: `${human(amount)} exceeds the ${human(remainingAllowance)} the token program still allows`,
			'over_allowance',
		);
	}

	if (recipient) {
		const list = policy.allow_recipients || [];
		const ok = list.length === 0 || list.includes(recipient);
		check(
			'recipient',
			ok,
			list.length === 0
				? 'recipients unrestricted'
				: ok
					? `${recipient} is on the recipient allowlist`
					: `${recipient} is not on the recipient allowlist (${list.length} allowed)`,
			'recipient_not_allowed',
		);
	}

	if (host) {
		const list = policy.allow_hosts || [];
		const ok = list.length === 0 || hostAllowed(list, host);
		check(
			'host',
			ok,
			list.length === 0
				? 'hosts unrestricted'
				: ok
					? `${host} is on the host allowlist`
					: `${host} is not on the host allowlist (${list.join(', ')})`,
			'host_not_allowed',
		);
	}

	let requires_confirm = false;
	if (policy.confirm_over !== null && policy.confirm_over !== undefined) {
		const threshold = toBaseUnits(policy.confirm_over, decimals);
		if (amount > threshold && !confirm) {
			requires_confirm = true;
			checks.push({
				check: 'confirm_over',
				ok: false,
				detail: `${human(amount)} is above the ${policy.confirm_over} confirm threshold: re-issue with confirm:true`,
			});
		} else {
			checks.push({
				check: 'confirm_over',
				ok: true,
				detail: amount > threshold ? 'confirmed by the caller' : `at or below the ${policy.confirm_over} threshold`,
			});
		}
	}

	if (denial) return { allowed: false, requires_confirm: false, ...denial, checks };
	if (requires_confirm) {
		return {
			allowed: false,
			requires_confirm: true,
			code: 'needs_confirmation',
			reason: `this spend is above the ${policy.confirm_over} confirm threshold. Re-issue the call with confirm:true.`,
			checks,
		};
	}
	return { allowed: true, requires_confirm: false, code: null, reason: null, checks };
}

/** Sum of allowed spends inside the rolling window, in base units. */
export function spentInWindow(ledger, { hours = 24, now = new Date() } = {}) {
	const cutoff = now.getTime() - hours * 3600 * 1000;
	return ledger
		.filter((row) => row.allowed && row.base_units && new Date(row.at).getTime() >= cutoff)
		.reduce((sum, row) => sum + BigInt(row.base_units), 0n);
}
