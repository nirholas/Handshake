# 10. Finish the x402scan listing

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> **Commit gate.** This touches a third-party registry. Any commit into three.ws
> whose diff names it needs owner approval first.

## Where this stands (re-measured 2026-09-02)

The indexer lists settlements per facilitator address from a registry in the
upstream repo. Our self-hosted Solana facilitator settles from fee payer
`WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`.

**The facilitator listing is done and live.** PR #1032 **merged 2026-08-11**
with no review requested, so the reviewer-verification comment that blocked
this for six weeks was never needed and is now moot. Measured the same day, all
without credentials:

| Fact | Value | How it was read |
|---|---|---|
| PR #1032 | `MERGED` 2026-08-11T20:01:45Z, 4 commits, 0 reviews | `gh pr view 1032 --repo Merit-Systems/x402scan` |
| Facilitator page | live, both fee payers rendered | `https://www.x402scan.com/facilitator/three-ws` |
| Attribution | 18,636 transactions, $1,055.01 USDC, latest settle same day | that page's payload |
| Origin listing | 60 resources, none deprecated, re-crawled by them 2026-08-27 | `https://www.x402scan.com/server/17cbd874-52ac-4920-a020-b22ff2489a07` |
| Discovery crawl | 46 pages, 4,519 items, `total` stable, 0 duplicate identities | their `listAllFacilitatorResources` replayed against production |
| Config URLs | `/supported` 200, logo 200, `docsUrl` 200 | `curl` |
| CDP Bazaar | three.ws in 0 of 15,127 catalog resources | full paged sweep of the CDP catalog |

Solana settlement is unchanged and still self-hosted. Nothing in this arc has
re-pointed, demoted, or touched the Solana rail, and nothing here should.

## What the re-verify found, and what it fixed

Their registration flow reads **`/openapi.json`**, not the facilitator catalog
(their facilitator crawl is still paused upstream: `FACILITATOR_SYNC_PAUSED =
true` in `apps/scan/src/app/api/resources/sync/route.ts`, re-checked
2026-09-02). That document hand-enumerated 24 of the 75 live paid services, so
52 endpoints answered a spec-valid 402 in production while being impossible to
register. That is why the origin has sat at 60 resources since 2026-07-11.

Fixed in the tree, not yet deployed: `catalogPaidPaths()` in
[api/openapi-json.js](../../api/openapi-json.js) projects every live paid
service from `api/_lib/service-catalog/` into the document, spread before the
hand-authored paths so the 24 richer entries keep their exact wording.
`/api/x402/*` operations went 24 → 79, with zero change to any existing path.
Five guards in [tests/openapi-aggregator.test.js](../../tests/openapi-aggregator.test.js)
keep it from reopening.

## What remains

1. **Deploy.** The `/openapi.json` fix is in the tree and production is behind
   `main`. Until it ships, registration still sees 24 endpoints.
2. **Register the missing resources** (owner: one SIWX wallet signature, no
   funds move). 53 live endpoints answer a valid 402 today and are absent from
   the origin listing. After the deploy, the whole set is reachable from
   `/openapi.json`, so the "Add API" flow for origin `https://three.ws` at
   <https://www.x402scan.com/resources/register> picks them up in one pass.
   Wallet sign-in is a signature, not a spend, but it binds an identity: render
   what is being signed and get an owner yes.
3. **Five endpoints cannot be registered until work order 01 lands capital.**
   `dance-tip`, `feed-health`, `ring-settle`, `spend-session` and `three-buy`
   are Solana-only, so while the sponsor wallet is under its SOL settle floor
   they answer 503 `settlement_unavailable` instead of a 402 and any probe
   fails. This is correct behavior, not a bug: every Base-carrying endpoint
   keeps its 402 through the same outage.
4. **Optional Base leg.** three.ws is in none of the CDP Bazaar's 15,127
   resources, exactly as documented: indexing is triggered by a settle through
   the CDP facilitator on Base, and production has no `X402_BUYER_PRIVATE_KEY`
   to pay from. It is a nice-to-have. **Never re-point Solana settlement to a
   third-party facilitator for visibility.** Listing is additive, Solana stays
   self-hosted, and an EVM-only directory is a footnote, not a goal.

## Verify

```sh
gh pr view 1032 --repo Merit-Systems/x402scan --json state,mergedAt
curl -s https://three.ws/api/x402-facilitator/discovery/resources \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['pagination']['total'], 'resources')"
curl -s https://three.ws/openapi.json \
  | python3 -c "import json,sys; p=json.load(sys.stdin)['paths']; print(len([k for k in p if k.startswith('/api/x402/')]), 'paid paths')"
npx vitest run tests/openapi-aggregator.test.js tests/service-catalog.test.js
```

The third command reads 24 against production today and 79 after the deploy.

## Definition of done

- [x] PR #1032 state re-read and reported: merged 2026-08-11, attribution live.
- [x] The verification comment is moot; the PR merged without it.
- [x] The discovery endpoint's live output matches what the PR registers,
      proven by replaying their own crawler against production.
- [x] Solana settlement unchanged and still self-hosted.
- [ ] Origin registration: blocked on the deploy, then one owner wallet
      signature. The exact 53 endpoints are listed in PROGRESS.md.
- [x] [PROGRESS.md](backlog-PROGRESS.md) updated.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/backlog-10-x402scan-listing.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
