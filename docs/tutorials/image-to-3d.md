# Turn Photos into a 3D Model

Have a real object you want in 3D? Photograph it from a few angles, drop the photos into the Forge, and get back a textured 3D model. This works for products, toys, sculptures, furniture, sneakers — anything you can put on a table and walk around.

**What you'll make:** a downloadable GLB model reconstructed from 1 to 6 photos of a real object.

**Prerequisites:** none. A phone camera is plenty.

---

## Step 1 — Take good photos

This step decides 90% of your result quality. Five rules:

1. **One object, plain background.** Put the object on a table against a wall, or hold it against the sky. Busy backgrounds get reconstructed as part of the object.
2. **Even lighting, no harsh shadows.** Indirect daylight is ideal. Avoid a phone flash — it creates hotspots that become weird texture patches.
3. **Fill the frame.** The object should take up most of the photo, in focus.
4. **Same object, different angles.** The core set is **front, back, left, right**; two more slots take a **top** shot and a **three-quarter** shot. Keep the object the same way up in every shot.
5. **Don't move the object between shots** — walk around it instead, so the lighting stays consistent.

One photo works. Four to six work noticeably better: every angle you provide is geometry the model doesn't have to guess.

**Formats:** PNG, JPG, or WebP, up to 8 MB each.

---

## Step 2 — Open the Forge in photo mode

Go to [three.ws/forge](/forge) and switch to the **From photos** tab.

You'll see a grid of six upload slots (front, back, left, right, top, and three-quarter). Drag your photos in, or click a slot to browse. After uploading you can **drag the thumbnails to reorder** them: put your best, clearest shot first.

**No object on hand? Draw it.** The Forge also takes drawings, two ways. On this page, the **From a sketch** tab (it appears when the sketch engine is live) takes one drawing plus a short required description of what it depicts: dark strokes on a light background work best, and the result is untextured geometry you can then **Stylize** or **Retexture**. In the [Forge Studio](/forge-studio), click **Or draw it instead** below the photo grid to open an in-browser drawing canvas: draw with your mouse, finger, or stylus, then **Use sketch** to drop the PNG straight into the next open slot, where it rides the same reconstruction pipeline as an uploaded photo. Nothing is uploaded while you draw, only when you click **Use sketch**; cancelling discards it with zero network activity.

---

## Step 3 — Add guidance (optional, but worth it)

Below the photo grid there's an optional text field. Use it to tell the engine things the photos can't:

```
matte plastic, neutral pose, no background
```

Good guidance mentions the **material** ("brushed aluminum", "soft fabric") and anything to ignore ("no background", "ignore the stand"). Keep it short — the photos are doing the heavy lifting.

---

## Step 4 — Pick a tier and generate

The same three quality tiers from [text-to-3D](/tutorials/text-to-3d) apply:

- **Draft** — fast preview to confirm your photos work.
- **Standard** — the default.
- **High** — maximum geometry + PBR textures, for the final asset.

Click **Generate**.

**If the Forge flags your image:** before spending a generation, the Forge runs a quick vision check on your photos. If it warns you — blurry, busy background, multiple objects — it tells you exactly what's wrong. You can fix the photo (best results) or click **Generate anyway** to override the check.

Reconstruction takes about a minute on Standard. You'll see the progress steps as it works.

---

## Step 5 — Inspect, download, share

The finished model lands in the 3D viewer:

- **Drag** to rotate, **scroll** to zoom, **F** for fullscreen turntable.
- Check the back and the side you photographed least — that's where the engine had to guess. If a guessed area matters, take a photo of that angle and regenerate.
- **Download GLB** to save it, **Share** for a link with a preview card.
- Rate it **👍 Keep** or **👎 Discard** — your verdicts train the engine selection.

Everything you generate is kept in **Your creations** at the bottom of the page, tied to your browser.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Background melted into the model | Busy backdrop in the photos | Reshoot against a plain wall, or note "no background" in the guidance field |
| Texture has bright patches | Flash or hard directional light | Reshoot in even, indirect light |
| Back of the model is wrong | Only front photos provided | Add back, side, and three-quarter views, up to 6 |
| Object came out warped | Photos show the object in different positions/orientations | Keep the object still; you move, not it |
| Upload rejected | File too large or wrong type | PNG/JPG/WebP, max 8 MB each |
| "Generation limit reached" | Per-visitor rate limit | Wait a minute, try again |

---

## What's next

- **No photos, just an idea?** → [Turn a Text Prompt into a 3D Model](/tutorials/text-to-3d).
- **Write better guidance text** → [Prompt Recipes for 3D Generation](/tutorials/prompts-for-3d).
- **Automate it** → [Generate 3D Models from Code](/tutorials/generate-3d-api) — upload photos and reconstruct via the HTTP API.
- **Put your object on the web** → [Upload a custom GLB avatar](/tutorials/upload-custom-glb) or [embed it on a website](/tutorials/embed-on-website).
