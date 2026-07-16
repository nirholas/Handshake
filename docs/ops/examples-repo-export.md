# Examples satellite repo: export and publish runbook

How the public `three-ws/examples` developer repo is assembled from this
monorepo and published. Plan of record: `prompts/roadmap/developer-resources-repos.md`.
This directory (`docs/ops/`) is excluded from the public docs build by the
`PRIVATE_DOCS` filter in `vite.config.js`, so publish mechanics live here verbatim.

**The one-line model:** the monorepo is the only source of truth. The examples
repo is a strictly one-way export, its git history is disposable, and it is
never pulled, fetched, or merged from (same rule as the retired `3D-Agent`
mirror). No CI is involved: GitHub Actions are unavailable on this account, so
the export runs locally from the push routine or the satellite rots.

## What the export does

`scripts/export-examples.mjs` (wired as `npm run export:examples`) assembles a
complete, self-contained copy of the examples repo into a gitignored build dir
and rewrites every monorepo-relative reference to a working surface so nothing
points back into the monorepo.

```bash
npm run export:examples                 # build into dist/examples-repo/
node scripts/export-examples.mjs --out /tmp/examples   # custom output dir
node scripts/export-examples.mjs --smoke                # also npm-install + check each runnable example
```

Properties:

- **Idempotent.** It wipes and rebuilds the output dir on every run; two runs
  produce byte-identical output.
- **Offline by default.** The assembly needs no network. `--smoke` is the only
  step that reaches the npm registry (it really runs `npm install` plus each
  example's check; do this right before publishing).
- **Curated, not a mirror.** Only the material listed in the script's manifest
  is exported. Adding an example means adding a manifest entry, nothing more.

### The rewrites it applies

| Source form in the monorepo | Rewritten to |
|---|---|
| `"file:../../solana-agent-sdk"` (and any `file:` SDK dep) | published `^<version>` read live from that package's `package.json` |
| `../src/...`, `../../src/...` | `https://three.ws/src/...` (hosted raw modules, all resolve 200) |
| `/avatars/...`, `/dist-lib/...`, `/src/...` | absolute `https://three.ws/...` |
| `../../docs/<slug>.md` links | `https://three.ws/docs/<slug>` |
| `agent-native-3d`'s `../../src/forge-embed-snippets.js` | vendored into `lib/` and imported as `./lib/forge-embed-snippets.js`; its output path is localised to `./out` |

After a run, the script prints the produced tree and a file/dir count. The
current export is 59 files across quickstarts, agents, embeds, tutorials, and
skills.

### Output layout

```
dist/examples-repo/
  README.md            # generated index (quickstarts / agents / embeds / tutorials / skills)
  LICENSE              # carried from the monorepo root (see the license note below)
  .gitignore
  quickstarts/         # one folder per SDK: install command + real Quick start section + npm/docs links
    sdk/  solana-agent-sdk/  agent-payments-sdk/  mcp-server/
  agents/              # coach-leo  pump-fun-agent  three-concierge  metamask-agent-wallet
  embeds/              # minimal / two-agents / web-component / widget-rpc  (single-file HTML)
  tutorials/           # agenc-task-roundtrip  agent-native-3d  (long-form, runnable)
  skills/              # pump-fun trading / strategy / compose / trade, solana-wallet
```

## License note before first publish

The export carries the monorepo root `LICENSE` verbatim, which is currently
"All rights reserved". A public examples repo usually ships a permissive license
(MIT/Apache-2.0). Confirm or replace `dist/examples-repo/LICENSE` before the
first public push. This is an owner decision; the export does not choose one.

## Owner publish steps (run by hand; not automated here)

Nothing below is executed by any script in this repo. The export produces a
plain directory; the owner turns it into a repo.

1. **One-time: create the GitHub org and repo.**
   ```bash
   # Org `three-ws` is created in the GitHub UI (three.ws is not a valid org slug).
   gh repo create three-ws/examples --public \
     --description "Runnable examples, SDK quickstarts, and embeds for three.ws"
   ```

2. **Build and smoke-test the export.**
   ```bash
   npm run export:examples
   node scripts/export-examples.mjs --smoke   # verifies the runnable examples install
   ```

3. **Confirm the license** in `dist/examples-repo/LICENSE` (see the note above).

4. **Publish the built directory as the repo's single-parent history.** The
   satellite history is disposable, so a fresh single commit is correct; never
   preserve or merge prior satellite history.
   ```bash
   cd dist/examples-repo
   git init -b main
   git add -A
   git commit -m "Sync examples from monorepo"
   git remote add origin https://github.com/three-ws/examples.git
   git push --force origin main
   ```

5. **Never pull, fetch, or merge from the satellite.** To update it later,
   re-run the export and repeat steps 2 to 4. The satellite is output, never input.

## Cross-linking (rolling, after the repo exists)

- three.ws docs pages link to the matching example folder; the examples README
  already links back to `https://three.ws/docs` and the live platform.
- `public/llms.txt` / `llms-full.txt` reference the examples repo.
- The org profile README pins `examples` and the monorepo.
- Ship a `data/changelog.json` entry when the repo goes public (this is a
  user-visible developer resource). The export script itself is internal
  tooling and gets no changelog entry.
