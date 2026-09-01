# Filming three.ws on a Seeker without a Seeker

You do not need the phone to make a Seeker screen recording of three.ws, and you should not buy a
generic Android phone to fake one. This page explains why, and gives the two capture paths that
produce real footage: one for the app itself, one for the Android surfaces around it.

## Why no device is needed for the app

`ws.three.app` is a Trusted Web Activity. The APK is a full-screen shell with no browser chrome, and
everything inside it is `https://three.ws/seeker` rendered by Chrome's engine on the phone. There is
no second, native UI that only the hardware can draw. So a browser rendering that page at the
Seeker's real panel geometry produces the same pixels the Seeker does. That is a capture of the
shipping product, not a re-creation of it.

The Seeker panel is a 6.36" AMOLED at 1200x2670 (about 460 ppi), which Android reports to the page
as a 400x890 CSS viewport at device pixel ratio 3. Those are the numbers
[make-screencast.mjs](../solana-mobile/scripts/make-screencast.mjs) captures at, and they are the
same numbers behind the store screenshots in
[make-screenshots.mjs](../solana-mobile/scripts/make-screenshots.mjs).

What a browser capture cannot show, because it genuinely is not part of the app: the Android status
bar, the launcher and the app-open animation, the system share sheet, the Seed Vault approval sheet,
and the dApp Store install. Those are system surfaces. Capture them in an emulator (below) and cut
them around the app footage. Do not draw them.

## Path 1: the app itself

```bash
node solana-mobile/scripts/make-screencast.mjs
```

Two files land in `marketing/seeker-video/`:

| File | Size | What it is |
|---|---|---|
| `seeker-screen.mp4` | 1200x2670 | The bare panel, for dropping into your own edit or device frame |
| `seeker-device.mp4` | 1080x1920 | The same panel seated in a Seeker-proportioned body on the three.ws backdrop, ready to post |

The tour is scripted in the `TOUR` constant at the top of the script: the hero and the Seed Vault
sign-in, the agents rail, the Seeker verification card, then back to the top. Every selector in it
resolves on the live page, and a step whose target is missing fails the run rather than quietly
recording a still frame. Edit that array to change the story.

It stays on `/seeker` deliberately. That is the screen the app opens to and the only one composed
for this aspect ratio. Continuing into the marketplace was tried and cut: the filter panel opens
over the top half of the page, the corner stack (onboarding pill, language picker, claim card)
lands on top of the grid, and its Connect Wallet button contradicts the Seed Vault story the rest
of the video tells. Any page you add to the tour needs the same look before it earns a place.

Useful flags:

- `--origin=http://localhost:3000` records against a dev server instead of production.
- `--authed` replays the QA session so the signed-in state is on screen. Mint the session first with
  `npm run audit:web:login`; it writes the `.auth/audit-state.json` this reads.
- `--out=<dir>` writes somewhere other than `marketing/seeker-video/`.

Frames are stepped rather than recorded in real time. Playwright's video recorder ignores
`deviceScaleFactor`: ask it for a 1200x2670 video of a 400x890 CSS viewport and it draws the page
at 400x890 in the corner and pads the rest grey. Screenshots do honour the scale factor, so the
script advances the tour one output frame at a time and captures each at full device resolution.
Capture time is then decoupled from playback time, and a rerun of the same tour gives the same
video.

That needs `ffmpeg` on `PATH` (`sudo apt-get install -y ffmpeg`) to assemble the frames. Playwright
ships its own ffmpeg, but that build is VP8-only with no filters, so it can do neither the H.264
encode nor the device compositing.

## Path 2: the Android surfaces around the app

For the launcher tap, the status bar, the share sheet, and an end-to-end Seed Vault sign-in, run the
signed APK in a stock Android emulator and record that. This is the same setup the app's QA uses.

1. `bash solana-mobile/scripts/setup-android-sdk.sh` stages a JDK 17 and the Android command-line
   tools under `~/.bubblewrap`. Add the emulator and a system image to it with
   `sdkmanager 'emulator' 'system-images;android-34;google_apis;x86_64'`.
2. On a machine without KVM group access, `sudo chgrp kvm /dev/kvm && sudo chmod 660 /dev/kvm` (or
   the equivalent for your host). Without hardware acceleration the emulator is too slow to record.
3. Create a device close to the Seeker's proportions. A Pixel 7 profile with `hw.lcd.width=1200`,
   `hw.lcd.height=2670`, `hw.lcd.density=460` matches the panel; the AVD at `~/.android/avd/seeker`
   already carries this shape.
4. Install the release APK: `adb install -r solana-mobile/build/app-release-signed.apk`.
5. For wallet flows, sideload Solana Mobile's **Seed Vault Simulator** from
   [solana-mobile/seed-vault-sdk](https://github.com/solana-mobile/seed-vault-sdk). It implements the
   Wallet API on any Android 12+ image, so Mobile Wallet Adapter sign-in works end to end in the
   emulator. It is a development tool with no security guarantees: use throwaway test seeds only,
   never a real one.
6. Record with `adb shell screenrecord --bit-rate 16000000 /sdcard/take.mp4`, then
   `adb pull /sdcard/take.mp4`.

The emulator's own frame rate is not good enough to carry a whole marketing video. Use it for the
few seconds of system chrome and let Path 1 carry the app.

## Why not just buy an Android phone

A phone that is not a Seeker gives you a recording of a phone that is not a Seeker. It has no Seed
Vault, no dApp Store, no Seeker Genesis Token, and a different panel shape, so every Seeker-specific
moment in the video would still have to come from somewhere else. It costs money and removes none of
the work. Buy a Seeker if you want a Seeker; otherwise use the two paths above.

## Related

- [three.ws on Solana Seeker](./seeker-app.md) - what the app adds over the website
- [Publishing to the Solana dApp Store](./seeker-publishing.md) - how a release ships
- [solana-mobile/README.md](../solana-mobile/README.md) - the packaging and code layout
