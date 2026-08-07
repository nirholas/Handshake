import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionJournal } from "../src/core/DecisionJournal.js";
const entry = {
  agentId: "agt-1",
  chosenBranch: "auto-execute",
  confidence: 0.9,
  decisionType: "intervention",
  inputsSnapshot: { usd: 1200 },
  reasoning: "under threshold"
};
afterEach(() => {
  vi.restoreAllMocks();
});
describe("DecisionJournal", () => {
  it("forwards the entry to the sink", () => {
    const sink = vi.fn();
    new DecisionJournal(sink).record(entry);
    expect(sink).toHaveBeenCalledWith(entry);
  });
  it("is a no-op when no sink is provided", () => {
    expect(() => new DecisionJournal().record(entry)).not.toThrow();
  });
  it("does not throw into the decision path when the sink throws synchronously", () => {
    const sink = vi.fn(() => {
      throw new Error("db down");
    });
    const journal = new DecisionJournal(sink);
    expect(() => journal.record(entry)).not.toThrow();
    expect(sink).toHaveBeenCalledOnce();
  });
  it("does not reject the caller when the async sink rejects", async () => {
    let reject;
    const pending = new Promise((_, r) => {
      reject = r;
    });
    const sink = vi.fn(() => pending);
    const journal = new DecisionJournal(sink);
    expect(() => journal.record(entry)).not.toThrow();
    reject(new Error("write failed"));
    await expect(pending.catch(() => "swallowed")).resolves.toBe("swallowed");
  });
  it("returns synchronously without awaiting a slow sink", () => {
    let settled = false;
    const sink = vi.fn(
      () => new Promise((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve(void 0);
        }, 1e3);
      })
    );
    new DecisionJournal(sink).record(entry);
    expect(settled).toBe(false);
  });
});
