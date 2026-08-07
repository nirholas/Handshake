import { beforeEach, describe, expect, it } from "vitest";
import { SpendGuard } from "../src/core/SpendGuard.js";
const AGENT = "agt_test";
function fixedClock(start = 17e11) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    }
  };
}
function makeTx(overrides = {}) {
  return { agentId: AGENT, valueUsd: 100, ...overrides };
}
function makeGuard(config, clock = fixedClock()) {
  return { guard: new SpendGuard(config, { now: clock.now }), clock };
}
describe("SpendGuard", () => {
  describe("per-tx maximum", () => {
    let guard;
    beforeEach(() => {
      guard = new SpendGuard({ perTxMaxUsd: 1e3 });
    });
    it("allows a transaction at the per-tx limit", () => {
      const result = guard.check(makeTx({ valueUsd: 1e3 }));
      expect(result.allowed).toBe(true);
    });
    it("blocks a transaction over the per-tx max with a deterministic reason", () => {
      const result = guard.check(makeTx({ valueUsd: 1500 }));
      expect(result.allowed).toBe(false);
      expect(result.code).toBe("CAP_PER_TX");
      expect(result.reason).toBe(
        "Transaction $1,500 exceeds per-transaction maximum of $1,000"
      );
    });
    it("is deterministic - identical inputs yield identical results", () => {
      const a = guard.check(makeTx({ valueUsd: 2e3 }));
      const b = guard.check(makeTx({ valueUsd: 2e3 }));
      expect(a).toEqual(b);
    });
  });
  describe("rolling spend cap", () => {
    it("blocks the next tx once cumulative spend crosses the rolling cap", () => {
      const { guard } = makeGuard({ rollingMaxUsd: 1e3 });
      guard.recordSpend(AGENT, 500);
      guard.recordSpend(AGENT, 300);
      expect(guard.check(makeTx({ valueUsd: 150 })).allowed).toBe(true);
      const blocked = guard.check(makeTx({ valueUsd: 300 }));
      expect(blocked.allowed).toBe(false);
      expect(blocked.code).toBe("CAP_ROLLING");
      expect(blocked.remainingRollingUsd).toBe(0);
    });
    it("slides the window - old spend outside the window no longer counts", () => {
      const { guard, clock } = makeGuard({ rollingMaxUsd: 1e3, rollingWindowMs: 6e4 });
      guard.recordSpend(AGENT, 900);
      expect(guard.check(makeTx({ valueUsd: 200 })).allowed).toBe(false);
      clock.advance(60001);
      expect(guard.check(makeTx({ valueUsd: 200 })).allowed).toBe(true);
    });
    it("enforces the daily (rolling 24h) cap independently", () => {
      const { guard } = makeGuard({ dailyMaxUsd: 5e3 });
      guard.recordSpend(AGENT, 4900);
      const blocked = guard.check(makeTx({ valueUsd: 200 }));
      expect(blocked.allowed).toBe(false);
      expect(blocked.code).toBe("CAP_DAILY");
    });
    it("tracks spend per agent, not globally", () => {
      const { guard } = makeGuard({ rollingMaxUsd: 1e3 });
      guard.recordSpend("agt_a", 900);
      expect(guard.check(makeTx({ agentId: "agt_b", valueUsd: 900 })).allowed).toBe(true);
      expect(guard.check(makeTx({ agentId: "agt_a", valueUsd: 900 })).allowed).toBe(false);
    });
  });
  describe("reserve floor", () => {
    let guard;
    beforeEach(() => {
      guard = new SpendGuard({ reserveFloorUsd: 1e3 });
    });
    it("allows a tx that leaves the balance at the floor", () => {
      const result = guard.check(makeTx({ balanceUsd: 1500, valueUsd: 500 }));
      expect(result.allowed).toBe(true);
    });
    it("blocks a tx that would drain below the reserve floor", () => {
      const result = guard.check(makeTx({ balanceUsd: 1200, valueUsd: 500 }));
      expect(result.allowed).toBe(false);
      expect(result.code).toBe("RESERVE_FLOOR");
    });
    it("cannot enforce the floor without a balance (passes through)", () => {
      const result = guard.check(makeTx({ valueUsd: 5e3 }));
      expect(result.allowed).toBe(true);
    });
  });
  describe("token/target firewall", () => {
    it("blocks a destination on the deny list", () => {
      const guard = new SpendGuard({
        firewall: { denyDestinations: ["0xBADACTOR"] }
      });
      const result = guard.check(makeTx({ destination: "0xbadactor", valueUsd: 10 }));
      expect(result.allowed).toBe(false);
      expect(result.code).toBe("FIREWALL_DENY_DEST");
    });
    it("blocks a token on the deny list (case-insensitive)", () => {
      const guard = new SpendGuard({ firewall: { denyTokens: ["scam"] } });
      const result = guard.check(makeTx({ token: "SCAM", valueUsd: 10 }));
      expect(result.allowed).toBe(false);
      expect(result.code).toBe("FIREWALL_DENY_TOKEN");
    });
    it("blocks an off-allowlist destination in strict mode", () => {
      const guard = new SpendGuard({
        firewall: { allowDestinations: ["0xsafe"], strictMode: true }
      });
      expect(guard.check(makeTx({ destination: "0xSAFE", valueUsd: 10 })).allowed).toBe(true);
      const blocked = guard.check(makeTx({ destination: "0xunknown", valueUsd: 10 }));
      expect(blocked.allowed).toBe(false);
      expect(blocked.code).toBe("FIREWALL_NOT_ALLOWED");
    });
    it("blocks an off-allowlist token in strict mode", () => {
      const guard = new SpendGuard({
        firewall: { allowTokens: ["USDC"], strictMode: true }
      });
      expect(guard.check(makeTx({ token: "usdc", valueUsd: 10 })).allowed).toBe(true);
      expect(guard.check(makeTx({ token: "PEPE", valueUsd: 10 })).allowed).toBe(false);
    });
    it("does not enforce the allowlist when strict mode is off", () => {
      const guard = new SpendGuard({
        firewall: { allowTokens: ["USDC"], strictMode: false }
      });
      expect(guard.check(makeTx({ token: "PEPE", valueUsd: 10 })).allowed).toBe(true);
    });
    it("deny takes precedence over allow", () => {
      const guard = new SpendGuard({
        firewall: { allowTokens: ["USDC"], denyTokens: ["USDC"], strictMode: true }
      });
      const result = guard.check(makeTx({ token: "USDC", valueUsd: 10 }));
      expect(result.allowed).toBe(false);
      expect(result.code).toBe("FIREWALL_DENY_TOKEN");
    });
  });
  describe("custody reconciliation", () => {
    it("flags a breach and latches the agent when on-chain outflow exceeds the ledger", () => {
      const { guard } = makeGuard({ perTxMaxUsd: 1e4 });
      expect(guard.check(makeTx({ valueUsd: 100 })).allowed).toBe(true);
      const recon = guard.reconcile(AGENT, {
        ledgerRecordedUsd: 5e3,
        onChainOutflowUsd: 7500
      });
      expect(recon.breach).toBe(true);
      expect(recon.unrecordedUsd).toBe(2500);
      expect(guard.isTripped(AGENT)).toBe(true);
      const blocked = guard.check(makeTx({ valueUsd: 100 }));
      expect(blocked.allowed).toBe(false);
      expect(blocked.code).toBe("BREACH");
    });
    it("does not flag a breach when the chain matches the ledger within tolerance", () => {
      const { guard } = makeGuard({ breachTolerance: 0.01 });
      const recon = guard.reconcile(AGENT, {
        ledgerRecordedUsd: 5e3,
        onChainOutflowUsd: 5040
        // within 1% tolerance
      });
      expect(recon.breach).toBe(false);
      expect(guard.isTripped(AGENT)).toBe(false);
    });
    it("reconciles via an injected ledger reader", async () => {
      const { guard } = makeGuard({});
      const recon = await guard.reconcileFromLedger(
        AGENT,
        async () => ({ ledgerRecordedUsd: 1e3, onChainOutflowUsd: 3e3 }),
        "user_1"
      );
      expect(recon.breach).toBe(true);
      expect(guard.isTripped(AGENT)).toBe(true);
    });
    it("reset() clears the breach latch", () => {
      const { guard } = makeGuard({});
      guard.reconcile(AGENT, { ledgerRecordedUsd: 0, onChainOutflowUsd: 500 });
      expect(guard.isTripped(AGENT)).toBe(true);
      guard.reset(AGENT);
      expect(guard.isTripped(AGENT)).toBe(false);
      expect(guard.check(makeTx({ valueUsd: 100 })).allowed).toBe(true);
    });
  });
  describe("envelope composition", () => {
    it("allows a tx that satisfies every configured limit", () => {
      const { guard } = makeGuard({
        dailyMaxUsd: 1e4,
        firewall: { allowTokens: ["USDC"], strictMode: true },
        perTxMaxUsd: 1e3,
        reserveFloorUsd: 500,
        rollingMaxUsd: 5e3
      });
      const result = guard.check(
        makeTx({ balanceUsd: 5e3, token: "USDC", valueUsd: 800 })
      );
      expect(result.allowed).toBe(true);
      expect(result.remainingRollingUsd).toBe(4200);
      expect(result.remainingDailyUsd).toBe(9200);
    });
    it("seeds the rolling window from a persisted ledger total", () => {
      const { guard } = makeGuard({ rollingMaxUsd: 1e3 });
      guard.syncSpendFromLedger(AGENT, 950);
      expect(guard.check(makeTx({ valueUsd: 100 })).allowed).toBe(false);
      expect(guard.windowSpend(AGENT, 24 * 60 * 60 * 1e3)).toBe(950);
    });
  });
});
