import { describe, expect, it, vi } from "vitest";
import { SpendGuard } from "../src/core/SpendGuard.js";
import { createSpendPreflight, createSpendRecorder, spendTxFromStep } from "../src/core/spendGuardPipeline.js";
import { TransactionPipeline } from "../src/core/TransactionPipeline.js";
function step(overrides = {}) {
  return {
    action: "swap",
    apiName: "executeSwap",
    args: { amount: 500, toToken: "USDC" },
    dependsOn: [],
    description: "Swap step",
    estimatedGasUsd: 1,
    id: "step_1",
    isSimulation: false,
    requiresApproval: false,
    riskLevel: "low",
    toolIdentifier: "solana_swap",
    ...overrides
  };
}
function plan(steps) {
  return {
    category: "swap",
    chains: ["arbitrum"],
    confidence: 0.9,
    createdAt: "2024-01-01T00:00:00.000Z",
    id: "plan_test",
    originalIntent: "test",
    requiresWallet: true,
    riskLevel: "low",
    steps,
    tokens: ["USDC"],
    totalEstimatedGasUsd: steps.reduce((s, st) => s + st.estimatedGasUsd, 0),
    warnings: []
  };
}
const okExecutor = async () => ({ data: { ok: true }, isSuccess: true, txHash: "0xabc" });
const CTX = { agentId: "agt_1", userId: "user_1" };
describe("spendTxFromStep", () => {
  it("extracts value, token, and destination from a value-moving step", () => {
    const tx = spendTxFromStep(
      step({ args: { amount: 1200, fromToken: "USDC", recipient: "0xDEAD" } }),
      CTX
    );
    expect(tx).toMatchObject({ agentId: "agt_1", destination: "0xDEAD", token: "USDC", valueUsd: 1200 });
  });
  it("returns null for simulation / read-only / inflow steps", () => {
    expect(spendTxFromStep(step({ isSimulation: true }), CTX)).toBeNull();
    expect(spendTxFromStep(step({ action: "withdraw" }), CTX)).toBeNull();
    expect(spendTxFromStep(step({ action: "claim" }), CTX)).toBeNull();
  });
  it("resolves a value-moving step even with no parseable amount (keeps firewall in force)", () => {
    const tx = spendTxFromStep(
      step({ action: "approve", apiName: "approve", args: { spender: "0xBAD", token: "USDC" } }),
      CTX
    );
    expect(tx).toMatchObject({ destination: "0xBAD", token: "USDC", valueUsd: 0 });
  });
});
describe("SpendGuard \u2194 TransactionPipeline", () => {
  it("blocks a step over the per-tx max and aborts the plan", async () => {
    const guard = new SpendGuard({ perTxMaxUsd: 100 });
    const pipeline = new TransactionPipeline({
      preflight: createSpendPreflight(guard, CTX)
    });
    const executor = vi.fn(okExecutor);
    const execution = await pipeline.execute(plan([step({ args: { amount: 500 } })]), executor);
    expect(execution.status).toBe("failed");
    expect(executor).not.toHaveBeenCalled();
    expect(execution.stepResults.get("step_1")?.error).toContain("Spend guard blocked [CAP_PER_TX]");
  });
  it("allows a within-envelope step and records its spend across the plan", async () => {
    const guard = new SpendGuard({ perTxMaxUsd: 1e3, rollingMaxUsd: 700 });
    const pipeline = new TransactionPipeline({
      preflight: createSpendPreflight(guard, CTX),
      onStepExecuted: createSpendRecorder(guard, CTX)
    });
    const s1 = step({ args: { amount: 500 }, id: "step_1" });
    const s2 = step({ args: { amount: 500 }, dependsOn: ["step_1"], id: "step_2" });
    const execution = await pipeline.execute(plan([s1, s2]), okExecutor);
    expect(execution.stepResults.get("step_1")?.status).toBe("completed");
    expect(execution.stepResults.get("step_2")?.error).toContain("Spend guard blocked [CAP_ROLLING]");
    expect(guard.windowSpend("agt_1", 24 * 60 * 60 * 1e3)).toBe(500);
  });
  it("latches shut after a reconciliation breach - every step blocked", async () => {
    const guard = new SpendGuard({ perTxMaxUsd: 1e4 });
    guard.reconcile("agt_1", { ledgerRecordedUsd: 100, onChainOutflowUsd: 5e3 });
    const pipeline = new TransactionPipeline({
      preflight: createSpendPreflight(guard, CTX)
    });
    const executor = vi.fn(okExecutor);
    const execution = await pipeline.execute(plan([step({ args: { amount: 50 } })]), executor);
    expect(execution.status).toBe("failed");
    expect(executor).not.toHaveBeenCalled();
    expect(execution.stepResults.get("step_1")?.error).toContain("Spend guard blocked [BREACH]");
  });
});
