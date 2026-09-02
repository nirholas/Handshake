# RM-GEN: Generation suite parity and production truth

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/roadmap-generation-suite.md`".
It is complete on its own. Also read `prompts/finish/roadmap-00-README.md` (safety doctrine and the
regression gate) and `CLAUDE.md`.

## Binding operating clause

1. Finish 100%. Never end with a question, a plan you did not execute, or "should I proceed?".
2. "Works" means verified in production by running it, after deploy. Tests passing is not the
   bar; a stranger getting a GLB is the bar.
3. Fix the smallest broken thing that unblocks a whole flow before building anything new.
4. CLAUDE.md hard rules: no mocks, no stubs, no TODO comments, no em-dash or en-dash
   characters. Stage explicit paths only. Deploys are owner-gated: prepare them so the ship is
   one command.

## Mission

A generation suite that matches Meshy and Tripo on quality and beats them on agent-nativeness,
and that actually works in production. The repo has the surface area; the gap has historically
been between "code exists" and "a user can run it on three.ws today".

## Step 0: rebuild the truth table (mandatory, replaces every claim below)

The June 2026 audit that this file used to carry is stale: several workers that it listed as
undeployed are Ready now. Do not read old status from anywhere. Probe production yourself and
write the table into your report:

```bash
gcloud run services list --region us-central1 --project aerial-vehicle-466722-p5 \
  --format="table(metadata.name,status.conditions[0].status)"
gcloud run services describe three-ws-api --region us-central1 \
  --project aerial-vehicle-466722-p5 --format=yaml | grep -E "^ *- name: (GCP_|MODEL_|LONGCAT_|REPLICATE_)" -A1
curl -s "https://three.ws/api/forge?catalog" | python3 -m json.tool | head -60
curl -s "https://three.ws/api/forge?health" | python3 -m json.tool | head -60
```

Then, for each row, run the real flow end to end against production and record the outcome:

| Feature | Endpoint | Probe |
|---|---|---|
| Text to 3D | `POST /api/forge` | submit, poll to `done`, download the GLB, assert it parses with geometry |
| Image to 3D | `POST /api/forge` | presign, upload, submit, poll, download |
| Auto-rig | `POST /api/forge?action=rig` | rig a real mesh, assert bones and skin weights exist |
| Remesh / retopo | `POST /api/forge-remesh` | real mesh in, real mesh out |
| Stylize | `POST /api/forge-stylize` | same |
| Segment | `POST /api/forge-segment` | same |
| Background removal | `POST /api/forge-rembg` | real image in, alpha out |
| Text to motion | `POST /api/forge-motion` | clip out, plays on the default rig |
| Retexture | `POST /api/studio/retexture-*` | textures actually change |
| Talking avatar | the longcat worker route | real video out |
| x402 paid generation | `POST /api/x402/forge` | 402, pay, artifact |
| MCP 3D Studio tools | `POST /api/mcp-studio`, `/api/mcp-3d` | `tools/list` then a real `tools/call` |

A `configured: true` in the catalog means an env var exists, nothing more. That is exactly how
dead flows once looked green. Only a real artifact counts.

## Tasks

1. **Close every red row from Step 0.** Root-cause each (missing env var, worker not Ready,
   provider regression, schema drift), fix it, and re-run the same probe. If the fix needs a
   deploy, stage everything and name the one command.
2. **Health that tells the truth.** `GET /api/forge?health` must live-probe each provider
   (cheap authenticated HEAD or equivalent) rather than reporting on env-var presence. Add or
   extend the scheduled smoke test so a draft generation runs daily and alerts on failure.
3. **Surface the hidden tools in `/forge`.** Retexture (full and region), remesh, stylize,
   segment, rig, animate and export exist as APIs or MCP tools; the result panel should offer
   them as one pipeline on one page. Every button wired to the real endpoint.
4. **Preview then refine.** Cheap fast preview, then a one-click refine of the chosen result at
   a higher tier conditioned on the same seed and reference. The tier system already exists.
5. **Export formats.** The remesh worker already converts glb, obj, stl, ply, usdz, 3mf and fbx.
   Expose a format picker on download instead of GLB-only.
6. **PBR material controls.** Expose the map outputs (albedo, normal, roughness, metallic) and
   a re-bake option in the result panel. Coordinate with `prompts/quality-bar/04-...` rather
   than duplicating it.
7. **Job webhooks and public API docs.** Extend the existing Replicate webhook plumbing to
   forge jobs and publish the endpoint contract in `docs/` with runnable examples, since we
   sell it through x402.
8. **Community gallery.** Add an opt-in public showcase over the existing private gallery, with
   a remix action that generates a variation.

## Definition of done

- [ ] Step 0 table filled in from real production probes, every row green or explained with a
      named blocker and a one-command fix.
- [ ] `/api/forge?health` live-probes providers; the daily smoke test covers what you shipped.
- [ ] Every newly surfaced tool clicked through in a real browser at 320, 768 and 1440 px, with
      loading, empty, error and success states designed.
- [ ] `npm run gate` no worse than the baseline you captured at the start; `npm test` green.
- [ ] `data/changelog.json` entries for the user-visible additions; docs updated for the API
      contract.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| A worker is not deployed | Deploy it from `workers/<name>/cloudbuild.yaml` with the pinned build and runtime service accounts. Staging weights from `gs://three-ws-model-weights` is part of the task. |
| An env var is missing | Look in `.env`, then the Cloud Run service, then Secret Manager. Update single vars with `--update-env-vars`; `--set-env-vars` replaces the entire set. |
| A third-party provider 404s or throttles | Use the failover chain in `api/forge.js`; if a rung is missing, adding it is part of the task. |
| `gcloud` auth dead | Do everything else, then put the exact commands in the report; one `gcloud auth login` clears it. |
| A deploy is required | Owner-gated. Prepare it, name the single command, and finish everything else. |
| Production is behind `main` | Check `curl -s https://three.ws/api/version` against `git log` before debugging a "broken" feature. A stale revision explains most phantom failures. |

## Report format

The Step 0 truth table (before and after), the root cause per red row, what you shipped, and
the single owner action if one remains. No recap of this file.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/roadmap-generation-suite.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
