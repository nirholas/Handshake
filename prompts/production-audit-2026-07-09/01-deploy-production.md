# 01 — Ship the 34 undeployed commits (including the /app + /chat routing fix)

## Mission

Production is running a Cloud Run revision built 2026-07-08 02:28 UTC. HEAD on `main` is
2026-07-09 20:21 UTC — 34 commits ahead, all already merged, all already passing local build
checks. Deploy them. This single action fixes the majority of what the 2026-07-09 production
audit found broken, including three of the highest-traffic routes on the site.

## Why this is first

Nothing in the other 8 prompts is worth doing before this ships, because:

1. **`/app` and `/chat` are currently infinite-redirect-looping for every real visitor.** This
   was root-caused and fixed during the audit (see `server/index.mjs` — a `hasMatches()`
   evaluator was added and wired into the three route-matching passes that previously ignored
   Vercel's `has` route conditions, which caused `/app`, `/chat`, and `/agents/:id` to always
   match bot-only OG rules meant to be gated to social-preview crawlers). That fix is committed
   but not deployed.
2. **`/minted`, `/creations`, `/vault` currently 404 live** even though their `.html` files
   exist in `dist/` right now and pass every static build check — they were never shipped.
3. Every other prompt in this pack ends with "verify against production" — that verification is
   only meaningful once production actually matches `main`.

## What's in the gap (representative, not exhaustive — `git log` is authoritative)

- `feat(bnb-vault): vault UI (/vault)` — browse, buy, unlock, view
- `feat: add quest markers and NPCs for job interactions`
- `feat: implement economy UI with store and bank functionalities`
- `fix(tokenized-3d): unwrap /api/v1 gateway envelope in the /minted gallery`
- `fix(liquidations): resolve coin-id links for the /coins liquidations strip`
- `feat(liquidation-collector): standalone futures liquidation service`
- `feat(market-data): DeFiLlama yield-pool API`
- `feat(viewer): keyboard-accessible canvas + low-power auto-degrade`
- `feat(tour-builder): Sperax preset — guided tour of USDs`
- the `server/index.mjs` `hasMatches()` routing fix described above
- 25 more — run `git log --oneline <last-deployed-sha>..HEAD` to get the full list (see below
  for how to find the last-deployed sha).

## Tasks

1. **Confirm the deployed revision and the gap.**
   ```bash
   gcloud run services describe three-ws-api --region us-central1 \
     --format='value(status.latestReadyRevisionName,status.traffic[0].revisionName)'
   gcloud run revisions describe <revision-name> --region us-central1 \
     --format='value(metadata.creationTimestamp)'
   git log --oneline --since="<that timestamp>" | wc -l
   ```
   Confirm the count is in the neighborhood of 34 and skim `git log --oneline` for anything that
   looks unfinished, WIP, or explicitly marked do-not-deploy. If everything on `main` looks
   intentional and merged (it should — this is normal trunk-based flow per root `CLAUDE.md`),
   proceed.

2. **Sanity-check the build before shipping.**
   ```bash
   npm run build
   npm run check:dist
   ```
   Confirm `dist/minted.html` (or wherever the minted gallery page actually lives — check
   `data/pages.json` for the real path), `dist/creations.html`, and `dist/vault.html` exist and
   are non-empty. If `check:dist` fails, stop and fix the failure — do not deploy a broken build.

3. **Deploy.**
   ```bash
   npm run deploy:gcp
   ```
   This runs `gcloud builds submit --config server/cloudbuild.yaml --region us-central1
   --project aerial-vehicle-466722-p5`. Watch the build log to completion; do not background it
   and walk away, since this is the highest-blast-radius action in this entire prompt pack (it's
   a production deploy of 34 commits at once).

4. **Verify the specific regressions the audit named, against the live site:**
   - `curl -sI https://three.ws/app` — must return a real page (200/no redirect loop), not a
     302 back to `/app`.
   - `curl -sI https://three.ws/chat` — must resolve, not 301-loop through `/app`.
   - Load `https://three.ws/agents/<a-real-agent-id>` in a browser (pick any id from
     `/api/agents` or the `/agents` list) — must render the agent detail page, not redirect to
     the `/agents` list.
   - Confirm bot traffic still reaches the OG handlers (the fix must not have broken the thing
     it was gating): `curl -sI -A "facebookexternalhit/1.1" https://three.ws/app` should still
     route to the OG handler's response, not the app shell.
   - `curl -sI https://three.ws/minted` , `/creations` , `/vault` — must all return 200, not 404.

5. **Spot-check 3–5 more items from the "in the gap" list above** against production (e.g. load
   `/vault`, check the store/bank UI mentioned in the economy-UI commit, hit the new DeFiLlama
   yield-pool endpoint) to confirm the deploy actually picked up the full commit range, not a
   stale cache.

## Verification (must all pass before reporting done)

- [ ] `gcloud run services describe three-ws-api` shows a `latestReadyRevisionName` created
      **after** this deploy, receiving 100% traffic.
- [ ] `/app` and `/chat` resolve without redirect loops for a plain (non-bot) UA.
- [ ] `/agents/<id>` serves the real detail page.
- [ ] `/minted`, `/creations`, `/vault` all return 200 live.
- [ ] Bot UA still reaches the OG-preview handlers on `/app`.
- [ ] No new errors introduced — spot-check `/api/healthz` for any subsystem that flipped from
      healthy to degraded/down as a result of this deploy (should be none; this is a code-only
      deploy, no env/infra change).

## Do not

- Do not cherry-pick a subset of the 34 commits — deploy `main` as-is. If something on `main`
  turns out to be broken, fix it forward with a new commit; do not deploy a stale sha.
- Do not skip step 4's bot-UA check — the whole point of the routing fix is that it must satisfy
  *both* plain visitors and bots at once.
