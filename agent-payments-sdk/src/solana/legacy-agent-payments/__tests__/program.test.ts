// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import {
  OFFLINE_PUMP_PROGRAM,
  decodeLegacyGlobalConfig,
  decodeLegacyTokenAgentPaymentInCurrency,
  decodeLegacyTokenAgentPayments,
  getLegacyOfflineProgram,
  getLegacyPumpProgram,
  getLegacyPumpProgramWithFallback,
} from "../program.js";
import { LEGACY_AGENT_PAYMENTS_PROGRAM_ID } from "../pdas.js";

// Construct a Connection without doing IO. The constructor accepts a URL
// but doesn't actually connect until a method is invoked.
const FAKE_CONNECTION = new Connection("http://127.0.0.1:8899", "processed");

describe("legacy-agent-payments / program", () => {
  it("getLegacyPumpProgram returns a Program with the correct programId", () => {
    const program = getLegacyPumpProgram(FAKE_CONNECTION);
    expect(program.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(
      true,
    );
  });

  it("getLegacyOfflineProgram returns a Program without throwing", () => {
    const program = getLegacyOfflineProgram();
    expect(program.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(
      true,
    );
  });

  it("getLegacyPumpProgramWithFallback returns offline when no connection", () => {
    const program = getLegacyPumpProgramWithFallback();
    expect(program.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(
      true,
    );
  });

  it("getLegacyPumpProgramWithFallback uses connection when supplied", () => {
    const program = getLegacyPumpProgramWithFallback(FAKE_CONNECTION);
    expect(program.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(
      true,
    );
    expect(program.provider.connection).toBeDefined();
  });

  it("OFFLINE_PUMP_PROGRAM singleton is reused across calls", () => {
    expect(OFFLINE_PUMP_PROGRAM).toBe(getLegacyPumpProgramWithFallback());
  });
});

describe("legacy-agent-payments / decoders (offline encode then decode)", () => {
  const coder = OFFLINE_PUMP_PROGRAM.coder.accounts;

  it("decodeLegacyTokenAgentPayments round-trips fields", async () => {
    const sample = {
      bump: 254,
      mint: new PublicKey("11111111111111111111111111111112"),
      authority: new PublicKey("11111111111111111111111111111113"),
      buybackBps: 1234,
    };
    const encoded = await coder.encode("tokenAgentPayments", sample);
    const decoded = decodeLegacyTokenAgentPayments(encoded);
    expect(decoded.bump).toBe(sample.bump);
    expect(decoded.mint.toBase58()).toBe(sample.mint.toBase58());
    expect(decoded.authority.toBase58()).toBe(sample.authority.toBase58());
    expect(decoded.buybackBps).toBe(sample.buybackBps);
  });

  it("decodeLegacyTokenAgentPaymentInCurrency round-trips fields", async () => {
    const sample = {
      mint: new PublicKey("11111111111111111111111111111112"),
      currencyMint: new PublicKey(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ),
      totalInvoicePaymentsMade: new BN(1234567890),
      totalBuyback: new BN(42),
      totalWithdrawals: new BN(7),
      tokensBoughtBackAndBurned: new BN(99),
    };
    const encoded = await coder.encode(
      "tokenAgentPaymentInCurrency",
      sample,
    );
    const decoded = decodeLegacyTokenAgentPaymentInCurrency(encoded);
    expect(decoded.mint.toBase58()).toBe(sample.mint.toBase58());
    expect(decoded.currencyMint.toBase58()).toBe(
      sample.currencyMint.toBase58(),
    );
    expect(decoded.totalInvoicePaymentsMade.toString()).toBe(
      sample.totalInvoicePaymentsMade.toString(),
    );
    expect(decoded.totalBuyback.toString()).toBe(
      sample.totalBuyback.toString(),
    );
    expect(decoded.totalWithdrawals.toString()).toBe(
      sample.totalWithdrawals.toString(),
    );
    expect(decoded.tokensBoughtBackAndBurned.toString()).toBe(
      sample.tokensBoughtBackAndBurned.toString(),
    );
  });

  it("decodeLegacyGlobalConfig round-trips fields", async () => {
    const supported = Array.from({ length: 10 }, (_, i) =>
      i === 0
        ? new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        : PublicKey.default,
    );
    const sample = {
      bump: 250,
      protocolAuthority: new PublicKey(
        "11111111111111111111111111111112",
      ),
      buybackAuthority: new PublicKey(
        "11111111111111111111111111111113",
      ),
      supportedCurrenciesMint: supported,
      tokenizedAgentSequence: new BN(7),
    };
    const encoded = await coder.encode("globalConfig", sample);
    const decoded = decodeLegacyGlobalConfig(encoded);
    expect(decoded.bump).toBe(sample.bump);
    expect(decoded.protocolAuthority.toBase58()).toBe(
      sample.protocolAuthority.toBase58(),
    );
    expect(decoded.buybackAuthority.toBase58()).toBe(
      sample.buybackAuthority.toBase58(),
    );
    expect(decoded.tokenizedAgentSequence.toString()).toBe(
      sample.tokenizedAgentSequence.toString(),
    );
    expect(decoded.supportedCurrenciesMint).toHaveLength(10);
    expect(decoded.supportedCurrenciesMint[0]!.toBase58()).toBe(
      supported[0]!.toBase58(),
    );
    expect(decoded.supportedCurrenciesMint[1]!.toBase58()).toBe(
      PublicKey.default.toBase58(),
    );
  });
});
