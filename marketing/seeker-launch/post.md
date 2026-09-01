# Seeker launch: the announcement

Two posts. The first is the announcement and carries the photo. The second is a
reply to it and explains the whole app. Nothing here is written to be read
without the picture: the photo is the proof, the copy is the caption.

Counts are X's arithmetic (a URL costs 23 characters however long it is, and a
newline costs one). Every claim below is drawn from the shipping listing copy in
[solana-mobile/publish/listing/](../../solana-mobile/publish/listing/) and
[docs/seeker-app.md](../../docs/seeker-app.md); nothing is promised that v1.0
does not do.

---

## The photo

One frame, held in the hand, outdoors, natural light. What has to be legible:

- the three.ws listing on the Solana dApp Store, on screen, in focus
- the phone read as a phone someone owns, not a product shot on a white sweep

What to avoid: a flat-on screenshot angle (that is what the store screenshots
are for), direct sun on the AMOLED, and a grip that covers the listing. Tilt the
top of the phone a few degrees away from the camera to kill the glare, expose
for the screen rather than the trees, and let the woods go soft behind it.

The setting is the strongest thing about this image. A crypto launch photo is
normally a desk, a monitor, and a mechanical keyboard. This one is a person, in
the woods, holding a phone that just got an app. Do not art-direct that out.

**Alt text** (paste into X's alt field, it is not optional):

```
A hand holding a Solana Seeker phone outdoors in a forest, with the three.ws listing open on the Solana dApp Store.
```

---

## Post 1: the announcement

Attach the photo here. No link in the body: the install instruction is the
call to action, and the explainer in post 2 carries the URL.

### Option A, plain and certain

```
three.ws is live on the Solana dApp Store.

Take a selfie. Get a rigged 3D agent. Give it a mind, a voice, and a wallet that never leaves your Seeker.

No extension. No twelve words to write down.

Open the dApp Store on your Seeker and search three.ws.
```

### Option B, leans on what it costs to try

```
three.ws is live on the Solana dApp Store.

Your phone is now a 3D agent studio. One selfie, one rigged character, one wallet that signs without ever handing over a key.

Free to make. Free to talk to. Yours on-chain when you decide it is.

Search three.ws on your Seeker.
```

Pick A if the photo is tight on the listing and the screen carries the story.
Pick B if the photo is wider and the copy has to do more work.

---

## Post 2: the explainer

A reply to post 1. Written as one long post; the threaded version underneath is
the fallback if you are posting without Premium.

```
What three.ws actually is, and why it belongs on this phone.

It is a 3D agent studio. Start with a selfie: one frontal photo, plus two optional side angles for a sharper likeness. About a minute later you have a textured, rigged, animation-ready character. No photo? Describe the character in text instead, or upload a GLB you already have.

Then give it a mind. A personality, a voice, skills. And talk to it. It answers in 3D, on your phone, in your language.

The marketplace is everyone else's work. Drag to orbit any agent, tap to inspect it, open its page and talk to it. Every agent has a shareable URL and a one-line embed, so it drops into Telegram, X, or your own site.

When an agent should be properly yours, you deploy it on-chain as a Metaplex Core asset held by your wallet. Open manifest, no lock-in, portable to any compatible marketplace. Sell its skills, take tips, trade the agent itself in USDC.

Here is the part that needed a Seeker.

Every signature routes to Seed Vault through Mobile Wallet Adapter. Sign-In With Solana is a single interaction instead of a connect step followed by a signing step, and the private key never enters the app process at all. It stays in the hardware-isolated secure element. Approve a session once and it survives Android killing the app; revoke it in the wallet and the app drops it cleanly and asks again next time.

Share a photo to three.ws from any app and it opens the selfie flow with that photo already attached. Share a .glb and it opens the upload flow. Long-press the icon for Create, Discover, My agents. Any three.ws link opens in the app instead of a browser tab.

Own a Seeker and you can prove it. The app reads your soulbound Seeker Genesis Token, never moves it, and puts a Seeker verified badge on every agent you own.

Creating, chatting and browsing are free. Deploying an agent on-chain costs whatever Solana charges, typically under 0.01 SOL.

And everything you make on the Seeker is on the web app the moment you sign in there. Same wallet, same library, any screen.

Open source, all of it: github.com/nirholas/three.ws
```

### Threaded fallback, if you are posting without Premium

Post 2 becomes replies 2 through 9, in order.

**2**

```
What three.ws actually is, and why it belongs on this phone.

It is a 3D agent studio. Start with a selfie: one frontal photo, two optional side angles for a sharper likeness. About a minute later you have a textured, rigged, animation-ready character.
```

**3**

```
No photo? Describe the character in text instead. Or upload a GLB you already have.

Then give it a mind. A personality, a voice, skills. And talk to it.

It answers in 3D, on your phone, in your language.
```

**4**

```
The marketplace is everyone else's work.

Drag to orbit any agent. Tap to inspect it. Open its page and talk to it.

Every agent has a shareable URL and a one-line embed, so it drops straight into Telegram, X, or your own site.
```

**5**

```
When an agent should be properly yours, you deploy it on-chain as a Metaplex Core asset held by your wallet.

Open manifest. No lock-in. Portable to any compatible marketplace.

Sell its skills, take tips, trade the agent itself in USDC.
```

**6**

```
Here is the part that needed a Seeker.

Every signature routes to Seed Vault through Mobile Wallet Adapter. Sign-In With Solana is one interaction, not connect-then-sign.

The private key never enters the app. It stays in the secure element.
```

**7**

```
Approve a session once and it survives Android killing the app. Revoke it in the wallet and the app drops it cleanly, then asks again next time.

That is the whole sign-in story. No extension, no seed phrase typed into a phone.
```

**8**

```
Share a photo to three.ws from any app: it opens the selfie flow with the photo attached. Share a .glb: it opens the upload flow.

Long-press the icon for Create, Discover, My agents.

Any three.ws link opens in the app, not a browser tab.
```

**9**

```
Own a Seeker and you can prove it. The app reads your soulbound Genesis Token, never moves it, and badges every agent you own.

Creating, chatting and browsing are free. Deploying on-chain is usually under 0.01 SOL.

Open source: github.com/nirholas/three.ws
```

---

## What was deliberately left out

- **The home screen widget.** Agent glance is version 1.1. What is on the store
  is 1.0, so announcing the widget today would be announcing something nobody
  can install yet. It is the natural second announcement once 1.1 is approved.
- **$THREE.** The announcement is stronger as a product post than as a coin
  post, and the audience that installs an app from a launch photo is not the
  audience that wants a ticker in the first line. If you want it in, it belongs
  as a short standalone reply at the end of the thread, never in post 1.
- **Version numbers and release IDs.** Nobody installing an app needs them.
