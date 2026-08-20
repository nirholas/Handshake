# 3D AR Studio launch

The multi-model AR surface behind `three.ws/ar/studio`, extracted, generalized and published
as an open-source package anyone can drop into their own site.

**Live:**

- Demo: <https://nirholas.github.io/3D-AR-Studio/>
- Repo: <https://github.com/nirholas/3D-AR-Studio>
- npm: `3d-ar-studio`, `3d-ar-studio-mcp`
- MCP registry: `io.github.nirholas/3d-ar-studio`

**Media plan.** Lead with the room screenshots, not the UI. The whole argument is that an
object is standing on a real floor, so the first frame has to show a real floor.

1. The car model standing in the living room, shot through the phone
2. The armoured character standing in the same hallway
3. The studio itself with the prompt box visible, so the reader sees where it came from
4. Optional fourth: the desktop QR handoff

---

## Angle A: the one-line pitch (recommended)

Post this as a single tweet with images 1, 2 and 3.

```
Your iPhone has shipped with AR hardware for years. Almost no website uses it.

So I made it one line:

<script src="unpkg.com/3d-ar-studio"></script>
<ar-studio></ar-studio>

Type a prompt, get a 3D model, stand it on your actual floor at actual size. Add ten more. Send the whole room as a link.

Free. Open source. Works right now.

nirholas.github.io/3D-AR-Studio
```

### Shorter alternate

```
Every iPhone has had ARKit for years and almost no website uses it.

3D AR Studio makes it one script tag: describe an object, watch it appear, put it on your real floor. Add more. Share the whole scene as a link.

Open source, free, no key.

nirholas.github.io/3D-AR-Studio
```

---

## Angle B: the fix (use if the launch post underperforms, or as a follow-up a day later)

This is the sharper hook and it is true: the studio used to fall back to compositing over the
camera feed on iOS, which photographs like AR and behaves nothing like it.

```
Spent the day finding out my own AR was fake on iPhone.

No WebXR on iOS, so the model was just composited over the camera feed. It floats. It has no real size. Nothing occludes it.

Every iPhone already ships ARKit through Quick Look. Now it uses it, and the model is converted on the device in about a second.

nirholas.github.io/3D-AR-Studio
```

---

## Thread

Post Angle A as 1/, then:

**2/**

```
Most web AR drop-ins place exactly one model and hand you off to a native viewer. That ends the session.

This keeps the whole scene in your page. Place as many as you want, drag them, pinch to resize, twist to rotate. The arrangement is yours.
```

**3/**

```
Every device gets its real path, not an approximation.

Android and headsets: WebXR with one anchor per model, real light estimation, and depth occlusion so things hide behind your couch.

iPhone: Apple's AR Quick Look. The model is converted to USDZ on the device in about a second.
```

**4/**

```
Scenes are links. Compose on a laptop, scan the QR, it reopens exactly on your phone.

Open a room and someone else can build in it with you, live.

There's an MCP server too, so an agent can generate a model, arrange a scene, and hand a person one link that opens it in their room.

npm i 3d-ar-studio
github.com/nirholas/3D-AR-Studio
```

---

## Reply and quote-tweet lines

Use these under the main post rather than stuffing them into it.

- The models are free too. A few hundred public-domain props, and text-to-3D with no key and
  no account.
- Point it at your own catalogue with one option: `assets: 'https://your.cdn/models.json'`.
  Five common manifest shapes are read without reshaping anything.
- `npx 3d-ar-studio create my-ar-site` then `npx 3d-ar-studio deploy` puts a live AR page on
  GitHub Pages. Two commands.
- Characters do not T-pose. Any humanoid with no baked animation gets an idle clip retargeted
  onto its own skeleton, with no rig allow-list.
- Apache-2.0. Take it and put it in your product.

## Replies to expect

- **"Does this need an app?"** No. It is a web page. The AR opens in the viewer your phone
  already has.
- **"What does the generation cost?"** Nothing, and it needs no account or key.
- **"Can I use my own models?"** Yes, one option. Or write a source object with a `list()`
  and it can come from anywhere.
- **"Why not just model-viewer?"** model-viewer places one model and hands off. This composes
  a whole scene, keeps it in your page, generates new models into it, and shares the
  arrangement as a link.
- **"iOS support?"** Real ARKit through Quick Look, with the USDZ built on the device.

## Do not claim

- Do not say WebXR works on iPhone. It does not. iOS gets Quick Look and that is the point.
- Do not promise multi-model placement inside Quick Look or Scene Viewer. Those native
  viewers take one model at a time; the multi-model scene lives in the page.
- Do not put a number on generation time. It depends on queue depth.
