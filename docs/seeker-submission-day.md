# Submission day: getting three.ws onto the Seeker dApp Store

Everything the owner personally needs to do on submission day, in order, with every value inlined so you never have to open a file or a terminal. Budget about 90 minutes, most of it waiting on uploads and the phone.

The engineering runbook is [Publishing to the Solana dApp Store](./seeker-publishing.md); this page is the human half of it. Tick boxes as you go.

## Before you start

Status as of 2026-08-28: publisher profile and KYB **Approved**, signed APK built, release key backed up, and the site verified so the app runs full-screen. What is left is this page.

- [ ] A laptop with the Publisher Portal open: <https://publish.solanamobile.com>
- [ ] Your publisher wallet in a browser extension (Phantom, Solflare, or Backpack)
- [ ] **0.25 SOL** in that wallet. The App NFT, the release NFT, and the ArDrive uploads come out of it; 0.2 is the floor, so leave headroom.
- [ ] Your Seeker, charged, signed into Seed Vault, on wifi
- [ ] A password manager entry ready for the API key you are about to create

If the portal's Sumsub panel still reads "business verification is in progress" while the **Status** field reads **Approved**, go by the Status field: that is what gates minting. Only if a step actually refuses is the banner worth waiting on.

Already done, nothing to redo: publisher profile and KYB (Approved 2026-08-27), the signed APK, the release key, and the site side (`three.ws` is verified for the app, so it runs full-screen).

---

## Step 1. Fund the publisher wallet

In the portal, connect the wallet you want to own this listing forever. Every future release is signed by it, so use a wallet you control long-term, not a burner.

- [ ] Wallet connected in the portal (as of 2026-08-28 this is the Phantom wallet ending `krgd`)
- [ ] Balance shows at least 0.2 SOL
- [ ] Storage provider set to **ArDrive** (the recommended default)

---

## Step 2. Add the dApp

**Add a dApp → New Dapp.** Not "Import Dapp": that one is for an app whose Publisher and App NFTs already exist on-chain, from the retired CLI flow. three.ws has never minted those, so there is nothing to import and New Dapp mints the App NFT fresh.

Paste each value below exactly.

**Basics**

| Field | Value |
|---|---|
| App name | `three.ws` |
| Android package | `ws.three.app` |
| Website | `https://three.ws` |
| Privacy policy | `https://three.ws/legal/privacy` |
| License / EULA | `https://three.ws/legal/eula` |
| Copyright | `https://three.ws/legal` |
| Support email | `support@three.ws` |

**Short description** (one line)

```
Mint a 3D agent to your Seed Vault. On-chain, Solana-native, signed by Seeker.
```

**Long description**

```
three.ws turns your Seeker into a 3D agent studio.

Take a selfie, get a rigged 3D avatar, give it a voice and a personality, and put it on-chain in a wallet that never leaves the Seeker's secure element. Every signature happens inside Seed Vault; keys never touch the app layer.

WHAT YOU CAN DO

• Create from a selfie. One frontal photo (two optional side angles sharpen the likeness) becomes a textured, rigged, animation-ready avatar in about a minute. No photo? Describe the character in text, or upload a GLB you already have.
• Give it a mind. Attach a personality, a voice, and skills, then talk to it. Your agent answers in 3D, on your phone, in your language.
• Discover. Browse agents from the whole community in the marketplace: drag to orbit, tap to inspect, open any agent's page to chat with it.
• Own it on-chain. Deploy an agent as a Metaplex Core asset on Solana, held by your wallet. Sell skills, take tips, and trade agents with USDC.
• Embed anywhere. Every agent has a shareable URL and a one-line embed snippet for Telegram, X, or your own site.
• Sign with Seed Vault. Wallet linking, transaction approval, and Sign-In With Solana all route through Mobile Wallet Adapter. No seed phrases, no browser extensions.

WHY SEEKER

three.ws talks to the Seeker's on-device wallet through the Mobile Wallet Adapter protocol, so signing lives inside the hardware-isolated secure element and sign-in is a single tap. The agents you create on Seeker show up on the three.ws web app the moment you sign in there: your wallet, your library, anywhere you sign in.

OPEN BY DEFAULT

three.ws is open source (github.com/nirholas/three.ws). Agents are Metaplex Core assets on Solana with an open manifest, so they are portable to any compatible marketplace or wallet. No vendor lock-in.

REQUIREMENTS

• A Solana wallet: Seed Vault on Seeker or Saga.
• Camera permission (only for selfie capture; you can upload a photo instead).
• A small amount of SOL to deploy an agent on-chain (typically under 0.01 SOL). Creating, chatting, and browsing are free.

SUPPORT

Questions, bug reports, or feature requests: support@three.ws · https://three.ws/docs · github.com/nirholas/three.ws/issues
```

**What's new in this version**

```
First Seeker release of three.ws.

• One-tap Sign-In With Solana through Seed Vault (Mobile Wallet Adapter).
• Selfie to rigged 3D avatar, captured with the on-device camera.
• Deploy an agent on-chain as a Metaplex Core asset held by your wallet.
• Marketplace of community agents, each with a live 3D viewer and chat.
• Embed any agent in Telegram, X, or your own site with one URL.

Built for Seeker. Signed by Seed Vault. Seed phrases never leave the secure element.
```

**Testing instructions for the reviewer** (paste as-is; reviewers follow this literally)

```
1. Open the app on a Seeker or Saga. It launches full-screen into three.ws.
2. Long-press the app icon: the Create, Discover, and My agents shortcuts
   open /create, /marketplace, and /my-agents inside the app.
3. Tap "Sign in with Seed Vault" in the top bar. A single Seed Vault sheet
   appears (Sign-In With Solana). Approve. The bar shows your shortened
   address; the app is signed in via POST /api/auth/siws/verify.
4. Discover: /marketplace loads the agent grid from
   /api/marketplace/agents. Tap an agent to open its page; the 3D viewer
   renders it in WebGL. Drag to orbit.
5. Create: /create/selfie asks for camera permission, captures one frontal
   selfie (left and right angles optional), uploads to
   /api/avatars/reconstruct, and polls /api/avatars/regenerate-status
   until the rigged avatar is ready (about 90 seconds).
6. On-chain: from an agent you own, "Deploy on Solana" mints a Metaplex
   Core asset to the connected wallet. Fund it with at least 0.01 SOL on
   mainnet first; the Seed Vault sheet approves the transaction.
No off-chain test accounts are required: auth is wallet-only.
```

**Images.** Three are ready to upload from the repo at `solana-mobile/publish/media/`:

| Upload slot | File | Size |
|---|---|---|
| App icon (512x512) | `icon.png` | 344 KB |
| Banner (1200x600) | `banner.png` | 72 KB |
| Feature graphic (1024x500) | `feature.png` | 170 KB |

Screenshots are Step 3. If the portal will not let you save without them, do Step 3 first and come back.

- [ ] Every field above pasted
- [ ] Three images uploaded
- [ ] Saved, and the **App NFT minted** (you will approve one wallet transaction)

---

## Step 3. Five screenshots, on the Seeker

This is the only part nothing can do for you: reviewers reject emulator and desktop captures, and they can tell.

**Set up once:** Settings → Display → turn on gesture navigation, so the screenshots have no navigation bar across the bottom. Then open the three.ws app; it launches full-screen onto its home screen.

Capture with Power + Volume-Down. Five frames, 1080x1920 each:

| # | Screen | How to get there |
|---|---|---|
| 1 | The home screen | Open the app. Capture the hero with "Sign in with Seed Vault" and the Create cards. |
| 2 | Marketplace | Tap **Marketplace**. Wait for the agent grid to fill in. |
| 3 | An agent with the 3D viewer | Tap any agent. Wait for the model to render, drag once to a good angle. |
| 4 | The Seed Vault sheet | Tap **Sign in with Seed Vault**. Capture the sheet while it shows `three.ws` and a non-empty `Nonce:` line. |
| 5 | Selfie capture | Tap **Selfie to avatar**, allow the camera, and capture the capture screen (or the finished avatar). |

Rules that get listings rejected if broken: no placeholder or mocked UI, no other company's branding in frame, no notification shade pulled down, nothing personal in the status bar.

- [ ] Five PNGs, 1080x1920, on the phone
- [ ] Transferred to the laptop
- [ ] Uploaded to the portal listing in this order

While you have the phone in hand, confirm these four (they are the last unchecked boxes in the submission checklist):

- [ ] The app opens full-screen with no browser address bar
- [ ] Sign-in shows **one** Seed Vault sheet, not connect-then-sign
- [ ] Long-pressing the icon offers Create / Discover / My agents
- [ ] Share a photo from Photos into three.ws and confirm it opens the selfie flow with the photo attached

---

## Step 4. Create the API key

Portal → **Settings → API Keys → create**.

- [ ] Key created
- [ ] Saved in your password manager (it never goes in the repo, and it is shown once)

---

## Step 5. Submit

Hand me the API key and say "submit the Seeker release" and I run it. Or do it yourself from the repo:

```bash
cd solana-mobile
gcloud secrets versions access latest --secret three-ws-seeker-release-keystore \
  --project aerial-vehicle-466722-p5 | base64 -d > android.keystore
export SOLANA_MOBILE_KEYSTORE_PASSWORD="$(gcloud secrets versions access latest \
  --secret three-ws-seeker-keystore-password --project aerial-vehicle-466722-p5)"
KEYSTORE_PASSWORD="$SOLANA_MOBILE_KEYSTORE_PASSWORD" ACCEPT_ANDROID_SDK_LICENSES=1 \
  ./scripts/build-apk.sh
SOLANA_KEYPAIR=~/.config/solana/publisher.json \
DAPP_STORE_API_KEY='<the key from Step 4>' \
./scripts/publish.sh
```

The APK being submitted is `three.ws` **1.0.0**, versionCode **1**, package `ws.three.app`, 4.1 MB.

- [ ] Submitted, and the portal shows the release as pending review

---

## After you submit

Review results arrive by email from `publishersupport@dappstore.solanamobile.com` in **3 to 5 business days**. The portal dashboard shows status meanwhile.

On approval:

- [ ] Open the public listing and check all five screenshots and the feature graphic render
- [ ] Tell me, and I will add the changelog entry announcing it to holders

## If something goes wrong

| What you see | What it means |
|---|---|
| Portal rejects the APK's package name | It expects `ws.three.app`. Do not change it; it is baked into the signing identity. |
| "versionCode already used" | Only on a second release. Tell me and I bump it. |
| The app shows a browser address bar | Digital Asset Links did not verify. Tell me; it is a site-side fix, not a rebuild. |
| Upload dies part way | Resume it rather than restarting: `npx --no-install dapp-store resume --release-id <id>` |
| Anything else | Send me the exact error text and I will pick it up. |
