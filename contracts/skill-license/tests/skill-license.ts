// Integration tests for the skill_license program, run by `anchor test`
// against a local validator with the real compiled program deployed.
//
// Every test cites the invariant it proves from
// specs/ECONOMY_CONTRACT_INVARIANTS.md (ids SL-1 .. SL-8), so
// `grep -rn "SL-1" contracts/skill-license/tests` finds the proof.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from "@solana/spl-token";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const IDL = require("../target/idl/skill_license.json");

const MARKETPLACE_SEED = Buffer.from("marketplace");
const SKILL_LICENSE_SEED = Buffer.from("skill_license");
const SKILL_MINT_SEED = Buffer.from("skill_mint");

// SL-8: the on-chain seed is exactly sha256(skill_name), matching this
// client-side derivation byte for byte.
function skillSeed(skillName: string): Buffer {
  return createHash("sha256").update(skillName, "utf8").digest();
}

describe("skill_license", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(IDL, provider);
  const programId = program.programId;

  const authority = Keypair.generate(); // marketplace admin
  const minter = Keypair.generate(); // authorized backend minter
  const stranger = Keypair.generate(); // never authorized for anything
  const owner = Keypair.generate(); // license recipient (never signs a mint)
  const agentMint = Keypair.generate().publicKey; // grouping key only

  const [marketplace] = PublicKey.findProgramAddressSync([MARKETPLACE_SEED], programId);

  function deriveLicense(ownerKey: PublicKey, agent: PublicKey, skill: string) {
    const seed = skillSeed(skill);
    const [license] = PublicKey.findProgramAddressSync(
      [SKILL_LICENSE_SEED, ownerKey.toBuffer(), agent.toBuffer(), seed],
      programId,
    );
    const [nftMint] = PublicKey.findProgramAddressSync(
      [SKILL_MINT_SEED, ownerKey.toBuffer(), agent.toBuffer(), seed],
      programId,
    );
    const ownerTokenAccount = getAssociatedTokenAddressSync(nftMint, ownerKey);
    return { license, nftMint, ownerTokenAccount };
  }

  async function fund(key: PublicKey, sol = 2) {
    const sig = await provider.connection.requestAirdrop(key, sol * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  async function mintLicense(skill: string, ownerKey: PublicKey, agent: PublicKey) {
    const { license, nftMint, ownerTokenAccount } = deriveLicense(ownerKey, agent, skill);
    await program.methods
      .mintSkillLicense(skill)
      .accounts({
        marketplace,
        minter: minter.publicKey,
        owner: ownerKey,
        agentMint: agent,
        skillLicense: license,
        nftMint,
        ownerTokenAccount,
      })
      .signers([minter])
      .rpc();
    return { license, nftMint, ownerTokenAccount };
  }

  before(async () => {
    await Promise.all([
      fund(authority.publicKey),
      fund(minter.publicKey),
      fund(stranger.publicKey),
    ]);
  });

  // SL-1 (positive half of the admin leg): the deployer initializes the
  // singleton config and becomes its authority, naming the minter.
  it("initializes the marketplace with the caller as authority", async () => {
    await program.methods
      .initializeMarketplace(minter.publicKey)
      .accounts({ marketplace, authority: authority.publicKey })
      .signers([authority])
      .rpc();

    const state = await program.account.marketplace.fetch(marketplace);
    assert.ok(state.authority.equals(authority.publicKey));
    assert.ok(state.minter.equals(minter.publicKey));
    assert.strictEqual(state.licensesMinted.toNumber(), 0);
  });

  // SL-1 (negative half): a stranger cannot mint; the minter constraint is
  // enforced before any account is created.
  it("rejects a mint from a non-minter", async () => {
    const { license, nftMint, ownerTokenAccount } = deriveLicense(owner.publicKey, agentMint, "summarize");
    await assert.rejects(
      program.methods
        .mintSkillLicense("summarize")
        .accounts({
          marketplace,
          minter: stranger.publicKey,
          owner: owner.publicKey,
          agentMint,
          skillLicense: license,
          nftMint,
          ownerTokenAccount,
        })
        .signers([stranger])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("UnauthorizedMinter"), `expected UnauthorizedMinter, got: ${err}`);
        return true;
      },
    );
  });

  // SL-4 (negative halves): empty and over-long skill names are rejected.
  it("rejects an empty skill name", async () => {
    const { license, nftMint, ownerTokenAccount } = deriveLicense(owner.publicKey, agentMint, "x");
    await assert.rejects(
      program.methods
        .mintSkillLicense("")
        .accounts({
          marketplace,
          minter: minter.publicKey,
          owner: owner.publicKey,
          agentMint,
          skillLicense: license,
          nftMint,
          ownerTokenAccount,
        })
        .signers([minter])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("EmptySkillName"), `expected EmptySkillName, got: ${err}`);
        return true;
      },
    );
  });

  it("rejects a skill name over 64 bytes", async () => {
    const long = "s".repeat(65);
    const { license, nftMint, ownerTokenAccount } = deriveLicense(owner.publicKey, agentMint, long);
    await assert.rejects(
      program.methods
        .mintSkillLicense(long)
        .accounts({
          marketplace,
          minter: minter.publicKey,
          owner: owner.publicKey,
          agentMint,
          skillLicense: license,
          nftMint,
          ownerTokenAccount,
        })
        .signers([minter])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("SkillNameTooLong"), `expected SkillNameTooLong, got: ${err}`);
        return true;
      },
    );
  });

  // SL-2 / SL-3 / SL-7 (positive halves): the authorized mint creates the
  // license PDA and a 1-of-1 NFT whose supply is locked at 1.
  it("mints a 1-of-1 license NFT with locked supply", async () => {
    const { license, nftMint, ownerTokenAccount } = await mintLicense("summarize", owner.publicKey, agentMint);

    const state = await program.account.skillLicense.fetch(license);
    assert.ok(state.authority.equals(owner.publicKey));
    assert.ok(state.agentMint.equals(agentMint));
    assert.ok(state.nftMint.equals(nftMint));
    assert.deepStrictEqual([...state.skillHash], [...skillSeed("summarize")]); // SL-8
    assert.strictEqual(state.revokedAt.toNumber(), 0);
    assert.strictEqual(state.skillName, "summarize");

    // SL-3: supply exactly 1, mint authority removed, freeze authority kept.
    const mint = await getMint(provider.connection, nftMint);
    assert.strictEqual(mint.supply, 1n);
    assert.strictEqual(mint.mintAuthority, null);
    assert.ok(mint.freezeAuthority !== null && mint.freezeAuthority.equals(marketplace));

    const ata = await getAccount(provider.connection, ownerTokenAccount);
    assert.strictEqual(ata.amount, 1n);

    // SL-7: the counter advanced by exactly one.
    const market = await program.account.marketplace.fetch(marketplace);
    assert.strictEqual(market.licensesMinted.toNumber(), 1);
  });

  // SL-2 (negative half): the same purchase can never mint twice — the second
  // init hits existing accounts and the transaction fails.
  it("rejects minting the same (owner, agent, skill) twice", async () => {
    const { license, nftMint, ownerTokenAccount } = deriveLicense(owner.publicKey, agentMint, "summarize");
    await assert.rejects(
      program.methods
        .mintSkillLicense("summarize")
        .accounts({
          marketplace,
          minter: minter.publicKey,
          owner: owner.publicKey,
          agentMint,
          skillLicense: license,
          nftMint,
          ownerTokenAccount,
        })
        .signers([minter])
        .rpc(),
      (err: any) => {
        // The license PDA already exists, so the init fails (custom error 0x0
        // "already in use" surfaces as a simulation failure).
        assert.ok(String(err).length > 0, "expected a failure");
        return true;
      },
    );
  });

  // SL-1 (admin leg): only the authority may rotate the minter.
  it("lets the authority rotate the minter and rejects anyone else", async () => {
    const rotated = Keypair.generate();
    await assert.rejects(
      program.methods
        .setMinter(rotated.publicKey)
        .accounts({ marketplace, authority: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("UnauthorizedAdmin"), `expected UnauthorizedAdmin, got: ${err}`);
        return true;
      },
    );

    await program.methods
      .setMinter(rotated.publicKey)
      .accounts({ marketplace, authority: authority.publicKey })
      .signers([authority])
      .rpc();

    const state = await program.account.marketplace.fetch(marketplace);
    assert.ok(state.minter.equals(rotated.publicKey));

    // Rotate back so the remaining tests use the funded minter.
    await program.methods
      .setMinter(minter.publicKey)
      .accounts({ marketplace, authority: authority.publicKey })
      .signers([authority])
      .rpc();
  });

  // SL-5 (positive half) + refund path: the minter revokes, which freezes the
  // holder's token account and stamps revoked_at without deleting the record.
  it("revokes a license: freezes the NFT, stamps revoked_at, keeps the record", async () => {
    const { license, nftMint, ownerTokenAccount } = await mintLicense("translate", owner.publicKey, agentMint);

    await program.methods
      .revokeSkillLicense()
      .accounts({
        marketplace,
        minter: minter.publicKey,
        owner: owner.publicKey,
        skillLicense: license,
        nftMint,
        ownerTokenAccount,
      })
      .signers([minter])
      .rpc();

    const state = await program.account.skillLicense.fetch(license);
    assert.ok(state.revokedAt.toNumber() > 0);

    const ata = await getAccount(provider.connection, ownerTokenAccount);
    assert.ok(ata.isFrozen, "the holder's token account must be frozen on revoke");
  });

  // SL-5 (negative half): revoking an already-revoked license fails.
  it("rejects revoking an already-revoked license", async () => {
    const { license, nftMint, ownerTokenAccount } = deriveLicense(owner.publicKey, agentMint, "translate");
    await assert.rejects(
      program.methods
        .revokeSkillLicense()
        .accounts({
          marketplace,
          minter: minter.publicKey,
          owner: owner.publicKey,
          skillLicense: license,
          nftMint,
          ownerTokenAccount,
        })
        .signers([minter])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("AlreadyRevoked"), `expected AlreadyRevoked, got: ${err}`);
        return true;
      },
    );
  });

  // SL-1 (negative half, revoke leg): a stranger cannot revoke.
  it("rejects a revoke from a non-minter", async () => {
    const { license, nftMint, ownerTokenAccount } = await mintLicense("classify", owner.publicKey, agentMint);
    await assert.rejects(
      program.methods
        .revokeSkillLicense()
        .accounts({
          marketplace,
          minter: stranger.publicKey,
          owner: owner.publicKey,
          skillLicense: license,
          nftMint,
          ownerTokenAccount,
        })
        .signers([stranger])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("UnauthorizedMinter"), `expected UnauthorizedMinter, got: ${err}`);
        return true;
      },
    );
  });

  // SL-6 (negative half): nobody but the license owner may burn it.
  it("rejects a burn by anyone but the license owner", async () => {
    const { license, nftMint, ownerTokenAccount } = await mintLicense("audit", owner.publicKey, agentMint);
    await assert.rejects(
      program.methods
        .burnSkillLicense()
        .accounts({
          skillLicense: license,
          authority: stranger.publicKey,
          nftMint,
          ownerTokenAccount,
        })
        .signers([stranger])
        .rpc(),
      (err: any) => {
        assert.ok(String(err).includes("NotLicenseOwner"), `expected NotLicenseOwner, got: ${err}`);
        return true;
      },
    );
  });

  // SL-6 (positive half): the owner burns the NFT, closing both the token
  // account and the license PDA, with rent going back to the owner.
  it("lets the owner burn the license and reclaim rent", async () => {
    const skill = "burn-me";
    const burner = Keypair.generate();
    await fund(burner.publicKey);
    const { license, nftMint, ownerTokenAccount } = await mintLicense(skill, burner.publicKey, agentMint);

    const before = await provider.connection.getBalance(burner.publicKey);
    await program.methods
      .burnSkillLicense()
      .accounts({
        skillLicense: license,
        authority: burner.publicKey,
        nftMint,
        ownerTokenAccount,
      })
      .signers([burner])
      .rpc();

    assert.strictEqual(await provider.connection.getAccountInfo(license), null);
    assert.strictEqual(await provider.connection.getAccountInfo(ownerTokenAccount), null);
    const after = await provider.connection.getBalance(burner.publicKey);
    assert.ok(after > before, "burn should return the closed accounts' rent");
  });
});
