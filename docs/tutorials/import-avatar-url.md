# Import an avatar by URL

You already have an avatar living somewhere else — a model exported from an external avatar platform on a CloudFront link, a GLB on Arweave, an export sitting in your own storage. You don't need to download it, convert it, or re-host it. Paste the URL into [three.ws/import/rpm](/import/rpm) and the platform fetches it server-side, normalizes its skeleton, auto-rigs it so it can move, and saves it to your account as an avatar an agent can wear.

This tutorial walks the URL-import path end to end. It's the sibling of [Upload a custom GLB](/docs/tutorials/upload-custom-glb) — that one covers pushing a file from your disk; this one covers pulling one in from a link. Same destination, different on-ramp.

**Prerequisites:** a three.ws account (the importer redirects you to sign in if you're not), and a live, publicly reachable URL to a glTF 2.0 `.glb` file. No command line, no Blender, no local tooling required — the whole flow runs in the browser.

---

## What you're building

```
You:    paste  https://three.ws/avatars/michelle.glb   into /import/rpm
   ↓    server fetches the file (no CORS to fight)
   ↓    humanoid bones canonicalized → idle/walk clips will play
   ↓    stored on the three.ws CDN as an avatar record
   ↓    a fresh agent is provisioned and the avatar attached
   ↓    static rigs get auto-rigged so they animate, not freeze in T-pose
You:    "Avatar imported!" → open it at /avatars/<id> and chat with the agent
```

The end result is identical to creating an avatar from a selfie or building one in Studio: a saved avatar record, owned by you, attached to an agent with its own custodial wallet, ready to embed anywhere.

---

## How URL import works (two minutes of theory)

The import page offers two tabs — **Paste URL** and **Upload GLB**. This tutorial is the URL tab. Here's why it exists as a separate path from a plain file upload.

Most avatar hosts (external avatar platforms behind a CloudFront CDN, Arweave gateways, arbitrary object storage) serve their GLBs **without CORS headers**. A browser `fetch()` to those URLs is blocked before a single byte arrives. So the importer doesn't rely on your browser reaching the file at all:

1. The browser tries a direct CORS fetch first (works for the rare host that allows it).
2. When that's blocked — the common case — it falls back to a **server-side proxy fetch**. The three.ws API pulls the file on your behalf. No CORS to satisfy, and the server applies SSRF guards (it refuses loopback, private, link-local, and cloud-metadata addresses, follows a bounded number of redirects, and caps the download size) so a pasted URL can't be turned into a request against internal infrastructure.
3. Either way, the bytes land in three.ws storage and an avatar record is created.

Two things happen automatically once the file is in:

- **Bone canonicalization.** Humanoid skeletons come in many naming dialects — Mixamo (`mixamorig:LeftArm`), VRM/VRoid, Unreal, Daz/Genesis, MakeHuman, Blender. The platform renames whatever it finds to one canonical bone set so the pre-baked animation library (idle, walk, gestures) retargets onto it out of the box. A non-humanoid rig passes through untouched. The mapping lives in [src/glb-canonicalize.js](../../src/glb-canonicalize.js).
- **Auto-rig.** If the imported GLB has **no skeleton at all** (a static mesh export), the platform submits an auto-rig job after saving. The rigged GLB is swapped in place once the job lands — no T-pose, no second copy. This is the same guarantee every avatar created on three.ws gets: it can move. A GLB that already ships a skeleton skips this step.

You don't trigger any of this. Pasting the URL is enough.

---

## Step 1: Get the GLB URL of your avatar

The importer needs a direct link to a `.glb` file — the URL must end at the model itself, not a viewer page wrapped around it.

**External avatar platforms.** Many avatar builders hand you a model URL of the form `https://models.<host>/<id>.glb`. If you only have the avatar's web page, append `.glb` to the avatar ID, or open the page, then DevTools → **Network**, filter by `.glb`, and copy the request URL. These hosts typically serve files from a CloudFront CDN with no CORS headers — exactly the case the server-side fetch is built for.

**Any other hosted glTF/GLB.** The importer accepts any GLB URL, not just builder exports:

- A CDN link (CloudFront, Cloudflare, Bunny, etc.)
- An Arweave or IPFS gateway URL ending in `.glb`
- A file in your own object storage or static host

**Finding the URL when an app fetches it on load.** If your avatar shows up in some other web app but you don't know the raw URL, open that app, then **DevTools → Network → filter `.glb`**, and copy the request URL straight from the network log. That's the link to paste.

The only hard requirements: the URL is `http://` or `https://`, it's publicly reachable (no auth header, no signed-cookie wall), and it points at a valid glTF 2.0 binary. If the original host is gone or the file is behind a login, download it once and use the **Upload GLB** tab instead — see [Upload a custom GLB](/docs/tutorials/upload-custom-glb).

---

## Step 2: Open the importer

Go to **[/import/rpm](/import/rpm)** (linked from [/create](/create) as the "bring your own avatar" path).

You'll see an import card with two tabs. Leave it on **Paste URL** (the default). The warning banner up top spells out the model: the file is fetched on three.ws servers, so CORS-restricted CDNs all work; the Upload tab is the fallback for files on disk or dead hosts.

If you're not signed in, the import call returns a `401` and the page bounces you to `/login?return=/import/rpm` — sign in and you land right back on the importer.

---

## Step 3: Paste the URL and name the avatar

1. In **Avatar GLB URL or CDN link**, paste the full `.glb` URL from Step 1.
2. The field validates the protocol on submit — anything that isn't `http://` or `https://` is rejected with *"Enter a valid http:// or https:// URL."*
3. Optionally fill in **Avatar name**. If you leave it blank, the importer derives a name from the filename in the URL (e.g. `64c3f8e2.glb` → `64c3f8e2`), falling back to *"Imported Avatar"* when the path has nothing useful.

That's the whole form. Hit **Import from URL**.

---

## Step 4: Watch the import run

The progress bar narrates the real pipeline as it executes — these aren't fake stages on a timer, they map to actual work:

| Stage | What's happening |
|---|---|
| **Fetching model…** | The server (or browser, if CORS allows) pulls the GLB bytes from your URL. |
| **Normalizing bones…** | Humanoid bone names are canonicalized so the animation library can drive the rig. |
| **Uploading to three.ws…** | The file is written to the platform CDN with correct CORS and cache headers. |
| **Saving avatar record…** | The avatar row is created in your account; the agent provisioning and auto-rig jobs kick off. |

When it finishes you get an **"Avatar imported!"** card with a **View avatar** button pointing at `/avatars/<your-avatar-id>`.

Behind that success screen, three fire-and-forget jobs have already started and will complete on their own:

- **An agent is provisioned.** A fresh agent is created (or an unpaired one reused) with your imported avatar attached, and it gets its own custodial Solana wallet.
- **The avatar is auto-rigged if needed.** Static meshes are upgraded to animation-ready in place.
- **A thumbnail and tags are generated.** The GLB is rendered off-screen, a poster image is captured, and the model is auto-tagged.

None of these block the success screen — the avatar is usable immediately, and these enrich it over the next few moments.

---

## Step 5: Open the avatar and confirm it moves

Click **View avatar** (or go to `/avatars/<id>`). The avatar page renders your imported model.

What to check:

- **It's not frozen in a T-pose.** A canonicalized humanoid plays the idle clip right away. If you imported a *static* mesh, give the auto-rig job a moment — the model swaps to its rigged version in place once the job lands, and then it animates too. The platform never leaves an avatar stuck bind-pose; a rig that genuinely can't be skeleton-driven falls back to the default rig.
- **Geometry and materials look right.** PBR (`pbrMetallicRoughness`) materials render correctly. If the source used an unsupported material extension you may see a fallback — see [Upload a custom GLB](/docs/tutorials/upload-custom-glb) for the material fix-list, which applies identically to imported files.

---

## Step 6: Use the avatar on an agent

The import already provisioned an agent with this avatar attached, so the fastest path is to just use it:

1. Go to [three.ws/my-agents](/my-agents).
2. Find the agent created for your imported avatar.
3. Send it a message — it should switch to a talk-style animation while it replies, then return to idle.

To put the same avatar on a *different* agent, or to swap an existing agent's body to this one, open that agent and set its body to the imported avatar from the editor's **Body** tab. Because the avatar is a saved record on your account, it's available to any agent you own, and every embed of that agent — `<agent-3d agent-id="…">`, iframe widgets, script-tag embeds — picks up the body on next page load with no code change.

From here you can give the agent a brain and a voice: see [Give your agent a personality](/docs/tutorials/agent-personality) and [Create, enhance & edit agent memory](/docs/tutorials/create-and-edit-memory).

---

## Troubleshooting

- **"Could not fetch that URL … The file may no longer exist."** The server couldn't retrieve the GLB. The host is down, the link is dead, the path is wrong, or the file sits behind authentication. Open the URL in a new browser tab — if you don't get a file download, the importer can't reach it either. Re-copy the URL, or download the file once and use the **Upload GLB** tab.
- **"Enter a valid http:// or https:// URL."** The pasted value isn't a parseable web URL, or uses a non-web protocol. Paste the full link including `https://`. `file://`, `data:`, and relative paths are rejected.
- **The import gets you redirected to sign in.** The save needs an authenticated owner; you weren't signed in. Log in — you're returned to `/import/rpm` automatically. Then re-paste and import.
- **Avatar imported but stuck in a T-pose.** If it's a *static* mesh, the auto-rig job is still finishing — reload the avatar page in a moment and it swaps to the rigged, animating version in place. If a *humanoid* skeleton still won't animate, its bone naming convention may be one the canonicalizer doesn't yet map; the platform adds new conventions rather than maintaining an allowlist, so report the rig.
- **Materials render chalky/grey.** The source GLB uses a material extension the runtime renders as a fallback. Convert the materials to standard `pbrMetallicRoughness` at the source and re-import — the [Upload a custom GLB](/docs/tutorials/upload-custom-glb) material fix-list covers this exactly.
- **"This is taking forever" on a large file.** The server fetch caps download size and a huge, uncompressed GLB takes longer to pull and store. If your file is well over the cap, optimize it first (the `optimize:glb` / `gltf-transform` steps in [Upload a custom GLB](/docs/tutorials/upload-custom-glb)) and import the slimmer result.
- **I want to import a file on my disk, not a URL.** Switch to the **Upload GLB** tab on the same page — drag-and-drop or file-pick a `.glb` (up to 100 MB). Same canonicalization, auto-rig, and agent provisioning apply.

---

## Recap

You imported an existing avatar by URL, no download or conversion required:

- **Paste a `.glb` URL** at [/import/rpm](/import/rpm) — external avatar platforms, any CDN, Arweave, or your own storage all work.
- **The server fetches it for you**, so CORS-restricted hosts are a non-issue, with SSRF guards on the pasted URL.
- **Humanoid bones are canonicalized** ([src/glb-canonicalize.js](../../src/glb-canonicalize.js)) so the pre-baked animation library plays out of the box.
- **Static meshes are auto-rigged** in place after save — the platform guarantees an avatar that can move, never a frozen T-pose.
- **An agent is provisioned** with the avatar attached and its own wallet; the avatar is a reusable record you can put on any agent you own.

The URL path and the file-upload path converge on the same avatar record and the same agent flow — choose whichever fits where your file already lives.

### See also

- [Upload a custom GLB avatar](/docs/tutorials/upload-custom-glb) — the file-upload counterpart, plus the validator, compression, and material/skinning fix-lists
- [Avatar Creation](/docs/avatar-creation) — every way to make an avatar (photo, builder, upload) and the format spec
- [Give your agent a personality](/docs/tutorials/agent-personality) — match the brain to the imported body
- [Create, enhance & edit agent memory](/docs/tutorials/create-and-edit-memory) — give the agent durable facts to carry between sessions
