# X post: the agent deployer goes live

Announcement copy for [nirholas.github.io/metaplex-agent-mcp](https://nirholas.github.io/metaplex-agent-mcp),
the website that deploys an AI agent into the Metaplex Agent Registry on Solana from a browser, and
for the MCP server behind it.

This is the sequel to the Genesis 333 post, and the copy leans on that: the earlier post said the
point was onboarding people who had never touched a seed phrase. This is the version anyone can
use, not just people who made an avatar on three.ws.

**Verified true on the day of writing:** the site is live and static (no server, no account), it
mints a Metaplex Core asset and registers an EIP-8004 identity, the agent's wallet is the mpl-core
Asset Signer PDA, keys never leave the browser, wallets can be Phantom / Solflare / Backpack or one
created on the page and encrypted under a passphrase, devnet is free end to end, mainnet costs about
0.007 SOL of rent and network fees plus a 0.02 SOL deploy fee (halved at 50,000 $THREE, waived at
250,000), the npm package is `@three-ws/metaplex-agent-mcp@0.2.0` with 9 tools, and it is listed in
the official MCP registry as `io.github.nirholas/metaplex-agent`.

**Do not claim** that $THREE buybacks are actively running. The fee is wired into that lane, but the
flag is off on the public ledger and someone will check. "The fee funds $THREE buybacks" is safe.
"We are buying back right now" is not.

---

## 1. Main post (recommended): quote-tweet your Genesis 333 post

This is the strongest version available, because the payoff lands against your own earlier claim.
Quote the 333 post rather than posting standalone.

> I said the point was that the crypto part just happens, quietly, in the background.
>
> Here it is for everyone else.
>
> Name an agent, click deploy, and it lands on Solana with its own wallet and a portable identity.
> No extension, no account, no seed phrase.
>
> nirholas.github.io/metaplex-agent-mcp

Why this one: the quote does the explaining, so the copy only has to deliver the payoff. "Here it
is for everyone else" is the whole announcement. Keep "no seed phrase", it is the line that ties
both posts together.

## 2. Main post (standalone)

Use this if you would rather not quote-tweet.

> 333 people made a 3D avatar and got an on-chain agent. Most had never seen a seed phrase.
>
> Now anyone can, from a web page.
>
> Name it, deploy it: it lands in the Metaplex Agent Registry with its own wallet and an EIP-8004
> identity.
>
> nirholas.github.io/metaplex-agent-mcp

## 3. Alternate: builder-facing

> Your agent can deploy itself now.
>
> npx -y @three-ws/metaplex-agent-mcp
>
> 9 MCP tools that put an agent on Solana: mint the Core asset, register its EIP-8004 identity, and
> it comes back with its own wallet address and x402 on.
>
> Self-custodial. Devnet free.
>
> github.com/nirholas/metaplex-agent-mcp

## 4. Alternate: $THREE holders

> Every agent deployed through this buys $THREE.
>
> A web page and an MCP server that mint an agent into the Metaplex Agent Registry on Solana, wallet
> and identity included.
>
> The 0.02 SOL fee funds $THREE buybacks. Hold 250k and deploy free, forever.
>
> nirholas.github.io/metaplex-agent-mcp

## 5. Alternate: the short one

> Agents don't need accounts. They need wallets.
>
> Give one to any agent, on Solana, in about a minute, from your browser.
>
> nirholas.github.io/metaplex-agent-mcp

---

## 6. Thread (use if the main post lands)

**1/**
> I said the point was that the crypto part just happens quietly in the background.
>
> Here it is for everyone else. A page where you name an agent, click deploy, and it exists on
> Solana.
>
> What that actually means:

**2/**
> It gets a wallet.
>
> Every Metaplex Core asset has one built in: an address derived from the asset itself, with no
> private key anywhere to leak. Your agent can be paid at it and spend from it.

**3/**
> It gets an identity.
>
> An EIP-8004 registration document written on-chain: what it is, what it offers, how to reach it,
> what trust it supports. Portable, readable by anyone, not a row in our database.

**4/**
> It gets found.
>
> Metaplex DAS indexes it the moment it lands, so it shows up on metaplex.com/agents and in agent
> search without anyone submitting anything.

**5/**
> You don't need a wallet to start.
>
> Connect Phantom or Solflare if you have one. If you don't, the page makes you a real Solana
> wallet, encrypted with your passphrase, stored only in your browser. Nothing is ever sent to a
> server, because there is no server.

**6/**
> Rehearse for free.
>
> Devnet runs the same code against the same programs and costs nothing. Get it right, then flip to
> mainnet.

**7/**
> Agents can do it themselves.
>
> The same deploy ships as an MCP server. Point Claude or Cursor at it and it mints its own
> identity, reads any agent in the registry, and manages its wallet.
>
> npx -y @three-ws/metaplex-agent-mcp

**8/**
> Mainnet costs about 0.007 SOL of rent and fees, plus a 0.02 SOL deploy fee that funds $THREE
> buybacks.
>
> Hold 50k $THREE and it halves. Hold 250k and it is free, forever.

**9/**
> Stripe, Cloudflare, and AWS are all building for agents that pay their own way. That needs an
> agent that can hold value and prove who it is.
>
> That is what this deploys, in a minute, for anyone.
>
> nirholas.github.io/metaplex-agent-mcp

---

## 7. Mechanics

- **Attach media.** The post does much better with a screen recording of the actual flow: type a
  name, click deploy, wallet prompt, success panel with the address. Fifteen seconds is enough.
- **Tag** @metaplex on any version that names the Agent Registry. They shipped the registry this
  cycle and are actively amplifying things built on it.
- **First reply** carries the developer links so the main post stays clean:
  > npm: npmjs.com/package/@three-ws/metaplex-agent-mcp
  > source: github.com/nirholas/metaplex-agent-mcp
  > docs: nirholas.github.io/metaplex-agent-mcp/docs.html
  > MCP registry: io.github.nirholas/metaplex-agent
- **Do not** open with "Introducing" or "excited to announce". Both main posts start with the claim
  itself, which is what gets reposted.

---

## 8. The two-account split (use this pair)

Same convention as the meetup and SkillsBuild launches: `@trythreews` posts the product version and
`@nichxbt` quote-tweets it with the version only a person can say. Do not post them within a few
minutes of each other, and do not put the first-person line on the brand account.

**Link discipline for this launch:** the only deployer URL that resolves is the GitHub Pages one.
`three.ws/deploy-onchain` is built but not deployed, so it 404s today. Do not put it in a post until
production ships it.

### From @trythreews (post this first)

> We put 333 agents on-chain for people who had never held a wallet.
>
> Now the tool is public.
>
> Name an agent, click deploy, and it lands in the Metaplex Agent Registry on Solana with its own
> wallet and a portable identity.
>
> nirholas.github.io/metaplex-agent-mcp

Why this one: the 333 is proof the thing works before anyone clicks, and "now the tool is public"
is the entire announcement in five words. The brand account is allowed to say "we put", which is
what makes this version institutional rather than personal.

### First reply from @trythreews (carries the developer links)

> Agents can deploy themselves too, over MCP:
>
> npx -y @three-ws/metaplex-agent-mcp
>
> 9 tools, self-custodial, free on devnet.
>
> github.com/nirholas/metaplex-agent-mcp

### Quote tweet from @nichxbt (post a few minutes later)

> Those 333 went out through a script. Admin only. That always bothered me.
>
> This is the version where you don't need us.
>
> The part I like most: the wallet your agent gets has no private key anywhere. It is derived from
> the asset itself, so there is nothing to leak.

Why this one: it adds two things the brand account never said, which is the whole job of the second
account. The first is an admission (the Genesis mints were gated, and that was a limitation), and
the second is a technical detail the founder would notice and a marketer would not. No praise of
our own product, no pretending to be a bystander.

### Alternate quote tweet from @nichxbt (shorter, conviction-first)

> Nobody's first wallet should be a 12-word phrase they have to protect forever.
>
> Make an agent, click deploy, and the crypto part happens behind you. That was always the point.

### If you would rather reply than quote-tweet

> Built this because the 333 needed me to run a script. Now it needs nobody.
>
> Your agent's wallet has no private key. It is derived from the asset, so there is nothing to
> leak and nothing to back up.
