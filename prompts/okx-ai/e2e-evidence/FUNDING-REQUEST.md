# Work Order 04: funding request (rewritten 2026-09-02)

Every leg of the gauntlet that does not move money is finished and green against production.
The paid legs are blocked on one owner action. Amounts below are computed from the live
catalog and today's gas price, not padded.

## What changed since the 2026-08-01 version of this file

- **The wallet is logged in.** `onchainos wallet status` returns `loggedIn: true` as
  `claude@three.ws`, and the buyer address is confirmed unchanged
  (`0x75d00a2713565171f33216e5aa2a375e076ecf69`). The OTP ask in the previous version of
  this file is discharged; funding is now the only owner action.
- **The listing is a different product.** The 2026-08-22 rebuild replaced 11 REST rows with
  7 A2MCP forge rows, submitted on-chain 2026-08-27 and currently
  `approvalLabel: "Listing under review"`. The old ask was priced against `text-to-3d`,
  `avatar` and `fbx-export`; the gauntlet now buys the rows OKX actually lists.
- **The ask is smaller.** $1.32 covers a clean run, against $3.00 before.

## Live balances (X Layer RPC, direct `eth_call`, block 69607441, 2026-09-02)

| Wallet | Role | USD₮0 | OKB |
| --- | --- | --- | --- |
| `0x75d00a2713565171f33216e5aa2a375e076ecf69` | Buyer (onchainos TEE) | **0.000000** | 0.000000 |
| `0x4022de2D36C334E73C7a108805Cea11C0564f402` | Seller / payTo | 2.427731 | 0.839596 |
| `0xe81DE501Dd5D9299E2bA8964498858d3fAD0415B` | Relayer (gas) | 0.000000 | 0.020000 |

`payTo` re-probed off the live 402 today and unchanged. Gas is a non-issue: X Layer prices at
0.02 gwei, so one `transferWithAuthorization` costs 0.000002 OKB and the relayer's 0.02 OKB
covers roughly 10,000 settlements. The buyer needs no OKB at all: it signs an EIP-3009
authorization off-chain and the relayer broadcasts.

## The ask: 5.0 USD₮0, one transfer

| | |
| --- | --- |
| To | `0x75d00a2713565171f33216e5aa2a375e076ecf69` (buyer, onchainos TEE wallet) |
| Chain | X Layer mainnet, chainId **196** (`eip155:196`) |
| Token | USD₮0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6 decimals) |
| Amount | **5.0 USD₮0** (5,000,000 atomic) |

### How the number was computed

`node scripts/okx-e2e-gauntlet.mjs --budget` prints this live off the catalog module:

| Case | Service | Price | Settles? |
| --- | --- | --- | --- |
| 2 | forge-draft | $0.01 | yes |
| 2b | forge-standard | $0.05 | yes |
| 3 | forge-hd | $0.25 | yes |
| 3i | forge-image | $0.25 | yes |
| 3r | avatar (rigged, back burner) | $0.50 | yes |
| 5a | forge-draft | $0.01 | yes |
| 5b | forge-draft | $0.01 | no, rejected on amount before redemption |
| 5c | forge-draft | $0.01 | no, authorization expired |
| 6 | forge-image | $0.25 | no, that is the assertion |
| 7 | forge-draft | $0.01 | no, and it pays a different rail (see below) |

One clean run settles **$1.07**. The binding constraint is not that sum but the **balance
floor**: verify refuses any authorization whose value exceeds `balanceOf(buyer)`, including
the ones designed to be rejected, so the wallet must still hold $0.25 when case 6 signs. A
single clean run therefore needs a starting float of **$1.32**, which the gauntlet checks
before it signs anything and refuses to start below.

$1.32 covers one clean run. The rest is the fix loop: phase 3 re-runs the failed case plus
cases 2 and 5a as its regression floor, and the two dearest cases are the ones most likely to
need iterating (the HD lane hold-gates, the image lane depends on an upstream painter).
Budgeting five iterations at the worst case adds ~$2.6. **$1.32 + $2.6 = $3.9, rounded to
5.0** so the run is never the thing that runs out. Anything unspent stays in the buyer wallet
for WO-05 and for retests during OKX's review.

**Note this money largely comes back.** The buyer pays `payTo`
(`0x4022de2D…f402`), which is our own merchant wallet, so each settlement moves float from one
platform wallet to another. Net platform cost for a full run is the gas only (~0.00002 OKB).
If it is easier to fund from `payTo` (2.427731 USD₮0, enough for a clean run plus two
iterations) than from an exchange, that works and needs no external transfer. That key is in
Secret Manager, which this box cannot read (`gcloud` auth is expired here), so it has to be
you either way.

## Optional second leg: make case 7 a real paid legacy settlement

Case 7 currently proves the pre-OKX rails are still advertised at the right price, which
passes with no funding. The gauntlet is wired to also *pay* one, which turns it into a real
regression test that adding X Layer did not break the rails the platform already sells on.
The cheapest is the Solana USDC rail, whose accept carries a `feePayer`, so it needs **no SOL**:

| | |
| --- | --- |
| To | `9PirGw9wVLLNFgVyjgAt5jvuFQwJ3pYUBWt9n3vZfnyc` (same TEE wallet, Solana account) |
| Chain | Solana mainnet |
| Token | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Amount | **0.10 USDC** (ten draft calls' worth of headroom) |

The same challenge also advertises a **$THREE** rail (`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`,
10 THREE for a draft call). Funding that instead, or as well, would let the gauntlet prove
an agent can buy three.ws compute with $THREE. Say which you prefer; the run defaults to the
USDC rail and skips the paid leg cleanly if the wallet is empty.

## What runs the moment the funding lands

```bash
node scripts/okx-e2e-gauntlet.mjs --budget    # confirms the float arrived
node scripts/okx-e2e-gauntlet.mjs --yes       # the full gauntlet
```

Cases 1, 1d, 2, 2b, 3, 3i, 3r, 5a, 5b, 5c, 5d, 6, 7, then case 4 (on-chain settlement
verification of every payment the run produced), writing evidence for each into this
directory.

## One thing funding will NOT fix, and it is not mine to ship

Case 1d fails against production today, on all four paid rows: a spec-compliant MCP client
(`Accept: text/event-stream` + `MCP-Protocol-Version`, which is what an OKX reviewer probes
with) is answered **402 on `initialize` and `tools/list`**, so it can never read a tool
description or a parameter schema. The fix is already in this worktree with unit tests behind
it, written against the 2026-09-02 rejection. It reaches buyers on the next deploy, which is
owner-gated. The payment gauntlet does not depend on it (`tools/call` is never a discovery
method), but the listing does.
