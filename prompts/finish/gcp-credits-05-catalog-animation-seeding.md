# GCP-05: Bulk catalog and animation seeding on the self-hosted GPU fleet

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/gcp-credits-05-catalog-animation-seeding.md`".
It is complete on its own. Also read `prompts/finish/gcp-credits-README.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. Blockers have pre-answered routes at the bottom. Use them and keep going.
3. CLAUDE.md hard rules: no mocks, no fake data, no TODO comments, no em-dash or en-dash
   characters. Stage explicit paths only; other agents share this worktree.
4. GPU spend on the self-hosted fleet is pre-approved (credits). Curation beats volume: a
   catalog of 5,000 junk meshes is worse than today's catalog.

## Mission

Turn credits into durable platform content: a much larger curated avatar catalog and a
generated text-to-motion clip library, both quality-gated, both browsable at the new scale.

## Step 0: re-derive current state (trust nothing below)

```bash
gcloud run services list --region us-central1 --project aerial-vehicle-466722-p5 \
  --format="value(metadata.name,status.conditions[0].status)" | grep -E "trellis|text2motion|rig|hunyuan"
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=yaml | grep -E "GCP_TEXT2MOTION_URL|MODEL_TRELLIS_URL|FORGE_SELFHOST_PRIMARY|SEED_CRON_BATCH"
sed -n '1,40p' api/cron/forge-seed-cron.js
node -e "const d=require('./data/motion-prompts.json');console.log(Object.keys(d), d.prompts?.length)"

# clip library: total, and how many are NOT the Mixamo import
curl -s "https://three.ws/api/animations/library" | python3 -c \
  "import sys,json;d=json.load(sys.stdin);n=[c['name'] for c in d['clips']];print('clips',d.get('total'),'non-mixamo',sum(1 for x in n if not x.startswith('mx-')))"

# catalog size, through the repo's own db helper (psql is not installed here)
cat > /tmp/catalog-count.mjs <<'EOF'
import fs from 'node:fs';
if (!process.env.DATABASE_URL) {
  const m = fs.readFileSync('/workspaces/three.ws/.env', 'utf8').match(/^DATABASE_URL=(.*)$/m);
  if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
}
const { sql } = await import('/workspaces/three.ws/api/_lib/db.js');
console.log('avatars', (await sql`select count(*)::int as n from avatars`)[0].n);
console.log('last 7d', (await sql`select count(*)::int as n from avatars where created_at > now() - interval '7 days'`)[0].n);
EOF
node /tmp/catalog-count.mjs
```

**Measured 2026-08-01, re-measure before trusting it:** 18,622 avatars in the catalog with 104
added in the previous 7 days, so the seed cron runs but at roughly 15 a day. The clip library
serves 2,874 clips and **every one is the `mx-` Mixamo import: zero generated clips exist**, so
section B below is entirely open. `data/motion-prompts.json` (the section B prompt library),
`api/cron/forge-seed-cron.js`, `api/_lib/seed-prompts.js`, `api/marketplace/animations.js`,
`api/x402/animation-download.js` and `api/animations/library.js` all exist;
`scripts/gcp/seed-avatars.mjs` does not.

That shape sets the priorities: the cron is alive but slow and unproven on quality, and the
generated-motion half has never run. Do not spend the session re-confirming that the cron
exists.

## Tasks

### A. Avatar catalog seeding (target: several thousand curated avatars)

1. **Point the seed cron at the self-hosted lane** when `FORGE_SELFHOST_PRIMARY=1`, and make
   cadence and batch size env-tunable (`SEED_CRON_BATCH`, default equals current behavior, so
   the change is a no-op when unset).
2. **Broaden `api/_lib/seed-prompts.js`**: professions, fantasy, sci-fi, styles, with attention
   to what makes a good rigged avatar (humanoid, front-facing, full-body). Keep every prompt
   coin-neutral: no crypto project other than $THREE, ever, in committed content.
3. **Automated quality gate before publish**: render a thumbnail, run it through the vision
   check (`api/vision.js` / `api/_lib/vision.js`) for humanoid, complete body, not a blob, plus
   mesh sanity (vertex-count bounds, has texture). Rejected assets stay in R2 under a
   `forge/rejected/` prefix with the reason, for tuning. Track and report accept rate.
4. **Rig the keepers** through the rig worker so catalog entries are animation-ready, and spot
   check a sample in the viewer with idle and walk clips playing. A catalog avatar that T-poses
   is half-built.
5. **Resumable batch runner** `scripts/gcp/seed-avatars.mjs`: checkpoint file, safe to re-run,
   parallelism tuned to the deployed GPU count, asserts the backend actually used and aborts on
   fallthrough to any paid third-party lane. Run one real batch of 500 end to end, report
   accept rate and cost per accepted asset, then continue only if quality holds.

### B. Animation library seeding (target: several hundred curated clips)

6. **Use `data/motion-prompts.json`** as the prompt library (extend it if categories are thin;
   it is data, never hardcoded).
7. **Generate, retarget, publish**: clips through `GCP_TEXT2MOTION_URL`, converted to the exact
   canonical-skeleton clip JSON the library already serves (inspect a real clip from
   `GET /api/animations/library` first and match it byte-shape), uploaded under a distinct
   prefix, manifest updated. Quality gate: sane duration, no NaN keyframes, plays on the default
   rig without foot-sliding. Spot-check a sample visually.
8. **List the generated set** in `api/marketplace/animations.js` under a platform creator
   identity, priced consistently with existing listings, downloadable through the existing x402
   route. Implement a rotating free subset mechanism and record the policy choice you made.

### C. Scale-proofing

9. At 5 to 10 times the current catalog size, verify `/gallery`, `/dashboard/avatars`,
   `/animations` and the marketplace list endpoints paginate rather than fetch-all, that
   thumbnails lazy-load, and that API responses stay bounded. Fix what breaks: pagination,
   indexes on the avatars table, manifest sharding. Test at realistic counts, not ten items.

## Definition of done

- [ ] Seed cron on the self-hosted lane and env-tunable; quality gate live with a measured
      accept rate.
- [ ] First avatar batch published: rigged, animated in the viewer, browsable in the gallery.
- [ ] Generated motion clips live in the library and the marketplace, sample visually verified.
- [ ] Scale test at target counts passes on all four surfaces, with the fixes committed.
- [ ] Cost per accepted asset and accept rate recorded in `docs/gcp-credits.md`.
- [ ] `npm test` green; `git diff` reviewed (no esbuild-mangled `api/` files: check `head -1`
      for `__defProp`).
- [ ] `data/changelog.json` entries for the bigger catalog and the new generated-animation
      collection, in plain language.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| A self-host lane is not Ready | Deploy or scale it (credits approved) using the bind-first pattern in `workers/model-trellis/main.py`. If a lane genuinely cannot come up, seed with the lanes that are up and report which one is missing. |
| Accept rate is poor | Stop scaling, tune prompts and gates first, and report the numbers honestly. Volume without curation fails this work order. |
| A batch would fall through to a paid third-party lane | Assert the backend in the batch script and abort. Never let bulk spend leave the credits. |
| Database migration needed for an index | `npm run db:status` first (it previews), then `npm run db:migrate` applies every pending migration immediately with no dry run. Read the pending list before running it. |
| Vision QA rejects everything | Inspect ten rejected thumbnails yourself before touching the threshold; a broken render pipeline looks exactly like a strict gate. |

## Report format

Counts published, accept rates, spend, cost per accepted asset, the four scale-test results,
and any single remaining owner action. No recap of this file.
