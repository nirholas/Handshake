# third_party/

Complete third-party source trees, copied in byte-identical to their upstream
repository and never edited in place.

We keep each tree in full rather than a curated excerpt, because the worked
examples are the substance: a `SKILL.md` that points at a `demo/` is worth
nothing without the demo, and a component library without its assets cannot be
run to see what it does.

This is not a bundle directory. `public/vendor/` (and the `vendor/` folders
inside a surface, such as [src/scene-studio/vendor/](../src/scene-studio/vendor))
hold third-party artifacts we actually ship. `third_party/` holds whole
repositories we read: source, assets, tests, licence and all, so a re-sync is a
diff against upstream rather than a merge against our edits.

## What is here

| Directory | Upstream | Commit | Licence | Files |
|---|---|---|---|---|
| [threeui/](threeui) | [MengTo/threeui](https://github.com/MengTo/threeui) | `68802d5428071ada5c20db8094b1649e6bb770ed` (2026-09-01) | MIT, (c) 2026 Meng To | 430 |
| [designcode-agent-skills/](designcode-agent-skills) | [MengTo/Skills](https://github.com/MengTo/Skills) | `321c769739b823de5eb94eb3a52aa1974fe783a2` (2026-08-29) | MIT, (c) 2026 Meng To | 898 |

Both licences ship with their tree ([threeui/LICENSE](threeui/LICENSE),
[designcode-agent-skills/LICENSE](designcode-agent-skills/LICENSE)). MIT
requires the copyright notice and permission notice to travel with the copy, so
those two files are load-bearing: never delete or rewrite them.

What each tree is for, with entry points and worked examples, is documented on
our side in [docs/vendored-design-libraries.md](../docs/vendored-design-libraries.md).

### threeui

`@designcodeio/threeui` 1.2.0, the login-free Community edition of the ThreeUI
catalog: 50 parent components across 111 routes, the React component library
under [threeui/src/](threeui/src), 48 shader and scene studies under
[threeui/src/shaders/](threeui/src/shaders), the publishable package under
[threeui/packages/](threeui/packages), and the catalog application shell that
renders each component with live controls, a variant picker and a source tab.

### designcode-agent-skills

132 portable `SKILL.md` folders in five groups (`web-design` 88,
`game-development` 20, `codex` 19, `ui` 3, `media` 2), each with its references,
scripts and a runnable `demo/`. Same Agent Skills folder format as our own
[.agents/skills/](../.agents/skills).

## Rules

1. **Never edit a file inside a vendored tree.** A local fix becomes a permanent
   merge conflict on every future sync. Fix it upstream (issue or PR, per the
   open-source-first section of [CLAUDE.md](../CLAUDE.md)) and re-sync, or wrap
   it from our own code outside `third_party/`.
2. **Never import from `third_party/` at runtime.** Nothing in `api/`, `src/`,
   `server/` or a worker resolves a path under `third_party/`, and nothing
   should: these trees are not in the Cloud Build upload (see below), so a
   runtime import would resolve locally and 500 with `ERR_MODULE_NOT_FOUND` in
   production, which is exactly how revision 00412 broke. Copy what you need
   into the surface that uses it, keeping the upstream attribution with it.
3. **A new tree lands with its licence and a row in the table above.**

## How it is wired into the repo

Deliberately inert. Vendoring a tree must not change what three.ws builds,
tests, installs, or ships:

- **Not an npm workspace.** `workspaces` in [package.json](../package.json) is an
  explicit list, never a glob over this directory, so `npm install` never walks
  these trees or tries to resolve their dependencies. Run a vendored project's
  own `npm install` inside its directory when you want to boot it.
- **Not in the Cloud Build upload.** [.gcloudignore](../.gcloudignore) excludes
  the repository root (`/*`) and re-includes only what an image needs.
  `third_party/` is never re-included, so these 189 MB never enter a build
  context. That is also why rule 2 above exists.
- **Not in the frontend build.** Vite's Rollup input is an explicit map of
  `pages/*.html`, and `third_party/` is outside both `src/` and `public/`.
- **Not in the test run.** `vitest.config.js` includes explicit path globs
  (`tests/**`, `src/**`, `packages/*/tests/**`), none of which reach here, so
  upstream's own test files never join our suite.
- **Skipped by the house guards, on purpose** (all committed in `cb1ec2680`):
  `scripts/check-rules.mjs` skips it because the typography and comment rules
  apply to prose we write, not prose we transcribe (this drop carries 1625
  em-dashes that are upstream's to fix); `scripts/audit-docs.mjs` skips it
  because upstream's relative links resolve against upstream's layout;
  `eslint.config.js` and `.i18nrc.json` skip it for the same reason.
- **Still scanned for credentials.** `scripts/check-secrets.mjs` deliberately
  does NOT skip `third_party/`: a third party's leaked key is still a leaked key
  in our history. Both trees pass clean.
- **`demo/` needed an explicit re-include.** [.gitignore](../.gitignore) carries
  an unanchored `demo/` rule for local NVIDIA TRELLIS output, which silently
  swallowed 578 demo files here. `!third_party/**/demo/` re-includes them.

## Re-syncing a tree

Upstream moves. A sync is a clean re-copy, not a merge:

```bash
git clone --depth 1 https://github.com/MengTo/threeui /tmp/threeui-sync
git -C /tmp/threeui-sync rev-parse HEAD          # record this in the table above
rm -rf third_party/threeui
rsync -a --exclude .git /tmp/threeui-sync/ third_party/threeui/
node scripts/check-secrets.mjs --paths third_party/threeui
git status --porcelain third_party/threeui       # review before staging
```

Then update the commit, date and file count in the table above in the same
change, and add a `data/changelog.json` entry only if the sync changes something
a three.ws user or developer would notice.

Verify a copy is complete by comparing against upstream's tracked file list
rather than eyeballing it:

```bash
git -C /tmp/threeui-sync ls-files | wc -l        # must equal:
find third_party/threeui -type f | wc -l
```

## Attribution

Both trees are the work of [Meng To](https://github.com/MengTo) and the
[Design+Code](https://designcode.io) team, used here under the MIT licence.
Anything we ship that derives from them keeps that attribution with it.
