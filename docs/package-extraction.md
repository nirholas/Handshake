# Package extraction: breaking the monorepo into standalone repos

We are graduating the reusable packages out of the `three.ws` monorepo into their
own GitHub repos that publish to npm (or, for the VS Code extension, the
Marketplace) independently. This is the playbook. **We start with the x402 family.**

## Why

The x402 packages (`@three-ws/x402-*`) are general-purpose: a buyer-side fetch
wrapper, a seller-side core, MCP servers, payment modals. They are useful far
beyond three.ws, they version on their own cadence, and bundling them in a 60+
directory monorepo hides their issue tracker, inflates clone size, and couples
their releases to unrelated platform commits. Standalone repos fix all four.

## Decisions (locked)

- **One repo per package** (polyrepo), not a shared x402 monorepo.
- **History preserved** via `git filter-repo --subdirectory-filter`, so blame and
  authorship carry across.
- **Scope/owner unchanged**: keep publishing as `@three-ws/*`, host under
  `github.com/nirholas`. No renames, no broken installs.

## Tooling

Two scripts in [`scripts/`](../scripts) do the work:

| Script | Who runs it | What it does |
|---|---|---|
| [`extract-package.sh`](../scripts/extract-package.sh) | anyone | Splits `<prefix>` into a standalone repo (history at root), rewrites `repository`/`bugs`, adds the publish CI workflow, and verifies it installs, builds, tests, and packs. |
| [`publish-extracted.sh`](../scripts/publish-extracted.sh) | **owner only** | Creates the GitHub repo, pushes the history, and tags the version to trigger the publish workflow. Needs the owner's `gh` auth + the repo's publish-token secret. |

```bash
# 1. build the standalone repo (deterministic, reads committed monorepo history)
scripts/extract-package.sh packages/x402-fetch x402-fetch nirholas

# 2. ship it (owner creds: gh auth as the namespace owner, then set NPM_TOKEN)
scripts/publish-extracted.sh x402-fetch nirholas
```

`extract-package.sh` reads **committed** history — commit any source fixes to the
monorepo first, then extract.

## x402 roster

All seven extract cleanly with full history. Six are npm packages already live
under `@three-ws/*`; `vscode-x402` targets the VS Code Marketplace.

Versions move, so read this table as a snapshot and re-derive it before a
release: `npm view <pkg> version` for the live column, the package's own
`package.json` for the local one. Measured 2026-08-15.

| Package | Monorepo path | npm (live) | Local ver | Build | Tests | Notes |
|---|---|---|---|---|---|---|
| `@three-ws/x402-fetch` | `packages/x402-fetch` | 1.0.2 | **1.0.3** | vite | 7 pass | buyer-side fetch wrapper |
| `@three-ws/x402-server` | `packages/x402-server` | 0.1.2 | 0.1.2 | none | 24 pass | seller-side core |
| `@three-ws/x402-mcp` | `packages/x402-mcp` | 0.2.1 | **0.2.2** | none | 10 pass | MCP server |
| `@three-ws/ibm-x402-mcp` | `packages/ibm-x402-mcp` | 1.1.2 | **1.1.3** | none | 37 pass | IBM MCP variant |
| `@three-ws/x402-modal` | `x402-modal-sdk` | 0.2.1 | **0.3.0** | esbuild | 24 pass | payment modal SDK |
| `@three-ws/x402-payment-modal` | `x402-payment-modal` | 1.2.0 | **1.2.1** | esbuild | 20 pass, 2 skipped | deps fixed, see below |
| `@three-ws/vscode-x402` | `packages/vscode-x402` | not published | 0.2.0 | esbuild | none | **Marketplace**, not npm; needs a name fix |

A bolded local version is ahead of npm and publishes on its next tag. The two
MCP packages ship their sources directly and have no build step, so "none" in
that column is correct rather than missing.

### Fixes the split surfaced (already applied to the monorepo)

- **`x402-payment-modal/build.mjs`** imported esbuild via a hardcoded
  `../node_modules/esbuild/lib/main.js`, coupling it to the monorepo's hoisted
  layout and breaking it in a standalone repo. Changed to a bare
  `import 'esbuild'`, which resolves in both.
- **`x402-payment-modal/package.json`** shipped a `server/` adapter importing
  `@solana/web3.js`, `@solana/spl-token`, and `express` with **zero declared
  dependencies**, so the published package was broken for anyone using the
  server subpath. Added them as optional `peerDependencies` (keeps the browser
  install lean) plus the Solana pair as `devDependencies` so tests run.

### vscode-x402: extra step before Marketplace publish

VS Code extensions cannot use a scoped `name`, and the package is still named
`@three-ws/vscode-x402`. Before `vsce publish`:

- set `name` to a plain id (e.g. `vscode-x402`); this is the one blocker left,
- the `publisher` field is already set to `three-ws`, which must match a
  registered Marketplace publisher,
- the extracted repo's publish workflow already uses `vsce publish` +
  `ovsx publish` (Open VSX) and expects `VSCE_PAT` / `OVSX_PAT` secrets.

## Owner handoff: the two steps that need credentials

Everything up to the GitHub/npm boundary is automated and verified. The final two
steps need the owner's credentials and cannot run from a collaborator session:

1. **Create + push each repo** (`nirholas` is a personal account; only its owner
   can create repos in that namespace). Each line is `<monorepo-path> <repo-name>`:
   ```bash
   while read -r path repo; do
     scripts/extract-package.sh "$path" "$repo" nirholas
     scripts/publish-extracted.sh "$repo" nirholas
   done <<'PKGS'
   packages/x402-fetch          x402-fetch
   packages/x402-server         x402-server
   packages/x402-mcp            x402-mcp
   packages/ibm-x402-mcp        ibm-x402-mcp
   x402-modal-sdk               x402-modal
   x402-payment-modal           x402-payment-modal
   PKGS
   ```
   (`vscode-x402` is handled separately: see the Marketplace note above.)
2. **Set the publish-token secret** on each new repo so its workflow can
   authenticate to npm (`NPM_TOKEN`) or the Marketplace (`VSCE_PAT`/`OVSX_PAT`).

Already-published versions republish only after a version bump: the workflow tags
and publishes the version in `package.json`, so bump it when there's something
new to ship. Five of the six npm packages currently sit one version ahead of the
registry (the bolded local versions above) and publish on their next tag.

## After a package is extracted

The monorepo copy can stay (the platform still imports it locally) or be replaced
with the published dependency. That cutover is tracked per-package and is **not**
part of the extraction itself: extract and publish first, swap the import later.
