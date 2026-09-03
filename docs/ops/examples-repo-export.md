# Examples satellite repo: export and publish runbook

How the public `three-ws/examples` developer repo is assembled from this
monorepo and published. Plan of record: the roadmap campaign's developer-resources
work order; the agent half shipped and the remaining step is the owner row that
creates the public repo (`prompts/finish/production-100-OWNER-ACTIONS.md`, row 16).
This directory (`docs/ops/`) is excluded from the public docs build by the
`PRIVATE_DOCS` filter in `vite.config.js`, so publish mechanics live here verbatim.

**The one-line model:** the monorepo is the only source of truth. The examples
repo is a strictly one-way export, its git history is disposable, and it is
never pulled, fetched, or merged from (same rule as the retired `3D-Agent`
mirror). No CI is involved: GitHub Actions are unavailable on this account, so
the export runs locally from the push routine or the satellite rots.

## What the export does

`scripts/export-satellites.mjs` (wired as `npm run export:satellites`) assembles
a complete, self-contained copy of the examples repo into a gitignored build dir,
rewrites every monorepo-relative reference to a working surface so nothing points
back into the monorepo, smoke-tests the result, and gives it a single-parent git
history ready to push.

```bash
npm run export:satellites                                 # build + smoke-test into dist/examples-repo/
node scripts/export-satellites.mjs --out /tmp/examples    # custom output dir
node scripts/export-satellites.mjs --offline              # structural checks only, no network
node scripts/export-satellites.mjs --no-git               # skip the staging git history
```

Properties:

- **Idempotent.** It wipes and rebuilds the output dir on every run.
- **Gated, not best-effort.** The smoke stages run by default and any failure
  aborts with a non-zero exit, because a broken public example is anti-marketing.
  The staging tree is left in place for inspection but is not publishable.
- **Curated, not a mirror.** Only the material listed in the script's manifest
  is exported. Adding an example means adding a manifest entry, nothing more.
- **It never touches a remote.** It prints the org-creation and push commands;
  the owner runs them (CLAUDE.md gate 2).

### The smoke gate

| Stage | Network | What it proves |
|---|---|---|
| 1. structure | no | No reference escapes the export or dangles; no `file:` dep survives; every `package.json` parses |
| 2. registry | yes | Every pinned `@three-ws/*` version actually exists on npm |
| 3. install | yes | `npm install` succeeds per staged package, then that example's own check runs (`npm test` where it has one, else a parse check of every source it ships) |
| 4. links | yes | Every distinct `https://three.ws` URL in the export is reachable (405 counts: a POST-only endpoint answering 405 proves the route exists; a missing one answers 404) |

### The rewrites it applies

Every relative reference is resolved against the file's real monorepo location
and routed by where it lands. A regex sweep over `../src/` would be wrong: an
example with its own `src/` folder (`paid-mcp-server`, `sdk/example`) uses
exactly that spelling for its own files, and rewriting those produces an example
that cannot run.

| Where the reference resolves to | Rewritten to |
|---|---|
| Inside the same exported unit | left alone (the target ships with it) |
| Another exported unit | re-relativised to that unit's satellite path (`examples/skills/wave` becomes `skills/wave`, so an agent manifest's skill `uri` still resolves) |
| A published package's own source (`sdk/src/...` from `sdk/example`) | `https://cdn.jsdelivr.net/npm/@three-ws/sdk@<version>/src/...` |
| `docs/<slug>.md`, `docs/tutorials/<slug>.md` | `https://three.ws/docs/<slug>`, `https://three.ws/tutorials/<slug>` |
| Anything else in the monorepo | a `github.com/nirholas/three.ws/blob|tree/main/...` permalink |
| `"file:../../solana-agent-sdk"` (any `file:` SDK dep) | published `^<version>` read live from that package's `package.json` |
| `/avatars/...`, `/dist-lib/...`, `/src/...`, `/api/...` | absolute `https://three.ws/...` |

Two examples also get a targeted transform: `agent-native-3d` vendors
`src/forge-embed-snippets.js` into `lib/` and writes its transcript to `./out`,
and `wallet-sign-in` defaults its API base to `https://three.ws` (in the monorepo
it is served same-origin behind the dev proxy).

After a run the script prints the produced tree and a file/dir count.

### Output layout

```
dist/examples-repo/
  README.md            # generated index (quickstarts / agents / embeds / tutorials / skills)
  LICENSE              # carried from the monorepo root (see the license note below)
  .gitignore
  quickstarts/         # one folder per SDK: install command + real Quick start section + npm/docs links
    sdk/  solana-agent-sdk/  agent-payments-sdk/  mcp-server/
  agents/              # coach-leo  metamask-agent-wallet
  embeds/              # nine single-file HTML patterns
  tutorials/           # agent-native-3d  paid-mcp-server  wallet-sign-in
  skills/              # pump-fun trading / strategy / compose / trade, solana-wallet, wave
```

### What is deliberately held out

Three examples are excluded from the manifest under the CLAUDE.md commit gate,
because each references a crypto project other than `$THREE`. Re-including any of
them is a one-line manifest edit once the owner approves that specific content.

| Example | Why |
|---|---|
| `pump-fun-agent` | installs `pump-fun-skills/`, whose SKILL.md and lib carry third-party program ids, a third-party sample mint, and a bundler integration |
| `three-concierge` | same skill dependency |
| `agenc-task-roundtrip` | depends on a third-party agent-commerce SDK and pins that project's on-chain program id |

The rule behind the first two is also structural: an agent may only ship here if
every skill its manifest installs ships too. A public agent with a dangling skill
`uri` is broken for the first reader who tries it, and stage 1 fails the export
rather than let that happen.

## License note before first publish

The export carries the monorepo root `LICENSE` verbatim, which is the Apache
License 2.0. That is already the permissive license a public examples repo
wants, so no substitution is needed. Ship `dist/examples-repo/NOTICE` alongside
it, since Apache-2.0 section 4(d) requires the notice to travel with the code.

## Owner publish steps (run by hand; not automated here)

Nothing below is executed by any script in this repo. The export produces a
plain directory; the owner turns it into a repo.

1. **One-time: create the GitHub org and repo.**
   ```bash
   # Org `three-ws` is created in the GitHub UI (three.ws is not a valid org slug).
   gh repo create three-ws/examples --public \
     --description "Runnable examples, SDK quickstarts, and embeds for three.ws"
   ```

2. **Build and smoke-test the export.** A non-zero exit means do not publish.
   ```bash
   npm run export:satellites
   ```

3. **Confirm the license** in `dist/examples-repo/LICENSE` (see the note above).

4. **Push the staging tree.** The export already made it a single-commit `main`;
   the satellite history is disposable, so force-push is correct and prior
   satellite history is never preserved or merged. The script prints these two
   lines at the end of every successful run:
   ```bash
   git -C dist/examples-repo remote add satellite https://github.com/three-ws/examples.git
   git -C dist/examples-repo push --force satellite main
   ```

5. **Never pull, fetch, or merge from the satellite.** To update it later,
   re-run the export and repeat steps 2 to 4. The satellite is output, never input.

## Cross-linking

The cross-links are wired and live today, pointed at the curated source in this
monorepo (`examples/` and the SDK directories), because the satellite repo does
not exist yet and shipping a link to a 404 is worse than shipping no link.

Already in place:

- **Eight docs pages carry a `## Runnable example` section** linking to the folder
  that backs them: `docs/sdk.md`, `docs/mcp.md`, `docs/embedding.md`,
  `docs/authentication.md`, `docs/create-agent.md`, `docs/solana.md`,
  `docs/a2a-payments.md`, `docs/agent-wallets.md`.
- **`public/llms.txt` and `public/llms-full.txt` carry an examples pointer**, emitted
  by `scripts/build-page-index.mjs` from a single constant, `site.examples` in
  `data/pages.json`. Nothing else hardcodes that URL.
- **The exported root README links back** to `https://three.ws/docs`, the changelog,
  and the live platform, and states that the monorepo is the source of truth.

When the repo goes public, flip it in this order:

1. Set `site.examples` in `data/pages.json` to `https://github.com/three-ws/examples`
   and run `node scripts/build-page-index.mjs`. That moves both llms feeds at once.
2. Repoint the eight `## Runnable example` links at the satellite paths
   (`quickstarts/`, `tutorials/`, `embeds/`, `agents/`).
3. Pin `examples` and the monorepo on the org profile README.
4. Add the `data/changelog.json` entry: the repo is a user-visible developer
   resource. The export script itself is internal tooling and gets no entry.
