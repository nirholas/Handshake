# Ship an Avatar Manifest

By the end of this tutorial you will have taken a raw `.glb` file and turned it into a signed-off, hash-anchored avatar manifest, embedded that avatar on a real page, and added a check to your release process that fails the build if the model ever silently changes underneath you.

The thing you are building is small: a JSON file. What matters is what it buys you. A manifest turns "some GLB on a CDN" into a portable, verifiable identity: one document that names the avatar, points at its mesh, records the exact bytes of that mesh, declares which skeleton it rigs to, and says who owns it. Any tool that reads the schema can render it, verify it, or refuse it. That is the difference between an asset and an artifact.

**What you'll build:**

- A schema-valid avatar manifest scaffolded from a wallet address and a mesh file
- A working embed of that avatar on a plain HTML page, no build step
- A release gate that detects a tampered or re-exported mesh before it ships
- An understanding of every field in the manifest, and which optional ones are worth adding

**Prerequisites:**

- Node 18 or newer, and `curl`. That is the whole toolchain.
- No account, no API key, no wallet signature. Every command here runs offline against local files.
- Optional: the [Avatar CLI reference](../avatar-cli.md) is the exhaustive flag-by-flag contract. This tutorial is the guided path through it.

Every command below is real and runs as written.

---

## Step 1 - Get a mesh

You need a humanoid `.glb`. Use one of ours to follow along exactly:

```bash
curl -sLO https://three.ws/avatars/michelle.glb
ls -lh michelle.glb
```

```
-rw-r--r-- 1 you you 830K michelle.glb
```

If you have your own model, point at that instead. The CLI accepts `.glb`, `.gltf`, and `.vrm`, and the extension decides the `format` recorded in the manifest.

The one property your mesh needs is a humanoid skeleton. three.ws retargets its animation library onto any rig whose bone names it recognizes (Mixamo, Avaturn, Ready Player Me, VRM, Daz, MakeHuman, and more), so a rigged character from almost any pipeline will walk and gesture without extra work.

---

## Step 2 - Decide where the mesh will live

This is the step people skip, and it is the one that breaks the embed.

A manifest points at its mesh by URI. If that URI is a path on your laptop, the manifest is still valid, still hashes correctly, and is completely useless to a browser, which cannot read `file:///home/you/michelle.glb` from a web page.

So decide now: what public URL will serve these bytes? Any static host works, because a GLB is just a file. Object storage, your own CDN, a `public/` directory in your app, or three.ws itself. For this walkthrough we use the copy already served at:

```
https://three.ws/avatars/michelle.glb
```

Confirm whatever URL you pick actually serves the file, before it goes in a manifest:

```bash
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
  https://three.ws/avatars/michelle.glb
```

```
200 model/gltf-binary 849756
```

Two things to check in that output: the status is `200`, and the size matches the file you hashed. A CDN that silently serves an HTML error page returns `200` too, which is exactly the failure the hash gate in Step 6 is designed to catch.

---

## Step 3 - Scaffold the manifest

Install the CLI and scaffold:

```bash
npm install -g @three-ws/avatar-cli

three-ws-avatar init \
  --owner eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e \
  --name "Nicholas" \
  --mesh ./michelle.glb \
  --skeleton mixamo \
  --mesh-uri https://three.ws/avatars/michelle.glb \
  --out manifest.json
```

```
✔ wrote /home/you/manifest.json
  • id        eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e
  • skeleton  mixamo
  • mesh      glb · 830 kB · sha256:28d788538f7b…
  › next: three-ws-avatar preview manifest.json
```

Three flags carry real decisions:

**`--owner`** takes a [CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md) account id, which is `chain:reference:address`. A bare `0x…` address is accepted as shorthand and expands to `eip155:1` (Ethereum mainnet). Spell out the chain when the avatar belongs anywhere else, so the manifest is unambiguous on its own.

**`--skeleton`** declares the rig convention, and it is the field that decides whether animation works. `mixamo` is correct for `michelle.glb`. The valid values are `avaturn`, `mixamo`, `rpm`, `vrm-humanoid`, and `custom`. Guessing here produces a manifest that validates and an avatar that moves wrong, which is worse than an error. If you did not rig the model yourself, check where it came from before choosing.

**`--mesh-uri`** is the public URL from Step 2. Leave it out and the URI falls back to your local path.

Note what you did *not* pass: the hash. `init` reads the mesh and computes SHA-256 itself, so the manifest cannot disagree with the file it was built from at the moment it was built.

---

## Step 4 - Read what it wrote

```bash
cat manifest.json
```

```json
{
  "schemaVersion": 1,
  "id": "eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  "name": "Nicholas",
  "mesh": {
    "uri": "https://three.ws/avatars/michelle.glb",
    "sha256": "28d788538f7b22b8e00c1d715fffc380bb06a304613d522c20523d3d6ff79bc2",
    "format": "glb",
    "kBytes": 830
  },
  "skeleton": "mixamo",
  "owner": {
    "chain": "eip155:1",
    "address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
  },
  "createdAt": "2026-07-30T19:23:34.595Z"
}
```

The `sha256` is the load-bearing field. `uri` says where the mesh is; `sha256` says what it must be. Those are different promises, and only the second one survives someone re-uploading a different model to the same path.

The `id` was derived from the owner account. Had you passed `--name "nick.eth"`, the CLI would have recognized the name service handle and used that as the id instead, because the schema accepts either form. An explicit `--id` overrides both.

---

## Step 5 - Validate, and see what failure looks like

```bash
three-ws-avatar validate manifest.json
```

```
✔ manifest.json is valid
```

That is unsurprising, since `init` validates before writing. The command earns its keep on manifests that were hand-edited, generated by something else, or committed six months ago. Break one deliberately to see the output you will eventually get for real:

```bash
printf '{"schemaVersion":1,"id":"broken","name":"Broken"}' > broken.json
three-ws-avatar validate broken.json
echo "exit: $?"
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

```
exit: 1
```

Read the `id` errors as one finding, not three. The schema allows a CAIP-10 account *or* a name service handle, so an invalid id fails both branches and then fails the `anyOf` that combined them. `"broken"` is neither.

The non-zero exit is what makes this usable in a script, which is Step 6.

---

## Step 6 - Put it on a page

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

Take the web-component block and save it as `index.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>My avatar</title>
<body style="margin:0;background:#111">
  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
  <agent-3d src="https://three.ws/avatars/michelle.glb" style="width:400px;height:600px"></agent-3d>
</body>
```

Serve it and open it:

```bash
npx serve .
```

You get a lit, orbitable 3D character that idles on its own. No build step, no bundler, no three.js in your dependencies.

Both lines matter. `<agent-3d>` is an unknown element that renders nothing until the loader script registers it, which is why `preview` prints them together. If you paste only the element you get an empty box, and the browser will not warn you.

The iframe is the other option and needs no script at all, at the cost of a cross-origin boundary. Use the element when the avatar is part of your page, and the iframe when you want it sandboxed.

> Had you skipped `--mesh-uri` in Step 3, `preview` would stop here and tell you the mesh is a local path that no browser can load, instead of printing a snippet that silently renders nothing.

---

## Step 7 - Gate your release on it

A manifest that is only correct on the day you wrote it is a document, not a guarantee. Two checks turn it into one.

**Check that the mesh still matches its hash:**

```bash
expected=$(node -p "require('./manifest.json').mesh.sha256")
actual=$(three-ws-avatar hash ./michelle.glb)
[ "$expected" = "$actual" ] || { echo "mesh hash mismatch"; exit 1; }
```

Silence means it passed. Prove it fires by changing one byte:

```bash
printf 'x' >> michelle.glb
actual=$(three-ws-avatar hash ./michelle.glb)
[ "$expected" = "$actual" ] || echo "mesh hash mismatch"
```

```
mesh hash mismatch
```

This is the check that catches the re-export nobody mentioned, the lossy optimization pass, the CDN that started serving an error page with a `200`, and the teammate who replaced the model and kept the filename.

**Check that every manifest in the repo is still valid:**

```bash
find . -name '*.avatar.json' -not -path './node_modules/*' -print0 \
  | xargs -0 -n1 three-ws-avatar validate
```

`xargs` exits non-zero if any single invocation failed, so one bad manifest fails the whole step.

Wire both into whatever already runs on release. A `package.json` script is usually enough:

```json
{
  "scripts": {
    "check:avatars": "three-ws-avatar validate manifest.json && node scripts/check-mesh-hash.mjs"
  }
}
```

Then call `npm run check:avatars` from your existing build or deploy command. There is nothing special about where it runs; it just has to run somewhere that can fail.

For output a machine can read, add `--json`:

```bash
three-ws-avatar validate manifest.json --json | jq -e '.valid'
```

```
true
```

---

## Step 8 - Grow the manifest

You now have the seven required fields. The schema accepts five more, and they are where a manifest stops being a pointer and starts being a record. Add them by hand and re-run `validate`:

| Field | What it is for |
|---|---|
| `animations` | A pointer (`uri` + `sha256`) to a clip manifest, so custom motion travels with the avatar instead of being wired up per site. |
| `accessories` | Slot bindings for equipped items: hats, glasses, held props. Each entry names its slot and its own mesh. |
| `traits` | Free-form key/value pairs, NFT-style. String, number, and boolean values only. |
| `creator` | The original creator, when that differs from the current `owner`. Omit when they are the same. |
| `signature` | An `algorithm`/`value`/`signer` triple over the canonical JSON serialization, which turns the whole document into something a third party can verify. |

`signature` is the one that changes the security model. Everything else in the manifest is a claim you are making; a signature is a claim someone else can check without trusting your server.

---

## What you built

A JSON file that names an avatar, pins its mesh by content rather than by location, declares the rig so animation retargets correctly, records ownership as a chain-scoped account, and fails your build the moment any of that stops being true.

**Next:**

- The [Avatar CLI reference](../avatar-cli.md) documents every flag, exit code, and `--json` shape.
- The [web component reference](../web-component.md) covers everything `<agent-3d>` can do beyond rendering a body: voice, an LLM brain, memory, and skills.
- [`@three-ws/avatar-schema`](../../packages/avatar-schema/README.md) is the schema itself, for writing your own tooling against the format.
