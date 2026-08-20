# X post: 72 MCP servers in the official registry

Announcement copy for the three.ws MCP fleet as a whole, rather than any single server. The news
is the shape of the thing: one namespace, `io.github.nirholas`, carrying 72 distinct servers in the
official Model Context Protocol registry, every one of them at its current published version.

**Thesis of this announcement:** we did not ship one MCP server and call it a platform. The agent
tooling is a fleet, it is all installable in one command each, and it is all current. Nothing else.
No roadmap, no coin talk.

**Every claim below is true today**, verified against registry.modelcontextprotocol.io on
2026-08-20: 72 distinct servers under `io.github.nirholas`; 36 of them published or version-bumped
in a single run today; zero remaining version gaps between the shipped npm packages and their
registry entries; every stdio server installs with `npx -y @three-ws/<name>`; the newest entry is
`io.github.nirholas/onchain-agent-wallets@0.1.0`, live and flagged latest.

**Things to NOT claim:**

1. **Do not claim a rank, and do not say "most of any publisher".** A partial sweep of the registry
   (3,176 servers) put the largest namespace observed at 213, so 72 is a lot and is not a record.
   The number is impressive without a superlative, and a superlative is exactly what someone will
   spend ten minutes disproving.
2. **Do not imply all 72 are equally mature.** They range from load-bearing servers to small
   single-purpose ones. "72 servers" is true; "72 production platforms" is not.
3. **Do not quote a download or usage figure.** We have not measured one.

---

## 1. Main post (recommended)

268 characters with X's 23-character URL count.

> 72 MCP servers, one namespace, all live in the official registry.
>
> Wallets, payments, 3D avatars, on-chain identity, market data, x402. Each installs into Claude or
> Cursor in one command.
>
> We have been building the agent toolchain, not a demo.
>
> three.ws

Why this one: the number does the work in the first six words, the second line proves it is a range
rather than 72 wrappers on the same API, and the last line is the only opinion in the post. It reads
as a status report, which is the tone that survives scrutiny.

## 2. Alternate: the builder cut

> Every three.ws MCP server is now current in the official MCP registry. 72 of them.
>
> ```
> npx -y @three-ws/onchain-agent-wallets
> npx -y @three-ws/metaplex-agent-mcp
> npx -y @three-ws/x402-mcp
> ```
>
> Agent wallets, on-chain deploy, and x402 payments. Pick one and it runs.

Three real commands beat any adjective. All three are verified working.

## 3. Alternate: the quiet flex

> Shipped 36 MCP server updates to the official registry today.
>
> Not a launch. Just the fleet catching up to the code.
>
> 72 servers total, all current.
>
> three.ws

For an audience that reads restraint as competence. Works best as a reply to your own earlier
launch post rather than standalone.

---

## Thread version

Post 1 is the main post. Then:

**2/**

> The registry entry is the boring part that matters. It means an agent client can discover the
> server, see what it needs, and install it without a human copying a JSON blob out of a README.

**3/**

> What is in there: agent wallets with on-chain spending limits, x402 payment rails, Solana and EVM
> tooling, on-chain agent identity, 3D avatar generation, market data, notifications, and the
> account plumbing underneath all of it.

**4/**

> Every one is self-custodial where money is involved. No server holds a key. The ones that move
> funds show you the transaction and refuse to broadcast without an explicit yes.

**5/**

> The newest is onchain-agent-wallets: give an agent a Solana spending allowance instead of a
> private key, and the token program enforces the ceiling.
>
> github.com/nirholas/onchain-agent-wallets

---

## Notes on framing

- **Lead with the number, not with "MCP".** The count is legible to anyone; the acronym is not.
- **Name concrete categories.** "72 servers" invites the reply "72 of what". Answer it in the post.
- **No $THREE in this one.** The fleet story stands on its own, and the coin belongs in posts where
  a fee or a holder benefit is actually wired, like the metaplex deployer copy.
- Registry namespace, for anyone who asks: `io.github.nirholas`.
