# "About you" answer for Play Console account creation

Play Console asks new developers to describe their Play Console and Android
experience during account setup. The field is private to the account holder and
is not part of any store listing.

Kept in git for the same reason as the rest of this directory: the answer should
be recoverable and accurate rather than retyped from memory, and every claim in
it is checkable against this repository.

## Paste this

> Android experience: I build and ship the Android app for three.ws
> (https://three.ws), an open-source platform for creating, animating and
> embedding 3D AI avatars. The app, package `ws.three.app`, is a Trusted Web
> Activity built with Bubblewrap: signed release APK and AAB, minSdk 23,
> targetSdk 36.
>
> I set up the release keystore and a non-interactive signing pipeline, Digital
> Asset Links (live at https://three.ws/.well-known/assetlinks.json, confirmed
> through Google's digitalassetlinks statements API), long-press app shortcuts,
> an Android share-sheet target for images and .glb model files, a maskable
> adaptive icon, an offline shell, and web push through a service worker. QA on a
> Pixel 7 emulator running Android 14 covered install and launch, shortcut
> registration through `dumpsys shortcut`, `ACTION_SEND` intent handling, and
> deep-link verification state through `pm get-app-links`. Source is public:
> https://github.com/nirholas/three.ws, with the Android packaging under
> `/solana-mobile`.
>
> I also built an Android app as a student, long before the current toolchain.
>
> Play Console: this is my first developer account, and three.ws will be my first
> Play submission. The same build is already prepared for the Solana dApp Store.

## Why it is worded this way

- **The Android work leads; the Play Console answer closes.** Both are stated
  plainly, but opening with the disclaimer buried real experience behind it.
  Order is presentation. The facts do not move.
- **Do not claim prior Play Console use.** It is tempting and it is strictly the
  worst option available. The field is private and gates nothing, Google can
  already see whether this identity has held an account, and registration
  accuracy is a termination condition in the Developer Distribution Agreement.
  That bet risks the account to improve a text box only the owner ever reads.
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
