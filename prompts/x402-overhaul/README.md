# x402 Overhaul — Work Orders

Rebuild three.ws's paid-agent offering into things crypto users and their AI agents actually
use. Current state: 17 mostly-useless endpoints, $5.87 revenue / 30 days. Target: two free
loss-leaders (Crypto Data API + 3D API) that funnel into a few paid uniques.

## How to use
Each file is a standalone work order. Open a fresh chat and say:
> Read `prompts/x402-overhaul/00-CONTEXT.md` then `prompts/x402-overhaul/<file>` and execute it 100%.

**Every prompt is fully independent** — any order, any parallelism, no prompt waits on another.
`00-CONTEXT.md` carries all shared facts, the codebase map, the "never blocked" decision
defaults, and the shared definition-of-done. Read it first, every time.

## The work orders

### Free Crypto Data API — `/api/crypto/*` (keyless, free; the adoption wedge)
| File | Endpoint |
|---|---|
| `01-crypto-token-snapshot.md` | `/api/crypto/token` — price, mcap, liquidity, volume, 24h |
| `02-crypto-token-security.md` | `/api/crypto/security` — mint authority, rug/risk signals |
| `03-crypto-token-holders.md` | `/api/crypto/holders` — holder count + concentration |
| `04-crypto-pumpfun-launches.md` | `/api/crypto/launches` — live new pump.fun launches |
| `05-crypto-bonding-status.md` | `/api/crypto/bonding` — bonding-curve / graduation status |
| `06-crypto-whale-activity.md` | `/api/crypto/whales` — large-buy / whale activity |
| `07-crypto-symbol-availability.md` | `/api/crypto/symbol` — ticker collision check (free) |
| `08-crypto-wallet-portfolio.md` | `/api/crypto/wallet` — balances / holdings for an address |
| `09-crypto-trending.md` | `/api/crypto/trending` — trending / hot tokens |
| `10-crypto-api-index.md` | `/api/crypto` — bundle index + OpenAPI + discovery |
| `11-crypto-api-docs-page.md` | public docs/landing page for the Crypto Data API |

### Free 3D API — `/api/3d/*` (keyless, free)
| File | Endpoint |
|---|---|
| `12-3d-free-generate.md` | `/api/3d/generate` — free text→3D (NIM/TRELLIS) |
| `13-3d-free-inspect.md` | `/api/3d/inspect` — free glTF/GLB validate + optimize report |
| `14-3d-api-index-and-docs.md` | `/api/3d` index + docs page |

### Paid uniques — generalize & elevate
| File | Work |
|---|---|
| `15-generalize-reputation.md` | agent-reputation → any agent, any chain |
| `16-generalize-identity-verify.md` | onchain-identity-verify → cross-platform trust primitive |
| `17-elevate-forge-listing.md` | Forge Pro: tiers + description + discovery (not the payment layer) |
| `18-elevate-vanity-listing.md` | Vanity Grinder: make it the flagship listing |
| `19-elevate-pump-launch-listing.md` | Pump Launcher: sharpen listing + discovery |

### Cleanup, unification, marketing
| File | Work |
|---|---|
| `20-deprecate-dead-endpoints.md` | retire dance-tip / fact-check / tutor / revenue-vision / mint-to-mesh from the agent catalog |
| `21-unified-catalog.md` | one catalog module both x402scan + OKX.AI read |
| `22-x402scan-profile-overhaul.md` | rewrite the server-level profile, tags, resource descriptions |

## Ground rules (full detail in 00-CONTEXT.md)
- No mocks, no stubs, no TODOs. Real data only. Every state designed.
- Free = keyless, no account, generous limits. Paid = real 402 + real settlement seams.
- Never stop to ask — 00-CONTEXT has a decision default for every common blocker.
- Commit explicit paths, `git push threews main` (only push target), append to PROGRESS.md.
