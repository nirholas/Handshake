// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import { LegacyPumpAgentOffline } from "../PumpAgentOffline.js";
import {
  LEGACY_AGENT_PAYMENTS_PROGRAM_ID,
  getBondingCurvePDA,
  getBuybackAuthorityPDA,
  getGlobalConfigPDA,
  getInvoiceIdPDA,
  getPaymentInCurrencyPDA,
  getTokenAgentPaymentsPDA,
  getWithdrawAuthorityPDA,
} from "../pdas.js";
import idlJson from "../idl.json" with { type: "json" };

interface IdlInstructionAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlInstructionAccount[];
}
const IDL_INSTRUCTIONS = (idlJson as { instructions: IdlInstruction[] })
  .instructions;
const idlIxByName = (name: string): IdlInstruction => {
  const ix = IDL_INSTRUCTIONS.find((i) => i.name === name);
  if (!ix) throw new Error(`IDL is missing instruction ${name}`);
  return ix;
};

// Deterministic test inputs.
const MINT = new PublicKey("11111111111111111111111111111112");
const AUTHORITY = new PublicKey("11111111111111111111111111111113");
const NEW_AUTHORITY = new PublicKey("11111111111111111111111111111114");
const AGENT_AUTHORITY = new PublicKey("11111111111111111111111111111115");
const USER = new PublicKey("11111111111111111111111111111116");
const USER_TOKEN_ACCOUNT = new PublicKey(
  "11111111111111111111111111111117",
);
const RECEIVER_ATA = new PublicKey("11111111111111111111111111111118");
const CURRENCY_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const GLOBAL_BUYBACK_AUTHORITY = new PublicKey(
  "11111111111111111111111111111119",
);
const SWAP_PROGRAM = new PublicKey("1nc1nerator11111111111111111111111111111111");
const ACCOUNT_FOR_EXTEND = new PublicKey(
  "1111111111111111111111111111111A",
);

const agent = new LegacyPumpAgentOffline(MINT);

/** Match (length + writable/signer flags) of `keys` against IDL declaration. */
function expectIdlAccountFlagsMatch(
  ixName: string,
  keys: { isWritable: boolean; isSigner: boolean }[],
) {
  const idl = idlIxByName(ixName);
  expect(keys).toHaveLength(idl.accounts.length);
  idl.accounts.forEach((a, i) => {
    expect(
      keys[i]!.isWritable,
      `${ixName} account[${i}] (${a.name}).isWritable`,
    ).toBe(!!a.writable);
    expect(
      keys[i]!.isSigner,
      `${ixName} account[${i}] (${a.name}).isSigner`,
    ).toBe(!!a.signer);
  });
}

function expectDiscriminator(data: Buffer, ixName: string) {
  const idl = idlIxByName(ixName);
  const disc = Buffer.from(idl.discriminator);
  expect(data.slice(0, 8).equals(disc)).toBe(true);
}

describe("LegacyPumpAgentOffline / programId & discriminators & flags", () => {
  it("create -> agentInitialize", async () => {
    const ix = await agent.create({
      authority: AUTHORITY,
      mint: MINT,
      agentAuthority: AGENT_AUTHORITY,
      buybackBps: 1000,
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentInitialize");
    expectIdlAccountFlagsMatch("agentInitialize", ix.keys);
    // Check bondingCurve & tokenAgentPayments derivations match IDL seeds.
    const [bondingCurve] = getBondingCurvePDA(MINT);
    const [tokenAgentPayments] = getTokenAgentPaymentsPDA(MINT);
    expect(ix.keys[1]!.pubkey.equals(bondingCurve)).toBe(true);
    expect(ix.keys[4]!.pubkey.equals(tokenAgentPayments)).toBe(true);
    expect(ix.keys[3]!.pubkey.equals(MINT)).toBe(true);
  });

  it("withdraw -> agentWithdraw", async () => {
    const ix = await agent.withdraw({
      authority: AUTHORITY,
      currencyMint: CURRENCY_MINT,
      receiverAta: RECEIVER_ATA,
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentWithdraw");
    expectIdlAccountFlagsMatch("agentWithdraw", ix.keys);
    // tokenProgram default
    const tokenProgramAcct = ix.keys[6]!;
    expect(tokenProgramAcct.pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("withdraw with custom tokenProgram is forwarded", async () => {
    const ix = await agent.withdraw({
      authority: AUTHORITY,
      currencyMint: CURRENCY_MINT,
      receiverAta: RECEIVER_ATA,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    const tokenProgramAcct = ix.keys[6]!;
    expect(tokenProgramAcct.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("acceptPayment -> agentAcceptPayment", async () => {
    const ix = await agent.acceptPayment({
      user: USER,
      userTokenAccount: USER_TOKEN_ACCOUNT,
      currencyMint: CURRENCY_MINT,
      amount: new BN(100),
      memo: new BN(200),
      startTime: new BN(0),
      endTime: new BN(9999),
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentAcceptPayment");
    expectIdlAccountFlagsMatch("agentAcceptPayment", ix.keys);
    const [tokenAgentPayments] = getTokenAgentPaymentsPDA(MINT);
    const [paymentInCurrency] = getPaymentInCurrencyPDA(MINT, CURRENCY_MINT);
    const [globalConfig] = getGlobalConfigPDA();
    const [invoiceId] = getInvoiceIdPDA(
      MINT,
      CURRENCY_MINT,
      new BN(100),
      new BN(200),
      new BN(0),
      new BN(9999),
    );
    expect(ix.keys[2]!.pubkey.equals(tokenAgentPayments)).toBe(true);
    expect(ix.keys[4]!.pubkey.equals(paymentInCurrency)).toBe(true);
    expect(ix.keys[5]!.pubkey.equals(globalConfig)).toBe(true);
    expect(ix.keys[6]!.pubkey.equals(invoiceId)).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(CURRENCY_MINT)).toBe(true);
  });

  it("acceptPaymentSimple BN coercion: number, bigint, BN produce identical data", async () => {
    const base = {
      user: USER,
      userTokenAccount: USER_TOKEN_ACCOUNT,
      currencyMint: CURRENCY_MINT,
    };
    const ixNumber = await agent.acceptPaymentSimple({
      ...base,
      amount: 100,
      memo: 200,
      startTime: 0,
      endTime: 9999,
    });
    const ixBigint = await agent.acceptPaymentSimple({
      ...base,
      amount: 100n,
      memo: 200n,
      startTime: 0n,
      endTime: 9999n,
    });
    const ixBN = await agent.acceptPayment({
      ...base,
      amount: new BN(100),
      memo: new BN(200),
      startTime: new BN(0),
      endTime: new BN(9999),
    });
    expect(ixNumber.data.equals(ixBigint.data)).toBe(true);
    expect(ixNumber.data.equals(ixBN.data)).toBe(true);
    // Also account ordering identical.
    expect(ixNumber.keys.length).toBe(ixBN.keys.length);
    for (let i = 0; i < ixNumber.keys.length; i++) {
      expect(ixNumber.keys[i]!.pubkey.toBase58()).toBe(
        ixBN.keys[i]!.pubkey.toBase58(),
      );
    }
  });

  it("distributePayments -> agentDistributePayments", async () => {
    const ix = await agent.distributePayments({
      user: USER,
      currencyMint: CURRENCY_MINT,
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentDistributePayments");
    expectIdlAccountFlagsMatch("agentDistributePayments", ix.keys);
    const [buybackAuthority] = getBuybackAuthorityPDA(MINT);
    const [withdrawAuthority] = getWithdrawAuthorityPDA(MINT);
    expect(ix.keys[6]!.pubkey.equals(buybackAuthority)).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(withdrawAuthority)).toBe(true);
  });

  it("buybackTrigger -> agentBuybackTrigger (with remaining accounts)", async () => {
    const remaining = [
      {
        pubkey: SystemProgram.programId,
        isWritable: false,
        isSigner: false,
      },
    ];
    const ix = await agent.buybackTrigger({
      globalBuybackAuthority: GLOBAL_BUYBACK_AUTHORITY,
      currencyMint: CURRENCY_MINT,
      swapProgramToInvoke: SWAP_PROGRAM,
      swapInstructionData: Buffer.from([1, 2, 3, 4]),
      remainingAccounts: remaining,
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentBuybackTrigger");
    // Remaining accounts are appended after fixed accounts.
    const idl = idlIxByName("agentBuybackTrigger");
    expect(ix.keys.length).toBe(idl.accounts.length + 1);
    // Check the fixed prefix matches IDL flags.
    idl.accounts.forEach((a, i) => {
      expect(ix.keys[i]!.isWritable).toBe(!!a.writable);
      expect(ix.keys[i]!.isSigner).toBe(!!a.signer);
    });
    // Remaining account at the end.
    expect(
      ix.keys[ix.keys.length - 1]!.pubkey.equals(SystemProgram.programId),
    ).toBe(true);
  });

  it("extendAccount -> extendAccount", async () => {
    const ix = await agent.extendAccount({
      account: ACCOUNT_FOR_EXTEND,
      user: USER,
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "extendAccount");
    expectIdlAccountFlagsMatch("extendAccount", ix.keys);
    expect(ix.keys[0]!.pubkey.equals(ACCOUNT_FOR_EXTEND)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(USER)).toBe(true);
  });

  it("updateAuthority -> agentUpdateAuthority", async () => {
    const ix = await agent.updateAuthority({
      authority: AUTHORITY,
      newAuthority: NEW_AUTHORITY,
    });
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentUpdateAuthority");
    expectIdlAccountFlagsMatch("agentUpdateAuthority", ix.keys);
  });

  it("updateBuybackBps -> agentUpdateBuybackBps (with explicit supportedCurrenciesMint)", async () => {
    const ix = await agent.updateBuybackBps(
      { authority: AUTHORITY, buybackBps: 5000 },
      { supportedCurrenciesMint: [CURRENCY_MINT, PublicKey.default] },
    );
    expect(ix.programId.equals(LEGACY_AGENT_PAYMENTS_PROGRAM_ID)).toBe(true);
    expectDiscriminator(ix.data, "agentUpdateBuybackBps");
    const idl = idlIxByName("agentUpdateBuybackBps");
    // Fixed accounts + 1 non-default supported currency remaining account.
    expect(ix.keys.length).toBe(idl.accounts.length + 1);
    // The fixed accounts portion still respects IDL flags.
    idl.accounts.forEach((a, i) => {
      expect(ix.keys[i]!.isWritable).toBe(!!a.writable);
      expect(ix.keys[i]!.isSigner).toBe(!!a.signer);
    });
  });

  it("updateBuybackBps offline rejects without supportedCurrenciesMint", async () => {
    await expect(
      agent.updateBuybackBps({ authority: AUTHORITY, buybackBps: 5000 }),
    ).rejects.toThrow(/supportedCurrenciesMint/);
  });
});

describe("LegacyPumpAgentOffline / static load", () => {
  it("load() returns an instance with correct mint", () => {
    const a = LegacyPumpAgentOffline.load(MINT);
    expect(a).toBeInstanceOf(LegacyPumpAgentOffline);
    expect(a.mint.equals(MINT)).toBe(true);
  });
});
