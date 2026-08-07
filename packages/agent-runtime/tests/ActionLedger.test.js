import { describe, expect, it } from "vitest";
import {
  LEDGER_CANONICAL_FIELD_ORDER,
  LEDGER_FIELD_SEPARATOR,
  LEDGER_GENESIS_HASH,
  auditChainRows,
  canonicalizeEntry,
  computeEntryHash,
  findUnrecordedOutbound,
  verifyChain,
  verifyChainWindow
} from "../src/core/ActionLedger.js";
const baseEntry = (overrides = {}) => ({
  agentId: "agt_1",
  amountWei: "1000000000000000000",
  balanceAfterWei: "4000000000000000000",
  balanceBeforeWei: "5000000000000000000",
  detail: { source: "transaction-pipeline" },
  event: "transfer",
  network: "arbitrum",
  reason: "rebalance",
  seq: 1,
  target: "0xabc",
  ts: "2026-07-06T00:00:00.000Z",
  txHash: "0xhash1",
  userId: "user_1",
  valueUsd: 2500,
  ...overrides
});
const buildChain = (n, userId = "user_1") => {
  const rows = [];
  let prevHash = LEDGER_GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const entry = baseEntry({
      seq: i,
      txHash: `0xhash${i}`,
      ts: `2026-07-06T00:0${i}:00.000Z`,
      userId
    });
    const entryHash = computeEntryHash(entry, prevHash);
    rows.push({ ...entry, entryHash, prevHash });
    prevHash = entryHash;
  }
  return rows;
};
describe("computeEntryHash", () => {
  it("is deterministic for fixed inputs", () => {
    const entry = baseEntry();
    const a = computeEntryHash(entry, LEDGER_GENESIS_HASH);
    const b = computeEntryHash(entry, LEDGER_GENESIS_HASH);
    expect(a).toBe(b);
    expect(a).toMatch(/^[\da-f]{64}$/);
  });
  it("changes when any committed field changes", () => {
    const base = computeEntryHash(baseEntry(), LEDGER_GENESIS_HASH);
    expect(computeEntryHash(baseEntry({ amountWei: "2" }), LEDGER_GENESIS_HASH)).not.toBe(base);
    expect(computeEntryHash(baseEntry({ target: "0xdef" }), LEDGER_GENESIS_HASH)).not.toBe(base);
    expect(computeEntryHash(baseEntry({ event: "failed" }), LEDGER_GENESIS_HASH)).not.toBe(base);
  });
  it("changes when the previous hash changes (chain linkage)", () => {
    const entry = baseEntry();
    expect(computeEntryHash(entry, LEDGER_GENESIS_HASH)).not.toBe(
      computeEntryHash(entry, "f".repeat(64))
    );
  });
  it("canonicalises detail independent of key order", () => {
    const a = canonicalizeEntry(baseEntry({ detail: { a: 1, b: 2 } }));
    const b = canonicalizeEntry(baseEntry({ detail: { b: 2, a: 1 } }));
    expect(a).toBe(b);
  });
});
describe("verifyChain", () => {
  it("treats an empty chain as valid", () => {
    expect(verifyChain([]).valid).toBe(true);
  });
  it("passes on a well-formed chain", () => {
    const result = verifyChain(buildChain(5));
    expect(result.valid).toBe(true);
    expect(result.brokenAtIndex).toBe(-1);
    expect(result.length).toBe(5);
  });
  it("is order-independent (sorts by seq before walking)", () => {
    const chain = buildChain(4);
    const shuffled = [chain[2], chain[0], chain[3], chain[1]];
    expect(verifyChain(shuffled).valid).toBe(true);
  });
  it("fails at the exact index of a mutated row", () => {
    const chain = buildChain(5);
    chain[2] = { ...chain[2], amountWei: "999" };
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.brokenAtSeq).toBe(3);
    expect(result.reason).toContain("entryHash mismatch");
  });
  it("detects a deleted row via the broken prevHash link", () => {
    const chain = buildChain(5);
    const withGap = [chain[0], chain[1], chain[3], chain[4]];
    const result = verifyChain(withGap);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.reason).toContain("prevHash mismatch");
  });
  it("detects a missing genesis link", () => {
    const chain = buildChain(2);
    chain[0] = { ...chain[0], prevHash: "a".repeat(64) };
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });
});
describe("findUnrecordedOutbound", () => {
  it("returns outbound tx hashes absent from the ledger", () => {
    const ledger = [{ txHash: "0xAAA" }, { txHash: "0xbbb" }, { txHash: null }];
    const onChain = ["0xaaa", "0xCCC", "0xbbb", "0xddd"];
    const unrecorded = findUnrecordedOutbound(onChain, ledger);
    expect(unrecorded).toEqual(["0xCCC", "0xddd"]);
  });
  it("is empty when everything is recorded", () => {
    const ledger = [{ txHash: "0x1" }, { txHash: "0x2" }];
    expect(findUnrecordedOutbound(["0x1", "0x2"], ledger)).toEqual([]);
  });
  it("deduplicates repeated on-chain hashes", () => {
    expect(findUnrecordedOutbound(["0xa", "0xa"], [])).toEqual(["0xa"]);
  });
});
describe("LEDGER_CANONICAL_FIELD_ORDER", () => {
  it("matches the order canonicalizeEntry actually emits", () => {
    const entry = baseEntry({
      agentId: "AGENT",
      amountWei: "AMOUNTWEI",
      balanceAfterWei: "BALANCEAFTER",
      balanceBeforeWei: "BALANCEBEFORE",
      detail: null,
      network: "NETWORK",
      reason: "REASON",
      target: "TARGET",
      txHash: "TXHASH",
      userId: "USERID"
    });
    const segments = canonicalizeEntry(entry).split(LEDGER_FIELD_SEPARATOR);
    expect(segments).toHaveLength(LEDGER_CANONICAL_FIELD_ORDER.length);
    expect(LEDGER_CANONICAL_FIELD_ORDER).toEqual([
      "seq",
      "ts",
      "userId",
      "agentId",
      "event",
      "target",
      "amountWei",
      "valueUsd",
      "txHash",
      "reason",
      "balanceBeforeWei",
      "balanceAfterWei",
      "network",
      "detail"
    ]);
    expect(segments[LEDGER_CANONICAL_FIELD_ORDER.indexOf("userId")]).toBe("USERID");
    expect(segments[LEDGER_CANONICAL_FIELD_ORDER.indexOf("network")]).toBe("NETWORK");
  });
  it("separates fields with a control character that cannot occur in a value", () => {
    expect(LEDGER_FIELD_SEPARATOR).toHaveLength(1);
    expect(LEDGER_FIELD_SEPARATOR.codePointAt(0)).toBeLessThan(32);
  });
});
describe("verifyChainWindow", () => {
  it("verifies a mid-chain window when anchored to the preceding entry hash", () => {
    const chain = buildChain(5);
    const window = chain.slice(2);
    expect(verifyChainWindow(window, { anchorHash: chain[1].entryHash }).valid).toBe(true);
  });
  it("rejects a mid-chain window checked against genesis", () => {
    const chain = buildChain(5);
    expect(verifyChainWindow(chain.slice(2)).valid).toBe(false);
  });
  it("catches an entry deleted at a window boundary", () => {
    const chain = buildChain(5);
    const withHole = [chain[3], chain[4]];
    expect(verifyChainWindow(withHole, { anchorHash: chain[1].entryHash }).valid).toBe(false);
  });
  it("is equivalent to verifyChain when anchored at genesis", () => {
    const chain = buildChain(4);
    expect(verifyChainWindow(chain)).toEqual(verifyChain(chain));
  });
});
describe("auditChainRows", () => {
  it("reports every row as sound for an intact chain", () => {
    const checks = auditChainRows(buildChain(4));
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.hashOk && c.linkOk)).toBe(true);
    expect(checks[0].expectedPrevHash).toBe(LEDGER_GENESIS_HASH);
  });
  it("recomputes the same hash that is stored", () => {
    const [check] = auditChainRows(buildChain(1));
    expect(check.computedHash).toBe(check.storedHash);
  });
  it("flags only the altered row as hash-broken, and only its successor as link-broken", () => {
    const chain = buildChain(4);
    chain[1] = { ...chain[1], amountWei: "999" };
    const checks = auditChainRows(chain);
    expect(checks.map((c) => c.hashOk)).toEqual([true, false, true, true]);
    expect(checks.map((c) => c.linkOk)).toEqual([true, true, true, true]);
  });
  it("flags the successor link when a row is removed", () => {
    const chain = buildChain(4);
    const checks = auditChainRows([chain[0], chain[2], chain[3]]);
    expect(checks.map((c) => c.linkOk)).toEqual([true, false, true]);
    expect(checks.every((c) => c.hashOk)).toBe(true);
  });
  it("returns an empty array for an empty chain", () => {
    expect(auditChainRows([])).toEqual([]);
  });
});
