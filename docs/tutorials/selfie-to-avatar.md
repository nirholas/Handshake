# Turn a Selfie into a Rigged 3D Avatar

Take one front-facing photo and walk away with a rigged 3D avatar that looks like you — one you can drop onto an agent, animate, and embed anywhere. The Scanner handles capture, reconstruction, and auto-rigging end to end; you point a camera and name the result.

**Prerequisites:** a device with a camera (phone or laptop) or a clear front-facing photo to upload. No code, no 3D experience, and no account needed to start a scan. You'll want a [three.ws account](/create) to save the avatar and put it on an agent.

---

## What you're building

```
You:  one front-facing selfie  (optionally + left and right angles)
        ↓   [reconstruct → texture → auto-rig]
Result:  a rigged GLB that looks like you — animation-ready,
         attached to an agent, downloadable for any engine
```

A flat photo has no geometry. The Scanner reconstructs a 3D head-and-body mesh, wraps your real face onto it as a texture, then **auto-rigs the mesh with a humanoid skeleton** so it can move — idle, walk, gesture — without you touching a rig. The output is a standard glTF 2.0 binary (`.glb`) that works in three.ws and in external tools (VRChat, Spatial, Unity, Unreal) alike.

This tutorial covers the full path: **capture → generate → auto-rig → put it on an agent**.

---

## How the flow works (one minute of theory)

The Scanner is one pipeline reachable two ways:

- **[/scan](/scan)** is the front door. It immediately forwards to **[/create/selfie](/create/selfie)**, which is the full capture experience (including the option to bring your own reconstruction key). Either URL gets you to the same place — `/scan` is the memorable one to share.
- **[/create/selfie](/create/selfie)** is where capture, the build progress, and the finished avatar all live.

Under the hood the page ([src/selfie-capture.js](../../src/selfie-capture.js)) collects your photos, downscales them in your browser, and hands them to the pipeline ([src/selfie-pipeline.js](../../src/selfie-pipeline.js)), which submits the job and polls for progress. There are exactly two calls:

1. `POST /api/avatars/reconstruct` — submit the photos, get back a `jobId`.
2. `GET /api/avatars/regenerate-status?jobId=…` — poll until the job reports `done`.

The job moves through visible stages — reconstructing the mesh, building geometry and textures, **auto-rigging the skeleton and skinning** — then returns the finished avatar's id. You never call the rig step yourself; it's part of the job. This is the platform-wide rule: every avatar three.ws creates is auto-rigged so it can animate. (For the rig internals, see [Avatar Creation](../avatar-creation.md).)

---

## Step 1: Take or pick a good photo

Result quality is mostly decided here. The face the engine can see clearly is the face you get back.

Five rules for the front-facing shot:

1. **Face the camera directly** — no extreme angles, chin level.
2. **Good, even lighting** — indirect daylight is ideal; avoid harsh shadows or backlighting.
3. **Remove anything covering your face** — sunglasses, masks, a hat brim over the eyes.
4. **Keep hair off your forehead and jawline** where you can — the engine needs your face outline.
5. **Plain background** helps the reconstruction isolate you.

You don't need a studio. A normal selfie in a well-lit room is plenty.

**Accepted formats:** JPEG, PNG, WebP, and HEIC/HEIF (iPhone photos work as-is). Photos are downscaled in your browser to a maximum of 1024px before upload — your original file never sits on disk, and only the generated avatar texture is kept.

---

## Step 2: Open the Scanner and add your photo

Go to **[/scan](/scan)** (it lands you on [/create/selfie](/create/selfie)).

You'll see one required slot: **Add a front-facing photo**. Two ways to fill it:

- **Use camera** — opens your camera in the browser with live face guides. Hold still inside the oval; the page checks framing, lighting, blur, and head angle and captures when it's a good frame.
- **Upload photo** — pick an existing image from your device.

If your browser or device can't open the camera (common on non-HTTPS connections and some desktop browsers), the camera option is disabled automatically — use **Upload** instead.

That one front-facing photo is all you need to build an avatar. The submit button stays disabled (showing "Add a photo to start") until a frontal photo is in place.

---

## Step 3: Add side angles for sharper geometry (optional)

Open the **Add side angles** disclosure to reveal two more slots:

- **Left** — turn your head about 45° to the left.
- **Right** — turn your head about 45° to the right.

Each extra angle is geometry the engine doesn't have to guess, so the sides and back of your head come out noticeably crisper. The trade-off is time: the submit button updates to reflect it — roughly **~90s** for one photo, **~120s** when you add angles.

Keep the same lighting and the same way-up across all three shots. Side angles are optional; skip them if you just want a fast result.

---

## Step 4: Choose style and body type

Two quick choices below the photos:

**Style**

- **Photoreal** — likeness-first; closest to how you actually look. (This is the default.)
- **Stylized** — cleaner, cartoon-leaning; good for streaming and games.

**Body type**

- **Masc** (default) or **Femme** — this selects the body proportions the rig is built on.

Pick the pair that fits how you'll use the avatar. You can always run another scan with different settings later — nothing here is permanent.

---

## Step 5: Build the avatar

Click the build button (it reads **Build my avatar · ~90s**, or the high-fidelity variant if you added angles).

What happens next:

- If you're not signed in, you'll be sent to sign in and returned to the Scanner — saving an avatar requires an account.
- The page submits your photos and switches to the build view: **"Building your avatar… This usually takes 1–2 minutes. Don't close this tab."**
- You'll see the pipeline narrate real progress as it works:

```
Queued — waiting for a reconstruction slot…
Generating 3D mesh from your photo…
Building geometry and textures…
Auto-rigging skeleton and skinning…
Finishing avatar…
```

That **"Auto-rigging skeleton and skinning…"** line is the step that makes the avatar movable — the reconstruction produces a mesh, and the pipeline fits a humanoid skeleton to it and binds the skin so animation clips can drive it. You don't trigger it; it's part of every build.

The build is resilient: the job id is held in your session, so if you reload mid-build the page resumes polling the same job instead of starting over. If the engine is busy you may see "Still working — this one is taking a bit longer…"; that's expected on the longer tail, not an error.

---

## Step 6: Why "auto-rigged" matters

A reconstructed mesh that isn't rigged is a statue — it can be viewed but not animated. That's why rigging is built into the create path, not an optional extra.

Across three.ws, **every avatar that gets created auto-rigs so it can move.** For the selfie flow the rig is fitted inside the reconstruction job (the step you watched in Step 5). For avatars that arrive already built — an uploaded GLB or a forged model — the same guarantee holds: if the mesh comes in static, the platform fires an auto-rig pass in the background and swaps the rigged version in place, with a sweep cron as a safety net so nothing gets stuck half-rigged. The mechanism differs; the outcome is identical: a humanoid you can animate.

Once rigged, the avatar drives the shared clip library. Bone names from common conventions (Mixamo, VRM, Unreal, and more) are mapped to a canonical skeleton, and idle/walk/gesture clips retarget onto it automatically — legs included. The practical upshot: the avatar you just built will move the moment you open it in the [Animation Studio](/pose), with no extra rigging work from you.

---

## Step 7: Name it and open your avatar

When the build finishes you land on the done view: **"Your avatar is ready."**

- It renders in a live 3D preview — drag to spin it and check the result. Look at the sides and back; if you skipped angles, that's where the engine had the least to work with.
- Give it a name in the **Name your avatar** field (up to 60 characters).
- Click **Open my avatar →** to go to your avatar's page at `/avatars/<id>`.

From the done view you can also:

- **Customize in editor** — opens the avatar in the editor (`/avatars/<id>/edit`) to adjust appearance, clothing, and accessories.
- **List on marketplace** — flips the avatar to public and takes you to its marketplace listing.
- **Not quite right — try again** — resets the form so you can rescan with a better photo or different settings.

Whatever you choose, the avatar is already saved to your account as a rigged GLB.

---

## Step 8: Put the avatar on an agent

An avatar is a body; an agent is the brain that lives in it. Creating an avatar already wires up an agent for you — the two are tied together so the avatar shows up, animates, and can transact.

You have two paths:

**It's already done.** When the avatar is saved, three.ws attaches it to an agent automatically: it links the avatar to one of your agents that doesn't yet have a body, and if you don't have one, it creates a default agent and gives it this avatar. Open **Open my avatar →** and the agent behind it is provisioned and ready.

**Reassign it deliberately.** If you want this avatar to become the face of a *specific* existing agent, attach it explicitly:

```js
await fetch('/api/onboarding/link-avatar', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    avatarId: 'your-avatar-uuid',   // the id from /avatars/<id>
    force: true,                    // replace the agent's current avatar
  }),
});
// → { agent: { id, avatar_id, updated_at } }
```

`force: true` overrides an avatar the agent already has. Omit it (or set `false`) to only attach when the agent has no avatar yet. Either way the call is owner-scoped — you can only attach avatars to agents you own.

Once linked, give the agent a [personality](/tutorials/agent-personality) and a [brain](/tutorials/connect-ai-brain), then [share it](/tutorials/share-your-agent) or embed it on a site.

---

## Step 9: Use the avatar everywhere

Because the output is a clean, rigged glTF 2.0 file, it isn't locked to three.ws:

- **Animate it** in the [Animation Studio](/pose) — load it, browse the clip gallery, and retarget motion onto it live. It works because it's rigged.
- **Download the GLB** from the avatar page to use it in Unity, Unreal, Blender, or any glTF-aware tool.
- **Embed it** on a website with the web component — see [Embed in 30 seconds](/tutorials/embed-in-30-seconds).
- **Refine the look** with [Customize your agent's appearance](/tutorials/customize-appearance) — clothing, accessories, and more layer on without re-rigging.

---

## Privacy — what happens to your photo

Your photo(s) are uploaded to the platform's storage and referenced by the build job so it can complete and be retried on failure — the same way any creation tool keeps its source input while the job runs. Concretely:

- **Not public.** The raw photo isn't exposed by any public endpoint or gallery — only the *generated avatar* is shareable, and only if you set its visibility to unlisted/public.
- **Not analyzed beyond this build.** Nothing runs face recognition, identity matching, or profiling against your photo outside of producing the 3D reconstruction you asked for.
- **Deleting an avatar** removes it from your account and any listing immediately; it's a soft delete, not an instant hard purge of the underlying storage object.

If you'd rather nothing persisted at all, use a disposable/cropped photo — the reconstruction only needs a clear, evenly-lit face, not an identifiable original.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Add a photo to start" won't go away | No frontal photo in the required slot | The front-facing slot is mandatory; side angles alone aren't enough |
| The **Use camera** option is missing or disabled | Browser/device can't open the camera (often non-HTTPS, or no camera) | Use **Upload photo** instead, or open the page in Safari/Chrome on a device with a camera |
| Build failed: "Try clearer photos in better light" | Blurry photo, no detectable face, or harsh lighting | Reshoot per Step 1 — face the camera, even light, nothing covering your face |
| Sides or back of the head look wrong | Only a frontal photo was provided | Add **Left** and **Right** angles (Step 3) and rebuild |
| "Photos are too large" | The upload exceeded the size limit | Photos are downscaled to 1024px in-browser; retry, or use a smaller source image |
| Asked to sign in mid-build | Saving an avatar needs an account | Sign in when prompted — you're returned to the Scanner and the build continues |
| "Too many requests" / rate-limited | Per-visitor cooldown after repeated attempts | Wait about a minute and try again |
| The reload during a build started a fresh scan | Rare; the pending job id wasn't found | The build resumes automatically when the job id is in your session — re-open [/create/selfie](/create/selfie) and let it poll |
| Asked for a reconstruction API key | This deployment runs in bring-your-own-key mode | Paste a key from the supported provider in the form shown; it's stored for your session only |

---

## Recap

You turned a single selfie into a rigged, agent-ready 3D avatar:

- **Capture** — one front-facing photo at [/scan](/scan) → [/create/selfie](/create/selfie); optional left/right angles sharpen the geometry.
- **Choose** — Photoreal vs Stylized, Masc vs Femme body type.
- **Generate** — `POST /api/avatars/reconstruct` builds the mesh and texture; the page polls `regenerate-status` and shows real progress.
- **Auto-rig** — the build fits a humanoid skeleton and skins the mesh so it can animate; this happens for every avatar three.ws creates, no manual step.
- **Attach** — the avatar is linked to an agent automatically, or attach it to a specific agent with `POST /api/onboarding/link-avatar`.

The result is a standard `.glb` that animates in the [Animation Studio](/pose), embeds on the web, and works in external engines — a real likeness of you, ready to move.

### See also

- [Turn Photos into a 3D Model](/tutorials/image-to-3d) — reconstruct an *object* (not a person) from a few photos in the Forge.
- [Animate your avatar](/tutorials/animate-your-avatar) — apply and tune motion on the rigged avatar you just built.
- [Avatar Creation](../avatar-creation.md) — the full reference: every creation path, rig requirements, and accessories.
- [Customize your agent's appearance](/tutorials/customize-appearance) — clothing, accessories, and styling on top of your avatar.
- [Give your agent a personality](/tutorials/agent-personality) — turn the body into a character.
