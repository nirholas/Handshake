# Avatar CLI

`@three-ws/avatar-cli` is terminal-native tooling for on-chain avatars. It scaffolds an avatar manifest from a wallet and a mesh file, validates that manifest against the published schema, hashes mesh bytes, and prints an embed snippet you can paste into a page.

It is the piece that lets avatars live in a build pipeline instead of a browser tab. Everything it does is offline and deterministic: no account, no API key, no network call. That is what makes it safe to put in a release script.

**On this page:** [Install](#install) · [Quick start](#quick-start) · [Commands](#commands) · [The manifest](#the-manifest) · [Exit codes](#exit-codes-and-scripting) · [Release gate](#gate-a-release-on-the-manifest)

Related: [`@three-ws/avatar-schema`](../packages/avatar-schema/README.md) is the wire format this validates against. The [web component reference](./web-component.md) covers the `<agent-3d>` element the CLI emits.

---

## Install

Global, if you use it often:

```bash
npm install -g @three-ws/avatar-cli
three-ws-avatar --version
```

```
0.2.0
```

Or run it without installing. The package has exactly one binary, so `npx` resolves it directly:

```bash
npx @three-ws/avatar-cli --version
```

Pin the version in anything automated so a future release cannot change your build's behavior:

```bash
npx @three-ws/avatar-cli@0.2.0 validate manifest.json
```

Node 18 or newer. The CLI has one runtime dependency, `@three-ws/avatar-schema`, which carries the JSON Schema it validates against.

---

## Quick start

Four commands take you from a `.glb` file to a snippet you can paste into a page. Every command below runs as written.

```bash
# 1. Grab a real rigged avatar to work with (or point --mesh at your own GLB)
curl -sLO https://three.ws/avatars/michelle.glb

# 2. Scaffold a manifest. sha256 and size are computed for you.
three-ws-avatar init \
  --owner eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --name "Nicholas" \
  --mesh ./michelle.glb \
  --skeleton mixamo \
  --mesh-uri https://three.ws/avatars/michelle.glb \
  --out manifest.json

# 3. Validate it
three-ws-avatar validate manifest.json

# 4. Print embed snippets
three-ws-avatar preview manifest.json
```

Step 2 prints its summary to stderr, so it stays out of anything you pipe:

```
✔ wrote /home/you/manifest.json
  • id        eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e
  • skeleton  mixamo
  • mesh      glb · 830 kB · sha256:28d788538f7b…
  › next: three-ws-avatar preview manifest.json
```

> **Pass `--mesh-uri`.** Without it the manifest's `mesh.uri` points at the local `file://` path, which no browser can load. `preview` warns when that happens, but it is easier to set up front.

---

## Commands

### `init` - scaffold a manifest

Builds a schema-valid manifest from flags. The mesh is read once to compute its SHA-256 and size. Output goes to stdout unless you pass `--out`.

```bash
three-ws-avatar init --owner <id> --name <name> --mesh <path> [options]
```

| Flag | Required | Description |
|---|---|---|
| `--owner <caip10\|sol\|0x…>` | yes | Owner identity. Full CAIP-10 (`eip155:1:0xabc…`), a bare Solana address, which is assumed to be `solana:mainnet-beta`, or a bare `0x…` address, which is assumed to be `eip155:1`. |
| `--name <string>` | yes | Display name. If it looks like a name service handle (`nick.eth`, `nick.ws`, `nick.sol`) it also becomes the manifest `id`. |
| `--mesh <path>` | yes | Path to a `.glb`, `.gltf`, or `.vrm` file. Must exist; the extension decides `mesh.format`. |
| `--skeleton <name>` | no | One of `avaturn`, `mixamo`, `rpm`, `vrm-humanoid`, `custom`. Default `avaturn`. |
| `--mesh-uri <url>` | no | Public URL for the mesh. Defaults to the local `file://` path, which is fine for a hash-only workflow and wrong for anything embedded. |
| `--id <string>` | no | Override the derived id. |
| `--out <path>` | no | Write to a file instead of stdout. |

Without `--out` the manifest goes to stdout and the summary to stderr, so redirecting captures clean JSON:

```bash
three-ws-avatar init --owner 0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --name "nick.eth" --mesh ./michelle.glb > manifest.json
```

```json
{
  "schemaVersion": 1,
  "id": "nick.eth",
  "name": "nick.eth",
  "mesh": {
    "uri": "file:///home/you/michelle.glb",
    "sha256": "28d788538f7b22b8e00c1d715fffc380bb06a304613d522c20523d3d6ff79bc2",
    "format": "glb",
    "kBytes": 830
  },
  "skeleton": "avaturn",
  "owner": {
    "chain": "eip155:1",
    "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
  },
  "createdAt": "2026-07-30T19:23:34.595Z"
}
```

The scaffolded manifest is validated before it is written, so `init` cannot produce an invalid file.

### `validate` - check a manifest against the schema

```bash
three-ws-avatar validate <path> [--json]
```

Exits `0` when valid, `1` otherwise. Every schema error is printed at the instance path where it occurred:

```bash
three-ws-avatar validate broken.json
```

```
✖ broken.json is invalid (7 errors)
  • / must have required property 'mesh'
  • / must have required property 'skeleton'
  • / must have required property 'owner'
  • / must have required property 'createdAt'
  • /id must match pattern "^[a-z0-9-]{3,8}:[a-zA-Z0-9_-]{1,32}:[a-zA-Z0-9]{1,64}$"
  • /id must match pattern "^[a-z0-9][a-z0-9-]{0,62}\.(eth|ws|sol)$"
  • /id must match a schema in anyOf
```

The last three lines are one failure, not three: `id` accepts either a CAIP-10 account or a name service handle, so a bad id reports both branches plus the `anyOf` that rejected it.

`--json` emits `{ "valid", "path" }` on success and adds a raw `errors` array on failure, suitable for annotating a build.

### `hash` - SHA-256 a file

```bash
three-ws-avatar hash <path> [--json]
```

Prints lowercase hex on stdout and nothing else, so it composes:

```bash
sha=$(three-ws-avatar hash ./michelle.glb)
echo "$sha"
```

```
28d788538f7b22b8e00c1d715fffc380bb06a304613d522c20523d3d6ff79bc2
```

`--json` emits `{ "path", "sha256", "bytes" }` instead of the bare line.

This is the same digest `init` writes into `mesh.sha256`, which is what makes the [release gate](#gate-a-release-on-the-manifest) below a one-line comparison.

### `preview` - print an embed snippet

```bash
three-ws-avatar preview <path> [--viewer <origin>] [--json]
```

Validates the manifest, then prints three ways to put the avatar on a page:

```bash
three-ws-avatar preview manifest.json
```

```
Nicholas (eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e)

› resolver url
https://three.ws/a/eip155%3A1%3A0x742d35Cc6634C0532925a3b844Bc454e4438f44e

› web component (loader registers <agent-3d>)
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d src="https://three.ws/avatars/michelle.glb" style="width:400px;height:600px"></agent-3d>

› iframe (zero-install)
<iframe src="https://three.ws/a/eip155%3A1%3A0x742d35Cc6634C0532925a3b844Bc454e4438f44e" width="480" height="640" frameborder="0" allow="camera; microphone; xr-spatial-tracking"></iframe>
```

The web-component block is emitted with its loader on purpose. `<agent-3d>` is an ordinary unknown element until that script registers it, so the snippet is only complete with both lines. See the [web component reference](./web-component.md) for the full attribute surface.

When `mesh.uri` is still a local path, `preview` says so rather than handing you a snippet that renders nothing:

```
⚠ mesh.uri is a local path, so the snippet above will not load in a browser.
  re-run init with --mesh-uri https://your-host/avatar.glb, or edit mesh.uri to a public URL
```

`--viewer <origin>` swaps the host in the resolver URL, the loader, and the iframe, for a staging environment or a self-hosted deployment:

```bash
three-ws-avatar preview manifest.json --viewer https://staging.example.com
```

`--json` returns the pieces separately (`resolverUrl`, `loader`, `element`, `iframe`, `meshUri`, `meshIsLocal`, `schemaVersion`) so a site generator can place them itself.

---

## The manifest

Seven fields are required: `schemaVersion`, `id`, `name`, `mesh`, `skeleton`, `owner`, `createdAt`. `init` writes all seven.

| Field | Notes |
|---|---|
| `schemaVersion` | Always `1` for documents validated against the v1 schema. |
| `id` | Either a CAIP-10 account id or a name service handle ending in `.eth`, `.ws`, or `.sol`. |
| `name` | Human-readable display name. |
| `mesh` | Requires `uri`, `sha256`, `format`. `init` also writes `kBytes`. |
| `skeleton` | `avaturn`, `mixamo`, `rpm`, `vrm-humanoid`, or `custom`. Picks the animation library that retargets onto the rig. |
| `owner` | Requires `chain` and `address`. |
| `createdAt` | ISO 8601 UTC. |

Five optional fields the schema accepts and `init` leaves out, for you to add by hand: `animations` (a clip manifest pointer), `accessories` (slot bindings for hats, glasses, and the like), `traits` (free-form NFT-style key/values), `creator` (when it differs from `owner`), and `signature` (over the canonical JSON serialization).

Add any of them and re-run `validate` to confirm the result still conforms.

---

## Exit codes and scripting

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Validation failed, a required flag or argument was missing, a file was missing or unreadable, or the command was unknown. |

Three conventions make the output safe to pipe:

- **stdout carries payloads only.** The hash hex, scaffolded JSON, `--json` output, and embed snippets go to stdout undecorated. Status lines, warnings, and hints go to stderr.
- **Color is suppressed automatically** when stdout is not a TTY. `--no-color` and the [`NO_COLOR`](https://no-color.org) environment variable both disable it; `FORCE_COLOR=1` forces it back on for a CI log that renders ANSI.
- **Glyphs degrade to ASCII** off a TTY, so log files stay readable.

A mistyped command suggests the closest match rather than dumping the whole help text:

```bash
three-ws-avatar previw manifest.json
```

```
✖ unknown command: previw
  did you mean "preview"?
  run "three-ws-avatar --help" to see all commands
```

---

## Gate a release on the manifest

Avatars are content, and content drifts. Two checks catch the drift that actually bites, and neither needs network access.

**Has the mesh changed since the manifest attested to it?**

```bash
expected=$(node -p "require('./manifest.json').mesh.sha256")
actual=$(three-ws-avatar hash ./michelle.glb)
[ "$expected" = "$actual" ] || { echo "mesh hash mismatch"; exit 1; }
```

**Is every manifest in the repo still schema-valid?**

```bash
find . -name '*.avatar.json' -not -path './node_modules/*' -print0 \
  | xargs -0 -n1 three-ws-avatar validate
```

`xargs` propagates a non-zero exit, so one bad manifest fails the whole step. Add both to whatever runs your release (a `package.json` script, a Makefile target, your deploy script) and a broken avatar stops being something you discover in production.

For machine-readable output, swap in `--json` and test the result:

```bash
three-ws-avatar validate manifest.json --json | jq -e '.valid'
```

---

## Where to go next

- **[Ship an avatar manifest](./tutorials/ship-an-avatar-manifest.md)** walks the whole path end to end, from a raw GLB to a live embed, and explains the decision at each step.
- **[Web component reference](./web-component.md)** documents every attribute on the `<agent-3d>` element `preview` emits.
- **[`@three-ws/avatar-schema`](../packages/avatar-schema/README.md)** is the normative format if you are writing your own tooling.
- The package source lives in [`packages/avatar-cli`](https://github.com/nirholas/three.ws/tree/main/packages/avatar-cli).
