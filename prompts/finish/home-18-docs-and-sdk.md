# 18. Docs, SDK publish, the home MCP server package

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Run this once the
surfaces it documents have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated. **Publishing to npm is owner-gated**: prepare everything so the
publish is one command and batch the owner action into a single message.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
npm run audit:docs
npm run publish:packages:dry 2>&1 | tail -20
npm run publish:mcp:dry 2>&1 | tail -20
ls docs/ | grep -i home
grep -rn "home" data/pages.json | head
cat packages/home-bridge/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(p.name,p.version,p.files,p.dependencies)})"
```

## The docs set

CLAUDE.md requires a doc layer per kind of change. This lane produced all of them, so all of them
are due:

| Layer | File | State |
|---|---|---|
| Public route | `/home`, `/home/:id` in `data/pages.json` | added by orders 05 and 06; verify |
| Package README | `packages/home-bridge/README.md` | exists; update for anything added since |
| New service READMEs | `services/home-satellite/`, `services/home-relay/` | required by CLAUDE.md and enforced by `npm run audit:docs` |
| Feature doc | `docs/smart-home.md` | exists; must now describe what shipped, not what was planned |
| Developer capability | `docs/api-reference.md` (the `/api/home/*` routes), `docs/mcp.md` (the home MCP tools) | update both |
| Subsystem docs | `docs/home-security.md`, `docs/home-operations.md`, `docs/home-privacy.md` | from orders 11, 13, 15 |
| Tutorial | `docs/tutorials/connect-your-home.md` | new: zero to a working agent in a real house |
| Structure | `STRUCTURE.md` rows for every surface and package | required |
| Changelog | `data/changelog.json` | one community-readable entry for the launch, plus any user-visible changes |

**`docs/smart-home.md` must stop reading as a plan.** Rewrite its status, its build plan and its
verification table to describe what exists. A doc that still says "phase 2, designed" after phase
2 shipped is worse than no doc.

## The tutorial is the deliverable that matters most

`docs/tutorials/connect-your-home.md`, written for someone who has never used three.ws and owns
a Home Assistant:

1. What you need (a Home Assistant reachable over https, and how to check).
2. Minting a long-lived token, with the exact path.
3. Connecting, and what "connected" looks like.
4. Your first command by text.
5. Your first command by voice.
6. What the agent will and will not do without asking, and why the door asks every time.
7. Adding a household member and what a guest can do.
8. What to do when it says your home is unreachable.

Every command must run. Every link must resolve. Per CLAUDE.md, docs are real implementations:
no placeholders, no "see the code".

## The packages

### `@three-ws/home-bridge`

Already exists at `packages/home-bridge`, currently unpublished. Before publishing:

- Version it honestly. It is pre-1.0 and its API will move; say so in the README.
- `files`, `exports`, `engines` and dependency ranges are already set; re-verify them against what
  the lane added (a `RelayTransport` from order 10 changes the export surface).
- `npm pack --dry-run` and read the file list. Nothing from `tests/` or a fixture with a token.
- The README's examples must run against a real instance. Run them.

### `@three-ws/home-mcp` (new)

A standalone MCP server that gives **any** assistant the three.ws home tools, following the shape
of the 40+ existing packages (read `packages/brain-mcp/README.md` and its `package.json` first).

This is a distribution surface: someone using Claude Desktop or an SDK gets home control through
three.ws without opening a browser. It wraps the same handlers as order 04, so it cannot diverge
on the gate.

**The gate over stdio needs a decision, and it must be written down.** An MCP client has no
session and cannot satisfy a confirmation. Either the server refuses guarded actions entirely and
says where to confirm (recommended, and the honest default), or it opens the three.ws
confirmation URL for the human. Choose, implement, and state it in the README. Never silently
allow a guarded action because no browser was present.

## Tasks

| # | Task |
|---|---|
| 1 | Rewrite `docs/smart-home.md` to describe what shipped. |
| 2 | Write `docs/tutorials/connect-your-home.md` and run every command in it. |
| 3 | Update `docs/api-reference.md` and `docs/mcp.md`. |
| 4 | Verify or add `STRUCTURE.md` rows for every surface, package and service in the lane. |
| 5 | Verify or add `data/pages.json` entries for every public route. |
| 6 | Ready `@three-ws/home-bridge` for publish; run `npm pack --dry-run` and read the file list. |
| 7 | Build `packages/home-mcp` with its README, the gate decision, and one runnable example. |
| 8 | A `data/changelog.json` entry in plain community language, then `npm run build:pages`. |
| 9 | `npm run audit:docs` clean, `npm run check:docs-search` current. |
| 10 | Batch the publish into one owner message with the exact commands. |

## Definition of done

- [ ] `npm run audit:docs` clean. Paste it.
- [ ] Every command in the tutorial was run by you, against a real Home Assistant, and produced the documented output. Paste a transcript per step.
- [ ] Every link in every new doc resolves. `audit:docs` covers this; paste the run.
- [ ] `docs/smart-home.md` contains no unshipped claim presented as shipped, and no shipped thing described as planned. State how you checked.
- [ ] `npm pack --dry-run` file lists for both packages, with no test files, no fixtures containing tokens, and no stray artifacts.
- [ ] `npm run publish:packages:dry` and `npm run publish:mcp:dry` both clean. Paste them.
- [ ] The `home-mcp` gate decision is implemented, tested (a guarded action over stdio does not execute), and documented in its README.
- [ ] Both READMEs' examples were executed and worked. Paste the runs.
- [ ] `STRUCTURE.md` covers every new directory; `data/pages.json` covers every new route.
- [ ] The changelog entry reads as plain language with no commit jargon, and `npm run build:pages` validated it.
- [ ] `npm run check:docs-search` reports the index current.
- [ ] `npm run check:rules -- --paths <your files>` clean.
- [ ] The owner message is written: exact commands, one paragraph, nothing else needed from them.

## Never blocked

| Blocker | Do this |
|---|---|
| npm publish is owner-gated | Correct. Prepare everything, prove it with the dry runs, and batch the ask. Never publish. |
| A doc would be easier as a link to the code | CLAUDE.md forbids it. Write the explanation and the runnable example. |
| The tutorial needs a real house | Use the order 16 harness, or the docker one-liner in the context file. Do not write steps you did not execute. |
| `home-mcp` duplicates `home-bridge` | It must not. It wraps the same handlers. If you find yourself copying gate logic, stop and import it. |
| The changelog entry is hard to write without jargon | Write what a person would notice. "Your agent can run your house now, and it asks before it unlocks anything." |

## Report format

1. `audit:docs`, `check:docs-search`, both dry-run publishes.
2. A transcript per tutorial step.
3. Both `npm pack --dry-run` file lists.
4. The `home-mcp` gate decision, its test, and the README section.
5. The changelog entry text.
6. The single owner message for publishing.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-18-docs-and-sdk.md

If the npm publish is the only outstanding step, leave the file in place, say so, and name the
owner action. Never delete it on a partial.
