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

---

# Two-account plan: @trythreews then @nichxbt

The product account announces the thing. The personal account gives it a reason to be
interesting. Two different jobs, so two different voices, and they must not read as the same
person posting twice.

**Sequencing.** Post from @trythreews first. Wait for it to settle, roughly twenty to forty
minutes, then quote it from @nichxbt. Quoting immediately reads as self-amplification and
splits the engagement across both posts before either has traction. Do not have @trythreews
reply to the quote tweet: let the personal account carry that branch of the conversation.

**Voice split.**

- **@trythreews** is the platform. Declarative, no "I", no backstory, no feelings about it.
  It states what exists, shows it, and links to it.
- **@nichxbt** is a person who built it. First person, one specific detail nobody would know
  unless they had done the work, and an opinion. This is the post that earns the reshare.

---

## @trythreews (post first)

Attach the two room photos plus the studio screenshot.

### Option A: the release (recommended)

```
3D AR Studio is open source.

The multi-model AR studio from three.ws, extracted into a package any site can drop in:

<script src="unpkg.com/3d-ar-studio"></script>
<ar-studio></ar-studio>

Describe an object, watch it generate, put it on your real floor. Add more. Share the scene as a link.

Free, no key, Apache-2.0.

nirholas.github.io/3D-AR-Studio
```

### Option B: the capability, for a non-developer timeline

```
Put anything in your room, straight from a web page.

Type "a brass desk lamp". It gets generated, then stands on your actual floor at actual size. Put a chair next to it. Send the whole room to someone as a link.

One script tag. Free. Open source.

nirholas.github.io/3D-AR-Studio
```

### Option C: the shortest version

```
Any web page can now put real 3D objects in your actual room.

One script tag. Free. Open source. Works on the phone you're holding.

nirholas.github.io/3D-AR-Studio
```

---

## @nichxbt (quote tweet, 20 to 40 minutes later)

Pick one. A is the strongest: it is a real thing that happened, it is slightly unflattering,
and the technical detail proves the fix is real.

### Option A: the confession (recommended)

```
Yesterday I found out my own AR was fake on iPhone.

iOS has no WebXR, so we were painting the model over the camera feed. It floats. No real size. Nothing occludes it.

Every iPhone already ships ARKit. Now it uses it, and the model converts to USDZ on the device in about a second.
```

### Option B: why it is open source

```
People kept asking how the AR on three.ws works.

So I pulled it out of our site and published it. One script tag, your models, your domain, none of it pointing back at us unless you want it to.

I would rather this exist everywhere than be a feature only we have.
```

### Option C: for the graphics crowd

```
The part I am proud of: no rig allowlist.

Any humanoid GLB that ships with no animation gets an idle retargeted onto its own skeleton. Mixamo, VRM, Unreal, Daz, MMD, whatever came out of your pipeline.

No T-posing statues in anyone's living room.
```

### Option D: the short one

```
Every phone has had AR hardware in it for years and almost no website uses it.

Fixed that. It is one script tag and it is free.
```

---

## @nichxbt follow-up replies (under the quote tweet)

Post one or two of these under your own quote tweet, not under the @trythreews post. They are
where the developers land.

```
It is one npm install if you would rather bundle it:

npm i 3d-ar-studio three

Or two commands to get a live AR page on GitHub Pages:

npx 3d-ar-studio create my-ar-site
npx 3d-ar-studio deploy
```

```
It also ships an MCP server, so an agent can generate a model, arrange a scene, and hand a person one link that opens the whole arrangement in their room.

npx 3d-ar-studio-mcp
```

```
Models are free too. A few hundred public-domain props are already in it, and generating a new one needs no key and no account.

Point it at your own catalogue with one option if you would rather use yours.
```

---

## If someone big replies

- **A graphics or WebXR person**: go technical immediately. Mention the per-model XRAnchor,
  the light estimation, and the depth occlusion, and offer the repo. They will read code.
- **A non-technical account**: send them the demo link and tell them to open it on their
  phone and tap the AR button. Nothing else.
- **Someone asking "why not Unity / 8th Wall / a native app"**: no app install, no licence,
  no key, and it is a web page you can link to. That is the whole argument, do not oversell
  past it.
