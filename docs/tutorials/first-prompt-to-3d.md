# Your First Prompt to 3D in ChatGPT

Type one sentence into ChatGPT and get a real, textured 3D model back: spin it in the browser, download it as a GLB, and place it in your room through your phone's camera. Generation is free and runs on three.ws; you don't need a three.ws account, a wallet, or an API key.

**What you'll do:**
- Add the three.ws 3D Studio to ChatGPT (two ways, pick one)
- Write a first prompt that generates well
- Read the three links every model comes back with
- Place the model in your real room
- Iterate on it in plain words, and bring a rigged avatar to life

**Prerequisites:** A ChatGPT account. A smartphone (iPhone or Android) for the AR step; every other step works on a computer.

---

## Step 1: Add the 3D Studio to ChatGPT

There are two ways in. Both use the same free generation lane; they differ in how results are shown.

**Option A: the ChatGPT app (connector).** In ChatGPT, add a connector with the URL `https://three.ws/api/mcp-studio` and **No authentication**. Models render inline in an interactive 3D widget you can rotate right in the chat, with a **View in your space** button on it. This is the best experience if your plan supports connectors.

**Option B: the custom GPT.** Search the GPT Store for **three.ws 3D Studio** and open it. Models come back as three labeled links instead of an inline widget. Use this on plans without connector support.

---

## Step 2: Type your first prompt

Ask for one concrete object, like you're telling a friend what to look for in a shop:

```
Make me a 3D model of a glazed ceramic teapot
```

Three habits make prompts generate dramatically better:

1. **One object per prompt.** "A teapot" works. "A teapot on a table by a window" confuses the model; it tries to build all of it.
2. **Name the material.** "brushed metal", "worn leather", "glazed ceramic", "matte plastic". Materials drive how the surface looks.
3. **Skip the scenery.** No backgrounds, no lighting moods. You're describing a thing, not a photograph.

Want more recipes? There's a whole cookbook: [Prompt Recipes for 3D Generation](/tutorials/prompts-for-3d).

---

## Step 3: Read what comes back

Generation usually takes 20 to 60 seconds; ChatGPT will tell you it's checking on the job if it needs longer. Every finished model arrives with three links, in this order:

1. **See it in your space (AR)**: the place-in-your-room link. This is the one to open on your phone.
2. **Preview in your browser**: an interactive viewer; drag to spin the model, scroll to zoom.
3. **Download (GLB)**: the model file itself.

In the connector version the model also renders inline, and the AR link is the **View in your space** button on the widget.

---

## Step 4: Place it in your room

Open the AR link on your phone (if you're on a computer, send it to yourself; it's a normal URL). What happens next is automatic:

- **iPhone:** the page opens Apple Quick Look. The model appears through your camera at real-world scale. Behind the scenes the GLB is converted to Apple's USDZ format on the fly, in the page.
- **Android:** the link goes straight into Google Scene Viewer (pre-installed on most Android phones with Google Play).
- **Computer:** no AR hardware, so the link falls back to the interactive 3D viewer. Nothing breaks.

Point the camera at a flat surface, tap to place, then walk around it. The model stays anchored where you put it.

---

## Step 5: Iterate in plain words

Every change is a real regeneration, described in words:

- **Custom GPT:** just say the change ("make it metallic and gold", "give it a taller spout"). The GPT folds your change into the previous prompt and generates a new model.
- **Connector:** the `refine_model` tool keeps a version lineage. The inline widget shows a version strip you can click to cross-fade between versions, and you can branch from any earlier version instead of starting over.

Each version carries its own AR link, so you can place the before and after side by side on your desk.

---

## Step 6: Bring an avatar to life

Props place statically. Rigged avatars do more. Ask for one:

```
Make me a rigged astronaut avatar I can animate
```

A rigged avatar's AR link gains a **Bring it to life** option: instead of a frozen statue, it opens [IRL](/irl), where the avatar walks, animates, and talks with you through your camera, standing in your real space. Static placement stays one tap away if you just want it on a shelf.

---

## Step 7: Take it anywhere

- The **GLB download** works in Blender, Unity, Godot, three.js, and most 3D tools.
- **Share the AR link.** Paste it into any chat and it unfurls with a real rendered picture of your exact model. Whoever opens it gets the same one-tap placement, plus a "Create your own" link.
- Want the same thing from code instead of ChatGPT? The identical free lane is a plain HTTP API: [Generate 3D Models from Code](/tutorials/generate-3d-api).

---

## Troubleshooting

- **"prompt_rejected"**: prompts are screened for age-13+ appropriateness before generation. Stylized fantasy props (a sword, a wand) are fine; rephrase anything that isn't.
- **Stuck on "still generating"**: under load a job can take a few minutes. ChatGPT keeps the poll link; ask it to check again rather than re-submitting.
- **AR link shows a viewer, not AR**: you opened it on a computer, or on a phone browser without AR support. Open it in Safari on iPhone or Chrome on Android.
- **Rate limited (429)**: the free lane has a per-IP hourly cap. Wait the indicated time; generation is free, so a failed attempt never costs anything.

---

## What's next

- [AR in ChatGPT](/docs/chatgpt-ar): how this whole pipeline works under the hood
- [Place your 3D model in AR](/tutorials/view-in-ar): the on-site AR flow, QR handoff included
- [Turn a Text Prompt into a 3D Model](/tutorials/text-to-3d): the same generation lane in the Forge, with quality tiers
- [The 3D Studio MCP server](/docs/mcp-studio): every tool the connector exposes, including living agent personas
