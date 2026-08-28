# Shipping three.ws to the App Store

End-to-end, in the order the steps actually unblock each other. Everything
before "On a Mac" can be done from this repo on any machine; everything after
needs macOS with Xcode, because Apple's code signing and `altool` upload path
exist nowhere else.

Read [`REVIEW-RISK.md`](REVIEW-RISK.md) first. Step 1 is the long pole and does
not depend on any code, so start it the day this is decided.

## 1. Apple Developer Program, enrolled as an organization

Not as an individual. Apple only allows crypto wallet functionality from
organization accounts, and three.ws has wallets everywhere.

- $99/yr, renewed annually.
- Needs a legal entity and a **D-U-N-S number** for that entity. Look it up at
  Apple's D-U-N-S lookup tool first; if the entity has one, enrollment is
  typically days. If it does not, requesting one is the step that can take a
  week or more, and nothing else can absorb that delay.
- The person enrolling must have legal authority to bind the entity, or provide
  documentation of authorization.

Record the **Team ID** (10 characters) the moment it exists: everything in
step 3 is blocked on it.

## 2. App Store Connect setup

1. Create the app record. Bundle ID `ws.three.app`, matching
   `PRODUCT_BUNDLE_IDENTIFIER` in `native/App/App.xcodeproj/project.pbxproj`
   and the `appId` in `capacitor.config.ts`.
2. Register the bundle ID in the Developer portal with the **Associated
   Domains** and **Push Notifications** capabilities enabled; the app's
   entitlements declare both and signing fails without them.
3. Fill the listing from [`../publish/listing.md`](../publish/listing.md).
4. Answer the content rights, age rating, and privacy questionnaires. The
   privacy answers must match what the app actually collects; the camera,
   photos, location and identifiers sections all apply.

## 3. Wire the Team ID into production

```bash
gcloud run services update three-ws-api \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --update-env-vars APPLE_TEAM_ID=<team id>
```

`--update-env-vars` merges. Never `--set-env-vars`, which replaces the whole
environment.

Then verify Apple can read the association, because a wrong answer here fails
silently on device and links simply keep opening in Safari:

```bash
curl -sS -D- -o- https://three.ws/.well-known/apple-app-site-association
```

It must be `200`, `content-type: application/json`, **no redirect**, and the
`appIDs` entry must read `<team id>.ws.three.app`.

## 4. Build the web bundle

The app's WebView loads the deployed site, so "building the app" means the site
is deployed. The one build-time coupling is `src/native-bridge.js`, which is
injected into every page by the `three-ws-ios-native-bridge` plugin in
`vite.config.js`; a deploy that predates that plugin gives the app no native
behaviour at all. Confirm it landed:

```bash
grep -c native-bridge dist/create.html   # expect 1
```

Then sync the shell bundle into the Xcode project:

```bash
cd ios && npm install && npm run sync
```

## 5. On a Mac: archive, sign, upload

```bash
cd ios && npm run open        # opens native/App/App.xcodeproj
```

In Xcode:

1. Select the **App** target, Signing & Capabilities, choose the team. Confirm
   Associated Domains lists `applinks:three.ws` and Push Notifications is
   present; both come from `App/App.entitlements`.
2. Set the marketing version and build number. `MARKETING_VERSION` is `1.0`
   and `CURRENT_PROJECT_VERSION` is `1` in the project file; the build number
   must increase on every upload.
3. Replace the placeholder app icon in `App/Assets.xcassets` per
   [`ASSETS.md`](ASSETS.md). Xcode rejects an archive with a missing icon.
4. Product > Archive, then Distribute App > App Store Connect > Upload.

Capacitor 8 resolves its plugins through Swift Package Manager, so there is no
`.xcworkspace` and no CocoaPods step: `App.xcodeproj` is the whole project.

Headless alternative once signing is configured, for a Mac build machine or
Xcode Cloud:

```bash
xcodebuild -project native/App/App.xcodeproj -scheme App \
  -configuration Release -archivePath build/App.xcarchive archive
xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export
```

`ExportOptions.plist` does not exist yet; it needs the real team ID and
provisioning profile name, so it is written at the same time as step 1.

## 6. TestFlight, then review

- The first upload takes 15 to 60 minutes to finish processing before it is
  testable.
- Internal TestFlight testers need no review. External testers need a
  Beta App Review, usually a day.
- App Review itself is typically 24 to 48 hours for a first submission, and
  can be longer when a reviewer opens a question. Budget for at least one
  round trip: assume the first response is a question about the crypto
  surfaces and have the answer from [`REVIEW-RISK.md`](REVIEW-RISK.md) ready.

## Verification checklist before submitting

- [ ] `curl https://three.ws/.well-known/apple-app-site-association` returns a real association
- [ ] A shared `https://three.ws/viewer?src=...` link opens the app, not Safari
- [ ] Camera prompt appears on `/create/selfie` with the string from `Info.plist`
- [ ] Location prompt appears on `/irl`
- [ ] Share on an AR capture opens the system share sheet with the image attached
- [ ] Airplane mode at launch shows `shell/offline.html`, and it recovers by itself when the network returns
- [ ] An off-site link opens the Safari sheet and returns to the app
- [ ] Account deletion is reachable in-app (guideline 5.1.1)
- [ ] No white flash between launch screen and first paint
- [ ] Value-moving surfaces open in Safari, per `REVIEW-RISK.md`
