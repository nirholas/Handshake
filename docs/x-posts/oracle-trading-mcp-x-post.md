# X post: Oracle and our trading agents become MCP servers

Draft copy for announcing that [Oracle](https://three.ws/oracle) and the three.ws autonomous
trading agents are published as Model Context Protocol servers in
[Anthropic's official MCP registry](https://registry.modelcontextprotocol.io/?q=io.github.nirholas),
so any AI assistant can use them directly.

Build plan this announces: [`docs/oracle-trading-mcp-plan.md`](../oracle-trading-mcp-plan.md).

**Do not post until:** `npm run smoke:mcp` passes against the live remotes, and both
`io.github.nirholas/threews-oracle` and `io.github.nirholas/threews-agent-trader` resolve in the
registry. Every claim below has to be true at post time.

## Rules for this one

1. **Explain it to someone who has never heard of MCP.** The audience is not protocol people. It
   is traders who use Claude and builders who have heard the acronym and never installed one.
   One sentence of plain English up top, jargon only after the reader is already interested.
2. **Lead with the thing, not the plumbing.** Nobody wakes up wanting an MCP server. They want the
   score before the candle. Open on that.
3. **One outbound link in the main post.** Threads can carry more.
4. **Claim only what is live.** We publish to the registry, we do not "partner with Anthropic".
   Do not imply endorsement.
5. **No price talk, no predictions, no moon language.** This is a capability post.
6. **$THREE is the only coin named**, and only if it is naturally relevant. Do not force it in.

---

## 1. Main post (recommended)

> Your AI can now trade with our eyes.
>
> Oracle scores every new pump.fun coin 0 to 100 in the first seconds, from the creator's history,
> who is buying, and how clean the supply is.
>
> It is now an MCP server. One line of setup and Claude reads it live.
>
> https://three.ws/oracle

Why this one: the first line is the whole product in six words, the second line explains it with
zero jargon, and MCP shows up only after the reader already wants it.

## 2. Alternate main post (builder-facing)

> We turned our conviction engine into an MCP server.
>
> `npx @three-ws/oracle-mcp`
>
> Free, no key, no signup. Your agent gets a live 0-100 score on every new launch, the reasoning
> behind it, and the track record so it can decide how much to trust it.
>
> Now in Anthropic's MCP registry.

## 3. Thread (use if the main post lands)

**1/**
> Your AI can now trade with our eyes.
>
> Oracle scores every new pump.fun coin 0 to 100 in its first seconds. It is now an MCP server, so
> Claude can read it live.
>
> Here is what that actually means. 🧵

**2/**
> MCP is a plug for AI assistants. Instead of copy-pasting data into a chat, you connect a tool
> once and the AI can use it whenever it needs to.
>
> Anthropic built it. There is an official registry of them. We just published two.

**3/**
> Server one is Oracle.
>
> Ask your AI "what is worth looking at right now" and it pulls the live board: score, tier, the
> plain-language reasoning, and the honest track record.
>
> Free. No key. No account.

**4/**
> Server two is the trading agent.
>
> Same conversation, next step: "arm my agent on anything scoring 80+, half a SOL a day, simulate
> first."
>
> It runs. You can check what it did and stop it in one sentence.

**5/**
> Simulate is the default. Real spend is opt-in every time, and the per-trade and daily limits are
> enforced on our side, not in the client.
>
> An AI cannot talk its way past them. That is the point.

**6/**
> Why it matters: the first minutes of a new coin are the most lopsided market there is. The people
> with an edge have context you do not.
>
> Oracle is that context, as a number, delivered fast enough to act on.

**7/**
> Both servers are in the official MCP registry now, alongside the rest of ours.
>
> registry.modelcontextprotocol.io/?q=io.github.nirholas
>
> Docs: https://three.ws/oracle/docs

## 4. Reply to attach to whichever post lands

> The scoring model is fitted on our own labeled outcomes, not hand-tuned vibes, and the holdout
> numbers are published on the docs page including the ones that make us look worse.
>
> If you are going to let an agent act on a number, you should get to audit the number.

## 5. If someone asks "what is MCP" in the replies

> It is a standard way to plug a tool into an AI assistant. Connect it once and Claude can use it
> whenever it is relevant, instead of you pasting data in by hand. Anthropic made it and it is
> open. Ours takes one line to add.

---

## Facts a reply might need

Pull the live numbers from https://three.ws/oracle/docs before posting. As of 2026-08-19 the
docs report holdout AUC 0.879, top-decile good-rate 62.5 percent against an 11.7 percent base rate,
and Prime tier at 72.7 percent. **Re-read those from the page at post time.** The model is refit as
labels accumulate, and quoting a stale number in a post about being auditable is the worst possible
place to be wrong.

## What not to say

- Anything implying Anthropic endorses, reviewed, or partnered with us. We published to a public
  registry. That is all.
- "Guaranteed", "alpha", "printer", "financial advice" in any direction.
- A win-rate number without the base rate next to it.
- Anything about the agent being unsupervised. Simulate is the default and the limits are real.
