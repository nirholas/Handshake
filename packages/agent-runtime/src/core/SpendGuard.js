/**
 * SpendGuard - Per-Agent Spend Envelope + Token/Target Firewall + Custody Reconciliation
 *
 * The quantitative money-safety layer that `PermissionGuard`, `CapabilityGuard`, and
 * `DeFiGuard` do not encode. Where `DeFiGuard` scores *risk* and enforces *per-user tier*
 * limits, `SpendGuard` enforces a hard **per-agent spend envelope**:
 *
 *  1. **Per-tx maximum** - a single outflow may never exceed `perTxMaxUsd`.
 *  2. **Rolling / daily caps** - cumulative outflow over a rolling window (default 24h) may
 *     never exceed `rollingMaxUsd` / `dailyMaxUsd`. This is a true sliding window, not a
 *     calendar-day bucket.
 *  3. **Reserve floor** - a transaction may not drain the agent wallet below `reserveFloorUsd`.
 *  4. **Token/target firewall** - an allow/deny layer keyed by token *and* destination, with a
 *     strict mode that blocks anything not on the allowlist.
 *  5. **Custody reconciliation** - sums the *actual* on-chain outflow (independently observed)
 *     against the outflow the agent *recorded* in the Task 03 tamper-evident ledger; if the
 *     chain moved more than the ledger recorded, that is a breach (key-compromise signal) and
 *     the guard **latches shut** for that agent until explicitly reset.
 *
 * Ported from three.ws `economy-master.js` (reserve/per-run/per-target guards + registry
 * allowlist). The Solana multi-wallet funding topology is intentionally NOT ported - only the
 * guard envelope. Custody here is EVM (Plutus ERC-4337).
 *
 * ── Design contract ──
 * - **Pure & deterministic.** `check()` has no side effects and, for a fixed clock, always
 *   returns the same decision for the same inputs (runtime rule #4). Spend is only mutated by
 *   the explicit `recordSpend()` call, made *after* a transaction actually lands.
 * - **DB-agnostic.** Per-agent config is resolved server-side (from `agent_spend_limits`) and
 *   passed in; the ledger totals for reconciliation are injected via a `SpendLedgerReader`.
 *   The runtime package never imports the database, exactly like `PermissionGuard`.
 */
import { debuglog } from 'node:util';
const log = debuglog('three-ws-agent-runtime-spend-guard');
const DEFAULT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Absolute USD epsilon to absorb float noise in comparisons. */
const USD_EPSILON = 0.01;
function usd(n) {
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
function normToken(t) {
    return (t ?? '').trim().toUpperCase();
}
function normAddr(a) {
    return (a ?? '').trim().toLowerCase();
}
// ============================================================================
// SpendGuard
// ============================================================================
export class SpendGuard {
    config;
    denyTokens;
    allowTokens;
    denyDests;
    allowDests;
    now;
    /** Per-agent rolling spend log (agentId → entries). */
    spendLog = new Map();
    /** Per-agent breach latch. Once set, every check for that agent is blocked. */
    tripped = new Map();
    /**
     * @param config Per-agent spend envelope, resolved server-side from `agent_spend_limits`.
     * @param opts.now Injectable clock (defaults to `Date.now`) - keeps rolling-window tests
     *   deterministic without touching real time.
     */
    constructor(config = {}, opts = {}) {
        this.config = config;
        this.now = opts.now ?? (() => Date.now());
        const fw = config.firewall ?? {};
        this.denyTokens = new Set((fw.denyTokens ?? []).map(normToken));
        this.allowTokens = new Set((fw.allowTokens ?? []).map(normToken));
        this.denyDests = new Set((fw.denyDestinations ?? []).map(normAddr));
        this.allowDests = new Set((fw.allowDestinations ?? []).map(normAddr));
    }
    // ── Core check ───────────────────────────────────────────────────────────
    /**
     * Evaluate a single outflow against the full envelope. Pure - no state mutation.
     *
     * Order is fixed (hardest / most-specific block first) so the returned code is deterministic:
     * breach latch → firewall deny → firewall strict allowlist → per-tx cap → reserve floor →
     * rolling cap → daily cap.
     */
    check(tx) {
        // 0. Breach latch - a reconciliation breach blocks everything until reset.
        const trip = this.tripped.get(tx.agentId);
        if (trip) {
            return { allowed: false, code: trip.code, reason: trip.reason };
        }
        const token = normToken(tx.token);
        const dest = normAddr(tx.destination);
        const fw = this.config.firewall;
        // 1. Firewall deny lists (always enforced).
        if (token && this.denyTokens.has(token)) {
            return {
                allowed: false,
                code: 'FIREWALL_DENY_TOKEN',
                reason: `Token ${token} is on the deny firewall for this agent`,
            };
        }
        if (dest && this.denyDests.has(dest)) {
            return {
                allowed: false,
                code: 'FIREWALL_DENY_DEST',
                reason: `Destination ${dest} is on the deny firewall for this agent`,
            };
        }
        // 2. Firewall strict allowlist - anything not explicitly allowed is blocked.
        if (fw?.strictMode) {
            if (this.allowTokens.size > 0 && !(token && this.allowTokens.has(token))) {
                return {
                    allowed: false,
                    code: 'FIREWALL_NOT_ALLOWED',
                    reason: `Token ${token || '(unknown)'} is not on the strict-mode allowlist`,
                };
            }
            if (this.allowDests.size > 0 && !(dest && this.allowDests.has(dest))) {
                return {
                    allowed: false,
                    code: 'FIREWALL_NOT_ALLOWED',
                    reason: `Destination ${dest || '(unknown)'} is not on the strict-mode allowlist`,
                };
            }
        }
        // 3. Per-transaction maximum.
        if (this.config.perTxMaxUsd != null && tx.valueUsd > this.config.perTxMaxUsd + USD_EPSILON) {
            return {
                allowed: false,
                code: 'CAP_PER_TX',
                reason: `Transaction ${usd(tx.valueUsd)} exceeds per-transaction maximum of ${usd(this.config.perTxMaxUsd)}`,
            };
        }
        // 4. Reserve floor - must not drain the wallet below the configured minimum.
        if (this.config.reserveFloorUsd != null &&
            tx.balanceUsd != null &&
            tx.balanceUsd - tx.valueUsd < this.config.reserveFloorUsd - USD_EPSILON) {
            return {
                allowed: false,
                code: 'RESERVE_FLOOR',
                reason: `Transaction ${usd(tx.valueUsd)} would drain balance ${usd(tx.balanceUsd)} below the reserve floor of ${usd(this.config.reserveFloorUsd)}`,
            };
        }
        // 5. Rolling-window cap.
        let remainingRollingUsd;
        if (this.config.rollingMaxUsd != null) {
            const windowMs = this.config.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;
            const spent = this.windowSpend(tx.agentId, windowMs);
            remainingRollingUsd = Math.max(0, this.config.rollingMaxUsd - spent - tx.valueUsd);
            if (spent + tx.valueUsd > this.config.rollingMaxUsd + USD_EPSILON) {
                return {
                    allowed: false,
                    code: 'CAP_ROLLING',
                    reason: `Transaction ${usd(tx.valueUsd)} would exceed the rolling spend cap of ${usd(this.config.rollingMaxUsd)} (already spent ${usd(spent)} in the last ${Math.round(windowMs / 3_600_000)}h)`,
                    remainingRollingUsd,
                };
            }
        }
        // 6. Daily (rolling 24h) cap.
        let remainingDailyUsd;
        if (this.config.dailyMaxUsd != null) {
            const spent = this.windowSpend(tx.agentId, DAILY_WINDOW_MS);
            remainingDailyUsd = Math.max(0, this.config.dailyMaxUsd - spent - tx.valueUsd);
            if (spent + tx.valueUsd > this.config.dailyMaxUsd + USD_EPSILON) {
                return {
                    allowed: false,
                    code: 'CAP_DAILY',
                    reason: `Transaction ${usd(tx.valueUsd)} would exceed the daily spend cap of ${usd(this.config.dailyMaxUsd)} (already spent ${usd(spent)} today)`,
                    remainingDailyUsd,
                };
            }
        }
        return {
            allowed: true,
            reason: 'Within spend envelope',
            remainingDailyUsd,
            remainingRollingUsd,
        };
    }
    // ── Spend recording ────────────────────────────────────────────────────────
    /**
     * Record an outflow that actually landed. Call this AFTER a transaction succeeds so the
     * rolling/daily windows stay live within a multi-step plan. Never call it for a blocked or
     * failed transaction.
     */
    recordSpend(agentId, valueUsd, ts = this.now()) {
        if (!agentId || !(valueUsd > 0))
            return;
        const entries = this.spendLog.get(agentId) ?? [];
        entries.push({ ts, valueUsd });
        this.spendLog.set(agentId, entries);
        // Opportunistically prune anything older than the widest window we track.
        this.prune(agentId, Math.max(this.config.rollingWindowMs ?? 0, DAILY_WINDOW_MS));
    }
    /**
     * Seed the rolling window from a persisted total (e.g. confirmed outflow summed from the
     * ledger) so the in-memory tracker survives a cold start. Recorded as a single entry at the
     * current time; only raises the tracked total, never lowers it.
     */
    syncSpendFromLedger(agentId, confirmedRollingUsd, windowMs) {
        if (!agentId || !(confirmedRollingUsd > 0))
            return;
        const w = windowMs ?? this.config.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;
        const current = this.windowSpend(agentId, w);
        const delta = confirmedRollingUsd - current;
        if (delta > 0)
            this.recordSpend(agentId, delta);
    }
    /** Cumulative recorded spend for an agent over the last `windowMs`. */
    windowSpend(agentId, windowMs) {
        const entries = this.spendLog.get(agentId);
        if (!entries || entries.length === 0)
            return 0;
        const cutoff = this.now() - windowMs;
        let total = 0;
        for (const e of entries) {
            if (e.ts >= cutoff)
                total += e.valueUsd;
        }
        return total;
    }
    /** Remaining allowance under the daily cap for an agent (Infinity if uncapped). */
    remainingDaily(agentId) {
        if (this.config.dailyMaxUsd == null)
            return Infinity;
        return Math.max(0, this.config.dailyMaxUsd - this.windowSpend(agentId, DAILY_WINDOW_MS));
    }
    // ── Reconciliation / custody audit ──────────────────────────────────────────
    /**
     * Compare recorded vs. observed outflow. If the chain moved more than the ledger recorded
     * (beyond `breachTolerance`), the agent is **latched shut**: every subsequent `check()`
     * returns a `BREACH` block until `reset(agentId)` is called. This is the key-compromise
     * signal from the source `economy-reconcile` cron.
     */
    reconcile(agentId, figures) {
        const tolerance = this.config.breachTolerance ?? 0;
        const ceiling = figures.ledgerRecordedUsd * (1 + tolerance);
        const unrecorded = figures.onChainOutflowUsd - figures.ledgerRecordedUsd;
        if (figures.onChainOutflowUsd > ceiling + Math.max(USD_EPSILON, 0)) {
            const reason = `Custody breach: on-chain outflow ${usd(figures.onChainOutflowUsd)} exceeds ledger-recorded outflow ${usd(figures.ledgerRecordedUsd)} by ${usd(unrecorded)} - agent spending latched until reviewed`;
            this.tripped.set(agentId, { code: 'BREACH', reason });
            log('BREACH agent=%s unrecorded=%d', agentId, unrecorded);
            return { breach: true, reason, unrecordedUsd: unrecorded };
        }
        return {
            breach: false,
            reason: 'On-chain outflow matches recorded ledger within tolerance',
            unrecordedUsd: Math.max(0, unrecorded),
        };
    }
    /** Reconcile using an injected ledger reader (e.g. wired to the Task 03 ledger). */
    async reconcileFromLedger(agentId, reader, userId) {
        const figures = await reader({ agentId, userId });
        return this.reconcile(agentId, figures);
    }
    /** Whether an agent is currently latched shut by a breach. */
    isTripped(agentId) {
        return this.tripped.has(agentId);
    }
    // ── Lifecycle ───────────────────────────────────────────────────────────────
    /** Clear the breach latch and spend window for an agent (or all agents if omitted). */
    reset(agentId) {
        if (agentId) {
            this.tripped.delete(agentId);
            this.spendLog.delete(agentId);
        }
        else {
            this.tripped.clear();
            this.spendLog.clear();
        }
    }
    prune(agentId, windowMs) {
        const entries = this.spendLog.get(agentId);
        if (!entries)
            return;
        const cutoff = this.now() - windowMs;
        const kept = entries.filter((e) => e.ts >= cutoff);
        if (kept.length !== entries.length)
            this.spendLog.set(agentId, kept);
    }
}
