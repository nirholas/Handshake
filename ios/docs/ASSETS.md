# iOS app assets

What Xcode and App Store Connect refuse to build or accept without. Sizes are
exact; Apple rejects a mismatched pixel dimension and an icon with an alpha
channel.

**The icon and launch images are generated, not hand-exported.**

```bash
npm run ios:icons        # re-derive everything from the brand mark
npm run check:ios-icons  # verify the committed assets still match (runs in `npm run gate`)
```

[`../scripts/make-icons.mjs`](../scripts/make-icons.mjs) composites
`public/pwa-512x512.png` (the chrome wireframe cube the web and Android apps
also use) onto the product's own background, the same
`radial-gradient(120% 80% at 50% 0%, #16163a, #080814)` painted by
`ios/shell/offline.html` and `capacitor.config.ts`, so the icon, the launch
screen and the app's first frame are one colour. The mark ships with
transparency, which iOS forbids in an icon, and compositing rather than
flattening is what removes it without a white halo.

Editing a generated PNG by hand is caught by the `check:ios-icons` guard rather
than discovered a release later. Change the mark, not the output.

## App icon

Xcode 15+ takes a single 1024x1024 PNG and derives the rest.

| Slot | Size | Rules |
|---|---|---|
| App Store / universal | 1024x1024 | **No alpha channel**, no transparency, no rounded corners. iOS applies the mask. sRGB. |

Generated into `native/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
at 82% coverage: full-bleed, not the Android maskable framing, because iOS
applies only a squircle corner radius and the ~20% inset a circle crop needs
would leave the icon looking small beside every other app on the home screen.

Still worth adding by hand, since the product is dark-only: the dark and tinted
icon variants in the same asset set, so the mark does not glare on a dark home
screen.

## Launch screen

`native/App/App/Base.lproj/LaunchScreen.storyboard`, which renders the generated
`Splash.imageset`. The mark sits at 18% of a 2732 square that Capacitor scales
to fill, on the same background as `capacitor.config.ts` `ios.backgroundColor`,
`MainViewController.swift` and `shell/offline.html`. Any mismatch between those
four reads as a flash between the launch screen and the first frame.

The launch screen is static by definition: no logic, no network, no text that
needs localizing.

## Screenshots

Required for the listing. App Store Connect accepts one set and scales it to
the other sizes, so produce the largest:

| Device class | Size (portrait) | Count |
|---|---|---|
| iPhone 6.9" (15/16 Pro Max) | 1320x2868 | 3 to 10 |
| iPad Pro 13" (only if the listing includes iPad) | 2064x2752 | 3 to 10 |

Capture on a real device, not the simulator: the AR and camera surfaces are the
most convincing frames in the set and the simulator cannot produce them. A
strong order is `/create` mid-generation, the finished avatar in the viewer, an
agent placed in a real room via `/ar/studio`, `/irl` discovery, and a profile.

## App preview video (optional)

15 to 30 seconds, same resolutions as the screenshots, captured on device. The
AR placement flow is the obvious subject.

## Metadata art

None. Unlike the Solana dApp Store, App Store Connect has no banner or feature
graphic; the icon and screenshots are the whole visual listing.
