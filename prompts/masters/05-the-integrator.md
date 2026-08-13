# MASTER 05: The Integrator (wire it into everything adjacent)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, then add `TARGET: <one line naming the feature>` or the Designer's
HANDOFF block. Read [README.md](README.md) for the relay protocol. This file is complete
on its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Every connection this
   stage identifies is either wired or explicitly parked in open-risks with a reason;
   "could be integrated later" without a reason is a failed line item.
2. Integration code is production code: real calls, designed failure paths, tests where
   logic can fail silently. No em-dash or en-dash anywhere; explicit-path commits.
3. Solana first: any value-transfer connection leads with the Solana rail; an EVM leg is
   additive and never reframes the work.

## Mission

The best platforms feel like everything is linked. A feature that works but stands alone is
half-built: this stage wires the target into every surface where a user, an agent, or a
developer would expect to meet it. Isolation is the defect; this stage removes it.

## Step 0: re-derive current state

```bash
grep -rn "<feature route or key noun>" src/ pages/ api/ --include=*.js --include=*.html -l
cat STRUCTURE.md | grep -i "<adjacent nouns>"     # the surfaces that should link here
ls api/_mcp3d/tools/ api/_mcp-studio/             # the MCP tool surfaces
ls sdk/ packages/ | head -20                      # the developer surfaces
```

Build the integration matrix first: every surface that could touch the feature, with its
current state (wired, missing, not applicable). The matrix is the work list and ships in
the report.

## Method

Sweep the platform's connection planes in order. For each plane: wire it, or mark N/A with
one honest line.

1. **Navigation and discovery.** The feature is reachable from the surfaces users actually
   start at: relevant nav, the owning page's cards or lists, in-product cross-links both
   directions (the feature links back to what feeds it). If the platform's search or
   command surfaces index pages, the feature is indexed.
2. **Data cross-pollination.** What the feature produces appears where users would look for
   it: profiles, dashboards, feeds, leaderboards, galleries. What it consumes deep-links
   back to its sources. One new capability multiplied across existing surfaces is the
   cheapest feature the platform can ship; name at least one such multiplication and wire it.
3. **Agent plane.** If an agent could usefully drive the capability, expose it as an MCP
   tool following the existing patterns in `api/_mcp3d/tools/` or `api/_mcp-studio/`
   (free vs paid ladder per the neighbors, store-clean response shapes where the tool could
   ship to the app stores). Register it everywhere the existing tools are registered.
4. **Developer plane.** If a developer could want it programmatically: the API shape is in
   `docs/api-reference.md`, and the relevant SDK under `sdk/` or `packages/` gains the
   method following its existing export and README conventions. A capability worth an SDK
   method is worth its README example.
5. **Embed plane.** If the feature renders something third parties would want on their own
   sites, check whether an existing embed surface (viewer, page-agent, concierge lineage)
   should carry it; wire the smallest real version or park with a reason.
6. **Notification and feed plane.** If the feature produces events users would follow,
   connect the existing channels (in-product feeds, the changelog lane for holder-visible
   milestones). Never invent a parallel notification system.
7. **Verify every connection round-trip in a real browser or client:** the link renders,
   the click lands, the data flows, the MCP tool answers a real call, the SDK method runs
   in its README example form.

## Definition of done

- [ ] Integration matrix complete: every plane wired or N/A with a reason; zero blank cells.
- [ ] Every wired connection verified round-trip with real data; evidence in the report.
- [ ] At least one cross-pollination shipped (the feature's data enriching an existing
      surface, or an existing surface's data enriching the feature).
- [ ] MCP or SDK exposure shipped where applicable, following neighboring patterns exactly,
      with docs updated in the same change.
- [ ] No dead paths introduced: every new link, button, and state reachable and working.
- [ ] `npm test` green (unpiped exit code); `npm run check:rules -- --paths <files>` clean;
      explicit-path commits per topical slice.
- [ ] HANDOFF block emitted, `next-stage: 06-the-adversary.md`, with the matrix summarized
      in `state`.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| An adjacent surface is broken before you touch it | Fix it if it blocks your connection's verification path; otherwise wire up to the boundary, note the pre-existing break in open-risks. |
| A connection wants a surface that does not exist | Build the smallest real version if it is hours, not days; otherwise park it in open-risks as a named future target for the Frontier stage. |
| MCP store-cleanliness rules conflict with platform ids | Follow the existing store-clean twin pattern (the repo already does this: a clean variant beside the full one). |
| Unsure whether a plane is worth wiring | Wire it if a real user story reaches it in one sentence; otherwise N/A with that sentence. Do not gold-plate planes nobody reaches. |
| Another agent is mid-edit on a file you need | Re-read before each edit, pathspec-commit your own hunks promptly, continue. |

## Report format

1. The integration matrix (plane, action taken, evidence).
2. The cross-pollination shipped and why it multiplies value.
3. Connections parked, each with its reason.
4. The HANDOFF block.
