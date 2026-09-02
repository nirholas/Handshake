# RM-DEV: Developer resources and the examples satellite repo

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, or say "execute `prompts/finish/roadmap-developer-resources-repos.md`".
It is complete on its own. Also read `prompts/finish/roadmap-00-README.md` and `CLAUDE.md`.

## Binding operating clause

1. Finish 100% of what can be done from this machine. Never end with a question about scope.
2. Two things genuinely need the owner and nothing else does: creating the GitHub org, and
   pushing to any repo. Prepare both so each is one command, batch them into one closing note,
   and do everything else first.
3. CLAUDE.md hard rules: no mocks, no placeholder code, no TODO comments, no em-dash or en-dash
   characters. Stage explicit paths only. Never create `.github/workflows/`; this project does
   not use GitHub Actions.
4. Satellites are strictly one-way exports. Never pull, fetch or merge from one.

## Problem

Every developer-facing artifact (examples, SDK quickstarts, guides) lives inside the monorepo,
invisible to a developer browsing GitHub. The platforms we benchmark against (Vercel, Stripe,
Anthropic) all present a curated satellite examples repo as the onboarding front door.

## Step 0: re-derive current state (trust nothing below)

```bash
ls examples/
ls sdk solana-agent-sdk agent-payments-sdk agent-protocol-sdk agent-ui-sdk avatar-sdk
npm view @three-ws/sdk version && npm view @three-ws/mcp-server version
ls scripts/export-examples.mjs scripts/export-satellites.mjs 2>&1
gh api user --jq .login 2>&1 | head -2
gh api /orgs/three-ws --jq .login 2>&1 | head -2
```

Known as of 2026-08-01: the `@three-ws/*` packages are published on npm (so an examples repo no
longer fails on its first instruction), `scripts/export-examples.mjs` exists,
`scripts/export-satellites.mjs` does not, and the `three-ws` org may not exist yet.

## Tasks

1. **Curate the export set.** Decide, file by file, what belongs in a public examples repo:
   quickstarts (one per SDK, copy-paste minimal), full agent builds from `examples/`,
   single-file embed patterns, and long-form tutorials. Anything referencing a crypto project
   other than $THREE is subject to the CLAUDE.md commit gate: keep it out of the export set
   unless the owner has approved that specific content.
2. **Write `scripts/export-satellites.mjs`.** It must:
   - copy the curated paths into a staging directory, rewriting monorepo-relative imports to
     published package names;
   - smoke-test every example in staging (`npm install` plus the example's own check command)
     and abort the whole export on any failure, because a broken public example is
     anti-marketing;
   - produce a single-parent history in staging and print the exact push command rather than
     pushing (pushing is owner-gated);
   - expose itself as `npm run export:satellites`.
3. **Author the repo content in staging**: root README stating that the monorepo is the source
   of truth and that issues and PRs belong there, a per-example README (what it does,
   prerequisites, exact run commands, link to the matching page on three.ws), MIT LICENSE, and
   version pins to published packages, never relative paths.
4. **Prove it works before anyone sees it.** Run the smoke stage against the real npm packages
   in a clean directory outside the workspace, so hoisted `node_modules` cannot mask a broken
   install. Record every command and its output.
5. **Cross-linking (the part that makes it pay off).** three.ws docs pages link to the matching
   example folder; `llms.txt` and `llms-full.txt` reference the examples repo; the examples
   README links back to the docs and the live platform.
6. **Documentation and changelog.** `STRUCTURE.md` row for the export script, a `docs/` section
   describing the satellite policy (one-way, no PRs, how to refresh), and a
   `data/changelog.json` entry when the repo goes live.

## Definition of done

- [ ] `npm run export:satellites` runs end to end into staging, smoke-tests every example, and
      aborts on failure. Show a deliberate failure being caught.
- [ ] Staging tree complete: root README, per-example READMEs, LICENSE, published-package pins.
- [ ] Clean-room install proven outside the workspace with the output pasted in the report.
- [ ] Cross-links added in docs, `llms.txt` and the examples README.
- [ ] `STRUCTURE.md` and `docs/` updated; `npm run audit:docs` clean.
- [ ] `npm run check:rules -- --paths <files you touched>` clean.
- [ ] The two owner actions (create the `three-ws` org, run the printed push command) stated in
      one closing note, with the exact commands.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| The `three-ws` org does not exist | Build everything against a placeholder remote name, print the org-creation and push commands, and continue. Do not stall. |
| No push credentials for a new repo | Never push; that is gate 2 in CLAUDE.md anyway. Stage and print. |
| An example fails its smoke test | That is the point of the gate. Fix the example in the monorepo (it is broken for real users too), then re-export. |
| An example references another crypto project | Keep it out of the export set and list it in the report as owner-gated content. |
| `npx` resolves to hoisted workspace modules | Run the clean-room test outside `/workspaces/three.ws`; in-workspace `npx` breaks ESM resolution and produces false failures. |
| CI is wanted for the sync | There is no CI on this account and GitHub Actions are prohibited here. The export is a local script invoked from the push routine. |

## Deliberately out of scope (do not build)

- A separate documentation repo. Docs are wired into the site build and `data/pages.json`;
  extracting them creates a second source of truth that drifts.
- A separate tutorials repo. Tutorials live in `tutorials/` inside the examples satellite.
- Two-way sync or accepting PRs on satellites. The retired 3D-Agent mirror already proved that
  failure mode with a destructive history merge.
- Moving the canonical repo to the org. That is a separate decision with deploy implications.

## Report format

What the export produces, the clean-room install output, the caught-failure demonstration, and
the two owner commands. No recap of this file.
