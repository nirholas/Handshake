# Work order 06: the fabrication gate, docs, spec, and launch

**How to run:** paste this whole file into a fresh Claude Code chat in this
repo, or name its path. Read `prompts/finish/materialize-00-CONTEXT.md` first; its
decisions bind this order.

**Binding operating clause:** finish 100%. Never end with a question or an
unexecuted plan. CLAUDE.md hard rules apply: no mocks, no fake data, no
unfinished markers, no em-dash, explicit-path commits. Production deploy
and any public announcement remain owner-gated; this order ends with the
ship being one command and one yes.

## Why this order exists

Physical manufacturing raises the stakes of everything the platform
already moderates: a refused image generation costs nothing, a printed
firearm component is a crime. The gate must be code. And a surface this
novel without docs is invisible: the docs are how users, agents, and the
partner's engineers discover that prompt-to-object exists. This order
closes both, then assembles the launch.

## Step 0: re-derive current state

```
ls prompts/materialize/            # which orders already retired?
ls docs/materialize.md specs/PRINT_PIPELINE.md 2>/dev/null
grep -n "print" data/changelog.json | head
cat api/_mcp-studio/safety.js | head -80
npm test -- tests/api/print 2>/dev/null | tail -3
grep -rn "screening" api/_lib/print-store.js | head
```

All prior orders' deliverables must be verified on disk (the shrinking
pack directory is the ledger, but verify the code, not the ledger). Any
gap found belongs to this session now; fix it, never report around it.

## Tasks

### 1. The fabrication gate (`api/_lib/print/gate.js`)

Runs twice per order: at quote time (cheap, fail fast, nothing charged)
and again on the `paid → screening` transition (thorough, auto-`rejected`
+ refund path on failure). Layers, all real code with tests:

- Reuse the upstream generation safety verdicts: a creation the forge
  gate flagged never reaches a printer (re-derive where forge/mcp-studio
  verdicts are recorded; read `api/_mcp-studio/safety.js` and
  `docs/mcp-safety.md`).
- Fabrication-specific denylist evaluated over prompt lineage + model
  title + buyer note: firearm parts and receivers, suppressors, working
  weapon mechanisms, keys or bypass tools for real locks, counterfeit
  branded goods and logos/trademarks, ammunition. Structured rules with
  per-rule tests, not one regex blob.
- LLM screening pass over the same lineage through the platform's
  existing LLM chain (`api/_lib/llm.js`) with a constrained verdict
  schema, results recorded on the order (`analysis.screening`), the
  denylist always winning over a permissive LLM verdict.
- Geometry heuristics where cheap and honest (e.g. blade-profile aspect
  ratios are NOT reliably detectable; do not pretend otherwise, and say
  so in the spec's limitations section).

Every refusal is designed UX: names the category, links the content
policy, offers what is allowed. Refusals emit the same ops-channel
notification as stalls (order 04), so a human reviews edge cases.

### 2. The spec (`specs/PRINT_PIPELINE.md`)

The wire contracts other code depends on: printability report v1 (every
field, units, the score deductions), quote token claims, order states +
legal transitions, adapter interface, webhook envelope + HMAC, certificate
memo payload, gate verdict shape and its stated limitations. Follow the
depth of the neighboring specs in `specs/`.

### 3. Docs (every layer from CLAUDE.md's documentation section)

- `docs/materialize.md`: the feature doc, zero-context reader, linked
  from `docs/start-here.md` and `docs/nav.json` per how sibling docs are
  wired. Covers the user flow, materials, pricing model shape, the agent
  lane with a runnable x402 example, certificates, and the content
  policy.
- `docs/api-reference.md`: the `/api/print/*` endpoints in the house
  format; the x402 endpoint listed with its siblings.
- STRUCTURE.md: one row for Materialize mapping every path this campaign
  created.
- `data/changelog.json`: one holder-readable entry (tags: feature), plus
  a second entry if certificates shipped separately. `npm run build:pages`
  validates.
- MCP: if the platform's MCP studio exposes forge tools, add the
  analyze/quote tools there so agents discover the lane the same way they
  discovered generation (re-derive the tool registry location; follow an
  existing tool's shape end to end including its safety wiring).

### 4. Launch assembly

- `npm run audit:docs` green; `npm test` green; `npm run gate` run and
  triaged (fix what your campaign broke; pre-existing reds noted per the
  never-blocked table).
- Walk the CLAUDE.md definition-of-done checklist against the whole
  surface in a real browser and record it in the report.
- Owner ship-list, one message: deploy command (`npm run deploy:gcp:full`
  after the runbook's worktree steps), the partner/env residuals from
  order 04, mainnet cert approval from order 05, and suggested changelog
  timing. Nothing else may remain.

## Definition of done

- [ ] Gate tests cover every denylist category (allow + deny cases) and the two run points; `npm test` green.
- [ ] A crafted violating order is refused at quote time on the dev server, and a paid fixture reaching `screening` auto-rejects, both evidenced in the report.
- [ ] `specs/PRINT_PIPELINE.md` exists and matches the shipped code (spot-check three fields against live responses).
- [ ] `npm run audit:docs` passes; changelog entry validates via `npm run build:pages`.
- [ ] STRUCTURE.md row, docs/nav.json wiring, api-reference section all present.
- [ ] `npm run check:rules -- --paths <files you touched>` passes.
- [ ] Committed with explicit paths; this file AND the campaign README/context retire per the pack's retirement policy once PROGRESS.md records final evidence.

## Never blocked

| Blocker | Resolution |
|---|---|
| Upstream verdict storage unclear | Read the mcp-studio safety module and grep where its verdicts persist; if generation verdicts are not persisted, gate on re-evaluation of the lineage text and note the gap as a one-line owner FYI, not a stall. |
| LLM chain budget | The free-first chain in `api/_lib/llm.js` is the platform default; screening prompts are short. Use it as-is. |
| `npm run gate` has pre-existing reds | Fix what blocks your verification path; list the rest with one line each. Never let someone else's red stop your green (CLAUDE.md playbook). |
| Content-policy page to link | If none exists for fabrication, add the section to the existing policy/legal page the platform links elsewhere; a refusal must never link a 404. |
| Announcement copy | Changelog entry is the deliverable; social/announce content is owner-gated publishing and goes in the ship-list message only. |

## Report format

The final campaign report: every order's deliverables verified on disk,
gate evidence, docs/audit results, the one-message owner ship-list, and
PROGRESS.md's closing entry.
