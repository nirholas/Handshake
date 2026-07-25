# Mine a Solana vanity address

By the end of this tutorial you'll have ground a **custom Solana address** — one that starts with, ends with, or is bookended by characters you choose — entirely in your browser, with the secret key never leaving your device. You'll also understand the **proof-of-grind protocol** around the paid grinder: how to verify a signed receipt, publish to the rarity gallery, and post a bounty when a pattern is too hard for one machine.

Along the way you'll learn why a vanity service is normally a trust problem, and how `three-vanity/v1` replaces "just trust us" with math you can check yourself.

**Prerequisites:** a modern browser (the grind uses Web Workers + WASM). No account is needed to grind in the browser. The paid grinder, gallery publishing, and bounties are optional and covered later — those touch x402 payments and an X25519 key you generate on the page.

---

## What you're building

A vanity address is a normal Solana keypair whose public key happens to match a pattern you picked:

```
Pattern:  starts with "AGNT"
        ↓  [your CPU grinds candidates until one matches]
Result:   AGNTxK9…vP4q   ← a real Ed25519 keypair, address matches the pattern
```

A Solana address is just the Base58 encoding of an Ed25519 public key. There's no shortcut to "AGNT…" — you generate random keypairs and check each address until one starts with your characters. That's *grinding*. Each extra character multiplies the work by ~58, so short patterns are instant and long ones can take a fleet.

This tutorial covers the full lifecycle: **grind in the browser → (optionally) buy a provably-fair grind → verify the receipt → publish to the gallery → post a bounty for hard patterns**.

---

## How grinding works (two minutes of theory)

The address space is the Base58 alphabet (`123…ABC…xyz`, minus the ambiguous `0 O I l`, 58 symbols). Each character you pin multiplies the work by ~58, so a rough ladder looks like this:

| Pattern length | Expected attempts | Feel |
|---|---|---|
| 1 char | ~58 | instant |
| 3 chars | ~195k | seconds |
| 4 chars | ~11M | a minute on several cores |
| 5 chars | ~633M | minutes to hours |
| 6+ chars | billions | a fleet, or a bounty |

**The first character is the exception, and it matters a lot.** Base58 encodes an address as one big 256-bit number, not as a string of independent symbols. A 32-byte key needs 44 Base58 digits unless it happens to be small enough for 43, and since 2²⁵⁶ / 58⁴³ ≈ 17, a 44-digit address can only ever *start* with one of the first 17 symbols. Anything later in the alphabet has to come from the ~5.9% of keys that fit in 43 digits:

| Your prefix starts with | Difficulty vs. the flat 58ⁿ guess |
|---|---|
| `2`-`H` | **3.4× easier** |
| `J` | about the same |
| `K`-`z` (40 of the 58 symbols) | **17× harder** |

So `Agent…` is dramatically cheaper to grind than `zebra…`, even though both are five characters. Suffixes have no such skew, the *last* characters of an address are uniform at 1/58 each, which is why moving a pattern to the suffix is often the cheapest way to get the look you want.

A **case-insensitive** match (matching letters in any case) roughly halves the work per letter, at the cost of not choosing the casing of the result.

Two ways to do the grind exist on three.ws, and they solve different problems:

- **In-browser grind ([/vanity-wallet](/vanity-wallet))** — your machine generates the keypair. Nothing is sent anywhere, so there's nothing to trust. Free, up to 6 pattern characters.
- **Provably-fair paid grind (`/api/x402/vanity-verifiable`)** — three.ws's servers do the work and hand back a **signed receipt**. Because someone else generated your key, the protocol exists to *prove* they did it honestly and never kept a copy. This is the `three-vanity/v1` protocol, specified in [docs/PROTOCOL-vanity.md](../PROTOCOL-vanity.md).

Start with the browser grind. It's the right default for almost everyone.

---

## Step 1: Open the grinder and pick a pattern

Go to **[/vanity-wallet](/vanity-wallet)**.

You'll see two inputs:

- **Starts with** — the prefix your address should begin with (e.g. `AGNT`).
- **Ends with** — the suffix it should end with (e.g. `pump`).

Fill in either, or both. Each field accepts only Base58 characters (max 6 each). As you type, the page shows a live **preview** of where your characters land in a sample address, a difficulty meter, and a rough time estimate:

```
type a prefix or suffix to see estimated time
        ↓  (you type "AGNT")
rough estimate: ~40s on 4 cores      [tier: slow — minutes+]
```

The estimate comes from the exact Base58 distribution and your selected core count:

```
expectedAttempts = 1 / ( P(address starts with your prefix) × 58^-len(suffix) )
```

The prefix term is counted exactly rather than approximated as `58^-n`, it is the fraction of all 2²⁵⁶ possible keys whose encoding begins with your prefix, which is what makes the first-character table above fall out. Case-insensitivity sums the probabilities of every Base58-valid spelling (note `i`, `o` and `L` have only one valid case, since the alphabet drops `I`, `O` and `l`).

This is the same difficulty math the paid receipt commits to, see [src/solana/vanity/base58-distribution.js](../../src/solana/vanity/base58-distribution.js) for the derivation and [src/solana/vanity/validation.js](../../src/solana/vanity/validation.js) for the model dispatch. Receipts name their model in `difficulty.model`, so a receipt issued before this correction still verifies against the model it was issued under.

> **Tip:** the suggested-pattern chips (`AGNT…`, `…pump`, `GM…gm`, …) each show their own estimate. They're a fast way to see how dramatically each extra character costs you.

---

## Step 2: Decide on case sensitivity

Below the inputs is a **Case-insensitive** toggle:

> Case-insensitive — match letters in any case. Much faster to grind, but you don't get to choose the casing of the result.

Leave it **off** if the exact casing matters (you want `AGNT`, not `agnt` or `Agnt`). Turn it **on** when you only care about the letters and want the grind to finish sooner — each letter then matches two Base58 symbols instead of one, cutting the expected work for that character roughly in half.

The time estimate updates immediately when you toggle it, so you can see the trade-off before committing CPU.

---

## Step 3: Set your compute budget and grind

The **Compute — CPU cores to use** slider controls how many Web Workers run the grind in parallel. The page defaults to a sensible fraction of your machine's cores and caps at what your browser reports.

- More cores = faster, but a heavier load on the rest of your machine.
- You can **Pause** at any time to free the cores, then resume.

Press **Generate wallet**. The grind starts and a live panel shows:

```
12,400/s              847,213
tries/sec · 4 cores   attempts · eta ~12s
```

- **tries/sec** — combined throughput across your workers.
- **attempts** — cumulative candidates checked.
- **eta** — live estimate to a hit.

Under the hood each worker loads a WASM grinder ([src/solana/vanity/grinder-worker.js](../../src/solana/vanity/grinder-worker.js)) that batches keypair generation, draws fresh entropy with `crypto.getRandomValues`, and checks each candidate against your pattern. The orchestration lives in [src/solana/vanity/grinder.js](../../src/solana/vanity/grinder.js). No network requests are made during the grind — open DevTools → Network and confirm it stays empty.

---

## Step 4: Save the key (this is the critical step)

When a match is found, the page shows your new address and a warning that's there for a reason:

> Save this file somewhere safe before navigating away. Once you close this tab the secret key is gone unless you assign it to an agent. Anyone with the file can spend funds at this address.

The secret key exists **only in this browser tab's memory**. Your options:

- **Download** — saves a JSON file containing the 64-byte secret key as an integer array. This is the Solana CLI / `Keypair.fromSecretKey` format, importable into Phantom, Solflare, or the CLI.
- **Copy** — copies the public address to your clipboard (the address is safe to share; the secret key is not).
- **Assign to an agent** — encrypts the key at rest on three.ws and attaches the wallet to one of your agents, so the agent can transact from a memorable address.

If you only download, store the file somewhere safe (a password manager works). There's no recovery — three.ws never saw the key, so it can't help you restore it. That's the whole point of the in-browser model.

You're done if all you wanted was a vanity wallet. The remaining steps cover the **provably-fair** side of the protocol — relevant when a key was ground *for* you and you want to prove it was done honestly.

---

## Step 5: Understand the provably-fair grind (when the server holds the work)

If you buy a grind from the paid endpoint (`/api/x402/vanity-verifiable`, an x402-priced API), the server does the work and returns a **signed receipt**. Now there's a trust question the browser grind never had: *did they generate my key fresh, or grind a million candidates and quietly keep the one whose key they logged?*

`three-vanity/v1` answers this with a **commit–reveal + sealed-delivery + signed-receipt** scheme. In plain terms, the receipt lets you prove, after the fact, that:

1. the key came from entropy the server **committed to before** it knew your pattern (no precomputed table of keys);
2. **your own entropy** (`clientSeed`) was mixed in, so neither party alone controlled the address;
3. the address really derives from the revealed seed, matches your pattern, and the difficulty claim matches the model the receipt names in `difficulty.model`;
4. the receipt was **signed by the real three.ws service key**, not an impostor;
5. (optionally) the key you recovered from the sealed envelope is byte-for-byte the one the receipt describes — **you alone hold it**.

A receipt is a JSON object carrying the `commitment`, the revealed `serverSeed` and `clientSeed`, the `requestNonce`, the `winningIndex`, the `pattern`, the `difficulty`, and an Ed25519 `signature` over a canonical projection of those fields. When you supply a `sealTo` X25519 public key, the secret is delivered as a `sealedSecret` envelope encrypted to you — the plaintext key never appears in the response. The full field list and signing rules are in [docs/PROTOCOL-vanity.md](../PROTOCOL-vanity.md).

---

## Step 6: Verify a receipt

Open **[/vanity/verify](/vanity/verify)**.

1. **Paste the receipt JSON** into the Receipt JSON box (the full object you received from `/api/x402/vanity-verifiable`).
2. *(Optional)* Expand **"prove you hold the key"** and paste **your X25519 private key** to open the sealed envelope and confirm custody. This key is used only in your browser to decrypt and compare — it is never sent anywhere.
3. Press **Verify receipt**.

The page runs every check locally and shows a pass/fail line for each:

- **protocol** — the receipt is `three-vanity/v1`.
- **commitment** — `SHA-256(serverSeed)` equals the published commitment, so the server was locked to that seed before grinding.
- **derivation** — re-deriving the master seed and the candidate at `winningIndex` reproduces exactly `receipt.address`.
- **pattern** — the address actually satisfies the requested prefix/suffix.
- **difficulty**, `difficulty.expectedAttempts` equals the honest rounded value under the model named in `difficulty.model` (`base58-exact/v2` for anything issued since 2026-07-25).
- **signature** — the Ed25519 signature verifies, **and** the receipt's signing key matches the one pinned from the well-known document (impostors who self-sign under a different key fail here).
- **custody** *(if you opened the seal)* — the decrypted seed's public key equals `receipt.address`.

Before you even paste anything, the page fetches the live service key from [/.well-known/three-vanity.json](/.well-known/three-vanity.json) and pins it, so a forged receipt signed under a different key is caught. The verification logic is the open-source [src/solana/vanity/verifiable-grind.js](../../src/solana/vanity/verifiable-grind.js) (its `verifyVanityReceipt()` function), the same code the CLI and SDK use.

Prefer the command line? Run the open-source verifier:

```bash
node scripts/verify-vanity-receipt.mjs ./receipt.json --fetch-key
```

`--fetch-key` cross-checks the signature against the live well-known service key instead of the value pinned in the script. A single failing check means the receipt is not trustworthy.

---

## Step 7: Publish to the proof-of-grind gallery

The **[/vanity/gallery](/vanity/gallery)** is a public, ranked showcase of the rarest addresses ground on three.ws — each one provably-fair and verified.

Two things you can do there without publishing anything:

- **Appraise any address** — paste a Solana address and the gallery scores its rarity (tier, expected attempts, bonuses) using pure math, no persistence. Good for seeing how rare an address you already hold is.
- **Browse the leaderboard** — addresses ranked by an honest rarity score.

To **publish** one of your own (it's opt-in):

1. From the verify page, after a green verdict, click **Publish to the rarity gallery →** (or open the gallery's Publish tab directly).
2. The gallery submits your **receipt** to `/api/vanity/gallery`. The server re-verifies it against the live service key before storing anything.
3. Only public, secret-free metadata is kept — address, pattern, rarity, optional label. Secret fields (`secretKey`, `seed`, `sealedSecret`) are stripped client-side and rejected server-side, so there's no way to leak a key by publishing.

You can un-publish later by proving control of the key with an Ed25519 signature. Publishing is purely a flex — it never exposes anything that could spend your funds.

---

## Step 8: Post a bounty for a hard pattern

Some patterns are too slow for one machine (5–6+ characters can mean billions of attempts). **[/vanity/bounties](/vanity/bounties)** is a pay-for-results market: you escrow a reward, a fleet of independent workers grinds in parallel, and the first to find a verified match gets paid — without ever seeing your wallet.

To **create** a bounty:

1. Set the **pattern** (prefix/suffix). The page calls a difficulty oracle (`?view=quote`) and suggests an honest reward based on expected grind time.
2. **Generate or paste an X25519 recipient key.** This is the key the found secret will be **sealed to** — workers encrypt the result to you, so they earn the reward but can't keep your wallet.
3. Set the **reward** (denominated in **USDC**; there's a small floor) and an **expiry**.
4. **Escrow** the reward via x402 (USDC on Base or Solana mainnet). The bounty goes live once payment settles.

To **claim** a bounty (you're running grinders for others):

1. Poll open bounties with `GET /api/vanity/bounties?view=open`.
2. Grind the pattern with the same WASM grinder used on `/vanity-wallet`.
3. On a hit, **seal the secret to the requester's X25519 key** client-side, then submit `POST /api/vanity/bounties?action=claim` with the address, the sealed secret, and your payout address.
4. The server verifies the address matches the pattern and the envelope is valid, then settles atomically — only the **first** verified match is paid, on-chain, immediately.

When a bounty fills, the requester opens the sealed envelope with their X25519 **private** key — locally, the key never goes to the server — to recover the wallet. If a bounty expires unfilled, the escrow refunds to the requester. The bounty market is backed by [api/vanity/bounties.js](../../api/vanity/bounties.js).

> Rewards are **USDC**, the settlement asset for the bounty escrow. Nothing about a bounty involves any token other than the wallet you're grinding for.

---

## Bonus: Ethereum CREATE2 vanity addresses

The same idea applies to Ethereum, but for **smart-contract** addresses rather than wallets. **[/eth-vanity](/eth-vanity)** grinds a vanity *contract* address by searching **CREATE2 salts** — and crucially, no private keys are involved. A CREATE2 address is fully determined by the deployer, a salt you choose, and the contract's init-code hash:

```
address = keccak256(0xff ‖ deployer ‖ salt ‖ keccak256(initCode))[12:]
```

So the grind searches for a **salt** that produces a contract address matching your pattern. You feed that salt to your factory (Arachnid, CreateX, Safe, Coinbase, or any CREATE2 factory) at deploy time. The page runs the search in your browser, chain-agnostic and deployer-agnostic — there's no secret to protect, just a salt to hand to your deployment. The salt + factory details can be recorded against your agent identity via [api/agents/eth-vanity.js](../../api/agents/eth-vanity.js), which re-verifies the CREATE2 formula server-side before storing it.

---

## Troubleshooting

- **The grind is taking forever** — each extra character multiplies work by ~58. A 6-character case-sensitive pattern is billions of attempts; either shorten it, enable case-insensitive, raise the core count, or post a [bounty](/vanity/bounties) so a fleet grinds it.
- **The page froze / my fan spun up** — that's the grind using your cores. Lower the core slider or **Pause** to give your machine breathing room; resume when ready.
- **I closed the tab and lost the key** — there's no recovery. three.ws never received the key on the browser path. Always **Download** (or assign to an agent) before navigating away.
- **Verify says "could not fetch the live service key"** — the page falls back to verifying against the receipt's own key (unpinned). The signature still checks out, but to prove the signer is three.ws, retry so it can pin against [/.well-known/three-vanity.json](/.well-known/three-vanity.json).
- **A verify check fails (commitment / derivation / signature)** — the receipt is not trustworthy. A tampered address, swapped seed, wrong index, inflated difficulty, or an impostor signing key each fail by design. Do not use a key from a receipt that doesn't fully verify.
- **Custody check fails** — the X25519 private key you pasted doesn't match the `sealTo` the receipt was sealed to, or the envelope was altered. Use the exact private key matching the public key you sent as `sealTo`.
- **Bounty won't post** — confirm the recipient X25519 key is set and the escrow payment settled. The board fetches config (`?view=config`) to confirm payout is available before accepting a create.

---

## Recap

You learned to mine a Solana vanity address and to operate the proof-of-grind protocol around it:

- **Grind in the browser** ([/vanity-wallet](/vanity-wallet)) — pick a prefix/suffix, choose case sensitivity and cores, grind locally with WASM Web Workers, and download the key. Nothing leaves your device.
- **Difficulty is ~58 per character, except the first**, the leading symbol ranges from 3.4× easier to 17× harder than a flat `58ⁿ` guess; case-insensitive roughly halves per letter.
- **Provably-fair paid grind** — when the server holds the work, `three-vanity/v1` proves the key was fresh, your entropy was mixed in, and no copy was kept.
- **Verify** ([/vanity/verify](/vanity/verify)) — paste a receipt to re-check commitment, derivation, pattern, difficulty, signature, and (optionally) custody, all in your browser, pinned to the live service key.
- **Gallery** ([/vanity/gallery](/vanity/gallery)) — appraise any address or opt-in publish a verified, secret-free receipt to the rarity leaderboard.
- **Bounties** ([/vanity/bounties](/vanity/bounties)) — escrow a USDC reward for a hard pattern; a fleet grinds it and seals the result to you.
- **CREATE2 vanity** ([/eth-vanity](/eth-vanity)) — the same grind for Ethereum contract addresses, searching salts, no keys involved.

The protocol itself is fully specified in [docs/PROTOCOL-vanity.md](../PROTOCOL-vanity.md), and the verifier is open source — you never have to take three.ws's word for it.

## See also

- [three-vanity/v1 protocol specification](../PROTOCOL-vanity.md) — the commit–reveal, seed-mixing, sealed-delivery, and signing scheme in full
- [Create, enhance & edit agent memory](/docs/tutorials/create-and-edit-memory) — give the agent that owns your vanity wallet durable context
- [Build a Custom Skill](/docs/tutorials/custom-skill) — extend that agent with new capabilities at runtime
