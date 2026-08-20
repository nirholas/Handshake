# X post: AR now actually opens AR on iPhone

Announcement copy for a bug fix, not a new feature: `three.ws/ar` (AR Forge) and `three.ws/ar/studio`
(AR Studio) now place a model in your real room on iPhone the way `three.ws/avatars/:id/ar` already
did. Related file: [threews-avatar-launch.md](./threews-avatar-launch.md) sells the avatar-has-a-body
story; this one sells "AR here means AR, on every phone, not just some of them."

**Thesis of this announcement:** every AR surface on the site claimed to support Quick Look on
iPhone. Only one of them actually did. The other two silently degraded, in two different ways, and
nobody who wasn't holding an iPhone would have noticed. That gap is now closed. No roadmap talk, no
"coming soon."

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

**Things to NOT claim:**

1. **Do not say "new AR feature."** Nothing new was added to what AR Forge or AR Studio could already
   do on Android or in the browser. The whole story is that iPhone now gets what was always promised.
2. **Do not name the old bug's exact symptom as if it were widely reported.** Frame it as "we found
   this ourselves and fixed it," not "users complained." Nobody publicly complained; it was caught in
   review.
3. **Do not claim AR Studio's iPhone experience places multiple objects with real tracking.** Quick
   Look places one object at a time by design (a USDZ is a single scene). Multi-object placement with
   real tracking is still Android/WebXR only; the per-model "Place in your space" button on iOS is
   correct and true, but do not stretch it into "full multi-model AR on iPhone."

---

## 1. Main post (recommended)

258 characters with X's 23-character URL count.

> We shipped three AR surfaces. Only one of them actually opened AR on an iPhone.
>
> The other two quietly fell back to a flat 3D view or a fake camera overlay. Nobody would've
> noticed unless they were holding an iPhone.
>
> Fixed. All three now use real Quick Look.
>
> three.ws/ar

Why this one: the honesty is the hook. Admitting a real gap and naming the fix precisely reads as
credible in a way "AR now works!" never does, and it invites the reply "wait, which two."

## 2. Alternate: the technical explainer

269 characters.

> Apple Quick Look needs a real USDZ file. `<model-viewer>` does not generate one from a GLB on its
> own, no matter what the docs imply.
>
> Two of our AR pages never set it. iPhone silently got a downgrade nobody could see from the code.
>
> Fixed, verified on-device.
>
> three.ws/ar

Why this one: for a technical audience, naming the exact mechanism (`ios-src`, no auto-conversion) is
more convincing than any adjective. It also preempts "how do you know it's fixed."

## 3. Alternate: the room-floor angle

264 characters.

> AR that doesn't know where your floor is isn't AR. It's a video filter.
>
> Our multi-model AR studio faked it on iPhone with a camera overlay: no real scale, nothing to rest
> the model on.
>
> Now it hands off to Apple's own Quick Look. Real tracking, real floor.
>
> three.ws/ar/studio

Why this one: leads with a strong, quotable claim about what AR even means, which travels further
than a bug-fix framing on its own.

## 4. Alternate: the short one

Under 200 characters. Good as a reply-chain opener or a standalone if the thread below feels heavy.

> Fixed: `three.ws/ar` and `three.ws/ar/studio` now open real Apple Quick Look on iPhone, the same
> way our avatar pages always have.
>
> No more silent fallback to a flat 3D view.
>
> three.ws/ar

---

## Thread version

Post 1 is the main post above. Then:

**2/**

> Quick Look needs a USDZ file, not a GLB. `<model-viewer>`'s AR attribute offers Quick Look as a
> mode, but it will not convert the model for you: you have to hand it a real USDZ as `ios-src`, or
> the button quietly does nothing useful.

**3/**

> Our avatar AR page (`/avatars/:id/ar`) always did this: fetch the GLB, convert it to USDZ in the
> browser with three.js's own exporter, hand it to Quick Look. That page was always correct.
>
> AR Forge and AR Studio were not built the same way.

**4/**

> AR Forge fell back silently to the plain interactive 3D viewer on iPhone. No error, no warning: the
> button just stopped being an AR button.
>
> AR Studio went further: it faked AR with your camera feed and the phone's gyroscope. The model
> floats. Nothing anchors it to your floor. It looks like AR in a screenshot and nothing like it in
> your hand.

**5/**

> Both are fixed the same way: a shared page now runs the exact USDZ conversion the avatar page
> always used, and both surfaces hand off to it on iPhone.
>
> Android's Scene Viewer redirect was already correct the whole time and didn't need touching.

**6/**

> Try it: three.ws/ar, or forge a scene at three.ws/ar/studio and tap the AR button.
>
> three.ws

---

## Replies worth pre-writing

**"How did this ship broken in the first place?"**

> `<model-viewer>`'s AR attributes make Quick Look look wired up even when it isn't: the button
> renders, the attribute is set, and the only visible symptom is that tapping it on an iPhone does
> nothing useful. It doesn't throw an error. Caught in review, not from a report.

**"Does this mean AR Studio now places multiple objects in real tracked AR on iPhone?"**

> No, and we're not claiming that. Quick Look places one object at a time; that's how USDZ works.
> What's fixed is that placing one is now real device AR instead of a camera overlay. Multi-object
> placement with true tracking stays an Android/WebXR thing for now.

**"Was any user-facing data affected?"**

> No. This is a rendering/AR-launch bug, not a data issue. Nothing about accounts, wallets, or stored
> models was involved.

---

## Notes on framing

- **Lead with the honesty, not the fix.** "We found a real gap and closed it" earns more trust than
  "new AR upgrade," and it's the more accurate description of what happened.
- **Do not mention $THREE.** This is a reliability fix, not a growth feature; forcing a coin mention
  onto it would read as opportunistic.
- **Screenshots, if used, should be before/after on the same physical spot**, the way
  [3d-ar-studio-launch.md](./3d-ar-studio-launch.md) already frames its media: a real floor in frame
  is the whole point, so a screenshot without one undercuts the post.
- **Do not combine this with the AR Studio open-source package announcement**
  ([3d-ar-studio-launch.md](./3d-ar-studio-launch.md)). That post is about giving the surface away as
  a library; this one is about a bug on the site everyone already uses. Mixing them muddies both.
