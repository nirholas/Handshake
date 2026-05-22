// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * Fixture-based tests for the pump bonding-curve event parser.
 * Fixtures were captured from mainnet websocket logs — they are real bytes,
 * not synthesized ones, so the BorshEventCoder is the source of truth.
 */
import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPumpEventParser,
  subscribeToPumpEvents,
  eventDiscriminatorMap,
  type ParsedPumpEvent,
  PUMP_BONDING_CURVE_PROGRAM_ID,
} from "./pump-events.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

interface Fixture {
  signature: string;
  slot: number;
  logMessages: string[];
  expected: { name: string; data: Record<string, unknown> };
}

function loadFixture(name: string): Fixture {
  const p = join(
    new URL(".", import.meta.url).pathname,
    "fixtures/pump-events",
    `${name}.json`,
  );
  return JSON.parse(readFileSync(p, "utf8")) as Fixture;
}

// ─── Discriminator coverage ───────────────────────────────────────────────────

describe("eventDiscriminatorMap", () => {
  it("covers every event in the IDL", async () => {
    const { default: IDL_JSON } = await import("./idl/pump.json", {
      with: { type: "json" },
    });
    expect(eventDiscriminatorMap.size).toBe(IDL_JSON.events.length);
  });
});

// ─── Parser — fixture round-trips ─────────────────────────────────────────────

describe("createPumpEventParser", () => {
  const parser = createPumpEventParser();

  it("decodes create fixture: event name is CreateEvent", () => {
    const { logMessages } = loadFixture("create");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "CreateEvent");
    expect(ev).toBeDefined();
    expect(ev!.name).toBe("CreateEvent");
  });

  it("decodes create fixture: mint is valid base58 pubkey", () => {
    const { logMessages } = loadFixture("create");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "CreateEvent")!;
    const data = ev.data as { mint: unknown };
    expect(data.mint).toBeInstanceOf(PublicKey);
    expect(() => (data.mint as PublicKey).toBase58()).not.toThrow();
  });

  it("decodes create fixture: name/symbol are non-empty strings", () => {
    const { logMessages, expected } = loadFixture("create");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "CreateEvent")!;
    const data = ev.data as { name: string; symbol: string };
    expect(typeof data.name).toBe("string");
    expect(data.name.length).toBeGreaterThan(0);
    expect(data.name).toBe(expected.data.name);
    expect(data.symbol).toBe(expected.data.symbol);
  });

  it("decodes trade-buy fixture: event name is TradeEvent", () => {
    const { logMessages } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "TradeEvent");
    expect(ev).toBeDefined();
  });

  it("decodes trade-buy fixture: is_buy is true", () => {
    const { logMessages } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find(
      (e) => e.name === "TradeEvent" && (e.data as { is_buy: boolean }).is_buy,
    );
    expect(ev).toBeDefined();
    expect((ev!.data as { is_buy: boolean }).is_buy).toBe(true);
  });

  it("decodes trade-sell fixture: is_buy is false", () => {
    const { logMessages } = loadFixture("trade-sell");
    const events = parser.parseLogs(logMessages);
    const ev = events.find(
      (e) => e.name === "TradeEvent" && !(e.data as { is_buy: boolean }).is_buy,
    );
    expect(ev).toBeDefined();
    expect((ev!.data as { is_buy: boolean }).is_buy).toBe(false);
  });

  it("decoded trade-buy mint matches fixture expected", () => {
    const { logMessages, expected } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find((e) => e.name === "TradeEvent") as
      | ParsedPumpEvent<"TradeEvent">
      | undefined;
    expect(ev).toBeDefined();
    expect((ev!.data.mint as PublicKey).toBase58()).toBe(expected.data.mint);
  });

  it("decoded trade-buy sol_amount is a non-zero BN", () => {
    const { logMessages } = loadFixture("trade-buy");
    const events = parser.parseLogs(logMessages);
    const ev = events.find(
      (e) => e.name === "TradeEvent" && (e.data as { is_buy: boolean }).is_buy,
    ) as ParsedPumpEvent<"TradeEvent"> | undefined;
    expect(ev).toBeDefined();
    // BN is an object with a `words` array; verify it converts to a positive int
    const solAmt = ev!.data.sol_amount;
    expect(solAmt).toBeTruthy();
    expect(Number(solAmt.toString()) > 0).toBe(true);
  });

  it("ignores log lines without Program data: prefix", () => {
    const events = parser.parseLogs([
      "Program log: something",
      "Program invoke [1]",
      "Program 6EF8rrec... success",
    ]);
    expect(events).toHaveLength(0);
  });

  it("ignores base64 with unknown discriminator", () => {
    // 8 zero bytes + empty payload — won't match any event
    const unknown = Buffer.alloc(8).toString("base64");
    const events = parser.parseLogs([`Program data: ${unknown}`]);
    expect(events).toHaveLength(0);
  });

  it("empty logs array returns empty array", () => {
    expect(parser.parseLogs([])).toHaveLength(0);
  });
});

// ─── subscribeToPumpEvents ────────────────────────────────────────────────────

describe("subscribeToPumpEvents", () => {
  it("calls onEvent with parsed events from stubbed connection", async () => {
    const { logMessages, expected } = loadFixture("trade-sell");

    let capturedCallback: ((logs: unknown, ctx: unknown) => void) | null = null;
    const mockConn = {
      onLogs: vi.fn((_id: unknown, cb: (logs: unknown, ctx: unknown) => void) => {
        capturedCallback = cb;
        return 42; // subscription id
      }),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };

    const received: ParsedPumpEvent[] = [];
    subscribeToPumpEvents(
      mockConn,
      { programId: PUMP_BONDING_CURVE_PROGRAM_ID },
      (ev) => received.push(ev),
    );

    // Fire the stub callback with the real fixture logs
    capturedCallback!({ logs: logMessages, err: null, signature: expected.name }, { slot: 12345 });

    expect(received.length).toBeGreaterThan(0);
    expect(received.some((e) => e.name === "TradeEvent")).toBe(true);
  });

  it("unsubscribe is idempotent: calling twice does not throw", async () => {
    const mockConn = {
      onLogs: vi.fn(() => 99),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };
    const sub = subscribeToPumpEvents(mockConn, {}, vi.fn());
    await sub.unsubscribe();
    await sub.unsubscribe(); // second call — must not throw
    expect(mockConn.removeOnLogsListener).toHaveBeenCalledTimes(1);
  });

  it("mint filter: only emits events whose mint field matches", () => {
    const { logMessages, expected } = loadFixture("trade-sell");
    const targetMint = new PublicKey(expected.data.mint as string);
    const differentMint = new PublicKey(
      "So11111111111111111111111111111111111111112",
    );

    let capturedCallback: ((logs: unknown, ctx: unknown) => void) | null = null;
    const mockConn = {
      onLogs: vi.fn((_: unknown, cb: (logs: unknown, ctx: unknown) => void) => {
        capturedCallback = cb;
        return 1;
      }),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };

    const matchingEvents: ParsedPumpEvent[] = [];
    subscribeToPumpEvents(
      mockConn,
      { mint: targetMint },
      (ev) => matchingEvents.push(ev),
    );
    capturedCallback!(
      { logs: logMessages, err: null, signature: "sig1" },
      { slot: 1 },
    );
    expect(matchingEvents.length).toBeGreaterThan(0);

    const filteredEvents: ParsedPumpEvent[] = [];
    subscribeToPumpEvents(
      mockConn,
      { mint: differentMint },
      (ev) => filteredEvents.push(ev),
    );
    capturedCallback!(
      { logs: logMessages, err: null, signature: "sig2" },
      { slot: 2 },
    );
    expect(filteredEvents).toHaveLength(0);
  });

  it("skips errored log callbacks", () => {
    const { logMessages } = loadFixture("create");
    let capturedCallback: ((logs: unknown, ctx: unknown) => void) | null = null;
    const mockConn = {
      onLogs: vi.fn((_: unknown, cb: (logs: unknown, ctx: unknown) => void) => {
        capturedCallback = cb;
        return 1;
      }),
      removeOnLogsListener: vi.fn(() => Promise.resolve()),
    };

    const received: ParsedPumpEvent[] = [];
    subscribeToPumpEvents(mockConn, {}, (ev) => received.push(ev));

    // err != null → should be ignored
    capturedCallback!({ logs: logMessages, err: new Error("oops"), signature: "" }, { slot: 1 });
    expect(received).toHaveLength(0);
  });
});
