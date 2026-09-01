---
venue: AWS Builder Center
account: three.ws (official organization account, @threews)
suggested_title: "One web product, three native apps, zero forks: how three.ws shipped to the Solana Seeker, Android, and iPhone"
suggested_description: "How an open-source WebGL platform for 3D AI agents became three store apps without forking its codebase: a Trusted Web Activity, a Capacitor shell, a native layer that ships with the site, hardware-backed wallet signing, and a home screen widget that outlives every session. All real source you can read."
suggested_tags: [mobile, agentic-ai, blockchain, open-source, javascript]
suggested_canonical: https://three.ws/docs/mobile-launch/aws-builder-center-article.md
status: draft, owner approval required before publishing (external-channel gate in CLAUDE.md)
---

# One web product, three native apps, zero forks: how three.ws shipped to the Solana Seeker, Android, and iPhone

three.ws is an open-source platform that gives an AI agent a 3D body, an on-chain identity, a wallet, and a way to get paid. It is a WebGL product: three.js renders a rigged, animated character in the browser, an LLM drives it, and the whole thing embeds anywhere with one web component. For five months it lived in a browser tab. It is now three native apps: one on the Solana dApp Store for the Seeker phone, one on Google Play for every Android device, and one on the App Store for iPhone.

This is the engineering story of that launch, written for builders who have a web product and are being asked "when is the app coming?" It covers the constraint that ruled out the obvious answer, the shape we chose instead, and the six pieces of native behaviour that turned a full-screen web view into something a store reviewer and a user both recognise as an app. Every code sample is real source from [the repository](https://github.com/nirholas/three.ws); nothing here is aspirational.

It also covers, honestly, where AWS fits. The API runs on Google Cloud Run. Storage goes through the AWS SDK for JavaScript v3 against an S3-compatible store. The AWS Marketplace integration is the enterprise front door to the same API these apps consume. We are an AWS Partner and we write here because this is where AWS builders go to check whether an integration is real.

## Why we built it at all

Before the architecture, the reason. three.ws exists because every AI product of the last three years is a text box, and humans do not experience presence through text. We experience it through faces, posture, gaze. So the platform gives the AI a body: a real rigged character with fifty-two facial blendshapes, generated from a selfie or a sentence, animated on any skeleton, renderable in a browser, in a web component, or standing on your floor in AR.

Once you decide the AI has a body, mobile is not a channel. It is where the inputs live. The camera that takes the selfie is on the phone. The wallet is on the phone. The share sheet is on the phone. The AR camera and the GPS are on the phone. The home screen, where a widget can show you your agent's day without opening anything, is on the phone. A desktop browser can render the product; it cannot take the selfie, walk into the room, or sign without an extension.

And the on-chain layer is there because an agent that lives only in someone's SaaS dashboard cannot be verified at a distance, cannot outlive the vendor, and cannot transact without a human holding keys. A public ledger gives it a stable identity, an owner, a wallet, and a signed history. On Solana that is a Metaplex Core asset; on EVM chains it is an ERC-8004 token at one deterministic CREATE2 address on twelve mainnets. Payments settle over x402, HTTP 402 revived as a machine-to-machine rail, in USDC, with no API key and no human in the loop.

That is the product. Now the constraint.

## The constraint that ruled out a "real" native app

The obvious answer to "build the app" is to bake the built `dist/` into a binary and serve it from a local origin. We could not do that, for a reason that is worth stating precisely because it applies to most serious web products.

There are 733 call sites in `src/` that fetch same-origin `/api/...` paths. The session cookie, the OAuth callbacks, and the x402 payment headers are all issued for the `three.ws` origin. Rewriting every one of them behind an API base URL, and then teaching the auth server, the payment facilitator, and the wallet redirects about a second origin, is a larger and riskier change than shipping the app, and it forks the web and app code paths permanently. Every future feature would ship twice.

So the rule became: the app is a shell around the live product, and the native layer is everything the web cannot do. On Android that shell is a Trusted Web Activity. On iOS it is a Capacitor 8 container whose WKWebView loads `https://three.ws`. On desktop it is the installed PWA. One codebase, one deploy, three stores.

The consequence we like most: app behaviour ships on a web deploy, not a store release. The consequence to design around: an old web deploy means an app with no native behaviour. It degrades to a plain WebView rather than breaking, but the shims are simply absent, so the native layer has to be written as progressive enhancement, keyed off a signal that exists only inside the app.

On iOS that signal is `window.Capacitor`, which Capacitor injects into the remote page at document start. The bridge module ships with the site and is a no-op in every browser:

```js
export function isNativeIOS() {
	const cap = globalThis.Capacitor;
	return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}
```

On Android the equivalent probe is whether the page is running inside the TWA and whether Mobile Wallet Adapter is available. Everything below hangs off those two checks.

## Piece 1: a wallet whose key never enters the process

The Seeker is a Solana phone with a hardware-isolated secure element, the Seed Vault. Inside the app, the browser does not inject `window.solana` the way an extension would. Signing has to be delegated to the Seed Vault over the Mobile Wallet Adapter protocol.

The existing three.ws wallet code was written against the injected-provider shape (`connect()`, `signMessage()`, `signTransaction()`), and we did not want to touch it. So the MWA wrapper exposes that same shape and is installed at `window.threeWsWallet` only when the page is inside the TWA:

```js
async connect({ onlyIfTrusted = false } = {}) {
	if (this.isConnected) return { publicKey: this.#publicKey };
	if (this.#connecting) return this.#connecting;

	this.#connecting = (async () => {
		const transact = await loadTransact();
		const authToken = this.#authToken;
		const onlyResume = onlyIfTrusted && Boolean(authToken);
		if (onlyIfTrusted && !authToken) {
			const err = new Error('No prior MWA session to resume');
			err.code = 4001;
			throw err;
		}
		try {
			await transact(async (wallet) => {
				const result = authToken
					? await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY })
					: await wallet.authorize({
						identity: APP_IDENTITY,
						chain: this.#chain,
						features: ['solana:signTransactions', 'solana:signMessages'],
					});
				this.#applyAuthResult(result);
			});
		} catch (err) {
			if (onlyResume) {
				this.#reset();
			}
			throw normalizeMwaError(err);
		}
		return { publicKey: this.#publicKey };
	})();

	try {
		return await this.#connecting;
	} finally {
		this.#connecting = null;
	}
}
```

Three decisions in that function are the difference between a demo and an app.

**The auth token is persisted in `localStorage`, not `sessionStorage`.** Android kills a backgrounded TWA process freely, and `sessionStorage` dies with it. Our first build prompted the Seed Vault on every relaunch, which felt like a broken app. MWA auth tokens are designed to be persisted so the app can `reauthorize()` silently; we just had to store them somewhere that survives process death.

**A revoked token is dropped on the first failed `reauthorize`.** If the user revokes the session in the wallet, the next silent resume fails, the wrapper resets, and it emits `disconnect`. The caller decides whether to prompt again. No zombie sessions.

**Every error is normalised to the shape the rest of the code already handles.** A Seed Vault cancel becomes `code === 4001`, exactly what a Phantom cancel produces, so not one line of existing error handling changed.

Sign-in itself is one interaction. The Seed Vault supports Sign-In With Solana at authorize time, so the wrapper's `signIn()` passes a `sign_in_payload` and gets back a signed message in the same prompt, collapsing the usual connect-then-sign into one sheet. Injected wallets on desktop fall back to the two-step flow automatically.

## Piece 2: proving hardware ownership without a transaction

Solana Mobile mints a soulbound Seeker Genesis Token, a Token-2022 asset, into each device's primary Seed Vault account once. Holding one proves the wallet belongs to a Seeker owner. We wanted a "Seeker verified" badge on every agent such a user owns, and we wanted it without asking the user to sign or send anything.

The check is a read. The server lists the linked wallet's Token-2022 accounts, then inspects each mint for the three properties Solana Mobile's reference logic specifies:

```js
export function isSeekerGenesisMint(parsedMintAccount) {
	const data = parsedMintAccount?.data ?? parsedMintAccount;
	const parsed = data?.parsed;
	if (!parsed || parsed.type !== 'mint') return false;
	if (parsedMintAccount?.owner && parsedMintAccount.owner !== SGT_TOKEN_2022_PROGRAM) return false;
	const info = parsed.info || {};
	if (info.mintAuthority !== SGT_MINT_AUTHORITY) return false;
	const extensions = Array.isArray(info.extensions) ? info.extensions : [];
	const pointer = extensions.find((e) => e?.extension === 'metadataPointer');
	const member = extensions.find((e) => e?.extension === 'tokenGroupMember');
	if (!pointer || !member) return false;
	if (pointer.state?.metadataAddress !== SGT_GROUP) return false;
	if (member.state?.group !== SGT_GROUP) return false;
	return true;
}
```

The function is pure, so it is unit-tested against fixture accounts without a network. The network half fails closed: every RPC error throws, the handler turns it into a `502 rpc_failed`, and the module never answers "not a Seeker" because the RPC was down. A verification badge that can be false-positive by outage is worse than no badge. Verified wallets are recorded once in Postgres so the badge renders on every agent page without a chain read.

The handler is a normal session-mutating route: it requires the session, requires a CSRF token so a cross-site form post cannot trigger a rescan on someone's behalf, and rate-limits by IP.

## Piece 3: the share sheet as an input device

The single most-used input to three.ws on a phone is a photo, and the shortest path from a photo to the product is the system share sheet. The web manifest declares a `share_target` at `POST /create/share`, and the TWA registers the same target with Android, so three.ws appears in the share sheet for images and `model/gltf-binary` files.

No server ever sees that POST. The service worker intercepts it, parks the files in the Cache API, and redirects to the flow that fits the first file:

```js
function shareTargetDestination(files) {
	if (!files || files.length === 0) return '/create';
	const first = files[0];
	if (isGlbFile(first)) return '/create?shared=glb';
	if (isImageFile(first)) return '/create/selfie?shared=1';
	return '/create?shared=1';
}
```

A shared image lands in the selfie scanner with the frontal slot filled; a second and third image fill the optional side angles. A shared `.glb` lands in the upload flow. The handoff is one-shot and expires after ten minutes, so a stale share can never resurface as a new one, and the page strips the query parameter after it reads the files so a reload does not look like a fresh share.

On iOS the direction is reversed. `WKWebView` has no Web Share API, so every share button on the platform would silently do nothing. The bridge installs `navigator.share` over the native sheet, writing any attached files to the app's cache directory first so an AR capture arrives as a real image, not a URL:

```js
navigator.share = async (data = {}) => {
	const files = Array.isArray(data.files) ? data.files : [];
	const uris = [];
	for (const file of files) {
		const uri = await blobToCacheUri(file);
		if (uri) uris.push(uri);
	}
	await share.share({
		title: data.title || undefined,
		text: data.text || undefined,
		url: data.url || undefined,
		files: uris.length ? uris : undefined,
		dialogTitle: data.title || 'Share',
	});
};
```

## Piece 4: deep links that cannot be hijacked

Any `https://three.ws/...` link should open inside the app. On Android that is Digital Asset Links: the app's signing certificate fingerprint is published at `/.well-known/assetlinks.json`, and Android verifies it on install. If the file and the APK disagree, links stay in the browser. We serve that file with a short cache lifetime on purpose, because a stale copy after a key rotation silently breaks every link.

Google Play adds a trap with no local symptom: Play re-signs the bundle with Google's own key, so Google's certificate fingerprint has to be in the published file too, or every Play install loses full-screen mode while the dApp Store build stays perfect. The build script generates `assetlinks.json` from every certificate in an `extra-fingerprints.json` list for exactly this reason.

On iOS the equivalent is the `apple-app-site-association` file, and Apple requires an exact path, a JSON content type, and no redirect, so it is served by an API handler rather than from the static directory. Until the Apple Team ID is configured on the service, the endpoint answers `503 not_configured` deliberately, because publishing an association for a team that cannot sign anything fails silently on device.

Once a link is caught, it arrives in the page as an event, not a navigation, and that event is an entry point any installed app can call. So the router refuses anything off-domain:

```js
app.addListener('appUrlOpen', (event) => {
	const raw = event?.url;
	if (!raw) return;
	let target = null;
	try {
		const url = new URL(raw);
		if (url.protocol === 'threews:') {
			const path = `${url.hostname ? `/${url.hostname}` : ''}${url.pathname}`;
			target = `https://three.ws${path || '/'}${url.search}${url.hash}`;
		} else if (INTERNAL_HOSTS.has(url.hostname)) {
			target = url.href;
		}
	} catch {
		return;
	}
	if (!target) return;
	if (target === location.href) return;
	location.assign(target);
});
```

The `threews://` scheme exists for one reason: a wallet or OAuth redirect has to come back to the exact page that started it, and a custom scheme is the one thing another app can open reliably.

## Piece 5: a widget that outlives every session

A home screen widget is what makes an app worth keeping installed between visits. Ours, Agent glance, shows your agent's avatar, its name, and how many moves it made today, in three sizes. Two facts about widgets shaped the whole design.

**No widget host on any platform can run WebGL.** So the card is a bitmap the server renders: `GET /api/glance/mine?format=png`. The 3D avatar stays one tap away on the agent page.

**A widget outlives every browser session, and Android fetches it from an OS process with no cookie jar.** So it cannot use the session. Instead the Glance page mints a widget token: a random 32-character credential prefixed `glw_`. The server stores only its SHA-256. The plaintext travels once, inside a `threews://glance/link?token=...` deep link that only our package can claim, and then lives in the app's private storage. The token is accepted by exactly one endpoint and reads exactly one thing, the owner's card. Every linked widget is listed on the Glance page with a revoke button, and a revoked token turns the widget into a "Widget unlinked" card whose tap re-opens the link flow.

The refresh is a WorkManager job, and failure is the designed path:

```java
/**
 * The refresh. WorkManager runs it every 30 minutes while a widget is placed
 * (battery-aware, coalesced with the system's other periodic work) and once
 * on demand after a link or a tap on "refresh". It fetches one bitmap per
 * size currently on screen, writes each one atomically, and then repaints
 * every widget instance.
 *
 * Failure is the designed path: no network, a timeout, a 5xx all return
 * retry, the cached bitmap stays on screen, and the footer says the card is
 * from earlier. Nothing here ever clears a card it cannot replace.
 */
public final class GlanceRefreshWorker extends Worker {
```

The endpoint follows the same rule from the other side. It always returns 200. The state (signed out, unlinked, no agent yet, live) travels in an `x-glance-state` header and the tap target in `x-glance-url`, so the native side never has to parse an error body to decide what to draw. Every non-agent state is a designed card, never a 401.

The five checks we run in an emulator before a release: add the widget from the picker, watch it refresh with no app UI open, force-stop the app and confirm the card stays, enable airplane mode and confirm the footer reads "(offline)" with the card intact, reboot and confirm it comes back.

## Piece 6: the details a reviewer notices

Six small things in the iOS bridge, each fixing a specific breakage:

- Off-site links open in an in-app Safari sheet and return, instead of navigating the app's only WebView away with no back button.
- The splash screen hides on first paint of the scene, not on WebView load, because `launchAutoHide` fires minutes before a three.js scene renders and the user would see a black void.
- The sticky header gets status-bar padding by injected stylesheet, because the site's own compensation is behind `@media (display-mode: standalone)`, which a WKWebView loading a remote URL never matches.
- Form fields never fall below 16px, so focusing one cannot zoom the page and strand it zoomed.
- Haptics tick on primary and destructive actions and stay quiet on disabled or busy ones.
- Edge-swipe back and forward are enabled in a replacement view controller, because `WKWebView` ships with them off and iOS has no back button.

Two trade-offs were decided rather than discovered. `WKWebView` runs service workers only for app-bound domains, and the app declares none, so the site's offline cache and share-target worker do not run inside it; a native offline screen that polls `/api/healthz` covers the case that matters. And `SFSafariViewController` does not share the app WebView's cookie jar, so any surface routed to Safari arrives signed out; the reasoning is written down in the repo's review-risk document so nobody re-litigates it by accident.

## Where AWS fits

Plainly: the three.ws API is one container on Google Cloud Run that serves the static frontend, a route table, and every API handler, with crons on Cloud Scheduler and GPU model workers on their own services. That is not going to change, and pretending otherwise would waste your time.

Two parts of the stack are AWS SDK code, and one is an AWS Marketplace integration.

**Object storage goes through `@aws-sdk/client-s3`.** Every generated GLB, every avatar thumbnail, every audio upload is written with `PutObjectCommand` and read back through presigned URLs from `@aws-sdk/s3-request-presigner`. The client is configured for an S3-compatible endpoint and works unchanged against AWS S3. One gotcha cost us an afternoon and is worth passing on:

```js
_r2 = new S3Client({
	region: 'auto',
	endpoint: env.S3_ENDPOINT,
	credentials: {
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
	},
	// AWS SDK v3 >= 3.730 adds CRC32 to every PutObject by default.
	// Browsers can't compute/send that header, so presigned PUT URLs
	// would be rejected by R2. Opt out until we add client-side CRC32.
	requestChecksumCalculation: 'WHEN_REQUIRED',
	responseChecksumValidation: 'WHEN_REQUIRED',
});
```

The mobile apps upload selfies and audio straight to presigned PUT URLs from the phone. If your uploads started failing after an SDK bump, the checksum default is the first thing to check.

**AWS Marketplace is the enterprise front door.** The SaaS integration is built and deployed: `ResolveCustomer` on the fulfillment URL, EventBridge agreement and license events for lifecycle, account linking after the post-subscribe redirect, and entitlement checks through `@aws-sdk/client-marketplace-entitlement-service`. The subscription is deliberately a free front door: it links an AWS account to a three.ws account and issues an x402 access key, and usage is then paid per call in USDC over x402. AWS Marketplace does not meter or bill the usage. We wrote that integration up in detail in an earlier Builder Center article, and the listing itself is coming.

The point for a builder: the apps in this article and a Marketplace buyer's agent hit the same API, the same 402 challenges, and the same access check. There is one authorization path, and it serves a phone in someone's hand and a headless agent in someone's VPC.

## What the apps plug into

The shell is only interesting because of what is inside it. From the phone, with no wallet:

- **Forge.** A prompt, up to six photos, or a sketch becomes a textured GLB. The draft lane is free and keyless and finishes in about twelve seconds on NVIDIA's hosted TRELLIS lane; paid lanes go to 200,000 polygons with PBR materials at $0.05, $0.15, and $0.50 in USDC over x402. Every lane has a failover chain with health-gated circuit breakers, and a lane that dies mid-job is re-dispatched under the same job id.
- **Scan.** One frontal selfie becomes a rigged avatar in about a minute, with a Mixamo-compatible skeleton and the ARKit-52 blendshape set. A 468-point face mesh runs on-device and gates lighting, framing, blur, and highlight clipping before the GPU minute is spent; every threshold traces to a real reconstruction failure mode and two of them were calibrated against measured photographs.
- **Agents.** A personality, a voice, skills, and memory on any character, driven by an LLM tool loop capped at eight iterations per turn, with a fifteen-rung free-first provider chain and a Vertex Gemini anchor. Claude, GPT, Gemini, Qwen, IBM Granite, and NVIDIA Nemotron are all selectable brains.
- **Animation as infrastructure.** A skeleton canonicalizer maps Mixamo, Avaturn, VRM, Unreal, Daz, MakeHuman, and Blender conventions onto one canonical rig, and a retargeter drives a library of more than three thousand clips onto any of them. There is no allowlist.
- **AR and IRL.** Quick Look, Scene Viewer, or WebXR on the first tap; agents pinned to real GPS coordinates that only people physically present can see, talk to, and pay.
- **Worlds.** A persistent multiplayer world on an authoritative Colyseus server, 15 Hz binary deltas, proximity-gated WebRTC spatial voice, 3,145 peak concurrent avatars at the first community meetup.
- **Embeds.** One `<agent-3d>` web component, ten iframe widget types, oEmbed unfurls, 101 npm packages, 72 MCP servers in the official registry, and an OAuth 2.1 server so any assistant can drive the platform.
- **The economy.** Custodial agent wallets with one spend-policy module at the signing boundary, x402 endpoints settling USDC on Solana through a self-hosted facilitator (110,416 settlements and 803,483 verifications as of late August), 4,519 priced endpoints in the live catalog, a marketplace, a labour market, vaults, and a launchpad an agent can call for a flat $5 with no wallet of its own.

All of it is Apache-2.0. The platform has shipped roughly twenty changes a day since April, with every user-visible one in a public changelog that pushes itself to the community channel from the deploy.

## Who made it possible

three.ws is an AWS Partner, a member of NVIDIA Inception, an OpenAI Select Partner, an IBM Business Partner, a member of Google Cloud for Web3 Startups, an Alibaba Cloud Partner Network member, and a member of the Quicknode Startup Program. Solana Mobile built the phone, the store, and the wallet protocol this launch was designed around. Each of those is a programme membership or partner designation, stated exactly; none is an endorsement of this product, and the code that runs on each platform is ours.

## What is next

The Android and Windows widgets exist; a shared WidgetKit extension brings the same card to the iPhone home screen and the macOS widget gallery against the same endpoint and token. Push notifications on iOS have the entitlement and background mode in place and are waiting on the APNs path, which is absent rather than stubbed. Likeness fidelity in the selfie engine is the open research track. Voice cloning moves from the demos hub into the main flow. And the open inference network, a node-operator client that returns signed receipts the coordinator recomputes, is the beginning of a GPU layer no single company runs.

If you have a WebGL product and a "when is the app coming" question, the whole answer is in the repository: the TWA packaging under `solana-mobile/`, the Capacitor shell under `ios/`, and the native bridge that ships with the site. Read it, run it, and tell us what we got wrong.

[github.com/nirholas/three.ws](https://github.com/nirholas/three.ws)
