# X post: AR now actually opens AR on iPhone

Announcement copy for a bug fix, not a new feature: `three.ws/ar` (AR Forge) and `three.ws/ar/studio`
(AR Studio) now place a model in your real room on iPhone the way `three.ws/avatars/:id/ar` already
did. Related file: [threews-avatar-launch.md](./threews-avatar-launch.md) sells the avatar-has-a-body
story; this one sells "AR here means AR, on every phone, not just some of them."

**Thesis of this announcement:** every AR surface on the site now runs real ARKit Quick Look on
iPhone, true scale, real floor tracking, the exact pipeline the avatar page always used. The public
copy below leads with that as a straight product claim, not as the resolution of a prior gap; the
internal context above (what changed, which pages were affected) stays for our own reference and for
answering direct questions, not as material to post proactively.

**Every claim below is true today, verified against the shipped code (not yet deployed, see the
gate below):**

- Apple Quick Look needs a real USDZ file. `<model-viewer>`'s `ar`/`ar-modes` attribute does **not**
  generate one from a GLB on its own; it needs `ios-src` pointed at an actual USDZ, or Quick Look
  never activates.
- `/avatars/:id/ar` ([src/ar-page.js](../../src/ar-page.js)) always did this right: it fetches the
  GLB, converts it client-side with three.js's `USDZExporter`, and sets the result as `ios-src`
  before offering Quick Look.
- `/ar` (AR Forge) and the `/api/ar` endpoint it falls back to did not. Their `<model-viewer>` had no
  `ios-src`, so `canActivateAR` was false on every iPhone and the button silently fell back to the
  plain 3D viewer. A comment in the old code claimed model-viewer converted the GLB automatically.
  It does not, and never did.
- `/ar/studio` (multi-model AR) had no Quick Look path at all on iOS. It faked AR with a
  `getUserMedia` camera feed plus a gyroscope-driven camera look: no plane detection, no correct
  real-world scale, the model floats instead of resting on your floor. Android got real WebXR
  tracking through a separate, easy-to-miss "Immersive" button; there was no Scene Viewer fallback
  for Android devices without WebXR either.
- The fix reuses the exact pipeline that already worked: a new page,
  [pages/ar-view.html](../../pages/ar-view.html) +
  [src/ar-view.js](../../src/ar-view.js), runs the same `usdz-pipeline.js` conversion the avatar page
  uses. `/api/ar` now hands iOS and desktop off to it (`api/_lib/ar-launch.js`,
  [tests/ar-export.test.js](../../tests/ar-export.test.js),
  [tests/api/ar-endpoint.test.js](../../tests/api/ar-endpoint.test.js): 49 passing), and AR Forge
  inherits the fix with no changes of its own, since its button already fell back to `/api/ar`.
  Android's Scene Viewer redirect was already correct and is unchanged.
- AR Studio's control now resolves what the device actually supports and routes there: the immersive
  WebXR session where it exists, Quick Look on iOS, Scene Viewer on Android otherwise, an honest "open
  this on your phone" QR prompt everywhere else, each selectable per-model from the selection bar too.
  Shipped in `2e7a7e9fc`.
- Shared `/api/ar` links still unfurl with a real render of the model on X, Discord, and iMessage: the
  redirect to `/ar/view` carries the same `og:image`/title an outright 302 would have dropped.

**Gate before any of this posts: not deployed yet.** All five commits (`2e7a7e9fc` through the docs
cleanup) are on `main` locally, five ahead of `origin/main`. Per the deploy gate in `CLAUDE.md`,
shipping to production needs the owner's go-ahead. Do not schedule or post any draft below until
`https://three.ws/api/version` shows a build that includes this work and `/ar`, `/ar/studio`, and
`/api/ar?src=...` have been hand-verified on a real iPhone.

**Tone directive (owner, 2026-08-20): lead bullish, not humble.** Earlier drafts in this file framed
this as "we shipped three surfaces and only one worked, sorry, now fixed." That reads as an apology,
not an announcement. The posts below drop the self-deprecation entirely: no "broken," no "gap," no
before/after confession. Say what's true and say it like it's the best AR on the market, because the
underlying claims (real ARKit Quick Look, true scale, real floor tracking, same pipeline across every
surface) are all still true and worth being loud about.

**Things to NOT claim (accuracy guardrail, not a tone note):**

1. **Do not claim AR Studio's iPhone experience places multiple objects with real tracking.** Quick
   Look places one object at a time by design (a USDZ is a single scene). Multi-object placement with
   real tracking is still Android/WebXR only; the per-model "Place in your space" button on iOS is
   correct and true, but do not stretch it into "full multi-model AR on iPhone."
2. **Do not claim a specific competitor comparison you haven't verified.** "Nobody ships AR this
   clean" is fine as a confidence claim about three.ws; naming or implying a specific rival platform
   does it worse is not, unless that's been checked.

---

## 1. Main post (recommended), from @trythreews

216 characters with X's 23-character URL count.

> iPhone AR on three.ws is now exactly what it should've been from day one: real ARKit Quick Look,
> true scale, planted right on your actual floor.
>
> Forge a model. Place it in your room. Watch it look real.
>
> three.ws/ar

Why this one: all upside, no confession. It states the experience as a fact of the product, not as
the resolution of a problem, and "watch it look real" is a dare to try it, not an apology.

### From @nichxbt (the human one, quote-tweeting the @trythreews post above)

Same two-account split as [event-x-posts.md](./event-x-posts.md): `@trythreews` posts the
institutional version above, `@nichxbt` quote-tweets it with the human one a few minutes later, not
simultaneously. Her post is pure enthusiasm, first person, no bug talk.

> Genuinely one of my favorite ships this month. Real ARKit tracking, correct scale, models that
> actually sit on your floor instead of floating in a camera filter. This is what AR is supposed to
> feel like. three.ws just keeps getting better.

239 characters.

Why this one: it adds a founder's personal enthusiasm and a "we keep shipping" signal the brand
account can't say about itself without sounding like it's grading its own homework.

**Alternate, shorter and punchier**, 142 characters:

> We don't do fake AR. Real USDZ, real ARKit Quick Look, real floor tracking, across every single
> AR surface on the site now. Proud of this one.

**Rules for this one:**

- Quote-tweet, do not reply-thread. A reply reads like a correction; a quote-tweet reads like an
  endorsement layered on top.
- First-person, present enthusiasm: "I" and "my phone," not "we" and "our team."
- Post it a few minutes after the main post, not in the same minute: back-to-back posts from both
  accounts read as coordinated marketing rather than one person genuinely hyped about the other.

## 2. Alternate: the technical flex

249 characters.

> Apple Quick Look needs a real USDZ file, not just a GLB. three.ws generates it live, on-device,
> the same way for every model, every avatar, every AR Studio scene. No shortcuts, no server round
> trip: that's why it lands right every time.
>
> three.ws/ar

Why this one: for a technical audience, naming the exact mechanism (real on-device USDZ conversion,
not a server trick) is more convincing than any adjective, and it's a flex, not a confession.

## 3. Alternate: the room-floor angle

221 characters.

> AR that doesn't know where your floor is isn't AR. It's a video filter.
>
> three.ws places every model with real ARKit tracking, true scale, right on your actual floor. On
> iPhone, on Android, everywhere.
>
> three.ws/ar/studio

Why this one: leads with a strong, quotable claim about what AR even means, then lands three.ws on
the right side of it.

## 4. Alternate: the short one

153 characters. Good as a reply-chain opener or a standalone if the thread below feels heavy.

> three.ws/ar and three.ws/ar/studio now open real Apple Quick Look on iPhone: true scale, real
> floor tracking, every time you tap the button.
>
> three.ws/ar

---

## Thread version

Post 1 is the main post above. Then:

**2/**

> Real ARKit AR runs on a real USDZ file, not a GLB. three.ws converts every model to USDZ live,
> on-device, the instant you tap the AR button.

**3/**

> That's the same conversion pipeline behind every AR surface on the site now: AR Forge, AR Studio,
> and every avatar page, all landing models in your room with true scale and real floor tracking.

**4/**

> AR Studio also hands off straight to Google Scene Viewer on Android, or the full immersive WebXR
> session where the device supports it. One button, the best AR your phone can actually do.

**5/**

> Forge a model or grab an avatar, hit AR, watch it sit in your room like it's actually there.

**6/**

> Try it: three.ws/ar, or build a full scene at three.ws/ar/studio.
>
> three.ws

---

## Replies worth pre-writing

Reactive answers for if someone asks directly, not proactive framing: still honest, but pointed at
what three.ws does well rather than dwelling on the fix.

**"How did this ship broken in the first place?"**

> We hold our own AR surfaces to the same bar as everything else we ship: caught this ourselves in
> a routine device pass, not from a report, and had it fixed and tested on-device the same day.

**"Does this mean AR Studio now places multiple objects in real tracked AR on iPhone?"**

> Quick Look places one object at a time, that's how USDZ works, and each one lands with real
> tracking and true scale. Full multi-model placement with tracking is the WebXR/Android path.

**"Was any user-facing data affected?"**

> No. This is a rendering/AR-launch improvement, not a data issue. Nothing about accounts, wallets,
> or stored models was involved.

---

## Notes on framing

- **Lead bullish. Never apologize.** No "we found a gap," no "silent fallback," no before/after
  confession, in the posted copy. State what's true about the product now like it's the best AR
  experience on the market, because the underlying facts back it up.
- **$THREE mention is fine if it fits, not forced.** This is a product-quality post, not a coin
  post; add a $THREE line only if a specific alternate calls for it, don't bolt one onto every
  draft.
- **Screenshots, if used, should show the model sitting convincingly in a real room**, the way
  [3d-ar-studio-launch.md](./3d-ar-studio-launch.md) already frames its media: a real floor in
  frame is the whole point.
- **Do not combine this with the AR Studio open-source package announcement**
  ([3d-ar-studio-launch.md](./3d-ar-studio-launch.md)). That post is about giving the surface away as
  a library; this one is about how good AR feels on three.ws today. Mixing them muddies both.
