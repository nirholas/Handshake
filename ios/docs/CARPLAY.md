# three.ws Drive on CarPlay

The car screen half of [`/drive`](../../docs/carplay.md). Read that document first: it
explains why the architecture is what it is, and why the agent's 3D face is **not** on the
CarPlay screen.

This file covers the native side only: what is in the tree, what Apple has to grant before
any of it runs, and how to exercise it once they do.

## The one-paragraph version

three.ws declares CarPlay's **voice-based conversational app** category, added in iOS 26.4.
That category gives an app a template UI and an audio session, and no drawing surface. So the
car screen shows four controls and Apple's Voice Control template, the phone's WebView runs
`https://three.ws/drive?surface=carplay` with the real agent in it, and a WebKit message
channel keeps the two in step. Nothing about the phone app changes when CarPlay is absent.

## What is in the tree

| File | Role |
|---|---|
| `native/App/App/CarPlaySceneDelegate.swift` | The CarPlay scene. Root `CPListTemplate` with the four controls, `CPVoiceControlTemplate` presented for the length of a turn. |
| `native/App/App/DriveLink.swift` | The channel. Registers the `threeWsDrive` WebKit message handler, sends commands back with `evaluateJavaScript`, and owns the `AVAudioSession`. |
| `native/App/App/AppDelegate.swift` | Routes a `carTemplateApplication` scene session to `CarPlaySceneDelegate`. |
| `native/App/App/MainViewController.swift` | Attaches `DriveLink` to the Capacitor WebView on load. Inert until a CarPlay scene connects. |
| `native/App/App/Info.plist` | `UIApplicationSupportsMultipleScenes` is now `true` (CarPlay is a second scene), plus the `CPTemplateApplicationSceneSessionRoleApplication` configuration. |
| `native/App/App/App.entitlements` | `com.apple.developer.carplay-voice-based-conversation`. |
| `../../src/drive/bridge.js` | The web half of the same protocol. Change one side, change both. |

## The protocol

Version 1. The page posts to `window.webkit.messageHandlers.threeWsDrive`; every message
carries `{ v: 1, type }`.

| Page to car | Payload | Effect |
|---|---|---|
| `ready` | `{ agent: { id, name } }` | The agent's name becomes the list section header |
| `state` | `{ state }` (`idle`, `listening`, `transcribing`, `thinking`, `speaking`) | Presents, updates, or dismisses the voice template, and opens or closes the audio session |
| `heard` | `{ text }` | Last transcript, capped at 240 characters |
| `said` | `{ text }` | Last reply, capped at 500, shown as the Repeat row's detail |
| `error` | `{ code, message }` | Held for the next render |
| `actions` | `{ actions: [{ id, label, enabled }] }` | Up to four; rebuilds the list |

| Car to page | Effect |
|---|---|
| `talk-start` / `talk-stop` / `talk` | Begin, end, or toggle a listening turn |
| `hands` | Toggle hands free |
| `repeat` | Speak the last reply again |
| `hush` | Barge in and stop speaking |
| `say` (with `value`) | Send a turn as text |

## What Apple requires, and how this meets it

The voice category's rules are not style guidance; a build that misses one does not get
approved. Each is met in code, not by intention:

| Rule | Where |
|---|---|
| Voice is the primary modality on launch | `didConnect` sends `talk-start` immediately after setting the root template |
| No wake word | Nothing listens until a press or an explicit hands-free choice |
| Audio session open only while voice is in use | `DriveLink.syncAudioSession()` is driven by the page's own state and deactivates on `idle` |
| Template depth of three or less | One: a root list, with the voice template presented over it |
| The voice template accompanies active audio input | Presented on a non-idle state, dismissed the moment the turn ends |

## Getting the entitlement (owner action, nothing else is blocked)

1. Request it at <https://developer.apple.com/carplay/>, choosing the **voice-based
   conversational app** category. Apple reviews each request per app.
2. The request asks what the app does in the car. The honest answer is the pitch: a
   conversational assistant with a persistent identity, launched by hand, voice in and voice
   out, no navigation and no wake word.
3. On approval, enable the capability for bundle ID `ws.three.app` in the Developer portal
   and regenerate the provisioning profile. The entitlement key is already in
   `App.entitlements`, so no code changes.

Until then the key is harmless: a build signed without the grant simply never receives a
CarPlay scene, and the phone app behaves exactly as it does today.

## Testing it

Needs macOS with Xcode, so it cannot be done from this repo's Linux workspace.

- **Simulator:** run the app on an iOS simulator, then open Xcode's **I/O, External
  Displays, CarPlay** window. The CarPlay scene connects against the simulator without an
  entitlement grant, which is enough to exercise the templates, the message channel, and
  every state transition.
- **A real car or aftermarket head unit:** needs the granted entitlement and a provisioning
  profile that carries it.
- **The web half alone:** `npm run dev`, then open
  `http://localhost:3000/drive?surface=carplay`. With no native shell attached, every send is
  a no-op and `window.threeWsDrive.command({ type: 'repeat' })` in the console drives the
  page exactly as the Swift does.

## Review risk

Read [`REVIEW-RISK.md`](REVIEW-RISK.md) for the app's existing exposure. CarPlay adds two
items:

- **Category fit.** A conversational app that spends its time doing something other than
  conversing invites a rejection. `/drive` is voice in, voice out, four controls. It does not
  navigate, play media, or take payments on the car screen.
- **The keyboard.** Text entry exists on `/drive` for a parked car and a passenger, and it is
  hidden outright on the `carplay` surface preset because the WebView is on a phone in a
  mount. Do not "improve" that by exposing it: it is the single most obvious distraction
  finding available to a reviewer.
