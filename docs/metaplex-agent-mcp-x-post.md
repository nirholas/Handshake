# X post + Veo script: metaplex-agent-mcp

Announcement copy for [github.com/nirholas/metaplex-agent-mcp](https://github.com/nirholas/metaplex-agent-mcp),
the MCP server that mints an AI agent into the Metaplex Agent Registry on Solana with its own
on-chain wallet and an EIP-8004 identity, plus the shot-by-shot prompt for the Veo clip that goes
with it.

**Thesis of this announcement:** an agent should be able to deploy itself on-chain, hold its own
wallet, and pay for what it uses. Nothing else. No mint drop, no supply, no collection talk.

**Every claim below is true today** (verified against the package README and `package.json`):
`npx -y @three-ws/metaplex-agent-mcp`, 8 tools, mint + register in one flow, agent wallet is the
mpl-core Asset Signer PDA, `x402Support` ships in the registration document, ~0.007 SOL on mainnet,
free devnet rehearsal, keys never leave the client, Phantom/Solflare/Backpack/Ledger sign the
browser lane.

---

## 1. Main post (recommended)

278 characters with X's 23-character URL count, so it posts from any account, Premium or not.

> Your agent can now hold its own wallet.
>
> One command and it deploys itself into the Metaplex Agent Registry on Solana: an asset with its
> own on-chain wallet, an EIP-8004 identity, and x402 on so it can pay for what it uses.
>
> ~0.007 SOL. Keys stay yours.
>
> github.com/nirholas/metaplex-agent-mcp

Why this one: line 1 is the whole idea in seven words, line 2 is the mechanism without asking the
reader to already know what MCP is, line 3 kills the only two objections anyone has (what does it
cost, who holds the key). "Deploys itself" is the phrase doing the work; keep it in any rewrite.

Premium-length variant, if the account has the room, swap line 2 for:

> One command in Claude and it deploys itself into the Metaplex Agent Registry on Solana: a
> Metaplex Core asset with an on-chain wallet, an EIP-8004 identity, and x402 on so it can pay for
> what it uses.

## 2. Alternate: builder-facing

> ```
> npx -y @three-ws/metaplex-agent-mcp
> ```
>
> 8 MCP tools that put an AI agent on Solana: mint a Metaplex Core asset, register its EIP-8004
> identity, and it comes out the other side with its own wallet address and x402 enabled.
>
> Self-custodial both ways. Devnet is free.
>
> github.com/nirholas/metaplex-agent-mcp

## 3. Alternate: the punchy one

> Agents don't need accounts. They need wallets.
>
> This is an MCP server that gives one to any agent, on Solana, on-chain, in about a minute. It
> mints the asset, registers the identity, and hands back an address the agent can be paid at and
> spend from.
>
> github.com/nirholas/metaplex-agent-mcp

## 4. Thread (use if the main post lands)

**1/**
> Your agent can now hold its own wallet.
>
> One command and it deploys itself on-chain: an asset with a wallet address, a portable identity,
> and the ability to pay for the services it calls.
>
> Here is what that actually means. 🧵

**2/**
> Today an agent is a process. It has no address, no balance, nothing another agent can look up or
> pay. If it needs an API it uses your key and your card.
>
> Put it on-chain and it gets all three: an identity, a wallet, and a way to settle.

**3/**
> The identity is EIP-8004, on Solana, in the Metaplex Agent Registry. Name, description, the model
> it runs, whether it takes payment, what it can be trusted with. Anyone can read it. No login.

**4/**
> The wallet is the asset's own signer, derived from the asset itself. It is not a wallet you made
> for it and named after it. Fund it, and the agent is the thing spending.

**5/**
> x402 is how it pays. An HTTP 402 comes back with a price, the agent settles it, the response
> arrives. No key sharing, no invoice, no human in the loop for a $0.001 call.

**6/**
> Custody is the part we refused to compromise on.
>
> Agents sign with their own keypair. People sign with Phantom, Solflare, Backpack, or a Ledger.
> Nothing custodial, no key on any server of ours, ever.

**7/**
> Spends are gated. Every mint call returns a full preview and costs nothing until you pass
> confirm. Balance is checked before broadcast. Devnet is a first-class target, so you can rehearse
> the whole thing for free.

**8/**
> Works in any MCP client:
>
> ```
> claude mcp add metaplex-agent -- npx -y @three-ws/metaplex-agent-mcp
> ```
>
> Or skip the install and do it in the browser.

**9/**
> Open source. Real programs, real Solana, no mocks.
>
> github.com/nirholas/metaplex-agent-mcp

## 5. Reply-slot copy (post as first reply to the main post)

Use this to carry the second link without spending the main post's one outbound slot.

> No install path if you just want to see it: the browser deployer builds the transaction locally,
> your wallet signs it, nothing touches a server.

---

## Veo video script

The clip is an agent being deployed on-chain and then paying for something with its own wallet.
Reference image: a three.ws avatar render (front-facing, neutral pose, transparent or dark
background gives Veo the cleanest key).

**Direction rules for this one**

1. **No on-screen text you care about.** Generative video mangles letters. Keep every address,
   number, and label as an abstract glyph in the render, and comp the real text in afterwards if
   you want it legible.
2. **One idea per shot.** Materialize, wallet, pay, register. A shot that tries to do two reads as
   a mess at 8 seconds.
3. **Camera does one move per shot.** Slow. The subject moves, not the operator.
4. **Palette:** deep near-black background, Solana violet and teal accents, one warm gold for
   money in motion. Nothing else.

### Single hero clip (8s, use this if you only render one)

> Cinematic product shot, near-black void studio. A stylized 3D humanoid agent stands center
> frame, matching the reference character exactly. It begins as a cold violet wireframe, then
> textures resolve across its body from the feet up in one smooth sweep, as if it is being written
> into existence. As the last surface lands, a small hexagonal token of warm gold light ignites in
> its open right palm and settles there, pulsing slowly like a heartbeat. Thin violet data threads
> trail off its shoulders into the dark and dissolve. Camera: slow push in from a wide-medium to a
> medium, ending at chest height. Lighting: single soft key from the upper left, violet rim light
> from behind, gold bounce from the palm onto the face. Shallow depth of field, subtle volumetric
> haze, fine film grain. Audio: low sub-bass swell, a single crystalline chime as the token
> ignites, quiet room tone. No text, no logos, no people.

### Four-shot sequence (8s each, cut together to ~32s)

**Shot 1 of 4: deployment**

> Cinematic 3D render, near-black void. The agent from the reference image stands center frame as a
> cold violet wireframe. Textures and materials resolve upward across its body in one continuous
> sweep, surfaces catching the light as they land. A faint grid of light briefly maps its silhouette
> and fades. Camera: slow dolly in, wide to medium. Lighting: soft key upper left, violet rim from
> behind, haze in the beam. Audio: rising sub-bass, a soft mechanical lock as the last surface
> lands. No text.

**Shot 2 of 4: the wallet**

> Same character, same void, now fully rendered. It turns its right hand palm-up. A small holographic
> card materializes an inch above the palm and rotates slowly: an abstract key glyph, a row of
> shifting glyph-like characters standing in for an address, and a soft gold value that ticks
> upward. The card's light spills gold onto the agent's face and chest. Camera: slow arc from the
> right, medium close on the hand and face together. Lighting: gold from the card as key, violet
> rim. Shallow depth of field, the card in sharp focus. Audio: crystalline chime, quiet electrical
> hum, a soft ascending tick as the value rises. No readable text.

**Shot 3 of 4: paying for something**

> Same character. Three tall translucent violet service panels float in the dark in front of it,
> each sealed with a thin lock glyph. The agent reaches out and touches the center panel. A stream
> of small gold particles flows from its palm into the panel; the lock dissolves into teal, the
> panel opens, and a bright ribbon of data flows back into the agent's chest, lighting it from
> inside. Camera: slow lateral track left to right, keeping the agent in profile and the panel in
> frame. Lighting: teal from the unlocked panel, gold from the particle stream, violet rim. Audio:
> a rush of fine particles, a satisfying two-note unlock, data shimmer. No text.

**Shot 4 of 4: on the registry**

> Camera pulls back fast and smooth from the agent, revealing it standing on one lit tile in an
> enormous dark grid stretching to the horizon, other tiles glowing faintly with distant agent
> silhouettes. The agent's own tile pulses violet once, and a ring of light expands outward across
> the grid from it, lighting neighboring tiles as it passes. The agent stands still, palm still
> glowing gold. Camera: fast pull back to a wide, then settle and hold. Lighting: grid emissive
> violet, single gold point on the subject. Audio: bass drop on the pulse, long reverb tail, then
> near silence. No text.

### Negative prompt (paste into the negative field on every shot)

> text, letters, numbers, words, subtitles, watermark, logo, UI, user interface, HUD, charts,
> coins, dollar signs, crowds, extra characters, warped hands, extra fingers, face morphing,
> shaky camera, jump cuts, lens flare spam, rainbow colors, low resolution, cartoon shading

### Post-production

- Comp the real strings over shot 2 and shot 4 in an editor: the agent's address, `x402 enabled`,
  and the closing card. Rendered text is the only text that will survive a screenshot.
- End card, 2 seconds, static: the repo URL on black. Nothing else.
- Cut the video to land on the beat where the panel unlocks in shot 3. That is the moment the idea
  is legible, and it is what a muted autoplay timeline shows first.
- Post it as native video, not a link to a video. X will not show a preview card and the video at
  the same time, and the video wins every time.

---

## Naming the next repo (agent wallets + x402, standalone)

The thesis you wrote is custody plus guardrails plus payment, and the name should say the smallest
true thing about it rather than stacking nouns. `onchain-agents-money` describes the category, not
the product, and it reads like a folder.

Three that hold up, best first:

1. **allowance** (`@three-ws/allowance`, `allowance-mcp`). It is the whole product in one word every
   person on earth already understands: money you give something, with limits, that stays yours. It
   names the guardrails and the funding in the same breath, and "give your agent an allowance" is a
   sentence that needs no explanation to a non-crypto reader. Strongest option.
2. **purse**. Small, concrete, obviously a wallet without being called a wallet, and unclaimed as a
   crypto brand in a way "wallet" never will be. "Every agent gets a purse."
3. **spendkit**. The most literal and the safest. Says exactly what it is to a builder scanning npm,
   and pairs cleanly with x402 in a subtitle. Least distinctive of the three.

Whichever wins, the tagline is the same and it is the thesis compressed: **your agent's wallet, your
keys, your limits.**
