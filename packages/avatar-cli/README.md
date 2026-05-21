# @three-ws/avatar-cli

Terminal-native tooling for on-chain avatars. Scaffold, validate, hash, and
preview avatar manifests from your shell or CI.

> **What RPM doesn't have.** Ready Player Me has a hosted creator and a
> hosted SDK, but no CLI and no offline pipeline. three.ws's avatar workflow
> is composable with build pipelines, content-addressed storage, and any
> wallet — no service to sign up for.

## Install

```bash
# one-shot
npx @three-ws/avatar-cli init --owner 0xabc... --name "Nicholas" --mesh ./avatar.glb

# or globally
npm i -g @three-ws/avatar-cli
three-ws-avatar --help
```

## Quickstart — claim an on-chain avatar in 30 seconds

```bash
# 1. Generate a signed-ready manifest from your wallet + mesh
three-ws-avatar init \
  --owner 0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --name "Nicholas" \
  --mesh ./avatar.glb \
  --out manifest.json

# 2. Validate it
three-ws-avatar validate manifest.json
# → ok: manifest.json

# 3. Preview the embed snippet
three-ws-avatar preview manifest.json
# → resolver URL, <three-ws-avatar> element, and iframe snippet
```

## Commands

### `init` — scaffold a manifest

```bash
three-ws-avatar init \
  --owner <caip10|0xaddr> \
  --name <string> \
  --mesh <path> \
  [--skeleton avaturn|mixamo|rpm|vrm-humanoid|custom] \
  [--mesh-uri <https://... or ipfs://...>] \
  [--id <override>] \
  [--out manifest.json]
```

- `--owner` accepts either a full CAIP-10 (`eip155:1:0x...`) or a shorthand
  `0x...` address (assumed `eip155:1`).
- `--mesh` is the path to a `.glb`, `.gltf`, or `.vrm` file. SHA-256 and byte
  size are computed automatically; format is inferred from the extension.
- `--mesh-uri` lets you override the public URL the manifest references — if
  you're going to upload to IPFS or S3, pass that URI here so the manifest
  resolves correctly for everyone else.
- `--id` defaults to the owner's CAIP-10, or to `--name` if it's an ENS-style
  name (`*.eth` / `*.ws` / `*.sol`).
- The generated manifest is **validated against `@three-ws/avatar-schema`
  before output** — if you get JSON back, it's spec-compliant by definition.

### `validate` — check an existing manifest

```bash
three-ws-avatar validate manifest.json
# or for machine output
three-ws-avatar validate manifest.json --json
```

Exit code 0 if valid, 1 otherwise. Use in CI.

### `hash` — SHA-256 a file

```bash
sha=$(three-ws-avatar hash ./avatar.glb)
echo "$sha"
# 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b
```

`--json` emits `{ path, sha256, bytes }` instead.

### `preview` — get embed snippets

```bash
three-ws-avatar preview manifest.json
```

Outputs three things:

1. The three.ws viewer URL (`https://three.ws/a/{id}`)
2. A `<three-ws-avatar>` web-component snippet
3. A drop-in `<iframe>` embed snippet

Use `--viewer https://localhost:3000` to point at a local dev viewer instead.

## Why a CLI

Avatars are content. Content belongs in a build pipeline:

- Hash on commit, fail CI if the manifest's `mesh.sha256` doesn't match the
  bytes in the repo.
- Validate every change to a manifest before it merges.
- Generate per-environment manifests (dev viewer vs production viewer).
- Scriptable bulk migration: `find . -name avatar.glb | while read f; do three-ws-avatar init ...; done`

RPM has none of this. Their workflow is "open browser, drag sliders, copy
URL." Ours is "git commit, run CI, ship."

## License

Apache-2.0 — see [LICENSE](LICENSE).
