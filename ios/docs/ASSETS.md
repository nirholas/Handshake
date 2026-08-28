# iOS app assets

What Xcode and App Store Connect refuse to build or accept without. Sizes are
exact; Apple rejects a mismatched pixel dimension and an icon with an alpha
channel.

Source art lives with the rest of the brand marks in [`../../public/`](../../public):
`pwa-icon.svg` is the vector master, and `pwa-maskable-512x512.png` shows the
safe-zone framing the Android app uses.

## App icon

Xcode 15+ takes a single 1024x1024 PNG and derives the rest.

| Slot | Size | Rules |
|---|---|---|
| App Store / universal | 1024x1024 | **No alpha channel**, no transparency, no rounded corners. iOS applies the mask. sRGB. |

Optional and worth doing, since the product is dark-only: supply the dark and
tinted variants in the same asset set so the icon does not glare on a dark home
screen.

Drop it into `native/App/App/Assets.xcassets/AppIcon.appiconset/`. Capacitor's
template icon is what is there now, and an archive with it will upload but must
not ship.

## Launch screen

`native/App/App/Base.lproj/LaunchScreen.storyboard`. It should be the brand mark
on `#080814`, matching `backgroundColor` in `capacitor.config.ts` and the
`--bg` in `shell/offline.html`. Any mismatch reads as a flash.

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
