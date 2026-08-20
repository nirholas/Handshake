# X post: staking, balance, and buy SPA inside SperaxOS chat

Announcement copy for the new `/staking` surface on `chat.sperax.io` and the chat-native staking
tool calls (stake, unstake, extend lock, check balance, buy SPA) wired into the assistant.

**Thesis of this announcement:** you no longer need to leave the chat to manage your SPA position.
Ask the assistant to stake, check your balance, or buy SPA, and it runs as a real, guarded on-chain
call, not a redirect to a separate dApp.

**This is a two-part feature, and the two parts are in different states right now. Read this
section before picking a post to publish.**

## Part 1: chat-native staking tool calls, shipped and true today

Verified against the merged code (`88a3684` on `main`, live on `chat.sperax.io`):

- Asking the assistant to stake SPA, unstake, extend a veSPA lock, check balance, mint/redeem USDs,
  or buy SPA routes through real, guarded tool calls, not mocked responses.
- `stakeSpa`, `unstakeSpa`, `increaseStake`, `extendStake` are registered across every wiring
  surface (renders, inspectors, DeFi Guard mutating-API gate, keyword routing) so they render with
  a proper UI card and require the same risk confirmation as any other fund-moving action.
- SPA and USDs are in the Arbitrum token allowlist for the swap tool, so "buy SPA with USDC" works
  without depending on a remote tokenlist refresh.
- "buy spa", "stake spa", "unstake spa" are recognized keyword triggers, so the natural-language
  phrasing works without needing exact tool names.

**This part is safe to announce now.**

## Part 2: the embedded `/staking` page (full app.sperax.io experience in an iframe), NOT ready

The `/staking` page exists, is reachable from the sidebar, and matches SperaxOS's design language.
But the embedded app.sperax.io view inside it does not load yet:

1. `app.sperax.io` returns Cloudflare's managed-challenge 403 to the iframe request, and separately
   sends `X-Frame-Options: SAMEORIGIN`, which refuses to be framed by `chat.sperax.io` at the
   browser level. Both need a Cloudflare zone-level fix (response header transform +
   challenge-skip rule) on `app.sperax.io`, not yet applied.
2. `chat.sperax.io`'s own CSP `frame-src` directive does not yet include `app.sperax.io`. Code fix
   pending, blocked on repo access as of this writing.
3. The wallet connector on the live `chat.sperax.io` build has a corrupted
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` from an unrelated 2026-08-06 deploy incident, so even once
   framing is unblocked, WalletConnect will not work until that value is set correctly and the
   image is rebuilt.

**Do not publish a post claiming "the full app.sperax.io experience is in chat" until all three of
the above are resolved and independently verified with a real browser load, not just an HTTP
status check.** Once fixed, a short follow-up post ("now you can see your full position, not just
the tool card") is a good second post, not a rewrite of the first.

---

## 1. Main post (recommended, publish now)

Leads with the thing that actually works: talking to the assistant.

> You don't need a separate tab to manage your SPA position anymore.
>
> Tell SperaxOS to stake, check your balance, or buy SPA, and it runs as a real on-chain call, with
> the same risk checks as everything else in chat.
>
> chat.sperax.io

Why this one: it makes a concrete, checkable claim ("tell it to stake") instead of a vague platform
claim, and it doesn't reference the embed, which isn't ready.

## 2. Alternate: example-led

> "stake 500 SPA for 6 months"
> "what's my SPA balance"
> "buy SPA with USDC"
>
> All three now run inside SperaxOS chat as real transactions. No new tab, no separate dApp.
>
> chat.sperax.io

Why this one: the three example prompts are copy-pasteable and match the actual hint text shipped
on the `/staking` page footer, so anyone who tries it gets exactly what the post promised.

## 3. Alternate: short/punchy

> Staking, balance checks, and SPA buys now live inside the SperaxOS chat itself.
>
> Ask. It runs. No context switch.

---

## Notes on framing

- **Do not mention $THREE.** This is a Sperax/SPA-specific feature on a Sperax product. Keep the two
  ecosystems separate in copy.
- **Do not claim the embedded app.sperax.io iframe view works.** See Part 2 above. Posting that
  claim before the Cloudflare + CSP + WalletConnect fixes land and are verified in a real browser
  will read as false the moment someone clicks through, since the iframe currently renders a
  broken-content icon.
- **"Real on-chain call, not a redirect" is the phrase doing the work.** SperaxOS has had chat
  before; what's new is that these specific actions are wired as guarded tool calls rather than
  just being informational.
- Update this file (or add a dated addendum below) once Part 2 is verified fixed, so the "NOT ready"
  section doesn't go stale and mislead a future poster.
