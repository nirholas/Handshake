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
- **3D assets** — contribute to the Character Studio avatar library
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
# Minimum required: DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY

# 4. Apply the database schema (requires DATABASE_URL to be set)
psql "$DATABASE_URL" -f api/_lib/schema.sql

# 5. Start the development server
npm run dev
# App: http://localhost:3000
```

### Optional services

| Service | Purpose | Without it |
|---|---|---|
| Neon (Postgres) | Real test database | API routes that need DB will fail |
| Anthropic API key | LLM features | AI responses unavailable |
| Upstash Redis | Distributed rate limiting | Falls back to in-memory per-instance |

Most features work without the optional services. The app degrades gracefully, so basic 3D viewer work, skill development, and UI changes don't require any backend credentials.

For full backend setup including R2 storage and Vercel deployment, see the [Backend Setup](internal/SETUP.md) guide.

---

## Project Structure

```
src/              — client-side JavaScript (agent system, viewer, UI)
api/              — serverless API routes (Node.js, deployed to Vercel)
public/           — static pages and assets
contracts/        — Solidity smart contracts (Foundry)
character-studio/ — avatar builder (separate React SPA)
specs/            — design specifications
docs/             — internal documentation
tests/            — unit and API tests
scripts/          — build and maintenance scripts
examples/         — working code examples (including skill templates)
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

The test suite uses [Vitest](https://vitest.dev/) and covers both source modules and API endpoints.

```bash
# Run all tests
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

The `npm run verify` command is what CI runs. If it passes locally, the build check will pass in the PR.

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

1. **Use the template.** Copy `examples/skills/wave/` as your starting point — it demonstrates the minimal structure a skill needs.

2. **Build your skill.** See the [Skills documentation](./introduction.md) for the full format, lifecycle hooks, and message API.

3. **Host it.** GitHub Pages, Vercel, Netlify, or any static CDN works. The URL just needs to be publicly accessible over HTTPS.

4. **Write a `SKILL.md`** documenting what your skill does, what permissions it requires, and how to install it.

5. **Share it.** Post in the `#skills` channel on Discord, or open a PR to add it to the official skill registry.

---

## Contributing to Character Studio Assets

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

- **[GitHub Discussions](https://github.com/nirholas/three.ws/discussions)** — design questions, architecture ideas, general "how does X work"
- **[GitHub Issues](https://github.com/nirholas/three.ws/issues)** — bug reports and concrete feature requests
- **Discord** — real-time chat (link in the README)

Core team response times: typically 2–3 business days on GitHub, faster in Discord. If a PR has been open for a week with no review, a polite ping in Discord is welcome.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](../LICENSE).
