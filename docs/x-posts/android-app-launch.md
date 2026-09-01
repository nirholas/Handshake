# Announcement: the three.ws Android app

**What this announces.** three.ws now installs as a real Android app. The signed APK is
public at [`v1.0.0`](https://github.com/nirholas/three.ws/releases/tag/v1.0.0) and the
Solana dApp Store listing was submitted on 2026-08-28 and is in review.

**Two beats, deliberately.** This is beat one: the app exists and anyone can install it
today. Beat two is "live on the Solana dApp Store", and it waits for approval. Spending
both on one post wastes the bigger headline, and claiming a store listing that is still in
review is the kind of line that ages badly in public.

**Verified true when written (2026-08-28):**

- The APK is signed, public, and 3.95 MB: `ws.three.app`, versionCode 1, SHA-256
  `b83d9ab5…3c6945`. Installed and exercised on a physical Android phone by the owner.
- Its signing fingerprint is served at `https://three.ws/.well-known/assetlinks.json`,
  which is what makes the app open full-screen with no browser address bar.
- minSdk 23, so it installs on any phone from Android 6 up.
- dApp Store release `#331044442814` is In Review, submitted 2026-08-28.
- `/seeker`, `/changelog`, and `/marketplace` all answer 200.
- three.ws is open source under Apache 2.0.

**Do not claim:**

- "Available on the Solana dApp Store." It is in review. Say submitted, or say nothing.
- Seed Vault as the sign-in on a general Android phone. Seed Vault is Seeker and Saga
  hardware. On every other Android the same tap reaches whatever Solana wallet is
  installed, through Mobile Wallet Adapter. Both are true; write the one that matches the
  audience, and never imply a normal phone has a secure element it does not have.
- A date for dApp Store approval. Nobody controls that.

## Telegram (@three_ws)

```
three.ws is an Android app now.

Install it from GitHub and it opens full-screen, no browser, no address bar:
github.com/nirholas/three.ws/releases/tag/v1.0.0

What the app adds over the website:

- Sign in with one tap through your Solana wallet. On a Seeker that tap is Seed
  Vault, and the key never leaves the secure element.
- Point the phone camera at yourself and get back a rigged, animated 3D avatar.
- Share a photo into three.ws from any app and it lands in the avatar flow already
  attached.
- Mint an agent on Solana mainnet from the phone.

3.95 MB, Android 6 and up, open source. The Solana dApp Store listing is in review.
```

## The four images

The artwork and the X copy live in [`../../marketing/android-launch/`](../../marketing/android-launch/). X changed its four-image layout on 2026-08-28 from a 2x2 collage to a swipe carousel that shows one image at a time in a cell of about 1.18:1, center-cropped, so there are two renders of the same scene:

- **The strip (current).** `npm run build:x-strip` draws one 4800x1020 scene and cuts it into four 1200x1020 tiles in `kit/strip/`, the cell's own shape, so nothing is cropped and swiping reads as one continuous picture.
- **The grid (kept in case X brings the collage back).** `npm run build:x-grid` draws one 4096x2304 composition and quarters it into `kit/images/`: every quadrant of a 16:9 rectangle is itself 16:9, so a 2x2 collage reassembles into the picture that was drawn. The headline is set as two halves that meet at the vertical seam with a word space at the cut, every phone sits wholly inside one tile, and the render refuses to write tiles whose outer border or seams are brighter than X's black timeline allows. The uncut master also becomes `kit/cmc-cover-640x360.png`, the CoinMarketCap article cover.

**Attach the tiles in the order in [`kit/IMAGE-ORDER.md`](../../marketing/android-launch/kit/IMAGE-ORDER.md).** X lays the images out in attachment order, and any other order scrambles the scene. The full thread, per-image alt text, and the follow-up replies are in [`kit/post.md`](../../marketing/android-launch/kit/post.md).

## X (@trythreews), held until the account is restored

Do not post this while `@trythreews` is suspended; see
[`../x-account-appeal.md`](../x-account-appeal.md). It is written and ready for the day the
appeal lands.

```
three.ws is an Android app.

Install it, and it opens full-screen with no browser around it. Sign in with one tap
through your wallet. Take one selfie, get a rigged 3D avatar back. Mint it on Solana
from the phone.

3.95 MB. Open source. Solana dApp Store listing in review.

github.com/nirholas/three.ws/releases/tag/v1.0.0
```

Count: 331 characters (the URL counts as 23); needs Premium, which `@trythreews` has.

## When the dApp Store approves

Beat two gets its own post and its own changelog entry: the listing link, the five-panel
carousel from `solana-mobile/publish/media/`, and the line this post is not allowed to use.
The checklist item is in [`../../solana-mobile/docs/CHECKLIST.md`](../../solana-mobile/docs/CHECKLIST.md).
