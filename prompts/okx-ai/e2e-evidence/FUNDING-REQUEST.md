# Work Order 04: consolidated funding + login request (2026-08-01)

Every leg of the gauntlet that does not move money is finished and green against
production. The paid legs are blocked on exactly two owner actions. Amounts below are
computed from the catalog and the live gas price, not padded.

## What changed since the 2026-07-07 version of this file

That version computed a near-zero float on the grounds that buyer and seller were the same
address, making each payment a self-transfer. **That is no longer true.** The X Layer
`payTo` moved to `0x4022de2D36C334E73C7a108805Cea11C0564f402` (platform merchant wallet)
while the `onchainos` TEE buyer wallet stayed `0x75d00a2713565171f33216e5aa2a375e076ecf69`.
Payments now genuinely leave the buyer, so the float is consumed per call and the ask is
sized on real spend.

It also asked for 0.3 OKB of settlement gas. **Measured today, that is unnecessary.** X Layer
gas is 0.02 gwei and one `transferWithAuthorization` costs ~100k gas = 0.000002 OKB. The
relayer's existing 0.02 OKB covers roughly 10,000 settlements. No gas funding needed.

## Live balances (X Layer RPC, direct `eth_call`, block 66850812)

| Wallet | Role | USD₮0 | OKB |
| --- | --- | --- | --- |
| `0x75d00a2713565171f33216e5aa2a375e076ecf69` | Buyer (onchainos TEE) | **0.000000** | 0.000000 |
| `0x4022de2D36C334E73C7a108805Cea11C0564f402` | Seller / payTo | 2.427731 | 0.839596 |
| `0xe81DE501Dd5D9299E2bA8964498858d3fAD0415B` | Relayer (gas) | 0.000000 | 0.020000 |

## The ask: 3.0 USD₮0, one transfer

| | |
| --- | --- |
| To | `0x75d00a2713565171f33216e5aa2a375e076ecf69` (buyer, onchainos TEE wallet) |
| Chain | X Layer mainnet, chainId **196** (`eip155:196`) |
| Token | USD₮0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736` (6 decimals) |
| Amount | **3.0 USD₮0** (3,000,000 atomic) |

### How 3.0 was computed

One clean gauntlet run settles **$0.52**:

| Case | Service | Price | Settles? |
| --- | --- | --- | --- |
| 2 | text-to-3d | $0.01 | yes |
| 3 | avatar (flagship) | $0.50 | yes |
| 5a | text-to-3d | $0.01 | yes (the replay itself must not settle again) |
| 5b | text-to-3d | $0.01 | no, rejected on amount before redemption |
| 5c | text-to-3d | $0.01 | no, authorization expired |
| 6 | fbx-export | $0.10 | no, that is the assertion |

The binding constraint is not the sum, it is the **balance floor**: verify refuses any
authorization whose value exceeds `balanceOf(buyer)`, including the ones designed to be
rejected. Running in case order, the wallet must still hold $0.50 when case 3 signs and
$0.10 when case 6 signs, so a single clean run needs **$0.62**, not $0.52.

Phase 3's fix loop re-runs the failed case plus cases 2 and 5a as its regression floor.
Budgeting four iterations at the worst case ($0.52 each) adds **$2.08**.

$0.62 + $2.08 = $2.70. **Rounded to 3.0** for margin. Anything unspent stays in the buyer
wallet for work order 05 and future retests.

## Second owner action: the OKX login OTP

The wallet is logged out (`accountCount: 0`), so nothing can be signed. The login is
browser-based and the OTP is emailed, so only a human can complete it.

```
https://web3.okx.com/account/sociallogin?authSessionId=7a064ccb-a627-4ebc-815e-eba3a3b822f0&tempPubKey=PpyeNo6nZexcWiyuhlNdL2oUuAZ3ZO3H0aioDzx%2FbQ8%3D&clientType=agent-cli
```

Open it, choose email, enter `claude@three.ws`, complete the emailed OTP in the browser.
The session id above expires; if it has, `onchainos wallet login --phase init` mints a new one.

**Buyer address caveat:** `0x75d0…cf69` is the buyer wallet recorded by the previous
authenticated session, and it is what the funding line above targets. The first thing done
after login is `onchainos wallet status` to confirm the TEE account still resolves to that
address. If it does not, no payment is signed and the corrected address is reported before
anything is spent.

## Optional: make case 7 a real paid legacy settlement

Case 7 currently verifies that the pre-OKX rails (Solana, Base) are still advertised in every
challenge at the correct price, which passes with no funding. Turning it into a real paid
legacy settlement needs USDC on the TEE Solana account, whose address is only readable after
login. If that is wanted, the address gets reported post-login and the ask is 0.10 USDC plus
0.02 SOL. It is not a blocker for the resubmission.

## What runs the moment both land

`npm run okx:gauntlet -- --yes`, which executes cases 1, 2, 3, 5a, 5b, 5c, 5d, 6, 7 and then
case 4 (on-chain settlement verification of every payment the run produced), writing evidence
for each into this directory.
