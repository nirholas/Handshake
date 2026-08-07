import { describe, expect, it } from "vitest";
import {
  decideExit,
  decideLadderedExit,
  ladderMultiple,
  moonbagFraction,
  pct
} from "../src/core/ExitDecisionEngine.js";
const ENTRY = 10n ** 18n;
const OPENED_AT = 1e12;
const x = (mult) => BigInt(Math.round(Number(ENTRY) * mult));
const pos = (overrides = {}) => ({
  entryQuoteWei: ENTRY,
  openedAt: OPENED_AT,
  ...overrides
});
describe("pct", () => {
  it("treats null/undefined/blank as disabled (null), NOT 0", () => {
    expect(pct(null)).toBeNull();
    expect(pct(void 0)).toBeNull();
    expect(pct(Number.NaN)).toBeNull();
  });
  it("passes through finite numbers, including 0", () => {
    expect(pct(0)).toBe(0);
    expect(pct(15)).toBe(15);
    expect(pct(-10)).toBe(-10);
  });
});
describe("decideExit", () => {
  it("holds (null) when nothing triggers", () => {
    const p = pos({ stopLossPct: 20, takeProfitPct: 50 });
    expect(decideExit(p, x(1.1), x(1.1), OPENED_AT)).toBeNull();
  });
  it("returns null for a non-positive entry", () => {
    expect(decideExit(pos({ entryQuoteWei: 0n }), x(2), x(2), OPENED_AT)).toBeNull();
  });
  it("stop-loss wins over take-profit when both thresholds are crossed", () => {
    const p = pos({ stopLossPct: -25, takeProfitPct: 10 });
    expect(decideExit(p, x(1.2), x(1.2), OPENED_AT)).toBe("stop_loss");
  });
  it("fires a normal stop-loss below the threshold", () => {
    const p = pos({ stopLossPct: 20 });
    expect(decideExit(p, x(0.79), x(1), OPENED_AT)).toBe("stop_loss");
    expect(decideExit(p, x(0.81), x(1), OPENED_AT)).toBeNull();
  });
  it("never fires a null take-profit or null trailing-stop (the Number(null) trap)", () => {
    const p = pos({ stopLossPct: null, takeProfitPct: null, trailingStopPct: null });
    expect(decideExit(p, x(5), x(10), OPENED_AT)).toBeNull();
  });
  it("trailing-stop fires only after a peak above entry", () => {
    const p = pos({ trailingStopPct: 20 });
    expect(decideExit(p, x(0.75), x(0.95), OPENED_AT)).toBeNull();
    expect(decideExit(p, x(1.6), x(2), OPENED_AT)).toBe("trailing_stop");
    expect(decideExit(p, x(1.8), x(2), OPENED_AT)).toBeNull();
  });
  it("take-profit fires at/above the threshold", () => {
    const p = pos({ takeProfitPct: 50 });
    expect(decideExit(p, x(1.5), x(1.5), OPENED_AT)).toBe("take_profit");
    expect(decideExit(p, x(1.49), x(1.49), OPENED_AT)).toBeNull();
  });
  it("timeout uses the injected clock, not wall time", () => {
    const p = pos({ maxHoldSeconds: 3600 });
    const justBefore = OPENED_AT + 3599 * 1e3;
    const atLimit = OPENED_AT + 3600 * 1e3;
    expect(decideExit(p, x(1), x(1), justBefore)).toBeNull();
    expect(decideExit(p, x(1), x(1), atLimit)).toBe("timeout");
  });
  describe("signal-flip", () => {
    const bearish = { confidence: 0.9, minConfidence: 0.7, signal: "bearish" };
    it("fires only while underwater and only when sentiment is passed", () => {
      const p = pos({ stopLossPct: 50 });
      expect(decideExit(p, x(0.8), x(1), OPENED_AT, bearish)).toBe("signal_flip");
      expect(decideExit(p, x(1.2), x(1.2), OPENED_AT, bearish)).toBeNull();
      expect(decideExit(p, x(0.8), x(1), OPENED_AT)).toBeNull();
    });
    it("ignores a low-confidence or non-bearish read", () => {
      const p = pos({ stopLossPct: 50 });
      expect(
        decideExit(p, x(0.8), x(1), OPENED_AT, { confidence: 0.5, minConfidence: 0.7, signal: "bearish" })
      ).toBeNull();
      expect(
        decideExit(p, x(0.8), x(1), OPENED_AT, { confidence: 0.9, signal: "bullish" })
      ).toBeNull();
    });
    it("never overrides a hard stop-loss", () => {
      const p = pos({ stopLossPct: 10 });
      expect(decideExit(p, x(0.85), x(1), OPENED_AT, bearish)).toBe("stop_loss");
    });
  });
});
describe("ladderMultiple / moonbagFraction", () => {
  it("ladderMultiple requires > 1, else null", () => {
    expect(ladderMultiple(2)).toBe(2);
    expect(ladderMultiple(1)).toBeNull();
    expect(ladderMultiple(0.5)).toBeNull();
    expect(ladderMultiple(null)).toBeNull();
  });
  it("moonbagFraction defaults to 0.15 and clamps to [0, 0.95]", () => {
    expect(moonbagFraction(null)).toBeCloseTo(0.15);
    expect(moonbagFraction(20)).toBeCloseTo(0.2);
    expect(moonbagFraction(-5)).toBe(0);
    expect(moonbagFraction(300)).toBe(0.95);
  });
});
describe("decideLadderedExit", () => {
  it("is classic full-exit when the ladder is off", () => {
    const p = pos({ takeProfitPct: 50 });
    expect(decideLadderedExit(p, x(1.5), x(1.5), OPENED_AT)).toEqual({
      reason: "take_profit",
      sellFraction: 1
    });
    expect(decideLadderedExit(p, x(1.1), x(1.1), OPENED_AT)).toBeNull();
  });
  it("banks initials at N\xD7 and NEVER returns a 100% exit while up", () => {
    const p = pos({ initialsOutMultiple: 2, moonbagMinPct: 15 });
    const d = decideLadderedExit(p, x(2), x(2), OPENED_AT);
    expect(d?.reason).toBe("take_initials");
    expect(d?.recoversInitials).toBe(true);
    expect(d?.sellFraction).toBeCloseTo(0.5);
    expect(d?.sellFraction).toBeLessThan(1);
  });
  it("scales the take-initials sell down as the multiple grows", () => {
    const p = pos({ initialsOutMultiple: 5 });
    expect(decideLadderedExit(p, x(5), x(5), OPENED_AT)?.sellFraction).toBeCloseTo(0.2);
  });
  it("does not take initials twice - after recovery, the moon bag rides", () => {
    const p = pos({ initialsOutMultiple: 2, initialsRecovered: true, takeProfitPct: 400 });
    expect(decideLadderedExit(p, x(3), x(3), OPENED_AT)).toBeNull();
    expect(decideLadderedExit(p, x(5), x(5), OPENED_AT)).toEqual({
      reason: "take_profit",
      sellFraction: 1
    });
  });
  it("protective exits are always full exits and stop-loss wins", () => {
    const p = pos({ initialsOutMultiple: 2, stopLossPct: 20 });
    expect(decideLadderedExit(p, x(0.75), x(2), OPENED_AT)).toEqual({
      reason: "stop_loss",
      sellFraction: 1
    });
  });
});
