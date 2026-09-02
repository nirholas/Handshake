# SS-01: Store submission close-out

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/store-submissions-01-submission-closeout.md`".
It is complete on its own. Also read [`store-submissions-00-README.md`](store-submissions-00-README.md) (the strategy and the store
policy differences) and `CLAUDE.md`.

Every numbered work order in this pack shipped and was retired. What remains is close-out: a few
real code gaps, a stale tracker, and a list of steps only a human can click. This work order
owns all three.

## Binding operating clause

1. Finish 100% of what does not need a human account action. Never end with a question about
   scope, design or priority.
2. The genuinely human steps (portal submissions, `mcp-publisher login`, directory account
   claims, funding a wallet) get batched into ONE closing list with the exact command or URL for
   each. Do not stall on them and do not do them yourself.
3. CLAUDE.md hard rules: no mocks, no TODO comments, no em-dash or en-dash characters. Stage
   explicit paths only. The OpenAI surface must stay coin-clean: zero token, wallet or x402
   strings anywhere a reviewer can reach.

## Step 0: refresh the truth (the tracker is the deliverable, not a note)

`_generated/TRACKER.md` is the live state of every submission target and it was last verified
2026-07-15. Re-verify every row today, by running things, not by reading them:

```bash
# every hosted remote answers tools/list the way a registry crawler asks
for u in mcp mcp-3d mcp-studio mcp-agent mcp-bazaar ibm-mcp pump-fun-mcp; do
  echo "== $u"; curl -s -X POST "https://three.ws/api/$u" -H 'accept: application/json' \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 200; echo; done

# the free lane a reviewer will actually exercise, end to end
curl -s -X POST https://three.ws/api/mcp-studio -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"forge_free","arguments":{"prompt":"a small ceramic teapot"}}}'

curl -sI "https://three.ws/legal/privacy" | head -3
curl -sI "https://three.ws/support" | head -3
npm run audit:mcp && npm run audit:mcp-golden && npm run audit:mcp-catalog && npm run audit:mcp-safety
ls scripts/ | grep -i mcp          # the live generator set; see the note below
git diff --stat prompts/store-submissions/_generated/
```

**Generator note, verified 2026-08-01:** the two scripts the tracker's older entries name
(`build-mcp-listing-source.mjs`, `build-mcp-directory-docs.mjs`) no longer exist in the tree and
nothing else writes `_generated/mcp-listing-source.json` any more, so that file and
`_generated/mcp-registry-republish.sh` are now hand-maintained artifacts. The live tooling is
`npm run build:mcp-catalog` (writes `public/mcp-catalog.json`, gated by `audit:mcp-catalog`),
`npm run audit:mcp` (manifests), `npm run audit:mcp-golden` (contract snapshot) and
`npm run audit:mcp-safety` (annotations derived from each handler's AST). Reconcile the
`_generated/` artifacts against the real `server*.json` manifests plus `public/mcp-catalog.json`
by hand, and say in the tracker that they are hand-maintained, so the next agent does not go
looking for a generator that was retired.

Rewrite `_generated/TRACKER.md` from what you measured. Every row gets a status, today's date,
and the command that produced it. Any claim you cannot reproduce is downgraded, not carried
forward.

## Task 1: close the real code gaps

1. **`@x402/mcp` auto-pay rejects `mcp://` tool URLs.** This is the interop bug that keeps the
   agent-commerce demo from settling through the official client. Reproduce it, fix it on our
   side if the defect is ours, and if it is upstream, open a minimal reproduction and file it
   per the ecosystem rule in CLAUDE.md (contribute upstream rather than working around).
2. **Claude submission package** (`_generated/claude-submission.md`) is the one prerequisite the
   tracker still lists as not started. Regenerate it against the current live surface: privacy
   URL, allowed links, server metadata, the exact form-fill content, and the compliance
   acknowledgments. Every string in it must match what production serves today.
3. **Devnet mint E2E** for the tokenized-3D lane: run `node scripts/tokenize-3d-devnet-e2e.mjs`.
   If the faucet refuses (documented daily per-IP limit), say so with the exact error and leave
   the pre-funded-payer command (`E2E_PAYER_SECRET=...`) in the human list.
4. **Reviewer path**: confirm every paid tool still returns a clean `PaymentRequired` unpaid and
   that the review-mode entitlement in `mcp-server/src/payments.js` still works. A reviewer
   hitting a hang is how this pack lost a month once already.

## Task 2: keep the surfaces consistent

- `_generated/mcp-listing-source.json` is the canonical listing metadata and is hand-maintained
  (see the generator note above). Reconcile it against the real `server*.json` manifests, the
  live `tools/list` counts you captured in Step 0, and `public/mcp-catalog.json`. Commit only if
  something actually changed.
- `_generated/mcp-registry-republish.sh` holds the staged `mcp-publisher` commands. Check each
  entry against the live registry (`https://registry.modelcontextprotocol.io/?q=io.github.nirholas`)
  so the batch is accurate, and leave it unrun.
- Compliance grep across manifests, directory docs and the canonical source: zero references to
  any crypto project other than `$THREE`, and zero coin surface anywhere in the OpenAI lane.
- `STRUCTURE.md` and `docs/mcp.md` server counts must match the canonical source. Fix drift in
  the same change.

## Definition of done

- [ ] `_generated/TRACKER.md` rewritten from measurements taken today, every row carrying its
      command and result.
- [ ] The interop bug is fixed or filed upstream with a minimal reproduction linked in the
      tracker.
- [ ] The Claude submission package regenerated and matching production string for string.
- [ ] Devnet mint either completed with a signature or blocked with the exact error and the
      unblock command.
- [ ] All four MCP audits green; generator output committed only if it changed.
- [ ] Compliance grep clean; server counts consistent across `STRUCTURE.md`, `docs/mcp.md` and
      the canonical source.
- [ ] `npm run build:pages` green; `npm run audit:docs` clean;
      `npm run check:rules -- --paths <files you touched>` clean.
- [ ] One closing list of human steps, each with its exact command or URL.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| A portal needs an account or a role | That is a human step. Put it in the closing list with the URL and what to click. Never stall the session on it. |
| `mcp-publisher` needs a login | Same. The commands are already staged; leave them unrun and say so. |
| A hosted endpoint hangs | Check `api/_lib/http.js` `readBody` handling first; a body already drained by the server's parsers is the historical cause of exactly this symptom. |
| The devnet faucet refuses | Documented daily per-IP limit. Record it and move on with a pre-funded payer note. |
| A tool's annotations look wrong | `npm run audit:mcp-safety` derives them from the handler AST. Trust it over the name and fix the handler or the annotation, not the audit. |
| An `npx` package test fails inside the workspace | In-workspace `npx` resolves to hoisted `node_modules` and breaks ESM resolution. Re-run outside the repo before reporting a package defect. |

## Report format

The rewritten tracker's diff, what you fixed, what you could not reproduce, and the single
closing list of human steps. No recap of this file.

## Retire this prompt when it is done (required)

1. Verify every Definition of done line against actual command output in front
   of you. Never claim a line you did not verify.
2. Record the outcome in this campaign's PROGRESS or INDEX file if it has one.
3. Commit with explicit paths and a subject that describes the diff (house
   style: type(scope): what changed and why a reader cares), and delete this
   prompt file in that same commit:

       git rm prompts/finish/store-submissions-01-submission-closeout.md

   A finished order left on disk reads as open work to the next agent, so the
   shrinking directory is the campaign's progress ledger.

If a line genuinely cannot pass inside this session (an external party must
respond, or an owner-gated action is the final step), finish everything else,
leave this file in place, and state exactly which line remains and who owns it.
Never delete this file on a partial.
