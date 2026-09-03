# Contributing to three.ws

Thanks for your interest in contributing. This guide covers everything you need to get started — from setting up a local environment to submitting a pull request that will get merged.

---

## Ways to Contribute

You don't have to write code to make an impact. Contributions take many forms:

- **Bug reports** — open a GitHub issue with clear reproduction steps
- **Bug fixes** — pick up an open issue and submit a PR
- **New features** — discuss the idea in an issue first, then implement
- **Documentation** — improve or extend these docs (typos count)
- **Skills** — build and share a new agent skill without touching core code
- **3D assets** — contribute to the Avatar Studio avatar library
- **Smart contracts** — improve the ERC-8004 contracts (requires prior security audit review)
- **Translations** — localize the UI for new languages

---

## Before You Start

1. **Read the README and CLAUDE.md.** The CLAUDE.md coding guidelines are enforced in code review — save yourself a round trip.
2. **Search open issues.** Someone may already be working on the same thing. If you find a related issue, comment to claim it.
3. **Open a discussion issue for significant features.** Before spending a week on a new subsystem, get a signal that it aligns with project direction. A quick "I'd like to implement X because Y — any concerns?" prevents wasted work.

---

## Development Setup

### Requirements

- Node.js 24.x (the repo's `engines.node` pins to this)
- A browser with WebGL 2.0 (Chrome, Firefox, Safari 15+, or Edge)

### Steps

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/three.ws.git
cd three.ws

# 2. Install dependencies
npm install

# 3. Copy environment variables
cp .env.example .env.local
# Minimum required: DATABASE_URL, JWT_SECRET, and one chat provider key
# (GROQ_API_KEY, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY)

# 4. Provision the database (requires DATABASE_URL to be set)
npm run db:bootstrap
# Runs core schema + indexer + delegations + migrations; idempotent.
# Do NOT apply api/_lib/schema.sql alone (it skips the migration-defined tables).

# 5. Start the development server
npm run dev
# App: http://localhost:3000
```

### Optional services

| Service | Purpose | Without it |
|---|---|---|
| Neon (Postgres) | Real test database | API routes that need DB will fail |
| An LLM provider key (Groq, OpenRouter, NVIDIA, Anthropic, or OpenAI) | LLM features | AI responses unavailable |
| Upstash Redis | Distributed rate limiting | Falls back to in-memory per-instance |

Most features work without the optional services. The app degrades gracefully, so basic 3D viewer work, skill development, and UI changes don't require any backend credentials.

For full backend setup — R2 storage, environment variables, and how the app is deployed — see the [Configuration Reference](configuration.md) and the [Deployment & Self-Hosting](deployment.md) guide.

---

## Project Structure

```
src/              - client-side JavaScript (agent system, viewer, UI)
api/              - serverless-style API handlers (Node.js, served by the Cloud Run container)
pages/            - HTML entry points for the multi-page app
public/           - static pages and assets
contracts/        - Solidity smart contracts (Foundry)
character-studio/ - avatar builder (separate React SPA)
packages/         - publishable packages (MCP servers and more)
sdk/, *-sdk/      - client SDKs
workers/          - GPU/background workers
specs/            - design specifications
docs/             - public documentation (served at three.ws/docs)
tests/            - unit and API tests
scripts/          - build and maintenance scripts
examples/         - working code examples (including skill templates)
```

Key source files:

```
src/
├── app.js           — entry point, URL params, drag-and-drop
├── viewer.js        — Three.js scene, camera, controls, GUI
├── validator.js     — glTF validation pipeline
├── environments.js  — HDR environment map definitions
└── components/      — vhtml JSX components (string-based, no virtual DOM)
```

See the [Architecture Overview](./introduction.md) for a deeper understanding of how these pieces connect.

---

## Coding Guidelines

The project follows the rules in [CLAUDE.md](../CLAUDE.md). These are enforced in code review, so read them before writing a line. The short version:

**Simplicity first.** Write the minimum code that solves the problem. No abstractions for single-use code. No "configurability" that wasn't requested. If your change is 200 lines and it could be 50, rewrite it before opening the PR.

**Surgical changes.** Touch only what your task requires. Don't "improve" adjacent code, fix unrelated formatting, or refactor things that aren't broken. Match existing style even if you'd do it differently. Every changed line should trace directly to the issue you're addressing.

**No speculative features.** Only build what was asked. A bug fix doesn't need surrounding cleanup. A new widget doesn't need a plugin system for hypothetical future widgets.

**Comments only when the WHY is non-obvious.** If the code's intent is clear from the names, don't add a comment. Never describe what the code does — describe why it does something surprising.

**Clean up your orphans.** Remove imports, variables, and functions that your changes made unused. Don't remove pre-existing dead code unless you were asked to.

**Three.js resource hygiene.** Any new `Geometry`, `Material`, or `Texture` must be disposed in `Viewer.clear()`. Any `URL.createObjectURL()` must have a corresponding `URL.revokeObjectURL()`.

**No new dependencies without discussion.** Keep the bundle small. Open an issue first.

**Browser compatibility.** Must work in Chrome, Firefox, and Edge. Safari support is best-effort.

---

## Running Tests

The test suite uses [Vitest](https://vitest.dev/) for source modules and API endpoints, plus [Playwright](https://playwright.dev/) for browser tests. `npm test` runs Vitest first and only proceeds to the Playwright stage when the unit suite is green.

```bash
# Run all tests (vitest, then playwright)
npm test

# Run a specific test file
npx vitest run tests/src/manifest.test.js

# Run API tests only
npx vitest run tests/api/

# Watch mode (re-runs on file changes)
npx vitest

# With coverage
npx vitest run --coverage
```

Format and verify before opening a PR:

```bash
# Auto-format (Prettier)
npm run format

# Check formatting + run production build
npm run verify
```

`npm run verify` runs the same Prettier check and production build the maintainers gate on before merging. Run it locally before opening the PR — a green `verify` is what reviewers expect.

---

## Publishing packages & standalone mirrors

Every package in `packages/` ships to up to three destinations: npm, the official
MCP registry (MCP servers only), and its own standalone GitHub repo. All steps are
idempotent and default to a safe dry run, so re-running after a network drop or a
rate limit picks up where it stopped.

Which lane a package is in is decided by the filesystem, not by a list someone has
to remember to edit. A directory holding a `server.json` is an **MCP server**;
everything else with a non-private `package.json` is a **library package**.

**1. Library packages → npm** (`scripts/publish-packages.mjs`):

```bash
npm run publish:packages:dry   # report what would publish, run the preflight
npm run publish:packages       # publish every version missing from npm
node scripts/publish-packages.mjs --new          # only never-published packages
node scripts/publish-packages.mjs --only forge   # one package, by directory name
```

Before publishing anything the script runs a preflight per package and refuses to
ship one that would land broken: a scoped package without
`publishConfig.access: "public"` (npm publishes it restricted and then 402s on a
free plan), a missing README or LICENSE, an `exports`/`main`/`bin` target that is
not on disk, or a `workspace:`/`file:` dependency that no installer could resolve.
A blocked package exits non-zero; fix the manifest rather than skipping it.

**2. MCP servers → npm + the official MCP registry** (`registry.modelcontextprotocol.io`):

```bash
npm run audit:mcp          # validate every server.json (names, versions, descriptions)
npm run publish:mcp:dry    # report what would publish - no writes
npm run publish:mcp        # publish any package/version missing from npm or the registry
```

Auth: npm needs `npm whoami` to succeed or `NPM_TOKEN` set. The registry publishes
under the `io.github.nirholas` namespace and needs `MCP_REGISTRY_TOKEN`, or a
GitHub token for that account (`GITHUB_TOKEN`, or the PAT on the `origin` remote).
A token for a different account authenticates fine and is then rejected for that
namespace.

**3. Standalone GitHub mirrors** - each package also lives in its own repo at
`github.com/<owner>/<name>` (a read-only mirror; the monorepo stays canonical).
Each sync force-pushes one snapshot commit whose message records the source
monorepo SHA, and rewrites the mirror's `package.json` / `server.json`
`repository` fields to point at the standalone repo:

```bash
npm run sync:repos:dry     # plan only, both lanes
npm run sync:repos         # create missing repos + push snapshots (needs gh auth as the owner)
# scope it:
node scripts/sync-standalone-repos.mjs --dry-run --kind lib --new
node scripts/sync-standalone-repos.mjs --execute --only agent-sniper,copy-mcp
```

`--kind mcp` / `--kind lib` narrows to one lane, `--new` limits the run to repos
that do not exist yet, and the dry run prints how many repos it would CREATE
before you commit to it. Repo names come from the unscoped npm name, except that
a single-token `@three-ws/*` name mirrors as `three-ws-<name>`: the scope carries
the identity on npm, but `github.com/nirholas/render` says nothing about what it
is or who ships it.

Auth: `gh` must be authenticated as the target owner (default `nirholas`; override
with `--owner`) so it can create and push under that account.

---

## Writing Tests

- **Unit tests** go in `tests/src/` for pure functions and source modules
- **API tests** go in `tests/api/` for endpoint behavior
- Test file names mirror source paths: `src/manifest.js` → `tests/src/manifest.test.js`
- Use Vitest's `describe` / `it` / `expect` pattern — no other test frameworks
- **Don't mock the database in API tests.** Use a real test database pointed at by `DATABASE_URL`. Mocking the DB has caused production bugs when migration behavior diverged from mocked behavior.

---

## Submitting a Pull Request

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes**, following the coding guidelines above.

3. **Run the test suite:**
   ```bash
   npm test
   ```

4. **Format and verify:**
   ```bash
   npm run verify
   ```

5. **Commit** with a clear conventional message (see format below).

6. **Push to your fork:**
   ```bash
   git push origin feat/your-feature-name
   ```

7. **Open a PR** on GitHub against the `main` branch.

8. **Fill in the PR template** — what changed, how to test it, screenshots if the change is visual.

A core team member will review within 2–3 business days. Smaller, focused PRs get reviewed faster than large multi-concern changes.

---

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use |
|---|---|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |
| `chore:` | Maintenance — dep updates, config changes, build scripts |

Rules for the subject line:

- Imperative mood: "add" not "added", "fix" not "fixes"
- No period at the end
- Under 72 characters

Examples:

```
feat: add hotspot click animation to tour widget
fix: correct morph target decay rate for empathy emotion
docs: add AR guide to contributing section
test: add coverage for manifest normalization edge cases
```

---

## Contributing a Skill

Skills are the best way to extend three.ws without touching core code. A skill is a hosted directory of assets and a manifest — it runs in an isolated context and communicates via a defined message protocol.

1. **Use the template.** Copy `examples/skills/solana-wallet/` as your starting point — its `manifest.json`, `tools.json`, `handlers.js`, and `SKILL.md` demonstrate the minimal structure a skill needs.

2. **Build your skill.** See the [Skills documentation](./skills.md) for the full format, lifecycle hooks, and message API.

3. **Host it.** GitHub Pages, Vercel, Netlify, or any static CDN works. The URL just needs to be publicly accessible over HTTPS.

4. **Write a `SKILL.md`** documenting what your skill does, what permissions it requires, and how to install it.

5. **Share it.** Open a [GitHub issue](https://github.com/nirholas/three.ws/issues/new) announcing it, or list it on the platform's skill marketplace so agents can install it.

---

## Contributing to Avatar Studio Assets

The avatar asset library welcomes clothing, hair, accessories, and other character parts:

1. Use Blender with the base mesh template (documented in `/character-studio/README.md`).
2. Create your asset, staying within the vertex budget and UV guidelines described in the template.
3. Export as GLB following the naming conventions (also in the README).
4. Place the file in `/character-studio/public/<category>/`.
5. Add an entry to the asset manifest JSON in the same directory.
6. Submit a PR with at least one screenshot of the asset in context.

---

## Reporting Bugs

Open a [GitHub issue](https://github.com/nirholas/three.ws/issues/new) and include:

- Browser and OS version
- Steps to reproduce (numbered, specific)
- Expected behavior
- Actual behavior
- Console errors — screenshot or paste the full message
- A link to a GLB file that triggers the issue, if relevant

Check [existing issues](https://github.com/nirholas/three.ws/issues) before opening a new one to avoid duplicates.

**Security vulnerabilities:** Do NOT open a public issue. Follow the responsible disclosure process described in the [Security documentation](./security.md). Public disclosure of an unpatched vulnerability puts all users at risk.

---

## Getting Help

- **[GitHub Issues](https://github.com/nirholas/three.ws/issues)**: bug reports, concrete feature requests, design questions, and general "how does X work". Discussions are not enabled on the repository, so issues are the one channel.

Core team response times: typically 2-3 business days on GitHub. If a PR has been open for a week with no review, a polite bump on the PR is welcome.

---

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](../LICENSE), the same license the repository ships under.

---

## Related

- [Configuration Reference](/docs/configuration): every environment variable and config file
- [Deployment & Self-Hosting](/docs/deployment): running the full stack yourself
- [Skills](/docs/skills): the skill format, lifecycle hooks, and message API
- [Security](/docs/security): responsible disclosure and the security model
