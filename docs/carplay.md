# three.ws Drive: the agent in the car

**Status:** research complete, architecture decided, the shared car surface (`/drive`) is
built and verified in a browser, the native CarPlay scene is written and wired into the iOS
app, and the Android Auto car app is written, wired into the Android overlay, and compiled.
The steps that cannot be finished from here are Apple's entitlement grant and a car.
**Date:** 2026-09-03.
**Question asked:** can a three.ws 3D agent be the assistant on an Apple CarPlay screen, and
how much of it already exists in open source?

**Short answer:** the door opened five months ago and almost nobody has walked through it.
In iOS 26.4 Apple added a CarPlay app category for **voice-based conversational apps**, with
its own entitlement, aimed squarely at assistants like this one. iOS 27 then let the Voice
Control template present as an overlay on any other template, including a live map. That is
the unlock. What Apple does **not** give a conversational app is a drawing surface, so the
honest architecture is not "render the avatar on the car screen": it is a voice-first agent
whose control surface is Apple's templates and whose face lives everywhere else, on the
phone in the cradle, on a head unit browser, on the passenger display, and on the open head
units where nothing is gated at all.

---

## 1. Why this is a better fit than it looks

The [smart home plan](smart-home.md) argued that a home is the first place where a body, a
voice, memory and identity all pay off at once. A car is the second, and it is a better
first shipment, for a reason that has nothing to do with ambition: **in a car, voice is not
one interface among several. It is the only one that is legal.**

Every constraint that makes an in-car product hard is a constraint three.ws already builds
against:

- **You cannot ask the driver to read.** three.ws agents already speak, with a real voice
  and real lipsync, through `/api/tts` and the existing talk loop.
- **You cannot ask the driver to look for long.** A glanceable presence that conveys state
  through a face and a voice, rather than a list, is the whole product.
- **The agent has to be someone.** A generic assistant is interchangeable. An agent with a
  name, a face, a voice, memory, and an on-chain identity is the one a person actually wants
  riding along, and it is the one they can bring from the browser to the car to the house
  without re-teaching it anything.

The car is also where the platform's other surfaces stop being separate products. An agent
that can already reach a home through [`@three-ws/home-bridge`](../packages/home-bridge) is
the same agent that can be told "we are ten minutes out" on the way back.

---

## 2. The landscape, measured

### What Apple actually allows (this is the part that decides the design)

CarPlay apps are not free-form. An app declares one category, requests the matching
entitlement, and gets a fixed vocabulary of templates that iOS renders on the car screen.
The app is the controller and the model; iOS is the view.

| Category | What it gets | Fit |
|---|---|---|
| Navigation (`carplay-maps`) | A `UIWindow` to draw a map into, plus map templates | The only category with a real render surface, but the base view must be used **exclusively** to draw a map, with no panels or overlays of our own. A 3D agent in it is not a navigation app. |
| Audio, Communication, EV charging, Parking, Quick ordering | Lists, grids, now-playing | Voice only through SiriKit, no conversation |
| Driving task | Lists and grids, depth 2 (depth 3 on iOS 26.4+) | Explicitly must not duplicate navigation, and cannot use the voice template |
| **Voice-based conversation** (`carplay-voice-based-conversation`) | The Voice Control template, an audio session, depth 3 | **This one.** Added in iOS 26.4 for conversational assistants. |

The rules that come with the voice category shape the product, so they are worth stating
plainly rather than discovering during review: voice must be the primary modality on launch,
the app cannot be the system-wide assistant, there is **no wake word**, it must be launched
by hand from the CarPlay home screen, and the audio session may be held open only while
voice is actually in use.

iOS 27 loosened the visual half: the Voice Control template can present as an overlay over
another template instead of taking the whole screen, and the template was opened to every
category. An app holding `carplay-maps` can now keep a map rendering underneath a live
assistant. That is a door worth walking through later; it is not the first shipment.

### Android's side

Android draws the same line in a different place. The Car App Library
(`androidx.car.app`, Apache-2.0) is template-based too, and the host renders the UI. But its
`NavigationTemplate` hands an app a real `Surface` through `SurfaceCallback`, which can be
drawn into with Canvas or with the VirtualDisplay/Presentation APIs. MapLibre publishes a
working sample of exactly that. So the "3D agent rendered on the car screen" idea is
technically reachable on Android Auto through the navigation category, and blocked on
CarPlay by the exclusive-map rule. Android Automotive OS, which runs the app on the head
unit itself, is looser still.

What Android does **not** have is a conversational category. The manifest categories are
`NAVIGATION`, `POI`, `IOT`, `WEATHER`, `MEDIA`, `MESSAGING` and `CALLING`, and an app
declares exactly one. The accurate one here is **`androidx.car.app.category.IOT`**, for apps
that let people "take relevant actions on connected devices from within the car". That is
not a workaround: a three.ws agent already reaches a real house through the home tools wired
into `/api/chat` ([smart-home.md](smart-home.md)), with a safety gate that freezes anything
physical until a person approves it. "Turn the porch light on" from the car is the product,
and the category names it correctly.

The consequence is that Android and iOS end up in the same place from opposite directions.
Apple grants a conversational category with no canvas; Google grants a canvas only to
navigation and has no conversational category at all. Either way the car screen is
templates, the conversation is the page, and the agent's face is somewhere else.

### The open-source inventory

| Project | License | What it gives us | Verdict |
|---|---|---|---|
| [rhysmorgan134/node-CarPlay](https://github.com/rhysmorgan134/node-CarPlay) | MIT | Talks to a Carlinkit CPC200 USB dongle over WebUSB or Node USB bindings and forwards the CarPlay H.264 video and PCM audio, with mic and touch going back | **Adopt** for the head unit lane. It is the only practical way to render a real CarPlay session inside our own JS surface. |
| [birkir/react-native-carplay](https://github.com/birkir/react-native-carplay) | MIT | One template API across CarPlay and Android Auto for React Native apps | **Read, do not adopt.** Its template mapping is the best reference implementation in the open, but the three.ws app is Capacitor, not React Native, and the scene delegate we need is 200 lines of Swift. |
| [androidx.car.app](https://developer.android.com/training/cars/apps/library) | Apache-2.0 | The Android Auto and AAOS template host, including the navigation `Surface` | **Adopt** when the Android leg lands. |
| [maplibre/MapLibre-Android-Auto-Sample](https://github.com/maplibre/MapLibre-Android-Auto-Sample) | BSD-2 | A worked example of rendering into the Android Auto navigation surface | **Reference.** This is the shape a 3D agent on an Android car screen would take. |
| [f1xpl/openauto](https://github.com/f1xpl/openauto) | GPL-3.0 | Android Auto head unit emulation on a Raspberry Pi | **Reject.** Copyleft we cannot link into a commercial product, and effectively unmaintained. |

Everything below the protocol layer we already have and should not rebuild: speech in
(`/api/asr`, NVIDIA Riva), speech out (`/api/tts`, NVIDIA Magpie), the model chain
(`/api/chat`), lipsync, the retargeted animation library, and the avatar itself.

---

## 3. The decision

**Three lanes, one surface.** Everything that is actually the product lives in one page,
`/drive`, and each lane is a different way of putting that page in front of a driver. That
is what keeps the car from forking into three half-products.

### Lane A: `/drive`, the car surface (built)

A voice-first page sized and behaved for a car panel. It is the whole product on a head unit
browser, on a phone in a cradle, and on Android Automotive, with no approval from anyone.
See [Section 4](#4-what-drive-actually-does).

### Lane B: native CarPlay (built, waiting on Apple)

A `CPTemplateApplicationSceneDelegate` in the existing iOS app. The car screen shows the
four controls and the Voice Control template; the phone runs `/drive`; a WebKit message
channel joins them. Written, wired, and documented in
[`ios/docs/CARPLAY.md`](../ios/docs/CARPLAY.md). It cannot ship until Apple grants
`com.apple.developer.carplay-voice-based-conversation`, which is a per-app request.

### Lane C: native Android Auto (built)

A `CarAppService` in the Android app's overlay, declaring the IOT category. The car screen
shows the same four controls; the conversation runs in a web view inside a typed foreground
service, because during a drive the phone screen belongs to Android Auto and a background
process may not hold a microphone. Written, wired, compiled, and documented in
[`solana-mobile/docs/ANDROID-AUTO.md`](../solana-mobile/docs/ANDROID-AUTO.md).

That web view is never attached to a window, which means no animation frames, so
`?surface=androidauto` turns the 3D stage off and the loop runs as audio. The same preset
turns the confirmation card off: a person who cannot see what they are approving is a
recognizer being trusted with a lock, and the home safety doctrine refuses that outright.

### Lane D: the open head unit (designed, not built)

`node-carplay` plus a Carlinkit CPC200 dongle renders a real CarPlay or Android Auto session
inside a browser surface we own, on a Raspberry Pi or any Linux box. In that lane there is no
entitlement, no template vocabulary and no exclusive-map rule: the agent can stand beside
the projected phone screen at full size. This is where the original idea, the agent as the
face of the car, is legal today. It needs hardware to build against, so it is scoped and
deliberately not half-built.

### Explicitly not building

- **A navigation app.** Shipping turn-by-turn to obtain a render surface, then using that
  surface for something other than a map, is exactly what the exclusive-map rule forbids.
  If three.ws ever ships navigation it will be because navigation is the product.
- **A wake word.** Apple's category forbids it and the platform is better without one.
- **Our own dongle protocol.** `node-carplay` already speaks it.
- **A second voice stack.** The talk loop is the talk loop.

---

## 4. What `/drive` actually does

Route: [`/drive`](https://three.ws/drive). Page: `pages/drive.html`. Code: `src/drive/`.

The loop is the platform's existing one, unchanged: microphone into `/api/asr` (NVIDIA Riva,
with the browser recognizer as the fallback lane), transcript into `/api/chat`, reply into
`/api/tts`, audio into the lipsync driver and onto a real rigged avatar. What `/drive` adds
is everything that makes that safe at speed.

- **One line, not a transcript.** The reply is clamped to two lines and spoken in full. What
  was heard sits above it in a smaller, dimmer line so a misheard word is obvious.
- **Four controls, no more.** Hands free, Repeat, Stop, Type. The same four are mirrored to
  the car screen, which is why there are four: it is Apple's ceiling for the voice template's
  action buttons, and designing to the tightest surface keeps the others honest.
- **A keyboard that disappears.** The page starts in Driving and hides text entry. If the
  browser reports a real ground speed, moving above walking pace locks it back and closes
  anything open; a sustained stop lets the driver switch to Parked themselves. With no speed
  signal the toggle is manual and still defaults to Driving. On CarPlay and Android Auto the
  keyboard is not offered at all, because the web view is on a phone in a mount.
- **Local commands with no round trip.** "Repeat that", "stop talking", "louder", "night
  mode", "I'm parked" are answered by the page itself in `src/drive/commands.js`. Matching is
  against the whole utterance, never a substring, so "stop at the next charger" still reaches
  the agent.
- **Hands free that actually ends a turn.** On the Riva lane the page reads the real
  captured mic level and closes the turn after roughly a second of quiet, capped at fifteen
  seconds. On the browser recognizer lane the recognizer ends its own turn and the page
  simply re-arms.
- **Day and night.** Night is the default because a bright panel at speed is glare. Day is
  one press, or one sentence.
- **A surface preset per panel.** `src/drive/surface.js` scales every size from the viewport
  and the panel type: a head unit is about a metre from the driver's eyes and gets larger
  glyphs, an 800x480 dash gets a one-line reply and a shorter deck.

### What it fixed on the way

The talk loop's free voice lane, `/api/tts/edge`, requires a signed-in session. Every
anonymous listener on the platform, a public avatar page, an embed, and now a car, got a
working reply and complete silence. `TalkController` now falls through to `/api/tts/speak`,
the free NVIDIA Magpie lane that has no such gate, and latches the 401 so it costs one
wasted request per session rather than one per turn. `hush()` and `setVolume()` landed on the
same class, which is what makes barge-in and "louder" real rather than decorative.

---

## 5. Build plan

| Phase | Work | State |
|---|---|---|
| 1 | `/drive`: the surface, the voice loop, the safety rules, the presets | **Done.** Verified in Chromium at 800x480, 1280x720, 1920x720 and 390x844, day and night, with a real `/api/chat` and `/api/tts` turn. |
| 2 | Native CarPlay scene, audio session, message channel, entitlement, Info.plist | **Done in the tree.** Cannot be compiled or run without Xcode and a car or the CarPlay simulator. |
| 3 | Apple's entitlement request | **Owner action.** See `ios/docs/CARPLAY.md`. Nothing else blocks. |
| 4 | Android Auto: `CarAppService`, foreground-service web view, the same channel, the same four controls | **Done and compiled.** Needs the Desktop Head Unit and a phone to exercise on a car screen. |
| 5 | The home lane reaching the car: guarded actions surfaced and gated on being parked | **Done.** `/api/chat`'s home tools already work from `/drive`; the confirmation card is wired and refused while moving. |
| 6 | Android Automotive OS: `app-automotive` plus a `CarAppActivity` in its own build flavor | Scoped, not started. |
| 7 | Lane D head unit: `node-carplay` beside the agent on a Pi | Scoped, needs a CPC200 dongle. |

---

## 6. What was actually verified

Run against the live production API through the dev server's `/api` proxy, in headless
Chromium:

- The copilot picker loads real avatars from `/api/avatars/featured` and falls back from
  `/api/avatars` cleanly when nobody is signed in (401, no error shown to the user).
- Selecting an agent mounts the real GLB, binds the mouth target, and drives the shared
  retargeted idle clip, so no avatar stands in bind pose.
- A full turn: typed input into `/api/chat` (200), reply rendered and clamped, `/api/tts/edge`
  refused (401), `/api/tts/speak` served the audio (200), state moved `thinking -> speaking
  -> idle`, and Repeat became available. No console errors.
- A local command ("night mode") applied with zero network calls.
- The native bridge: `window.threeWsDrive.command({ type: 'repeat' })` re-spoke the last
  reply, which is the exact call `DriveLink.swift` makes.
- 17 unit tests in `tests/drive-surface.test.js` cover the surface presets, the command
  matcher (including the phrases it must NOT match), and the motion gate.

Not verified, and stated as such: the Swift has not been compiled, no CarPlay session has
been connected, and no Carlinkit dongle has been touched.

---

## 7. Licensing

Everything adopted or planned is permissive: MIT (`node-carplay`, and
`react-native-carplay` as a reference), Apache-2.0 (`androidx.car.app`), BSD-2 (MapLibre).
The GPL-3.0 projects in this space, OpenAuto and `aasdk`, are excluded on both counts:
copyleft we cannot link into a commercial product, and no meaningful maintenance.

The obligation runs the other way too. `node-carplay` is one maintainer's work holding up an
entire category of open head units. If the head unit lane lands and we fix something in it,
the fix goes upstream.

---

## Sources

- [Apple: Requesting CarPlay entitlements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
- [Apple: CarPlay for developers](https://developer.apple.com/carplay/)
- [Apple: CPTemplateApplicationScene](https://developer.apple.com/documentation/carplay/cptemplateapplicationscene)
- [Apple: Turbocharge your app for CarPlay (WWDC25)](https://developer.apple.com/videos/play/wwdc2025/216/)
- [Apple: Get more mileage out of your app with CarPlay (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10016/)
- [Mapbox: CarPlay on iOS 27 lets a voice assistant run over a live map](https://www.mapbox.com/blog/carplay-on-ios-27-lets-a-voice-assistant-run-over-a-live-map)
- [MacRumors: iOS 26.4 brings CarPlay support for conversational assistants](https://www.macrumors.com/2026/02/18/ios-26-4-carplay-support/)
- [Android: Use the Android for Cars App Library](https://developer.android.com/training/cars/apps/library)
- [Android: Draw maps on the navigation surface](https://developer.android.com/training/cars/apps/library/draw-maps)
- [rhysmorgan134/node-CarPlay](https://github.com/rhysmorgan134/node-CarPlay)
- [birkir/react-native-carplay](https://github.com/birkir/react-native-carplay)
- [maplibre/MapLibre-Android-Auto-Sample](https://github.com/maplibre/MapLibre-Android-Auto-Sample)
- [f1xpl/openauto](https://github.com/f1xpl/openauto)
