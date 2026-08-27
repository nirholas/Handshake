three.ws is built around three things the Seeker does better than a generic Android phone or a desktop browser.

1. Seed Vault signing through Mobile Wallet Adapter

Inside the app, every signing request (Sign-In With Solana, on-chain agent deploys, skill purchases, tips) is routed to the on-device Seed Vault. Sign-in is a single wallet interaction rather than a connect step followed by a signature step, and the private key never enters the application process. A session you approved once is remembered across app restarts; a session the wallet revokes is dropped cleanly and re-requested on the next action.

2. On-device camera capture for avatar creation

The Create flow uses the Seeker's camera to capture one frontal selfie (plus optional left and right angles), uploads the frames to the three.ws reconstruction pipeline, and returns a rigged, animation-ready avatar in about a minute. On Seeker this is the shortest path from "I want an agent that looks like me" to "it is in my wallet".

3. Home-screen shortcuts and deep links

Long-pressing the app icon offers Create, Discover, and My agents. Any three.ws link (an agent page, a marketplace listing, an embed) opens inside the app instead of a browser tab, verified through Digital Asset Links, so agents shared in Telegram or X land directly in the native experience.
