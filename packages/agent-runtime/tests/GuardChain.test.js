import { describe, expect, it, vi } from "vitest";
import { TradeGuard } from "../src/core/TradeGuard.js";
import {
  GUARD_LAYER_ORDER,
  GuardChain,
  analyzeGuardCoverage,
  guardLayerLabel,
  guardLayerWeight
} from "../src/core/GuardChain.js";
import { SpendGuard } from "../src/core/SpendGuard.js";
import { createX402Hook } from "../src/core/X402Hook.js";
const FIXED_NOW = 17e11;
function tickingClock() {
  let t = 0;
  return () => t += 1;
}
function makeChain(options = {}) {
  return new GuardChain({ clock: tickingClock(), now: () => FIXED_NOW, ...options });
}
function req(overrides = {}) {
  return {
    apiName: "executeSwap",
    arguments: { chainId: 1, fromToken: "ETH", toToken: "USDC" },
    identifier: "solana_swap",
    ...overrides
  };
}
function layer(verdict, id) {
  return verdict.layers.find((l) => l.layer === id);
}
describe("GuardChain", () => {
  describe("trace", () => {
    it("emits one result per layer, in declared order", async () => {
      const verdict = await makeChain().evaluate(req());
      expect(verdict.layers.map((l) => l.layer)).toEqual(GUARD_LAYER_ORDER);
    });
    it("runs every layer to completion rather than short-circuiting on a block", async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: false, reason: "no token" }),
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 10 })
      });
      const verdict = await chain.evaluate(req({ valueUsd: 5e3 }));
      expect(layer(verdict, "capability").status).toBe("block");
      expect(layer(verdict, "spend_guard").status).toBe("block");
      expect(layer(verdict, "spend_guard").code).toBe("CAP_PER_TX");
    });
    it("labels every layer with a renderable name", async () => {
      const verdict = await makeChain().evaluate(req());
      for (const result of verdict.layers) {
        expect(result.label).toBe(guardLayerLabel(result.layer));
        expect(result.label.length).toBeGreaterThan(0);
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });
    it("stamps evaluatedAt from the injected clock", async () => {
      const verdict = await makeChain().evaluate(req());
      expect(verdict.evaluatedAt).toBe(FIXED_NOW);
    });
  });
  describe("verdict", () => {
    it("allows a call that clears every applicable layer", async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true, level: "autonomous" }),
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 })
      });
      const verdict = await chain.evaluate(req({ valueUsd: 500 }));
      expect(verdict.decision).toBe("allow");
      expect(verdict.blockedBy).toBeUndefined();
    });
    it("escalates to block when any layer blocks, naming the layer", async () => {
      const chain = makeChain({ spendGuard: new SpendGuard({ perTxMaxUsd: 100 }) });
      const verdict = await chain.evaluate(req({ valueUsd: 5e3 }));
      expect(verdict.decision).toBe("block");
      expect(verdict.blockedBy).toBe("spend_guard");
      expect(verdict.code).toBe("CAP_PER_TX");
      expect(verdict.reason).toContain("Spend Envelope");
    });
    it("prefers a block over a concurrent approval_required", async () => {
      const chain = makeChain({
        checkPermission: async () => ({ allowed: false, level: "approval-required" }),
        spendGuard: new SpendGuard({ perTxMaxUsd: 100 })
      });
      const verdict = await chain.evaluate(req({ valueUsd: 5e3 }));
      expect(verdict.decision).toBe("block");
      expect(verdict.blockedBy).toBe("spend_guard");
    });
    it("reports require_approval when the strongest outcome is an approval gate", async () => {
      const chain = makeChain({
        checkPermission: async () => ({ allowed: false, level: "approval-required" })
      });
      const verdict = await chain.evaluate(req({ valueUsd: 100 }));
      expect(verdict.decision).toBe("require_approval");
      expect(verdict.blockedBy).toBeUndefined();
    });
    it("breaks ties toward the earlier layer, matching runtime firing order", async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: false, reason: "capability first" }),
        checkPermission: async () => ({ allowed: false, level: "forbidden" })
      });
      const verdict = await chain.evaluate(req());
      expect(verdict.blockedBy).toBe("capability");
    });
  });
  describe("intervention layers", () => {
    it("blocks on the runtime default blacklist when none is supplied", async () => {
      const verdict = await makeChain().evaluate(
        req({ apiName: "bash", arguments: { command: "rm -rf /" }, identifier: "bash" })
      );
      expect(layer(verdict, "security_blacklist").status).toBe("block");
      expect(layer(verdict, "security_blacklist").code).toBe("SECURITY_BLACKLIST");
      expect(verdict.decision).toBe("block");
    });
    it("honours an explicitly supplied blacklist", async () => {
      const verdict = await makeChain().evaluate(
        req({
          apiName: "transferAll",
          arguments: { destination: "0xdeadbeef" },
          identifier: "agent-wallet",
          securityBlacklist: [
            { description: "Known drainer address", match: { destination: "0xdead*" } }
          ]
        })
      );
      expect(layer(verdict, "security_blacklist").status).toBe("block");
      expect(layer(verdict, "security_blacklist").reason).toContain("drainer");
    });
    it("notes that headless mode skips blacklisted tools instead of surfacing them", async () => {
      const verdict = await makeChain().evaluate(
        req({
          apiName: "bash",
          approvalMode: "headless",
          arguments: { command: "rm -rf /" },
          identifier: "bash"
        })
      );
      expect(layer(verdict, "security_blacklist").reason).toContain("headless");
    });
    it("lets auto-run downgrade a `required` policy", async () => {
      const manual = await makeChain().evaluate(req({ interventionConfig: "required" }));
      const auto = await makeChain().evaluate(
        req({ approvalMode: "auto-run", interventionConfig: "required" })
      );
      expect(layer(manual, "intervention").status).toBe("approval_required");
      expect(layer(auto, "intervention").status).toBe("pass");
    });
    it("never lets an approval mode downgrade an `always` policy", async () => {
      for (const mode of ["auto-run", "headless", "allow-list"]) {
        const verdict = await makeChain().evaluate(
          req({ approvalMode: mode, interventionConfig: "always" })
        );
        expect(layer(verdict, "intervention").status).toBe("approval_required");
      }
    });
    it("honours the session allow list under allow-list mode", async () => {
      const listed = await makeChain().evaluate(
        req({
          allowList: ["solana_swap/executeSwap"],
          approvalMode: "allow-list",
          interventionConfig: "required"
        })
      );
      const absent = await makeChain().evaluate(
        req({ allowList: [], approvalMode: "allow-list", interventionConfig: "required" })
      );
      expect(layer(listed, "intervention").status).toBe("pass");
      expect(layer(absent, "intervention").status).toBe("approval_required");
    });
  });
  describe("capability and permission guards", () => {
    it("marks both as skipped for batched dispatch", async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true })
      });
      const verdict = await chain.evaluate(req({ executionPath: "batch" }));
      expect(layer(verdict, "capability").status).toBe("skipped");
      expect(layer(verdict, "capability").code).toBe("BATCH_BYPASS");
      expect(layer(verdict, "permission").status).toBe("skipped");
    });
    it("does not invoke the injected checkers when batching", async () => {
      const checkCapability = vi.fn().mockResolvedValue({ allowed: true });
      const chain = makeChain({ checkCapability });
      await chain.evaluate(req({ executionPath: "batch" }));
      expect(checkCapability).not.toHaveBeenCalled();
    });
    it("treats notify-and-proceed as a passing warning", async () => {
      const chain = makeChain({
        checkPermission: async () => ({ allowed: true, level: "notify-and-proceed" })
      });
      const verdict = await chain.evaluate(req());
      expect(layer(verdict, "permission").status).toBe("warn");
      expect(verdict.decision).toBe("allow");
      expect(verdict.warnings.some((w) => w.includes("Agent Permission"))).toBe(true);
    });
    it("fails closed when a checker throws", async () => {
      const chain = makeChain({
        checkPermission: async () => {
          throw new Error("permissions service unreachable");
        }
      });
      const verdict = await chain.evaluate(req());
      expect(layer(verdict, "permission").status).toBe("error");
      expect(verdict.decision).toBe("block");
      expect(verdict.reason).toContain("permissions service unreachable");
    });
  });
  describe("defi guard layer", () => {
    it("skips unregistered identifiers and says so explicitly", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(
        req({ identifier: "some-new-tool", valueUsd: 1e3 })
      );
      expect(layer(verdict, "defi_guard").status).toBe("skipped");
      expect(layer(verdict, "defi_guard").code).toBe("NOT_REGISTERED");
    });
    it("requires approval above the auto-execute ceiling", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(req({ userTier: "pro", valueUsd: 5e4 }));
      expect(layer(verdict, "defi_guard").status).toBe("approval_required");
      expect(verdict.decision).toBe("require_approval");
    });
    it("blocks above the tier transaction ceiling", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(req({ userTier: "free", valueUsd: 25e3 }));
      expect(layer(verdict, "defi_guard").status).toBe("block");
      expect(verdict.blockedBy).toBe("defi_guard");
    });
    it("surfaces guard warnings and MEV parameter adjustments on the verdict", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(
        req({ arguments: { chainId: 1, slippage: 3 }, userTier: "pro", valueUsd: 5e4 })
      );
      expect(verdict.warnings.some((w) => w.includes("Slippage reduced"))).toBe(true);
      expect(verdict.modifiedArguments).toMatchObject({ slippage: 1 });
    });
    it("flags an unregistered protocol as unverifiable", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(
        req({ protocol: "uniswap", userTier: "pro", valueUsd: 5e3 })
      );
      expect(verdict.blindSpots.some((s) => s.code === "PROTOCOL_UNVERIFIED")).toBe(true);
    });
  });
  describe("spend envelope layer", () => {
    it("exempts inflow operations from spend caps", async () => {
      const chain = makeChain({ spendGuard: new SpendGuard({ perTxMaxUsd: 1 }) });
      const verdict = await chain.evaluate(
        req({ apiName: "withdraw", identifier: "lending-tool", valueUsd: 5e5 })
      );
      expect(layer(verdict, "spend_guard").status).toBe("skipped");
      expect(layer(verdict, "spend_guard").reason).toContain("exempt");
    });
    it("gates approvals so the firewall can vet the grantee", async () => {
      const chain = makeChain({
        spendGuard: new SpendGuard({
          firewall: { denyDestinations: ["0xbad"] }
        })
      });
      const verdict = await chain.evaluate(
        req({
          apiName: "approve",
          destination: "0xBAD",
          identifier: "token-approvals",
          valueUsd: 0
        })
      );
      expect(layer(verdict, "spend_guard").status).toBe("block");
      expect(layer(verdict, "spend_guard").code).toBe("FIREWALL_DENY_DEST");
    });
    it("skips read-only APIs with a distinct reason", async () => {
      const chain = makeChain({ spendGuard: new SpendGuard({ perTxMaxUsd: 1 }) });
      const verdict = await chain.evaluate(
        req({ apiName: "getQuote", identifier: "solana_swap" })
      );
      expect(layer(verdict, "spend_guard").reason).toContain("Read-only");
    });
  });
  describe("x402 layer", () => {
    const requirements = {
      accepts: [
        {
          asset: "0x1111111111111111111111111111111111111111",
          description: "API access",
          maxAmountRequired: "2000000",
          network: "eip155:8453",
          payTo: "0xfeed",
          resource: "https://api.example.com/data",
          scheme: "exact"
        }
      ],
      x402Version: 1
    };
    it("is skipped when the call is not x402-metered", async () => {
      const chain = makeChain({ x402Hook: createX402Hook() });
      const verdict = await chain.evaluate(req());
      expect(layer(verdict, "x402").status).toBe("skipped");
    });
    it("passes a payment inside the hourly budget", async () => {
      const chain = makeChain({ x402Hook: createX402Hook(5) });
      const verdict = await chain.evaluate(
        req({
          x402: {
            amountSpentThisHourUsdc: 0,
            currentBalanceUsdc: 100,
            requirements,
            url: "https://api.example.com/data"
          }
        })
      );
      expect(layer(verdict, "x402").status).toBe("pass");
    });
    it("queues a payment that would exceed the hourly budget", async () => {
      const chain = makeChain({ x402Hook: createX402Hook(5) });
      const verdict = await chain.evaluate(
        req({
          x402: {
            amountSpentThisHourUsdc: 4.5,
            currentBalanceUsdc: 100,
            requirements,
            url: "https://api.example.com/data"
          }
        })
      );
      expect(layer(verdict, "x402").status).toBe("approval_required");
      expect(verdict.decision).toBe("require_approval");
    });
    it("blocks a payment the wallet cannot cover", async () => {
      const chain = makeChain({ x402Hook: createX402Hook(5) });
      const verdict = await chain.evaluate(
        req({
          x402: {
            amountSpentThisHourUsdc: 0,
            currentBalanceUsdc: 0.5,
            requirements,
            url: "https://api.example.com/data"
          }
        })
      );
      expect(layer(verdict, "x402").status).toBe("block");
    });
  });
  describe("blind spots", () => {
    it("flags a registered mutating call with no resolved USD value", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(req({ arguments: { amount: "0.5" } }));
      const spot = verdict.blindSpots.find((s) => s.code === "VALUE_UNRESOLVED");
      expect(spot).toBeDefined();
      expect(spot.severity).toBe("critical");
    });
    it("does not flag VALUE_UNRESOLVED once a value is supplied", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(req({ valueUsd: 1200 }));
      expect(verdict.blindSpots.some((s) => s.code === "VALUE_UNRESOLVED")).toBe(false);
    });
    it("flags a fund-moving tool absent from the DeFi registry", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(
        req({ apiName: "executeSwap", identifier: "community-dex-tool", valueUsd: 9e3 })
      );
      const spot = verdict.blindSpots.find((s) => s.code === "TOOL_UNREGISTERED");
      expect(spot).toBeDefined();
      expect(spot.remediation).toContain("community-dex-tool");
    });
    it("flags batched dispatch as bypassing the decorator guards", async () => {
      const verdict = await makeChain().evaluate(req({ executionPath: "batch" }));
      expect(verdict.blindSpots.some((s) => s.code === "BATCH_BYPASS")).toBe(true);
    });
    it("flags an outflow with no spend envelope attached", async () => {
      const verdict = await makeChain().evaluate(req({ valueUsd: 4e3 }));
      const spot = verdict.blindSpots.find((s) => s.code === "SPEND_UNSCOPED");
      expect(spot).toBeDefined();
      expect(spot.severity).toBe("critical");
    });
    it("does not flag SPEND_UNSCOPED when an envelope is configured", async () => {
      const chain = makeChain({ spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 }) });
      const verdict = await chain.evaluate(req({ valueUsd: 4e3 }));
      expect(verdict.blindSpots.some((s) => s.code === "SPEND_UNSCOPED")).toBe(false);
    });
    it("flags unwired capability and permission checkers", async () => {
      const verdict = await makeChain().evaluate(req());
      expect(verdict.blindSpots.some((s) => s.code === "CAPABILITY_UNWIRED")).toBe(true);
      expect(verdict.blindSpots.some((s) => s.code === "PERMISSION_UNWIRED")).toBe(true);
    });
    it("reports read-only DeFi calls as unanalyzed at info severity", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(req({ apiName: "getQuote" }));
      const spot = verdict.blindSpots.find((s) => s.code === "READONLY_UNANALYZED");
      expect(spot).toBeDefined();
      expect(spot.severity).toBe("info");
    });
    it("orders findings critical-first", async () => {
      const chain = makeChain({ defiGuard: new TradeGuard() });
      const verdict = await chain.evaluate(req({ executionPath: "batch" }));
      const rank = { critical: 0, info: 2, warning: 1 };
      const seq = verdict.blindSpots.map((s) => rank[s.severity]);
      expect(seq).toEqual([...seq].sort((a, b) => a - b));
    });
    it("reports no critical findings for a fully-wired evaluation", async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true, level: "autonomous" }),
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 })
      });
      const verdict = await chain.evaluate(req({ valueUsd: 2500 }));
      expect(verdict.blindSpots.filter((s) => s.severity === "critical")).toEqual([]);
    });
  });
  describe("coverage score", () => {
    it("reports 100 when every applicable layer evaluated the call", async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true, level: "autonomous" }),
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 })
      });
      const verdict = await chain.evaluate(req({ valueUsd: 2500 }));
      expect(verdict.coverageScore).toBe(100);
    });
    it("drops when guards are missing, even though the verdict is allow", async () => {
      const verdict = await makeChain().evaluate(req({ valueUsd: 2500 }));
      expect(verdict.decision).toBe("allow");
      expect(verdict.coverageScore).toBeLessThan(50);
    });
    it("does not penalise a read-only call for skipping the spend envelope", async () => {
      const readOnly = makeChain({
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true }),
        defiGuard: new TradeGuard()
      });
      const verdict = await readOnly.evaluate(req({ apiName: "getQuote" }));
      expect(verdict.coverageScore).toBe(100);
      expect(verdict.blindSpots.some((s) => s.code === "READONLY_UNANALYZED")).toBe(true);
    });
    it('separates "the layer ran" from "the layer checked something"', async () => {
      const chain = makeChain({
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true, level: "autonomous" }),
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 })
      });
      const verdict = await chain.evaluate(req({ arguments: { amount: "0.5" } }));
      expect(verdict.coverageScore).toBe(100);
      expect(verdict.decision).toBe("allow");
      expect(verdict.blindSpots.some((s) => s.code === "VALUE_UNRESOLVED")).toBe(true);
    });
    it("falls when batching removes the decorator guards from the surface", async () => {
      const options = {
        checkCapability: async () => ({ allowed: true }),
        checkPermission: async () => ({ allowed: true, level: "autonomous" }),
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 })
      };
      const single = await makeChain(options).evaluate(req({ valueUsd: 2500 }));
      const batched = await makeChain(options).evaluate(
        req({ executionPath: "batch", valueUsd: 2500 })
      );
      expect(batched.coverageScore).toBeLessThan(single.coverageScore);
    });
  });
  describe("determinism", () => {
    it("returns an identical verdict for identical input", async () => {
      const build = () => makeChain({
        defiGuard: new TradeGuard(),
        spendGuard: new SpendGuard({ perTxMaxUsd: 1e5 })
      });
      const a = await build().evaluate(req({ userTier: "pro", valueUsd: 42e3 }));
      const b = await build().evaluate(req({ userTier: "pro", valueUsd: 42e3 }));
      const strip = (v) => ({
        ...v,
        layers: v.layers.map(({ elapsedMs: _e, detail: _d, ...rest }) => rest),
        totalElapsedMs: 0
      });
      expect(strip(a)).toEqual(strip(b));
    });
  });
});
describe("analyzeGuardCoverage", () => {
  it("reports the registry itself as fully covered when given no argument", () => {
    const report = analyzeGuardCoverage();
    expect(report.coveragePercent).toBe(100);
    expect(report.unregistered).toEqual([]);
    expect(report.registered.length).toBeGreaterThan(0);
  });
  it("separates registered from unregistered identifiers", () => {
    const report = analyzeGuardCoverage(["solana_swap", "unknown-tool"]);
    expect(report.registered.map((e) => e.identifier)).toEqual(["solana_swap"]);
    expect(report.unregistered.map((e) => e.identifier)).toEqual(["unknown-tool"]);
    expect(report.coveragePercent).toBe(50);
  });
  it("deduplicates the supplied identifiers", () => {
    const report = analyzeGuardCoverage(["solana_swap", "solana_swap"]);
    expect(report.registered).toHaveLength(1);
    expect(report.coveragePercent).toBe(100);
  });
  it("lists the mutating API registry", () => {
    const report = analyzeGuardCoverage();
    expect(report.mutatingApis).toContain("executeSwap");
    expect(report.mutatingApis).toEqual([...report.mutatingApis].sort());
  });
  it("treats an empty deployment as fully covered rather than dividing by zero", () => {
    expect(analyzeGuardCoverage([]).coveragePercent).toBe(100);
  });
});
describe("layer metadata", () => {
  it("exposes a label and a positive weight for every layer", () => {
    for (const id of GUARD_LAYER_ORDER) {
      expect(guardLayerLabel(id)).toBeTruthy();
      expect(guardLayerWeight(id)).toBeGreaterThan(0);
    }
  });
  it("weights sum to 100 so the coverage score reads as a percentage", () => {
    const total = GUARD_LAYER_ORDER.reduce((sum, id) => sum + guardLayerWeight(id), 0);
    expect(total).toBe(100);
  });
});
