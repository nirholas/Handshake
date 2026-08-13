# Generate 3D Models Free, Powered by NVIDIA

The free text-to-3D lane in the Forge is **Microsoft TRELLIS**, a GPU model that turns a description into real, textured geometry, and **NVIDIA NIM** is the hosted rung of it. The Forge runs TRELLIS on our own GPU workers first and hands your prompt to a TRELLIS NIM whenever those workers are cold or busy, which on a shared free lane is often. Either way there is no API key, no credits, and no cost to you. This tutorial shows what the free lane is, when the NVIDIA rung kicks in, how to pin it deliberately, and how to watch TRELLIS rebuild a mesh live.

**What you'll make:** a 3D model generated for free on the NVIDIA NIM lane, downloaded as a GLB.

**Prerequisites:** none. No account, no wallet, no code. Just a browser.

---

## What the free NVIDIA lane is

When you type a prompt into the Forge, the path is:

1. Your words become a **reference image**.
2. That image is reconstructed into a textured 3D mesh by **TRELLIS**.
3. The mesh is packaged as a **GLB**, the standard 3D file the whole web understands.

Step 2 is the interesting one, because the same TRELLIS model runs on two different rungs of the free chain. **Draft** and **Standard** name our own self-hosted TRELLIS worker. When every self-hosted worker is cold, busy, or unhealthy, routing falls through to **NVIDIA NIM** (NVIDIA's inference microservice for hosted models), which is the last free rung and a health-gated safety net rather than a queue you wait in.

That fallthrough is what keeps the free lane answering at all. NVIDIA NIM keeps the GPU warm, so there is no slow cold start, and the lane costs the platform nothing per call. You never have to select it: bring no engine key and one of the free TRELLIS rungs serves you. You can also pin it deliberately, which is the next step.

---

## Step 1: Open the Forge

Go to [three.ws/forge](/forge). You'll land on the **Describe it** tab, which is text-to-3D mode.

Leave the **Engine** selector alone and you get the free TRELLIS chain: our own worker first, the NVIDIA NIM lane behind it. To generate on NVIDIA specifically, open the selector and pick **TRELLIS (free)**, the entry whose vendor reads *Microsoft TRELLIS · NVIDIA NIM*. Pinning it skips the routing decision entirely, so the rest of this tutorial is reproducible even when our own workers are warm. (Bringing your own geometry engine key is a separate thing, covered in [Turn a Text Prompt into a 3D Model](/tutorials/text-to-3d). Skip it here.)

---

## Step 2: Describe one object

Type a single subject and name its material:

```
a glazed ceramic teapot
```

Keep prompts short. TRELLIS reads roughly the first **77 characters**, so a tight description beats a paragraph. Three rules:

1. **One object per prompt.** "a teapot" works; "a teapot on a table by a window" confuses it.
2. **Name the material.** "brushed metal", "worn leather", "glazed ceramic".
3. **No scenery.** You're describing a thing, not a photo, so drop backgrounds and lighting moods.

Want a cookbook? See [Prompt Recipes for 3D Generation](/tutorials/prompts-for-3d).

---

## Step 3: Pick a tier (both are free)

| Tier | What you get | Speed |
|------|-------------|-------|
| **Draft** | Fast, low-poly (~12k triangles) | About 15 s on the NVIDIA rung, 35 s on our own worker. Generate five, keep the best shape |
| **Standard** | Balanced detail (~30k triangles) | About 20 s on the NVIDIA rung, a minute on our own worker. The everyday default |

Those are the live estimates the Forge itself reads, and `GET /api/forge?catalog` returns them per backend and tier if you want the current numbers rather than these.

Both Draft and Standard are free on every rung of the TRELLIS chain, so the tier you pick never changes what you pay. High tier and photo input are served by other engines, covered in [What's next](#whats-next).

The tier maps to TRELLIS **sampling steps**: more steps, more refinement, more time. Draft runs lean; Standard spends a little longer for cleaner geometry.

---

## Step 4: Generate and inspect

Click **Generate**. The Forge narrates each step (*painting reference image, reconstructing textured mesh, finalizing GLB*) and the preview image appears early, so you'll know within seconds whether it's on track.

When it finishes, the model loads in a live viewer:

- **Drag** to rotate, **scroll** to zoom.
- Press **F** for a fullscreen turntable; **Esc** to exit.
- Check the **back and underside**, which is where reconstruction flaws hide.

Then rate it **👍 Keep** or **👎 Discard**. Your verdicts feed the engine picker, so honest ratings make your future generations better.

---

## Step 5: Watch TRELLIS run live (the NIM demo)

To see the NVIDIA NIM contract end to end, with no UI in the way, open the live demo at [three.ws/forge-nim](/forge-nim).

It talks **directly** to a TRELLIS NIM and returns the GLB **synchronously** in a single call. Type a prompt or drop a photo, and you'll watch the raw model come back as bytes and render in the browser. It's the clearest way to understand what "powered by NVIDIA NIM" actually means: the same TRELLIS reconstruction the Forge uses, with the wire contract visible.

> The hosted NVIDIA preview only generates from **text prompts**. To reconstruct from your own **photos** on a NIM, you need a self-hosted TRELLIS NIM, which is the next tutorial.

---

## Step 6: Download or share

- **Download GLB** opens in Blender, three.js, Unity, Unreal, Windows 3D Viewer, and macOS Quick Look.
- **Share** gives a link with a proper preview card.
- Every generation is also saved to **Your creations** at the bottom of the page, tied to your browser.

---

## Didn't get what you wanted?

| What went wrong | What to change |
|-----------------|----------------|
| Right object, wrong style | Add a style word: "low-poly", "realistic", "stylized" |
| Surface looks flat | Name the material, or run the **High** tier for PBR textures |
| Extra junk attached | Your prompt described a scene, so cut it to just the object |
| "Generation limit reached" | The free lane is rate-limited per visitor (about 60 generations an hour, more for $THREE holders). Wait a minute |
| "The 3D generator is busy right now" | Every free rung is saturated, not your quota. It tells you how long to wait; try again after that |

---

## What's next

- **Generate from your photos** → [Turn Photos into a 3D Model](/tutorials/image-to-3d).
- **Run TRELLIS on your own GPU** → [Run Microsoft TRELLIS on your own NVIDIA NIM](/tutorials/nvidia-nim-self-host): self-host the NIM and reconstruct from photos too.
- **Generate from code** → [Generate 3D Models from Code](/tutorials/generate-3d-api): the same engine as a plain HTTP API.
- **Use it as an agent body** → [Build your first agent](/tutorials/first-agent).
