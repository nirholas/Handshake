# Turn a Text Prompt into a 3D Model

Type a sentence, get a downloadable 3D model. That's the whole tutorial. By the end you'll have generated your first model in the Forge, spun it around in 3D, and downloaded it as a GLB file you can use anywhere — games, websites, AR, 3D printing prep, or as an avatar body for your agent.

**What you'll make:** a real, textured 3D model from a one-line description — in about a minute.

**Prerequisites:** none. No account, no wallet, no code. Just a browser.

---

## Step 1 — Open the Forge

Go to [three.ws/forge](/forge).

You'll land on the **Describe it** tab — that's the text-to-3D mode. (The other tabs, **From photos** and **From a sketch**, turn images into models; see [Turn Photos into a 3D Model](/tutorials/image-to-3d) for those.)

---

## Step 2 — Describe the object

Click into the prompt box and describe **one object**, like you're telling a friend what to look for in a shop:

```
a glazed ceramic teapot
```

Not sure what to type? Tap one of the example chips under the form — *a low-poly red fox, sitting*, *a sci-fi combat helmet, brushed metal*, *a vintage film camera* — and it fills the box for you.

Three habits that make prompts work dramatically better:

1. **One object per prompt.** "A teapot" works. "A teapot on a table next to a window" confuses the model — it tries to build all of it.
2. **Name the material.** "brushed metal", "worn leather", "glazed ceramic", "matte plastic". Materials drive how the surface looks.
3. **Skip the scenery.** No backgrounds, no lighting moods, no "in a forest". You're describing a thing, not a photograph.

Want more recipes? There's a whole cookbook: [Prompt Recipes for 3D Generation](/tutorials/prompts-for-3d).

**Prefer to talk?** The Forge Studio variant at [three.ws/forge-studio](/forge-studio) has a mic button next to each prompt box: describe the object out loud and the transcript drops straight into the field, ready to edit before you generate. It uses your browser's built-in speech recognition where available, with a free cross-browser fallback (NVIDIA Riva) for browsers that don't have one (mainly Firefox). Nothing is written to disk on either path: the browser path never leaves your device, and the fallback path transcribes in memory and discards the audio once it replies. If neither is available the mic button simply doesn't appear.

---

## Step 3 — Pick a quality tier

Below the prompt are three quality buttons:

| Tier | What you get | When to use it |
|------|-------------|----------------|
| **Draft** | Fast, low-poly (~12k triangles) | Trying ideas. Generate five drafts, keep the best shape. |
| **Standard** | Balanced detail (~30k triangles) | The default. Right for most assets. |
| **High** | Maximum detail (~200k triangles) + PBR materials (metallic, roughness, normals) | The final version, once the prompt is dialed in. Slower. |

**Start with Draft or Standard.** The pro workflow is: iterate cheap and fast, then re-run your winning prompt on High.

**High is the premium tier.** Draft and Standard are free for everyone. High unlocks for $THREE holders (Bronze tier, $25 held) and shows a lock otherwise; a non-holder can pay for a single High generation, or spend prepaid credits, right from the tier picker. If you bring your own Meshy or Tripo key, High is not gated (you pay the vendor directly).

You can leave the **Engine** selector alone — the Forge picks a sensible default. (If you have your own [Meshy](https://meshy.ai) or [Tripo](https://www.tripo3d.ai) API key, you can select those engines and paste your key into the field that appears — it stays in your browser and is never stored. Skip this entirely for now.)

---

## Step 4 — Generate

Click **Generate**.

The Forge shows you each step as it happens:

1. **Painting reference image** — your words become a reference picture.
2. **Reconstructing textured mesh** — the picture becomes real 3D geometry.
3. **Finalizing GLB** — packaging the model file.

Draft takes roughly 15 seconds; Standard about a minute; High a couple of minutes. The preview image appears early, so you'll know almost immediately whether the model is on the right track.

---

## Step 5 — Inspect your model

When generation finishes, the model appears in a live 3D viewer:

- **Drag** to rotate, **scroll** to zoom.
- Press **F** for cinema mode — a fullscreen turntable. Press **Esc** to exit.
- On a phone or AR-capable device, use the AR button to place the model in your room.

Look at it from the back and underneath — that's where generation flaws hide.

Then rate it with **👍 Keep** or **👎 Discard**. This isn't decoration: your verdicts feed back into how the Forge picks engines, so rating honestly makes your future generations better.

---

## Step 6 — Download or share it

- **Download GLB** saves the model file. GLB is the standard 3D format for the web — it opens in Blender, three.js, Unity, Unreal, Windows 3D Viewer, and macOS Quick Look.
- **Share** gives you a link with a proper preview card, so the model shows up as an image when you post it.
- **Make another** clears the form for your next idea.

Every model you generate is also saved to **Your creations** at the bottom of the page — it's tied to your browser, so you can close the tab and come back later. Click any creation to reload it in the viewer.

---

## Didn't get what you wanted?

This is normal — prompt, generate, adjust, repeat is the workflow, not a failure mode.

| What went wrong | What to change |
|-----------------|----------------|
| Right object, wrong style | Add a style word: "low-poly", "realistic", "cartoon", "stylized" |
| Surface looks flat or plasticky | Name the material explicitly, or switch to the **High** tier for PBR textures |
| Extra junk attached to the model | Your prompt described a scene. Cut it down to just the object |
| Shape is mushy or vague | Be more specific: "a four-legged armchair with a tall back" beats "a chair" |
| "Generation limit reached" | The free lane allows about 60 generations per hour per visitor ($THREE holders get more). Wait a bit and try again |
| Model never finishes | Refresh the page — your job keeps running and your creations gallery keeps the result |

---

## What's next

- **Better prompts** → [Prompt Recipes for 3D Generation](/tutorials/prompts-for-3d) — copy-paste recipes by category, with the reasoning behind them.
- **Have photos of a real object?** → [Turn Photos into a 3D Model](/tutorials/image-to-3d) — reconstruct it from 1–4 pictures.
- **Want to generate from code?** → [Generate 3D Models from Code](/tutorials/generate-3d-api) — the same engine, as a simple HTTP API.
- **Use it as an agent body** → [Build your first agent](/tutorials/first-agent) — your generated GLB can be a talking 3D character.
