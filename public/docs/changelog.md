# Changelog & Versioning

This document covers how three.ws is versioned, what has changed across releases, and how to upgrade safely.

---

## Versioning Policy

three.ws follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

| Segment | When it increments | Example |
|---|---|---|
| **Major** | Breaking changes to the web component API, agent manifest schema, or SDK public exports | `2.0.0` |
| **Minor** | New backwards-compatible features | `1.6.0` |
| **Patch** | Bug fixes with no API changes | `1.5.1` |

**Current platform version:** `1.5.1`  
**Current SDK version (`@three-ws/sdk`):** `0.1.0`

The SDK is versioned independently from the platform. A platform patch release does not necessarily bump the SDK version if no public API changed.

---

## Breaking Changes Policy

Breaking changes are rare and follow a defined process:

1. **Deprecation notice** — the feature or behavior is marked deprecated in the preceding minor version. A console warning is emitted at runtime where applicable.
2. **Migration guide** — published before the breaking release so you can update before upgrading.
3. **Grace period** — old behavior is supported for at least one full minor version after the deprecation notice.

What counts as a breaking change:

- Removing or renaming a web component attribute or property
- Changing the agent manifest schema in a non-backwards-compatible way (field removal or rename)
- Changing an API endpoint path, method, or response shape
- Removing a public export from `@three-ws/sdk`

Adding new optional fields to manifests, new optional API response properties, or new SDK exports is **not** a breaking change.

---

## Changelog

Entries are organized by release. Categories follow [Keep a Changelog](https://keepachangelog.com/) conventions.

---

### [1.5.1] — 2026-04-27

#### Added
- `feat`: star field canvas and perspective grid on landing page for visual depth
- `feat`: features page with scroll-driven animations and responsive layout
- `feat`: parallax hero with additional depth layers and updated gallery layout
- `docs`: comprehensive documentation for Introduction, Quick Start, Architecture Overview, 3D Viewer, and Agent System Overview
- `docs`: widget types and configurations reference (`widgets.md`)
- `docs`: custom parallax layer guide

#### Fixed
- `fix`: on-chain deploy now correctly persists agent URI and serves real `agentURI` from the ERC-8004 registry
- `fix`: service worker no longer intercepts all navigations and serves `index.html` for non-page requests
- `fix`: routing paths in `vercel.json` corrected; `home.html` entry added to `appConfig`
- `fix`: `/agent/:id` route now resolves to bundled `agent-home.html` instead of broken public copy
- `fix`: double-mount of agent sidebar on app boot eliminated
- `fix`: boot order restored for `/app?agent=:id` deep links
- `fix`: auto-play of first animation on model load removed (viewer now waits for user intent)

#### Changed
- `refactor`: animation UUIDs updated and build scripts improved
- `refactor`: `explore` renamed to `discover` throughout codebase and comments
- `refactor`: `postMessage` calls streamlined; iframe snippet formatting improved
- `refactor`: aria-labels updated for accessibility; unused stylesheet link removed
- `refactor`: tip jar skill documentation and code cleaned up

---

### [1.5.0] — 2026-04-20

#### Added
- `feat`: share panel with SVG fallback for QR codes
- `feat`: on-chain agent discovery page (`/discover`) with styles and full logic
- `feat`: dashboard form additional fields and improved search
- `feat`: embed functionality with handshake verification and live preview

#### Fixed
- `fix`: auth pending attribute correctly removed from `<body>` after user fetch
- `fix`: agent wallet address visibility for owners in `GET /api/agents` response
- `fix`: agent routing paths updated to point to `/public` directory
- `fix`: unified username/email conflict error messages in registration flow

#### Changed
- `refactor`: cheerio dependency removed; related server code cleaned up
- `refactor`: My Agents page HTML, CSS, and JavaScript unified for consistency

---

### [1.4.0] — 2026-04-18

#### Added
- `feat`: manage permissions panel and ERC-7710 delegation toolkit
- `feat`: `PermissionsClient` — grant, list, verify, and revoke scoped delegations
- `feat`: permissions management lazy loading and advanced permissions smoke test
- `feat`: session management for login redirection
- `feat`: quota enforcement for avatar uploads and limit checks in agent creation flow
- `feat`: on-chain deployment button and styling on agent profile pages

#### Fixed
- `fix`: login and register redirection paths corrected
- `fix`: routing paths in `vercel.json` cleaned up (removed unnecessary `/public` prefix)

#### Changed
- `refactor`: Privy integration removed; wallet connection logic simplified to injected provider

---

### [1.3.0] — 2026-04-17

#### Added
- `feat`: ERC-8004 on-chain agent discovery page (initial implementation)
- `feat`: embed host and action bridges; iframe embed pipeline
- `feat`: LobeHub plugin — manifest, bridge, and dev harness
- `feat`: avatar idle animation loop — breathing, saccade, blink, and weight shift
- `feat`: agent home page with share panel and deploy chip
- `feat`: first-time onboarding banner for new agents
- `feat`: inline name/description editing on agent profile with deploy-on-chain header button
- `feat`: ERC-8004 chain dropdown on `/agent/:id` deploy chip; Base Mainnet as default
- `feat`: viewer camera polish on first load; spacebar, double-click, and `F` shortcuts; per-agent camera preferences stored locally
- `feat`: post-create redirect to editor; 3D body mounted on public agent profile

#### Fixed
- `fix`: wallet auth foundation hardened for agent reliability
- `fix`: TradingView widgets switched to dark mode for midnight theme

#### Changed
- `chore`: duplicate camera module (`capture`) retired
- `chore`: create→deploy flow accessibility polished
- `feat(tests)`: test suite for discover/my-agents rename and routing

---

## SDK Changelog (`@three-ws/sdk`)

The SDK is published separately. Its changelog lives at [sdk/CHANGELOG.md](../sdk/CHANGELOG.md).

### [0.1.0] — 2026-04-14

Initial public release.

**Added:**

- `AgentKit` — one-call class to ship an ERC-8004 agent (panel + registration + manifests)
- `AgentPanel` — standalone floating chat UI with voice I/O; bring your own `onMessage` handler
- ERC-8004 wallet + IPFS + on-chain registration flow via `registerAgent()`
- `.well-known` manifest generators: `agentRegistration()`, `agentCard()`, `aiPlugin()`
- `PermissionsClient` — ERC-7710 delegation grant, verify, and revoke
- Low-level exports: `IDENTITY_REGISTRY_ABI`, `REPUTATION_REGISTRY_ABI`, `VALIDATION_REGISTRY_ABI`, `REGISTRY_DEPLOYMENTS`, `agentRegistryId()`, `buildRegistrationJSON()`, `getIdentityRegistry()`, `connectWallet()`, `pinToIPFS()`
- TypeScript declarations (`index.d.ts`)
- Standalone `styles.css` under the `.ak-*` namespace

---

## CDN Versioning

The CDN bundle is served from Vercel. The URL includes the version so you can pin to an exact release.

```html
<!-- Pinned to 1.5.1 — safe for production; won't break when 2.0.0 releases -->
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>

<!-- Always latest stable — convenient for development, risky for production -->
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
```

The CDN also maintains rolling channel aliases:

| URL pattern | Tracks |
|---|---|
| `agent-3d@1.5.1.js` | Exact version (immutable) |
| `agent-3d@1.5.js` | Latest `1.5.x` patch |
| `agent-3d@1.js` | Latest `1.x` minor |
| `agent-3d.js` | Latest stable (any version) |

**Recommendation:** Pin to a full `MAJOR.MINOR.PATCH` version in production. Upgrade intentionally after reviewing the migration notes for the target version.

Each versioned bundle ships with a `integrity.json` sidecar for [Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) verification:

```
https://three.ws/agent-3d/1.5.1/integrity.json
```

---

## Smart Contract Versioning

ERC-8004 contracts are immutable after deployment. This is a property of the blockchain, not a limitation of the platform.

**What this means in practice:**

- Contract code never changes after deployment. The address is permanent.
- New features that require contract changes are deployed as new contracts at new addresses.
- Old contract addresses continue to work indefinitely — existing agent registrations remain valid.
- The platform always uses the latest contract address for **new** registrations.
- `REGISTRY_DEPLOYMENTS` in the SDK contains all historical deployment addresses; old addresses are never removed.

**When a new contract is deployed:**

1. The new address is added to `REGISTRY_DEPLOYMENTS` for the relevant chain ID.
2. Agents registered on older contracts continue to resolve normally.
3. A migration path is documented if agent owners want to re-register under the new contract (e.g., to gain access to new on-chain features).

```js
// All deployed contract addresses, by chain ID
import { REGISTRY_DEPLOYMENTS } from '@three-ws/sdk';

// Base Mainnet
console.log(REGISTRY_DEPLOYMENTS[8453].identityRegistry);

// Base Sepolia (testnet)
console.log(REGISTRY_DEPLOYMENTS[84532].identityRegistry);
```

---

## Manifest Format Versioning

Agent manifests carry a `$schema` field that identifies the format version:

```json
{
  "$schema": "https://three.ws/schemas/agent-manifest-v1.json",
  "name": "My Agent",
  "endpoint": "https://myapp.com"
}
```

**Current schema:** v1

| Rule | Detail |
|---|---|
| v1 manifests are always loadable | The manifest loader will support v1 indefinitely |
| Additive changes stay in v1 | New optional fields can be added without a version bump |
| Breaking changes require v2 | Field removals and renames will use a new schema URL |
| Simultaneous support | The manifest loader handles both v1 and v2 at the same time during transitions |

---

## How to Upgrade

### npm package

```bash
# Upgrade to latest
npm update @three-ws/sdk

# Pin to a specific version
npm install @three-ws/sdk@0.1.0
```

### CDN embed

Change the version number in the `src` attribute of your script tag. Before upgrading across a major version boundary, read the migration notes in this changelog for every version between your current version and the target.

### Checking your current version

```js
// From the SDK
import { version } from '@three-ws/sdk';
console.log(version); // "0.1.0"

// From the platform API
const { version } = await fetch('/api/config').then(r => r.json());
console.log(version); // "1.5.1"
```

---

## Deprecated Features

No public-facing features are currently deprecated. The only `@deprecated` annotations in the codebase are inside vendored dependencies (Three.js r175 internals) and have no effect on the public API.

When features are deprecated, they will be listed here with:

- The version that introduced the deprecation
- The target version for removal
- A migration path

---

## Release Process

For contributors and maintainers. A release follows these steps:

1. Changes are merged to the `main` branch via pull request.
2. `package.json` version is bumped (and `sdk/package.json` if the SDK changed).
3. This `CHANGELOG.md` is updated with entries for the new version.
4. A git tag is created: `git tag v1.5.1 && git push origin v1.5.1`
5. A GitHub Release is created from the tag with the changelog entry as the body.
6. `npm run build:all` produces the platform bundle and the CDN library build.
7. `npm run publish-lib` copies the CDN bundle into `dist/agent-3d/{version}/`, generates an `integrity.json` sidecar with SHA-384 hashes, updates the rolling channel aliases (`1.5`, `1`, `latest`), and writes a `versions.json` manifest.
8. Vercel auto-deploys from `main` and serves the updated `dist/` directory on the CDN.

The SDK (`@three-ws/sdk`) is published to npm separately:

```bash
cd sdk && npm publish
```

---

## Staying Up to Date

- **GitHub Releases** — Watch the repository and select "Releases only" to get an email for each new release.
- **npm outdated** — Add `npm outdated @three-ws/sdk` to your CI pipeline to detect available upgrades automatically.
- **`versions.json`** — The CDN publishes a machine-readable index at `https://three.ws/agent-3d/versions.json` listing all available versions, channel aliases, and SRI hashes.
