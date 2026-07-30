# Production Issues — three.ws

Live tracker for known production issues. When an item is fixed, drop it from
this file rather than leaving it here marked ✅ — this file should only contain
work that is still open.

> The 2026-05 incident batch (20 items, all resolved) and the 2026-06 resolved
> items were archived under `docs/internal/`, which was removed from the repo
> along with the rest of the internal content in commit `b80c1c379`. Both
> archives remain readable in git history:
> `git show b80c1c379^:docs/internal/ISSUES-ARCHIVE-2026-05.md`

---

## Open

Re-verified against the live Cloud Run services on 2026-07-22. The 2026-07-04
log-export batch is now mostly closed: `JWT_SECRET` and `WALLET_ENCRYPTION_KEY`
are set on `three-ws-api` (wallet sign-in and custodial provisioning work),
`ADMIN_CODE` is set on `hyperfy-world` (world.three.ws build rights are gated
again), and the reconstruct lane has a real fallback via
`GCP_RECONSTRUCTION_URL`. What remains requires owner/operator action outside
this repo:

1. **LLM paid backstops are dead** (owner billing decision). `OPENAI_API_KEY`
   is set on the service but the account returns `billing_not_active` 429s, so
   every OpenAI paid backstop is out. The OpenRouter platform key burned its
   credit on paid-model routing (invisible in metering: llm-pricing records
   OpenRouter as $0). Traffic survives on the free lanes (Groq/NIM plus the
   vertex-gemini credits anchor). Action: reactivate OpenAI billing and/or
   fund the OpenRouter key, or accept free-lane-only service.
2. **Every paid Solana RPC lane is over quota at once** (owner action: money).
   Re-probed 2026-07-30 with a metered `getBalance` (never `getHealth`, which is
   unmetered and returns ok on an exhausted endpoint): Helius `-32429 max usage
   reached`, QuickNode `-32003 daily request limit reached`, and BOTH Alchemy
   apps (`ALCHEMY_API_KEY` and the key inside `SOLANA_RPC_FALLBACK_URLS`) return
   `429 Monthly capacity limit exceeded` (they share one account quota, so the
   second is not a spare). The dead Alchemy endpoint was also pinned as
   `SOLANA_RPC_URL`, so every production Solana call began by failing over.
   Mitigated in config on 2026-07-30 (revision `three-ws-api-00335-ncg`):
   `SOLANA_RPC_URL` now points at `https://solana-rpc.publicnode.com`, with
   Leo RPC and MagicBlock as `SOLANA_RPC_FALLBACK_URLS`. All three were burst-
   probed 12/12 OK on `getBalance`, `getLatestBlockhash` and
   `getSignatureStatuses`. The exhausted paid lanes stay in the chain and
   re-enter rotation on their own when quota resets (`QUOTA_COOLDOWN_MS` is 6h).
   The platform is therefore up but throttled, which shows up as intermittent
   5xx and slow settles. Action: top up or upgrade a plan, or cut call volume
   via the ring cadence knobs. Note GCP credits cannot help here: Blockchain
   Node Engine is Ethereum-only, so there is no GCP-hosted Solana RPC.

Carried forward from the retired `prompts/x402-catalog/` tracker (campaign
closed 2026-07-28; full history in git):

3. **No web-search key in prod** (owner action, now non-blocking). `BRAVE_API_KEY` /
   `TAVILY_API_KEY` / `EXA_API_KEY` / `SERPER_API_KEY` are all absent on
   `three-ws-api`. This no longer leaves the fact-checker on DuckDuckGo scraps:
   the search chain now leads with Vertex-grounded Google Search (service-account
   auth, GCP credits, no third-party key) and the keyless Wikipedia rung returns
   full intro extracts rather than 150-char highlight fragments. Setting one of
   the four keys is still an upgrade, not a prerequisite.
4. **Fact-check verdict quality, reworked in-repo 2026-07-29, benchmark
   awaiting a clean run** (code). The chain-level defects behind the 20% score
   are fixed: `computeVerdict` now judges direction over stance-BEARING weight
   with a coverage gate (all-neutral evidence returns `insufficient` instead of
   collapsing every class to `mixed`), the Wikipedia rung returns real intro
   extracts, `searchAll` interleaves the three query angles round-robin instead
   of letting query 1 take all five checked slots, and the stance prompt carries
   an explicit rubric that names a differing figure/date/record-holder as a
   contradiction rather than "neutral". The published number is NOT restated
   here because no trustworthy run exists yet: the last one scored 7.5% with 30
   of 40 claims errored (it measured the LLM outage in item 1, not accuracy) and
   `data/_generated/fact-check-benchmark.json` has been removed so `/fact-check`
   renders its honest "not yet run" state. The runner now refuses to publish any
   run with >10% errored claims. Action: re-run
   `node scripts/fact-check-benchmark.mjs` against production once the deploy
   below lands (Vertex answers there, so the chain is not degraded).
5. **ASR/media backstops unconfigured** (owner action).
   `NVIDIA_ASR_FUNCTION_ID` unset in prod (`/api/v1/ai/asr` returns 503
   `not_configured`); the Replicate account is out of credit; Upstash Redis is
   absent on `three-ws-api`.
6. **ENS resolution was live-broken; fixed in-repo 2026-07-29, awaiting
   deploy.** `GET /api/v1/resolve?name=vitalik.eth` returned 503
   `ens_unavailable` (measured 9.7s and 12.4s against the 8s budget) while the
   `.sol` lane worked. Two root causes, both fixed: `RPC_URL_ETHEREUM` pointed
   at `eth.llamarpc.com`, which Cloudflare bot-walls with a 403 on datacenter
   POSTs, and an operator override is pinned first, so every call burned a
   guaranteed failure before failing over; and the handler used ethers
   `resolveName`, which walks registry, resolver, supportsInterface and addr as
   separate sequential round trips, multiplying that cost 3-5x. Now:
   `api/_lib/evm/rpc.js` sorts known-hard-fail keyless hosts last (kept, never
   dropped), and `api/v1/resolve.js` resolves through viem's ENS Universal
   Resolver in one `eth_call` per direction. Measured keyless (no Alchemy key,
   as production runs): 269ms forward, 234ms reverse, and a miss now returns a
   404 instead of timing out. Cover: `tests/evm-rpc-endpoint-order.test.js`,
   ops probe: `node --env-file=.env scripts/probe-evm-rpc.mjs --chain 1 --ens`.
   The same broken walk was in three more call sites, all now routed through
   the shared `api/_lib/evm/ens.js` helper: `/api/agents/ens/:name` (3s budget,
   so it timed out on every name), the x402 identity-claim verifier (5s, which
   silently downgraded every ENS claim to "no evidence"), and `/api/v1/resolve`.
   All verified resolving keyless end to end.
   Verify after the next deploy, then drop this item. The related operator
   action is already moot: `RPC_URL_ETHEREUM` is not set on the `three-ws-api`
   Cloud Run service at all (checked 2026-07-30), so there is nothing to
   repoint or unset. Re-measured live the same day, production still returns
   503 `ens_unavailable` on `vitalik.eth` while `three.sol` resolves in 246ms,
   which confirms the remaining gap is purely the undeployed fix.

7. **BSC testnet contracts are code-complete but never publicly deployed**
   (owner action; re-homed here 2026-07-30 when the BNB Chain campaign's work
   orders were retired). Every contract proof in that campaign ran against an
   anvil fork or a local instance because no funded deployer key exists:
   `BNB_TESTNET_DEPLOYER_KEY` is absent from the shell env, the root `.env`, and
   `contracts/.env`, and the public faucet is reCAPTCHA-gated, so the
   `GreenfieldVault` and `WorldMoves` deploys and every real Greenfield write
   never happened. The deploy scripts are dry-run verified and unchanged
   (`forge script script/DeployGreenfieldVault.s.sol` /
   `script/DeployWorldMoves.s.sol --broadcast`, both documented in
   [contracts/DEPLOYMENTS.md](contracts/DEPLOYMENTS.md)). Action: fund a
   throwaway EOA at `https://www.bnbchain.org/en/testnet-faucet`, set
   `BNB_TESTNET_DEPLOYER_KEY` (and `GREENFIELD_VAULT_OPERATOR_KEY`, which falls
   back to the same key), re-run the two scripts, then set
   `WORLD_MOVES_ADDRESS_TESTNET`. No code change is needed: the moment the
   address exists, `/api/bnb/world-config` starts returning `deployed:true` for
   real visitors and the sender/reader/ghost paths light up as already proven.
   Full history: `prompts/bnb-chain/PROGRESS.md`.
