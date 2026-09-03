# `apple/`: the Agent glance widget for macOS and iOS

The three.ws agent on a Mac's Notification Centre and on an iPhone home screen,
plus the small Mac app that feeds it. One WidgetKit extension serves both
platforms from one set of sources; the only thing that differs is which project
builds it.

The Android counterpart is [`../solana-mobile/android-overlay/`](../solana-mobile/android-overlay/README.md)
and the Windows 11 one is the `widgets` member of the web manifest in
[`../vite.config.js`](../vite.config.js) driven by
[`../public/glance-sw.js`](../public/glance-sw.js). All four render the same
card from the same endpoint, which is the point: adding a surface here is a
rendering job, not a data job. The card's wire format is pinned in
[`../specs/GLANCE_CARD.md`](../specs/GLANCE_CARD.md) and the product
documentation is [`../docs/native-widgets.md`](../docs/native-widgets.md).

## Layout

```
apple/
├── GlanceKit/           # shared sources, compiled into every target
│   ├── GlanceConfig.swift      # origin, App Group and keychain group, from Info.plist
│   ├── GlanceCard.swift        # the card, its states, its sizes and themes
│   ├── GlanceTokenStore.swift  # the widget token, in the shared keychain
│   ├── GlanceCache.swift       # the last card downloaded, in the App Group container
│   ├── GlanceClient.swift      # GET /api/glance/mine?format=png
│   ├── GlanceLink.swift        # claims threews://glance/link?token=...
│   ├── GlanceEntry.swift       # one moment in the widget's timeline
│   ├── GlanceImage.swift       # PNG to SwiftUI Image, on either platform
│   └── GlanceCardView.swift    # the widget's ink, every state drawn
├── GlanceWidget/        # the extension target
│   ├── GlanceProvider.swift    # the TimelineProvider and its refresh policy
│   ├── AgentGlanceWidget.swift # the widget, its families, the bundle entry point
│   ├── Info.plist
│   └── GlanceWidget.entitlements
├── macos/               # the Mac host app
│   ├── project.yml             # XcodeGen spec: app + extension
│   └── ThreeWSGlance/          # SwiftUI window, menu bar companion, link model
└── scripts/make-macos-icon.mjs # the Mac app icon, derived from the brand mark
```

## Building the Mac app

```bash
brew install xcodegen                 # once
node apple/scripts/make-macos-icon.mjs   # regenerates the icon set from the brand mark
cd apple/macos && xcodegen generate && open ThreeWSGlance.xcodeproj
```

Set a **Development Team** on both targets in Signing and Capabilities (or pass
`DEVELOPMENT_TEAM=XXXXXXXXXX` to `xcodebuild`). Nothing else needs configuring:
the App Group, the keychain group and the origin are derived from it.

The project is generated rather than committed because a hand-maintained
`.xcodeproj` is a merge conflict waiting to happen and `project.yml` says what
the two targets actually are in a page anyone can read. Distribution is
Developer ID, so the Mac app can ship before the iOS one clears review.

## Building the iOS widget

Nothing extra. The extension is a target in the committed Capacitor project at
[`../ios/native/App/App.xcodeproj`](../ios/native/App), it compiles the same
`apple/GlanceKit` and `apple/GlanceWidget` sources by relative path, and
`npm run ios:open` opens it. `bubblewrap`-style regeneration does not apply
here: Capacitor generates that project once and never rewrites it, which is why
the iOS side is a committed target rather than an overlay applied at build time
the way Android's is.

The extension deploys to iOS 17 while the app deploys to iOS 16. That is
deliberate: WidgetKit's `containerBackground` and `contentMarginsDisabled` are
iOS 17, and a phone too old to run the extension simply never sees it in the
widget gallery, while the app keeps working exactly as it does today.

## The three build settings, and why they are not constants

`GlanceKit` reads its origin and its two container identifiers back out of the
running target's Info.plist. They cannot be hard coded because the platforms
disagree:

| Setting | iOS | macOS |
| --- | --- | --- |
| `GLANCE_ORIGIN` | `https://three.ws` | `https://three.ws` |
| `GLANCE_APP_GROUP` | `group.ws.three.app` | `$(DEVELOPMENT_TEAM).group.ws.three.glance` |
| `GLANCE_KEYCHAIN_GROUP` | `$(DEVELOPMENT_TEAM).ws.three.shared` | `$(DEVELOPMENT_TEAM).ws.three.shared` |

An App Group identifier on a Mac signed with a Developer ID has to carry the
team prefix; the same identifier on iPhone must not. Xcode expands these
settings into both the Info.plist and the entitlements, so one file reads them
at runtime and neither platform needs its own copy of anything.

If `DEVELOPMENT_TEAM` is unset the values expand to a leading dot, which
`GlanceConfig` treats as absent: the token goes to the target's own keychain and
the cache to its own container, so a single-target debug run still works and
nothing pretends to be shared that is not.

## How a device gets a token

The Mac never sees a password, and neither does the phone.

1. The owner opens [three.ws/glance](https://three.ws/glance) signed in and
   presses **Link this device**. The page mints a token against the session
   (`POST /api/glance/token`, same-site only) and gets back the plaintext once.
2. The page navigates to `links.apple`, which is
   `threews://glance/link?token=glw_…`. Both Apple apps register that scheme, so
   the operating system hands it to the app rather than to a browser.
3. `GlanceLink.claim` checks the token's shape before storing anything, writes
   it to the shared keychain, drops any cached card from a previous account, and
   reloads every widget timeline.
4. If nothing claimed the URL, which is what happens on a Mac whose browser is
   signed in on a different machine, the page also shows the code and the Mac
   app takes it pasted.

On iOS the URL is claimed in
[`SceneDelegate`](../ios/native/App/App/SceneDelegate.swift) before Capacitor
sees it, and `ios/src/native-bridge.js` drops `/glance/link` as well, so a live
token can never end up as a WebView navigation.

The token reads exactly one endpoint and exactly one thing, the owner's own
card. It is revoked from the same page, and a revoked token makes the widget
draw the "link again" card the server sends rather than an error.

## Verifying without a Mac

`npm run check:apple-widget` ([scripts/check-apple-widget.mjs](../scripts/check-apple-widget.mjs))
is what a Linux build machine can prove: that both projects are internally
consistent, that every Swift source is a member of the targets that need it,
that the plists only expand settings the projects define, and that the client
and `api/glance/mine.js` still agree on the endpoint, the query, the six headers,
the four states, the sizes, the scales and the token shape. It is wired into
`npm run gate`. It is a structural check, not a build: green means the wire and
the projects agree, not that the Swift compiles.

`npm run check:macos-icon` holds the Mac icon to the brand mark the same way
`check:ios-icons` holds the iPhone one.

## What runs when

| | Refresh | Offline | Tap |
| --- | --- | --- | --- |
| macOS and iOS | WidgetKit timeline, requested every 30 minutes, 15 after a failure | Last card from the App Group container, with the time it was fetched | `x-glance-url`: the agent's page, opened by the app on iPhone and by the browser on a Mac |
| Android | WorkManager, battery-aware, about every 30 minutes | Same, from internal storage | Same, in the app |
| Windows 11 | The manifest's `update: 900` | The board keeps the last payload | The route in the Adaptive Card |
