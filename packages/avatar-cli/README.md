<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/avatar-cli</h1>

<p align="center"><strong>Terminal-native tooling for on-chain avatars: scaffold, validate, hash, and preview avatar manifests.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/avatar-cli"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/avatar-cli?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/avatar-cli"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/avatar-cli?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/avatar-cli?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/avatar-cli?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#ci-usage">CI usage</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/avatar-cli` brings the three.ws on-chain avatar workflow to your shell
> and CI. It scaffolds spec-compliant manifests from a wallet and a mesh file,
> validates existing manifests, computes content-addressing hashes, and prints
> embeddable preview snippets. Every command runs offline against
> [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema)
> — no service to sign up for, no browser required.

## Install

```bash
# run a single command without installing
npx @three-ws/avatar-cli --help

# or install globally
npm install -g @three-ws/avatar-cli
three-ws-avatar --help
```

The binary is `three-ws-avatar`. `--version` prints the package version; `--help` /
`-h` prints usage.

## Quick start

```bash
# 1. Grab a real rigged avatar to work with (or point --mesh at your own GLB)
curl -sLO https://three.ws/avatars/michelle.glb

# 2. Scaffold a manifest from your wallet + mesh (sha256 + size computed for you)
three-ws-avatar init \
  --owner eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --name "Nicholas" \
  --mesh ./michelle.glb \
  --skeleton mixamo \
  --out manifest.json
# → ok wrote /…/manifest.json   (validated against @three-ws/avatar-schema before writing)
#   plus a summary line for id, skeleton, and mesh (format · size · sha256)

# 3. Validate it
three-ws-avatar validate manifest.json
# → ok manifest.json is valid

# 4. Print embed snippets
three-ws-avatar preview manifest.json
# → resolver URL, <agent-3d> element + loader, and <iframe> snippet
```

## Commands

| Command | What it does |
|---|---|
| `init` | Scaffold a new avatar manifest from a wallet and mesh file. |
| `validate <path>` | Validate an existing manifest against the schema (exit 1 if invalid). |
| `hash <path>` | Compute the SHA-256 of any file, lowercase hex. |
| `preview <path>` | Print resolver URL + an embeddable `<agent-3d>` snippet (with its loader) and an `<iframe>` snippet. |

### `init` — scaffold a manifest

```bash
three-ws-avatar init \
  --owner <caip10|0xaddr> \
  --name <string> \
  --mesh <path> \
  [--skeleton avaturn|mixamo|rpm|vrm-humanoid|custom] \
  [--mesh-uri <https://… or ipfs://…>] \
  [--id <override>] \
  [--out manifest.json]
```

| Flag | Required | Notes |
|---|---|---|
| `--owner` | yes | Full CAIP-10 (`eip155:1:0x…`) or a shorthand `0x…` address (assumed `eip155:1`). |
| `--name` | yes | Avatar display name. |
| `--mesh` | yes | Path to a `.glb` / `.gltf` / `.vrm` file. SHA-256, byte size, and `format` are computed/inferred automatically. |
| `--skeleton` | no | One of `avaturn` (default) / `mixamo` / `rpm` / `vrm-humanoid` / `custom`. |
| `--mesh-uri` | no | Public URI to reference instead of the local `file://` path (use your IPFS/S3 URL). |
| `--id` | no | Override the id; otherwise derived from the owner's CAIP-10, or from `--name` if it's an ENS-style `*.eth` / `*.ws` / `*.sol` name. |
| `--out` | no | Write to a file (default: print JSON to stdout). |

The manifest is **validated against `@three-ws/avatar-schema` before output** — if
you get JSON back, it's spec-compliant by definition.

### `validate` — check a manifest

```bash
three-ws-avatar validate manifest.json           # → ok manifest.json is valid
three-ws-avatar validate manifest.json --json    # → {"valid":true,"path":"manifest.json"}
```

Exit code `0` if valid, `1` otherwise. On failure, each error prints its JSON
instance path and message (or a structured `errors` array with `--json`).

### `hash` — SHA-256 a file

```bash
sha=$(three-ws-avatar hash ./michelle.glb)
echo "$sha"
# 28d788538f7b22b8e00c1d715fffc380bb06a304613d522c20523d3d6ff79bc2
```

`--json` emits `{ "path", "sha256", "bytes" }` instead of the bare hex line.

### `preview` — embed snippets

```bash
three-ws-avatar preview manifest.json
```

Prints three things:

1. The resolver URL, `https://three.ws/a/{id}`
2. An `<agent-3d>` web-component snippet, together with the loader `<script>` that
   registers the element. Both lines are printed because `<agent-3d>` is an ordinary
   unknown element until that script runs, so the snippet is only complete with both.
3. A zero-install `<iframe>` embed snippet

When `mesh.uri` is still a local `file://` path, `preview` warns instead of printing a
snippet no browser can load. Pass `--mesh-uri` to `init` to set a public URL.

Use `--viewer http://localhost:3000` to target a local dev viewer, or `--json` for
machine-readable output
(`{ id, resolverUrl, loader, element, iframe, meshUri, meshIsLocal, schemaVersion }`).

## CI usage

Avatars are content, and content belongs in a build pipeline:

```bash
# Fail the build if the mesh bytes drifted from what the manifest attests to.
expected=$(node -p "require('./manifest.json').mesh.sha256")
actual=$(three-ws-avatar hash ./michelle.glb)
[ "$expected" = "$actual" ] || { echo "mesh hash mismatch"; exit 1; }

# Gate every manifest change on schema validity.
three-ws-avatar validate manifest.json
```

## Requirements

- Node `>=18`.
- Bundled dependency: [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) (used to validate every scaffolded and checked manifest).

## Related packages

- [`@three-ws/avatar-schema`](https://www.npmjs.com/package/@three-ws/avatar-schema) — the manifest format this CLI scaffolds and validates.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) is the runtime SDK behind the `<agent-3d>` element the `preview` snippets embed.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
