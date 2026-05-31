---
title: "Every Memecoin Is Now a 3D World You Can Walk Into"
target: CoinMarketCap Community / Editorial
---

# Every Memecoin Is Now a 3D World You Can Walk Into

## The community is the asset, so why does it live in a chat box?

Strip a memecoin down to what actually moves it and you don't find a product. You find a crowd. The chart is downstream of the community: the holders, the believers, the people refreshing the chart at 3am, the ones aping the next candle and the ones diamond-handing through the dip. On a memecoin, the community *is* the asset.

And yet that crowd lives in the two loneliest tabs on the internet: a Telegram group on one side, a price chart on the other. The whole point of the thing, the people, has nowhere to actually be. You can't walk into a coin. You can't see who else showed up. You can't feel the market move through a room.

[three.ws](https://three.ws) **/play** gives the crowd a body. It turns every [pump.fun](https://pump.fun) coin into a live 3D world you can walk into: a shared space where holders show up as real avatars, talk by voice, and watch the coin's on-chain activity ripple through the ground, the sky, and the light around them as it happens. The chart isn't on a screen across the room. The chart *is* the room. Buys roll green across the plaza, a whale lands like a thunderclap, and a coin getting aped looks like a storm of falling gold.

It's live now at **[three.ws/play](https://three.ws/play)**, in the browser, no install, no extension. Pick a coin and you're standing in it, next to everyone else who did.

## One coin, one world

The mental model is simple: **every coin is a room, keyed to its mint address.**

You open the /play lobby and see the trending pump.fun coins, plus a search box that reaches every coin on pump.fun, not just what's hot, *any* token. Pick one. You drop in as a 3D avatar standing on a plaza, under a sky, with a giant slowly-turning gold coin in the middle stamped with that token's art. A stadium jumbotron towers over the plaza showing the coin's name, its live market cap, and a count of how many people are in this community *right now*.

Other people are there too: real avatars, moving, with names floating over their heads and chat bubbles when they talk. You move with WASD and the mouse on desktop, or a touch joystick on mobile; sprint, jump, orbit the camera, wave an emote. Everyone in that space entered the same coin. Walk into a different coin and you're with a different crowd, in a different world.

Under the hood this is enforced by the multiplayer server: players are matched into the same room instance **only when their coin matches**. Each token is an isolated world. There's no bleed between communities: the people in $DOGE's world and the people in some fresh launch's world never see each other, because they're literally in different rooms anchored to different mints. A community becomes a shareable URL (`three.ws/play?coin=<mint>`); send it and someone lands directly in your coin's world.

## Anyone can walk in. Holders get a room of their own.

Not every crowd is the same crowd. There's the passer-by who clicked a link to see what a coin's world even looks like, and there's the holder with real skin in the game. /play gives a coin both, as two connected worlds.

The **open world** is the front door. Anyone can drop into any coin, no wallet required: walk the plaza, watch the market move the sky, read the live terminal, and ape in if the world wins you over. Think of it as the trailer for the community.

The **holders' world** is the community itself, and it's gated. To step through and actually take part, to talk, to build, to post into the coin's living feed, you have to hold at least **$8 worth of the coin**. That bar isn't a velvet rope three.ws invented. It's enforced through [Coin Communities](https://coin-communities.xyz), the protocol that powers each coin's social layer, which only lets verified holders participate in a token's community. Being in the room is itself proof that everyone around you has a stake in the same coin you do.

It's the oldest idea in crypto finally given a place: holders together, in a space only holders can enter. The market the world reacts to is the market everyone in that room is exposed to. When the totem spins and golden coins rain down, nobody in the holders' world is a tourist; the green ripping across the plaza is *their* green.

Send someone the open world and they can look around. Send them the holders' world and, if they're holding, they're home.

## The world reacts to the chain

This is the part that makes people stop and stare.

Every /play world is streaming that coin's **real on-chain trades** (the actual pump.fun swap tape) and piping them straight into the environment. The market doesn't sit politely on a panel. It physically moves the world around you:

- **Every buy ripples green** across the plaza and kicks the glowing boundary ring.
- **Every sell ripples red.**
- **Sustained volume spins the coin totem faster:** the room visibly speeds up when the tape heats up.
- **The rolling percentage change becomes the weather.** Green and the fog opens out, the sun flares: euphoria. Red and the fog closes in and the light dims: a storm rolls over the world. The mood drifts like a tide, not a strobe, so it reads as atmosphere rather than noise.
- **A whale trade detonates.** When a single trade crosses the whale threshold, a column of light fires up over the totem, a shockwave rolls out across the plaza, and on a big buy a fountain of golden coins rains off the top, with a toast naming what just happened ("🐋 Whale bought $X of $TICKER").

The coin's price becomes the room's pulse. You don't read the market; you stand inside it and feel it flinch. A quiet coin is a calm, still world. A coin getting aped into orbit is a thunderstorm of green light and falling coins. Nobody has to narrate the action in chat; the world *is* the action.

## A trading terminal you can walk up to

Atmosphere is one half. The other half is a real, legible terminal, because people in a coin's world want the numbers, not just the vibe.

Past the totem stands a second giant screen: a live in-world **trading terminal** for the coin. It's not a decoration and it's not a screenshot. It polls the same on-chain swap feed the rest of the platform uses and paints, in real time:

- the **price** (with the leading-zero sub-decimal notation memecoins need: $0.0₇123 and the like),
- the session **price chart** with a live, glowing line,
- **market cap**, **live volume**, **trade count**, and **buy/sell flow** as a pressure bar,
- and a **scrolling ticker of the latest real trades**: side, size in SOL and USD, the trader's short address, and how long ago.

Tap the terminal and it opens the coin straight on pump.fun. And you don't even have to leave: /play ships a native in-world **buy flow**. Click Buy and the three.ws server builds the unsigned pump.fun transaction (handling both the bonding curve and the post-graduation AMM), your Solana wallet signs it, and it broadcasts. You can ape the coin while standing inside its world, surrounded by the people who already did.

That's the loop a memecoin has never had in one place: *see the crowd → feel the market → read the tape → buy the coin*, without ever switching tabs.

## Walk up to someone and talk

A crowd you can't talk to is just wallpaper. Inside the holders' world, /play has **spatial voice chat**, and it's the thing that makes a coin's community feel like a real gathering instead of a chat box with 3D models.

It works the way your ears do. Walk up to someone and you hear them. Drift away and they fade out. Their voice comes from *their direction*: someone on your left sounds like they're on your left. Get far enough and they're gone. The audio is genuine peer-to-peer WebRTC with HRTF spatial panning and distance falloff; the server only passes the connection handshake between two people and never touches the audio itself. Connections open only to the people near enough to hear, so the voice layer stays light no matter how busy the plaza gets, which is also exactly what spatial audio *should* do.

Voice is opt-in (the mic stays off until you tap it), and when someone's talking, their nameplate pulses so you can pick the speaker out of a crowd. Alongside it there's text chat with floating bubbles and a set of emotes. The result is that a coin's world feels less like a Discord and more like actually being *somewhere* with other holders: clusters of people talking near the totem, someone shouting across the plaza when a whale lands.

## A thousand coins, a thousand worlds

If every coin shared one generic world, the whole thing would feel like a template. It doesn't.

Each coin's world is generated **deterministically from its mint address**. The mint is hashed into a seed, the seed picks one of several biome archetypes (Verdant Meadow, Dune Sea, Frostfields, Ashen Caldera, Neon Expanse, Lagoon Shore) and then nudges that biome's palette and scatters its flora from the same seed. So a given coin **always** renders the same world (your coin's place is *its* place, every time you return), and a thousand different coins render a thousand recognizably different ones. Two tokens that happen to land in the same biome still get their own color and layout.

Walking into a new coin and seeing what world it "is" becomes its own small ritual: a frozen tundra, a neon alien expanse, an ashen volcanic caldera. The world is a fingerprint of the mint.

## Build it together, and it stays

A community's world isn't read-only. /play includes **collaborative voxel building**: a block palette and a build mode where anyone in the holders' world can place and break blocks together, in real time, on a shared grid in the middle of the plaza.

It's server-authoritative: every block is validated and synced through the same room everyone's in, so what you build is what everyone sees. And critically, **builds persist**. The world's creation is saved per coin and rehydrated when the room spins back up, so a community's monument to their token survives even after the last person logs off and the room is torn down. Come back tomorrow and the thing your community built is still standing.

That's the difference between a chat log and a place. A chat scrolls away. A place accumulates.

## The flagship: the $THREE town

There's one world that's always pinned to the top of the lobby, badged official, dressed in a fixed signature biome instead of the seeded lottery: the **$THREE town**, three.ws's own coin community. It's the front door (the world a first-time visitor lands in), and its identity (name, art, market cap) refreshes live from pump.fun so the pinned card is never stale. It's also the proof that this isn't a tech demo bolted onto a homepage: the platform runs its own community in its own product.

## It's all real

For a CoinMarketCap reader, the load-bearing question is always: *is any of this actually real, or is it a render?* Here's what's under the hood, plainly:

- **Real multiplayer.** The worlds run on an authoritative [Colyseus](https://colyseus.io) server deployed on Google Cloud Run. Clients send movement ~15 times a second; the server validates every update (anti-teleport step clamp, world bounds, name and message rate limits), keeps the authoritative state, and broadcasts only what changed via a binary delta protocol. It's the same proven engine behind the platform's `/walk` scene.
- **Real on-chain data.** The chart, the ticker, the market cap, the reactor's green-and-red: all of it is driven by live pump.fun trending, search, coin, and swap-tape feeds. Nothing is mocked or canned. An empty coin honestly says "no recent trades yet. Be the first to ape in."
- **Real holder gating.** The holders' world is gated by genuine ownership, enforced through the Coin Communities protocol: only wallets holding at least $8 of the coin can enter the community and post to it. It's proof of stake in the literal sense, not an honor system or a club of screenshots.
- **Real avatars.** Players load actual GLB/VRM 3D models: pick a preset, browse your own avatars and the public gallery, paste a URL, drop in your own `.glb`, or bring the 3D agent you built on three.ws. Draco-compressed models (most pump.fun and Sketchfab exports) just work.
- **Real voice.** Peer-to-peer WebRTC with spatial HRTF audio, proximity-gated so it scales and so it sounds right.
- **Real buys.** A native pump.fun transaction built server-side and signed by your own wallet, not a redirect dressed up as a feature.

And it's **open source** under Apache 2.0, like the rest of the platform.

## Why this matters

Memecoins have spent two years proving that attention and community are the actual product, and that the chart is just the scoreboard. But the tools the space gives a community have barely moved past a group chat and a candlestick. The "community" tab on most coins is a link to a Telegram.

/play makes the community tab a *place*. It gives a token:

- **A spatial home:** a room of its own, anchored to its mint, that holders can walk into and that you can link anyone directly into.
- **An embodied crowd:** real avatars and spatial voice, so being "in" a coin means being somewhere with other people, not staring at a member count.
- **A members' room:** a holders-only world, gated to wallets with at least $8 in the coin, so the people you're talking to are the people holding the bag with you, not a follower count.
- **A living chart:** the on-chain tape rendered as environment, so the market is something you experience, not just read.
- **A persistent artifact:** a world the community can build in, that survives and accumulates instead of scrolling away.
- **A path to action:** read the tape and buy the coin from inside its own world.

For projects, that's a reason to send your holders somewhere that isn't a chat app. For traders, it's a way to *feel* a coin's momentum and meet the people behind it before you ape. For the space as a whole, it's a glimpse of what a memecoin community looks like when it finally gets a body.

## Try it

1. Go to **[three.ws/play](https://three.ws/play)**.
2. Pick a trending coin, or search any pump.fun token by name or ticker.
3. Choose an avatar: a preset, your own upload, or your three.ws agent.
4. Drop into the open world. Walk around, watch the world react as the trades land, and buy the coin from inside it.
5. Holding at least $8 of the coin? Step into the holders' world: tap the mic to talk to the people with a stake, and build something together that stays.

Or just open the front door: the pinned **$THREE town** at the top of the lobby.

The chart has always told you *what* a coin is doing. /play lets you go stand where it's happening.

---

*three.ws is an open-source, browser-native platform for 3D AI agents and on-chain communities, live at [three.ws](https://three.ws) and open source under Apache 2.0. Coin Communities (/play) is live at [three.ws/play](https://three.ws/play).*
