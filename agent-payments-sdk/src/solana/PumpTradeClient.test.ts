// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * PumpTradeClient unit tests
 *
 * Strategy: mock @pump-fun/pump-sdk at the module boundary and simulate
 * Connection RPC responses using vi.fn() stubs.
 *
 * Required coverage per spec:
 *  - resolveQuoteMint: USDC coin, legacy SOL coin, cache (single getAccountInfo for 2x calls)
 *  - quoteForBuy: correct expectedBaseTokens & maxQuoteCost, priceImpactPct > 0
 *  - buildBuyInstructions: count > 0, programId = PUMP_PROGRAM_ID, buyV2 discriminator
 *  - CoinGraduatedError / CoinNotFoundError
 *  - buildSellInstructions: programId, sellV2 discriminator
 *  - buildBuyExactQuoteInInstructions: buyExactQuoteInV2 discriminator
 *  - fee recipient is always from global.feeRecipients pool
 */

import { BN } from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

// ─── Shared test fixtures ────────────────────────────────────────────────────

const FAKE_MINT = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // arbitrary test mint
const FAKE_USER = new PublicKey("DRiP2Pn2K6fuMLKQmt5rZWyHiUZ6WK3GChEySUpHSS4");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// Discriminators from pump-public-docs/idl/pump.ts
const BUY_V2_DISC = [184, 23, 238, 97, 103, 197, 211, 61];
const SELL_V2_DISC = [93, 246, 130, 60, 231, 233, 64, 178];
const BUY_EXACT_QUOTE_IN_V2_DISC = [194, 171, 28, 70, 104, 77, 91, 47];

// Minimal BondingCurve shape that PumpTradeClient uses
function makeBondingCurve(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    virtualTokenReserves: new BN("1000000000000"),
    virtualQuoteReserves: new BN("30000000000"),
    realTokenReserves: new BN("793100000000000"),
    realQuoteReserves: new BN(0),
    tokenTotalSupply: new BN("1000000000000000"),
    complete: false,
    creator: new PublicKey("DRiP2Pn2K6fuMLKQmt5rZWyHiUZ6WK3GChEySUpHSS4"),
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: PublicKey.default,
    ...overrides,
  };
}

function makeGlobal() {
  return {
    initialized: true,
    authority: PublicKey.default,
    feeRecipient: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
    initialVirtualTokenReserves: new BN("1073000000000000"),
    initialVirtualSolReserves: new BN("30000000000"),
    initialRealTokenReserves: new BN("793100000000000"),
    tokenTotalSupply: new BN("1000000000000000"),
    feeBasisPoints: new BN(100),
    withdrawAuthority: PublicKey.default,
    enableMigrate: true,
    poolMigrationFee: new BN(0),
    creatorFeeBasisPoints: new BN(500),
    feeRecipients: [],
    setCreatorAuthority: PublicKey.default,
    adminSetCreatorAuthority: PublicKey.default,
    createV2Enabled: true,
    whitelistPda: PublicKey.default,
    reservedFeeRecipient: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    isCashbackEnabled: true,
    buybackFeeRecipients: [],
    buybackBasisPoints: new BN(0),
    initialVirtualQuoteReserves: new BN("30000000000"),
    whitelistedQuoteMints: [],
  };
}

function makeFeeConfig() {
  return {
    admin: PublicKey.default,
    flatFees: {
      lpFeeBps: new BN(0),
      protocolFeeBps: new BN(100),
      creatorFeeBps: new BN(500),
    },
    feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees: { protocolFeeBps: new BN(100), creatorFeeBps: new BN(500) } }],
  };
}

/** Build a fake AccountInfo<Buffer> wrapping any data. */
function fakeAccountInfo(owner = TOKEN_2022_PROGRAM_ID): AccountInfo<Buffer> {
  return {
    executable: false,
    lamports: 1_000_000,
    owner,
    rentEpoch: 0,
    data: Buffer.alloc(256),
  };
}

// ─── SDK mocks ───────────────────────────────────────────────────────────────

const mockBondingCurve = makeBondingCurve();
const mockGlobal = makeGlobal();
const mockFeeConfig = makeFeeConfig();

vi.mock("@pump-fun/pump-sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@pump-fun/pump-sdk")>();

  const fakePumpSdk = {
    decodeGlobal: vi.fn(() => mockGlobal),
    decodeFeeConfig: vi.fn(() => mockFeeConfig),
    decodeBondingCurve: vi.fn(() => mockBondingCurve),
    decodeUserVolumeAccumulator: vi.fn(() => ({
      currentSolVolume: new BN(1000),
      cashbackEarned: new BN(100),
    })),
    buyV2Instructions: vi.fn(async () => [
      {
        programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
        keys: Array(10).fill({ pubkey: PublicKey.default, isSigner: false, isWritable: false }),
        data: Buffer.from([184, 23, 238, 97, 103, 197, 211, 61, ...Array(16).fill(0)]),
      },
    ]),
    sellV2Instructions: vi.fn(async () => [
      {
        programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
        keys: Array(10).fill({ pubkey: PublicKey.default, isSigner: false, isWritable: false }),
        data: Buffer.from([93, 246, 130, 60, 231, 233, 64, 178, ...Array(16).fill(0)]),
      },
    ]),
    claimCashbackV2Instruction: vi.fn(async () => ({
      programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
      keys: [],
      data: Buffer.from([]),
    })),
  };

  // Fake program for buyExactQuoteInV2
  const fakeInstruction = {
    programId: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
    keys: Array(20).fill({ pubkey: PublicKey.default, isSigner: false, isWritable: false }),
    data: Buffer.from([194, 171, 28, 70, 104, 77, 91, 47]), // buyExactQuoteInV2 discriminator
  };
  const fakeMethodBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    instruction: vi.fn(async () => fakeInstruction),
  };
  const fakePumpProgram = {
    methods: {
      buyExactQuoteInV2: vi.fn(() => fakeMethodBuilder),
    },
  };

  return {
    ...orig,
    PUMP_SDK: fakePumpSdk,
    OnlinePumpSdk: class {
      fetchGlobal = vi.fn(async () => mockGlobal);
      fetchFeeConfig = vi.fn(async () => mockFeeConfig);
    },
    getPumpProgram: vi.fn(() => fakePumpProgram),
    // re-export real PDA helpers and math functions from orig
    bondingCurvePda: orig.bondingCurvePda,
    bondingCurveMarketCap: orig.bondingCurveMarketCap,
    getBuyTokenAmountFromSolAmount: orig.getBuyTokenAmountFromSolAmount,
    getBuySolAmountFromTokenAmount: orig.getBuySolAmountFromTokenAmount,
    getSellSolAmountFromTokenAmount: orig.getSellSolAmountFromTokenAmount,
    creatorVaultPda: orig.creatorVaultPda,
    feeSharingConfigPda: orig.feeSharingConfigPda,
    userVolumeAccumulatorPda: orig.userVolumeAccumulatorPda,
    GLOBAL_PDA: orig.GLOBAL_PDA,
    GLOBAL_VOLUME_ACCUMULATOR_PDA: orig.GLOBAL_VOLUME_ACCUMULATOR_PDA,
    PUMP_EVENT_AUTHORITY_PDA: orig.PUMP_EVENT_AUTHORITY_PDA,
    PUMP_FEE_CONFIG_PDA: orig.PUMP_FEE_CONFIG_PDA,
    PUMP_FEE_PROGRAM_ID: orig.PUMP_FEE_PROGRAM_ID,
    PUMP_PROGRAM_ID: orig.PUMP_PROGRAM_ID,
  };
});

// ─── Import after mocks are set up ───────────────────────────────────────────

import {
  CoinGraduatedError,
  CoinNotFoundError,
  InsufficientLiquidityError,
  PumpTradeClient,
} from "./PumpTradeClient.js";

// ─── Connection factory ───────────────────────────────────────────────────────

function makeConnection(overrides: {
  getMultipleAccountsInfo?: (...args: unknown[]) => unknown;
  getAccountInfo?: (...args: unknown[]) => unknown;
  getTokenAccountsByOwner?: (...args: unknown[]) => unknown;
} = {}): Connection {
  const conn = {
    // Default: return 4 slots (Global + FeeConfig + bondingCurve + optional userAta/extra)
    getMultipleAccountsInfo: vi.fn(async () => [
      fakeAccountInfo(), // Global
      fakeAccountInfo(), // FeeConfig
      fakeAccountInfo(), // bondingCurve
      null,              // userAta (not created yet)
    ]),
    // Used by resolveQuoteMint and _baseTokenProgram / _quoteTokenProgram
    getAccountInfo: vi.fn(async () => fakeAccountInfo(TOKEN_PROGRAM_ID)),
    getTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
    ...overrides,
  };
  return conn as unknown as Connection;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PumpTradeClient", () => {
  // ── resolveQuoteMint ───────────────────────────────────────────────────────

  describe("resolveQuoteMint", () => {
    it("returns NATIVE_MINT for a legacy coin (quoteMint === PublicKey.default)", async () => {
      // mockBondingCurve.quoteMint is already PublicKey.default → NATIVE_MINT
      const conn = makeConnection({
        getAccountInfo: vi.fn(async () => fakeAccountInfo()),
      });
      const client = new PumpTradeClient(conn);
      const result = await client.resolveQuoteMint(FAKE_MINT);
      expect(result.equals(NATIVE_MINT)).toBe(true);
    });

    it("returns the on-chain quoteMint for a v2 USDC coin", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ quoteMint: USDC_MINT }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection({
        getAccountInfo: vi.fn(async () => fakeAccountInfo()),
      });
      const client = new PumpTradeClient(conn);
      const result = await client.resolveQuoteMint(FAKE_MINT);
      expect(result.equals(USDC_MINT)).toBe(true);
    });

    it("caches result — second call does not trigger another getAccountInfo", async () => {
      const conn = makeConnection({
        getAccountInfo: vi.fn(async () => fakeAccountInfo()),
      });
      const client = new PumpTradeClient(conn);
      await client.resolveQuoteMint(FAKE_MINT);
      await client.resolveQuoteMint(FAKE_MINT);
      // resolveQuoteMint calls getAccountInfo once for the bonding curve PDA
      // _baseTokenProgram is NOT called here, so exactly 1 call
      expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("throws CoinNotFoundError when bonding curve account is null", async () => {
      const conn = makeConnection({
        getAccountInfo: vi.fn(async () => null),
      });
      const client = new PumpTradeClient(conn);
      await expect(client.resolveQuoteMint(FAKE_MINT)).rejects.toThrow(
        CoinNotFoundError,
      );
    });
  });

  // ── quoteForBuy ────────────────────────────────────────────────────────────

  describe("quoteForBuy", () => {
    it("returns expectedBaseTokens > 0 and priceImpactPct > 0 for a valid quote", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.quoteForBuy({
        mint: FAKE_MINT,
        quoteAmount: new BN(1_000_000_000), // 1 SOL
      });

      expect(result.quoteMint.equals(NATIVE_MINT)).toBe(true);
      expect(result.expectedBaseTokens.gtn(0)).toBe(true);
      expect(result.maxQuoteCost.gtn(0)).toBe(true);
      expect(result.priceImpactPct).toBeGreaterThan(0);
    });

    it("throws CoinNotFoundError when bonding curve is missing", async () => {
      const conn = makeConnection({
        getMultipleAccountsInfo: vi.fn(async () => [
          fakeAccountInfo(),
          fakeAccountInfo(),
          null, // missing bonding curve
        ]),
      });
      const client = new PumpTradeClient(conn);
      await expect(
        client.quoteForBuy({ mint: FAKE_MINT, quoteAmount: new BN(1_000_000_000) }),
      ).rejects.toThrow(CoinNotFoundError);
    });

    it("throws CoinGraduatedError when bondingCurve.complete === true", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ complete: true }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      await expect(
        client.quoteForBuy({ mint: FAKE_MINT, quoteAmount: new BN(1_000_000_000) }),
      ).rejects.toThrow(CoinGraduatedError);
    });
  });

  // ── quoteForSell ───────────────────────────────────────────────────────────

  describe("quoteForSell", () => {
    it("returns expectedQuoteOut > 0 and priceImpactPct > 0 for a valid quote", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.quoteForSell({
        mint: FAKE_MINT,
        baseAmount: new BN(10_000_000_000), // 10k tokens (6 decimals)
      });

      expect(result.quoteMint.equals(NATIVE_MINT)).toBe(true);
      expect(result.expectedQuoteOut.gtn(0)).toBe(true);
      expect(result.minQuoteOut.lte(result.expectedQuoteOut)).toBe(true);
      expect(result.priceImpactPct).toBeGreaterThanOrEqual(0);
    });

    it("throws CoinGraduatedError when bondingCurve.complete === true", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ complete: true }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      await expect(
        client.quoteForSell({ mint: FAKE_MINT, baseAmount: new BN(10_000_000) }),
      ).rejects.toThrow(CoinGraduatedError);
    });
  });

  // ── buildBuyInstructions ───────────────────────────────────────────────────

  describe("buildBuyInstructions", () => {
    it("returns at least one instruction", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        quoteAmount: new BN(1_000_000_000),
      });

      expect(result.instructions.length).toBeGreaterThan(0);
      expect(result.quoteMint.equals(NATIVE_MINT)).toBe(true);
      expect(result.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(result.expectedBaseTokens.gtn(0)).toBe(true);
    });

    it("buy instruction programId equals PUMP_PROGRAM_ID", async () => {
      const { PUMP_PROGRAM_ID } = await import("@pump-fun/pump-sdk");
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        quoteAmount: new BN(1_000_000_000),
      });
      const buyIx = result.instructions[result.instructions.length - 1]!;
      expect(buyIx.programId.equals(PUMP_PROGRAM_ID)).toBe(true);
    });

    it("buy instruction data first 8 bytes match buyV2 discriminator", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        quoteAmount: new BN(1_000_000_000),
      });
      const buyIx = result.instructions[result.instructions.length - 1]!;
      expect(Array.from(buyIx.data.slice(0, 8))).toEqual(BUY_V2_DISC);
    });

    it("returns USDC quote mint for v2 USDC coin", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      // Once — auto-resets after the single decodeBondingCurve call in buildBuyInstructions.
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ quoteMint: USDC_MINT }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection({
        // Return TOKEN_PROGRAM_ID as USDC's owner (for both base mint and quote mint lookups)
        getAccountInfo: vi.fn(async () => fakeAccountInfo(TOKEN_PROGRAM_ID)),
      });
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        quoteAmount: new BN(1_000_000), // 1 USDC
      });

      expect(result.quoteMint.equals(USDC_MINT)).toBe(true);
      expect(result.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
    });

    it("throws CoinGraduatedError when bondingCurve.complete === true", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ complete: true }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      await expect(
        client.buildBuyInstructions({
          mint: FAKE_MINT,
          user: FAKE_USER,
          quoteAmount: new BN(1_000_000_000),
        }),
      ).rejects.toThrow(CoinGraduatedError);
    });

    it("throws CoinNotFoundError when bonding curve account is null", async () => {
      const conn = makeConnection({
        getMultipleAccountsInfo: vi.fn(async () => [
          fakeAccountInfo(),
          fakeAccountInfo(),
          null,
        ]),
      });
      const client = new PumpTradeClient(conn);
      await expect(
        client.buildBuyInstructions({
          mint: FAKE_MINT,
          user: FAKE_USER,
          quoteAmount: new BN(1_000_000_000),
        }),
      ).rejects.toThrow(CoinNotFoundError);
    });

    it("fee recipient is a member of global.feeRecipients pool", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        quoteAmount: new BN(1_000_000_000),
      });
      // mockGlobal has feeRecipient + feeRecipients — the picked recipient must be one of them
      const pool = [mockGlobal.feeRecipient, ...mockGlobal.feeRecipients].map((p) =>
        p.toBase58(),
      );
      expect(pool).toContain(result.feeRecipient.toBase58());
    });
  });

  // ── buildSellInstructions ──────────────────────────────────────────────────

  describe("buildSellInstructions", () => {
    it("returns at least one instruction", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildSellInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        baseAmount: new BN(10_000_000_000),
      });

      expect(result.instructions.length).toBeGreaterThan(0);
      expect(result.quoteMint.equals(NATIVE_MINT)).toBe(true);
      expect(result.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(result.expectedQuoteOut.gten(0)).toBe(true);
    });

    it("sell instruction programId equals PUMP_PROGRAM_ID", async () => {
      const { PUMP_PROGRAM_ID } = await import("@pump-fun/pump-sdk");
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildSellInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        baseAmount: new BN(10_000_000_000),
      });
      const sellIx = result.instructions[result.instructions.length - 1]!;
      expect(sellIx.programId.equals(PUMP_PROGRAM_ID)).toBe(true);
    });

    it("sell instruction data first 8 bytes match sellV2 discriminator", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildSellInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        baseAmount: new BN(10_000_000_000),
      });
      const sellIx = result.instructions[result.instructions.length - 1]!;
      expect(Array.from(sellIx.data.slice(0, 8))).toEqual(SELL_V2_DISC);
    });

    it("throws CoinGraduatedError when bondingCurve.complete === true", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ complete: true }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      await expect(
        client.buildSellInstructions({
          mint: FAKE_MINT,
          user: FAKE_USER,
          baseAmount: new BN(10_000_000),
        }),
      ).rejects.toThrow(CoinGraduatedError);
    });

    it("throws CoinNotFoundError when bonding curve account is null", async () => {
      const conn = makeConnection({
        getMultipleAccountsInfo: vi.fn(async () => [
          fakeAccountInfo(),
          fakeAccountInfo(),
          null,
        ]),
      });
      const client = new PumpTradeClient(conn);
      await expect(
        client.buildSellInstructions({
          mint: FAKE_MINT,
          user: FAKE_USER,
          baseAmount: new BN(10_000_000),
        }),
      ).rejects.toThrow(CoinNotFoundError);
    });
  });

  // ── buildBuyExactQuoteInInstructions ───────────────────────────────────────

  describe("buildBuyExactQuoteInInstructions", () => {
    it("returns instruction list with ATA creates prepended", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyExactQuoteInInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        spendableQuoteIn: new BN(1_000_000_000),
        minBaseOut: new BN(1_000_000),
      });

      // Should have at least: createBaseATA + buyExactQuoteInV2 ix
      expect(result.instructions.length).toBeGreaterThanOrEqual(2);
      expect(result.quoteMint.equals(NATIVE_MINT)).toBe(true);
      expect(result.quoteTokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
    });

    it("buyExactQuoteInV2 instruction discriminator matches [194,171,28,70,104,77,91,47]", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const result = await client.buildBuyExactQuoteInInstructions({
        mint: FAKE_MINT,
        user: FAKE_USER,
        spendableQuoteIn: new BN(1_000_000_000),
        minBaseOut: new BN(1_000_000),
      });
      // last ix is the buyExactQuoteInV2 ix (after idempotent ATA creates)
      const exactIx = result.instructions[result.instructions.length - 1]!;
      expect(Array.from(exactIx.data.slice(0, 8))).toEqual(BUY_EXACT_QUOTE_IN_V2_DISC);
    });

    it("throws CoinGraduatedError when bondingCurve.complete === true", async () => {
      const { PUMP_SDK: pumpSdk } = await import("@pump-fun/pump-sdk");
      vi.mocked(pumpSdk.decodeBondingCurve).mockReturnValueOnce(
        makeBondingCurve({ complete: true }) as ReturnType<
          typeof pumpSdk.decodeBondingCurve
        >,
      );

      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      await expect(
        client.buildBuyExactQuoteInInstructions({
          mint: FAKE_MINT,
          user: FAKE_USER,
          spendableQuoteIn: new BN(1_000_000_000),
          minBaseOut: new BN(0),
        }),
      ).rejects.toThrow(CoinGraduatedError);
    });
  });

  // ── buildClaimCashbackInstructions ─────────────────────────────────────────

  describe("buildClaimCashbackInstructions", () => {
    it("returns zero instructions when discovery finds no non-zero ATAs", async () => {
      const conn = makeConnection({
        getTokenAccountsByOwner: vi.fn(async () => ({ value: [] })),
      });
      const client = new PumpTradeClient(conn);
      const ixs = await client.buildClaimCashbackInstructions({ user: FAKE_USER });
      expect(ixs.length).toBe(0);
    });

    it("returns two instructions when explicit quoteMints are passed", async () => {
      const conn = makeConnection();
      const client = new PumpTradeClient(conn);
      const ixs = await client.buildClaimCashbackInstructions({
        user: FAKE_USER,
        quoteMints: [NATIVE_MINT, USDC_MINT],
      });
      expect(ixs.length).toBe(2);
    });

    it("discovers mints from non-zero ATAs on the UserVolumeAccumulator PDA", async () => {
      // Encode a fake token account: mint at offset 0, amount (u64 LE) at offset 64
      const fakeMintBytes = USDC_MINT.toBuffer();
      const fakeAtaData = Buffer.alloc(165);
      fakeMintBytes.copy(fakeAtaData, 0);
      fakeAtaData.writeBigUInt64LE(BigInt(500_000), 64); // non-zero balance

      const conn = makeConnection({
        getTokenAccountsByOwner: vi.fn()
          .mockResolvedValueOnce({ value: [{ account: { data: fakeAtaData, owner: TOKEN_PROGRAM_ID } }] })
          .mockResolvedValueOnce({ value: [] }),
      });
      const client = new PumpTradeClient(conn);
      const ixs = await client.buildClaimCashbackInstructions({ user: FAKE_USER });
      expect(ixs.length).toBe(1);
    });
  });

  // ── Error types ────────────────────────────────────────────────────────────

  describe("exported error types", () => {
    it("CoinGraduatedError is an instanceof Error", () => {
      const e = new CoinGraduatedError(FAKE_MINT);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("CoinGraduatedError");
      expect(e.message).toContain("complete");
    });

    it("CoinNotFoundError is an instanceof Error", () => {
      const e = new CoinNotFoundError(FAKE_MINT);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("CoinNotFoundError");
      expect(e.message).toContain("not found");
    });

    it("InsufficientLiquidityError is an instanceof Error", () => {
      const e = new InsufficientLiquidityError("reserves exhausted");
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe("InsufficientLiquidityError");
      expect(e.message).toContain("reserves exhausted");
    });
  });
});
