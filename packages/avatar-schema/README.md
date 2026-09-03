<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/avatar-schema</h1>

<p align="center"><strong>JSON Schema and validator for three.ws on-chain avatar manifests — the canonical, hash-anchored avatar format.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/avatar-schema"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/avatar-schema?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/avatar-schema"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/avatar-schema?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/avatar-schema?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/avatar-schema?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#manifest-fields">Manifest fields</a> ·
  <a href="#api">API</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> `@three-ws/avatar-schema` is the canonical, hash-anchored format any cross-chain
> client can use to resolve and verify a three.ws avatar. It's a tiny,
> dependency-light spec package — bundled JSON Schema (`avatar.v1.json`) plus an
> Ajv-backed validator — so any third-party viewer, indexer, or marketplace can
> integrate with three.ws avatars without pulling in the full runtime.

## Install

```bash
npm install @three-ws/avatar-schema
```

## Usage

```js
import { readFile } from 'node:fs/promises';
import { validate, assertValid } from '@three-ws/avatar-schema';

// A manifest you scaffolded with @three-ws/avatar-cli, or fetched from wherever
// you host it (IPFS, S3, your own resolver).
const manifest = JSON.parse(await readFile('./manifest.json', 'utf8'));

const result = validate(manifest);
if (!result.valid) {
  console.error(result.errors); // Ajv ErrorObject[]
}

// Or throw on the first failure (useful in pipelines):
assertValid(manifest);
```

The raw JSON Schema is exported separately so you can bind it to any validator
(Python `jsonschema`, Go `gojsonschema`, etc.). It is a `.json` file, so Node's
ESM loader needs the import attribute:

```js
import schema from '@three-ws/avatar-schema/schema' with { type: 'json' };
// or the version-pinned subpath:
import schemaV1 from '@three-ws/avatar-schema/schema/v1' with { type: 'json' };
```

On Node versions without import attributes, or from CommonJS, use `require`:

```js
import { createRequire } from 'node:module';
const schema = createRequire(import.meta.url)('@three-ws/avatar-schema/schema');
```

The already-parsed object is also a named export of the package root
(`import { schema } from '@three-ws/avatar-schema'`), which needs neither.

The schema is served at its `$id` too: <https://three.ws/schema/avatar.v1.json>.

## Manifest fields

An on-chain avatar manifest binds a 3D mesh (and optional animations and
accessories) to an owner identity on a specific chain. Every binary asset is
referenced by URI plus SHA-256, so clients can verify they fetched the exact bytes
the manifest signer attested to.

| Field | Required | Purpose |
|---|---|---|
| `schemaVersion` | yes | Always `1` for this version of the schema. |
| `id` | yes | CAIP-10 account id, or an ENS-style `*.eth` / `*.ws` / `*.sol` name. |
| `name` | yes | Human-readable name. |
| `mesh` | yes | `{ uri, sha256, format, kBytes? }` — `format` is `glb`/`gltf`/`vrm`. |
| `skeleton` | yes | One of `avaturn`/`mixamo`/`rpm`/`vrm-humanoid`/`custom`. |
| `animations` | no | `{ uri, sha256 }` pointer to an animation manifest. |
| `accessories` | no | Array of `{ slot, uri, sha256 }` (slots: `head`, `eyes`, `ears`, `neck`, `torso`, `back`, `hands`, `waist`, `feet`). |
| `traits` | no | Flat key/value attributes (`string` / `number` / `boolean`). |
| `owner` | yes | `{ chain, address }` — current on-chain holder; `chain` is a CAIP-2 id. |
| `creator` | no | `{ chain, address }` original creator (omit if same as owner). |
| `createdAt` | yes | ISO 8601 UTC timestamp. |
| `signature` | no | `{ algorithm, value, signer }` — `eip-712` / `ed25519` / `secp256k1`. |

See [examples/basic.json](examples/basic.json) for a fully-populated manifest.
TypeScript consumers get an `AvatarManifestV1` interface and the supporting types
(`MeshRef`, `AccessoryRef`, `ChainAccount`, `Signature`, …) from the package types.

## API

| Export | Signature | Notes |
|---|---|---|
| `validate(manifest)` | `(unknown) => { valid: true } \| { valid: false, errors }` | Non-throwing. `errors` is Ajv's `ErrorObject[]`. |
| `assertValid(manifest)` | `(unknown) => void` | Throws `Error` with a joined message on the first invalid manifest; narrows to `AvatarManifestV1`. |
| `schema` | `object` | The parsed `avatar.v1.json` JSON Schema. |
| `SCHEMA_VERSION` | `1` | Integer schema version. |
| `SCHEMA_ID` | `string` | `https://three.ws/schema/avatar.v1.json`. |

Validation is backed by [Ajv](https://ajv.js.org) (2020 dialect) with `ajv-formats`,
compiled once at module load.

## Versioning

The schema uses an integer `schemaVersion`. Breaking changes get a new file
(`avatar.v2.json`), a new `SCHEMA_VERSION` const, and a new published major version
of this package. Old versions remain valid forever.

## Requirements

- Node `>=18`.
- Bundled dependencies: `ajv`, `ajv-formats` (no peer deps).
- Run the test suite with `npm test` (Node's built-in `node:test`, no extra runner).

## Related packages

- [`@three-ws/avatar-cli`](https://www.npmjs.com/package/@three-ws/avatar-cli) — scaffold, validate, hash, and preview manifests in this format from your shell or CI.
- [`@three-ws/avatar`](https://www.npmjs.com/package/@three-ws/avatar) — the runtime SDK that renders avatars resolved from these manifests.

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
