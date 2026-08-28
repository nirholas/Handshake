# "About you" answer for Play Console account creation

Play Console asks new developers to describe their Play Console and Android
experience during account setup. The field is private to the account holder and
is not part of any store listing.

Kept in git for the same reason as the rest of this directory: the answer should
be recoverable and accurate rather than retyped from memory, and every claim in
it is checkable against this repository.

## Paste this

> I have not used Play Console before. This is my first developer account, and
> the three.ws Android app will be my first Play submission.
>
> Android experience: I built a small Android app as a student, long before the
> current toolchain. My current Android work is three.ws (https://three.ws), an
> open-source platform for creating, animating and embedding 3D AI avatars. I
> built its Android app, package `ws.three.app`, as a Trusted Web Activity using
> Bubblewrap: a signed release APK and AAB, minSdk 23, targetSdk 36.
>
> That work covered the release keystore and a non-interactive signing pipeline,
> Digital Asset Links (live at https://three.ws/.well-known/assetlinks.json and
> confirmed through Google's digitalassetlinks statements API), long-press app
> shortcuts, an Android share-sheet target for images and .glb model files, a
> maskable adaptive icon, an offline shell, and web push via a service worker.
> I tested on a Pixel 7 emulator running Android 14: install and launch, shortcut
> registration through `dumpsys shortcut`, `ACTION_SEND` intent handling, and
> deep-link verification state through `pm get-app-links`.
>
> The same build is also prepared for the Solana dApp Store. The source is public:
> https://github.com/nirholas/three.ws, with the Android packaging under
> `/solana-mobile`.

## Why it is worded this way

- **"I have not used Play Console before" is stated first and plainly.** This
  field is not a pitch. Google uses it to calibrate the account, and an
  overstatement here is the kind of thing that surfaces later during developer
  verification.
- **No date is given for the first app.** The owner recalls it as roughly twenty
  years ago, which would predate the Android SDK. The claim is true without the
  number, so the number is left out rather than risk a wrong date on a form.
- **Every specific is verifiable.** The package name, the two SDK levels, the
  fingerprint URL and the emulator checks all resolve to something a reader can
  open. Nothing here describes work that is not in the repository.
- **No published-app claim.** Nothing has shipped to any store yet, so the answer
  says the Play submission will be the first.

## Update this when

The first release ships. Once `ws.three.app` is live on Play or the Solana dApp
Store, the honest answer changes from "prepared" to "published", and this file
should change with it.
