# Fork a trade: the one-tap "do what they just did"

Fork is the action that turns three.ws's read-only trading intelligence into
something you can act on without leaving the page. Wherever the platform shows
you a coin, a **Fork** button opens the real pump.fun trade panel for that exact
mint, pre-filled with the size being forked. Your own wallet signs it. three.ws
never holds your funds, never delegates a key, and never places the trade for
you.

Surfaces: [/radar](https://three.ws/radar) · [/trades](https://three.ws/trades)
· [/smart-money](https://three.ws/smart-money) ·
[/ghost-copy](https://three.ws/ghost-copy)
Module: `src/fork-trade.js` · Trade panel: `src/game/coin-buy.js`

## Why it exists

The platform already answers "who is winning and what are they in": the
[Coin Radar](radar.md) scores every launch in its first 90 seconds, the
[Smart Money Radar](smart-money.md) shows which proven wallets are accumulating
right now, [Ghost-copy](ghost-copy.md) replays a leader's real record against
your budget, and the [Live Trade Feed](trading-surfaces.md) opens the full
deep-dive on any mint. Until Fork, every one of those answers ended in a link
out to pump.fun, where you had to find the coin again and start over.

The unit of virality in trading is not "follow me". It is "do what I just did,
right now, in one tap". Fork is that tap, and because a fork is a link, it
travels: any shared artifact can carry one back into the product.

## Using it

**On a page.** Click **Fork** on a radar card, a smart-money card, the coin
deep-dive header on /trades, or a still-open position in a ghost-copy replay.
The trade panel opens on that mint. On ghost-copy it opens at the size your
ghost budget used, so the paper position and the real one match.

**From a link.** Any page that mounts Fork also honors a `?fork=` deep link:

```
https://three.ws/trades?fork=<mint>&fork_size=0.5
```

Landing on that URL opens the trade panel for `<mint>` pre-filled with 0.5 SOL.
The fork params are stripped from the address bar once honored, so a refresh
does not reopen a panel you dismissed. Everything else in the query string is
left alone, including `ref`.

**Share sheet.** The Fork buttons that carry a share icon (the coin deep-dive
header on /trades, the smart-money coin drawer) build that link for you and hand
it to the X / Farcaster / copy panel, with your referral code appended when you
are signed in. That is what closes the loop: the fork you shared pays you when
whoever clicked it signs up.

## What Fork does not do

- **It does not take custody.** The transaction is built server-side (unsigned),
  your wallet signs it, and it is broadcast through the same-origin RPC proxy.
  No key is delegated, no session key is minted, no balance is held.
- **It does not skip the safety checks.** The panel runs the same firewall as
  every other trade surface: honeypot and sell-tax simulation, authority checks,
  liquidity floor, price impact. A coin that fails hard renders **Blocked,
  likely unsafe to buy** and the buy button stays disabled. A forked link cannot
  route around that.
- **It does not trust the link's numbers.** A `fork_size` arrives from whoever
  wrote the link, so it is clamped to a positive amount no larger than 10 SOL
  and rounded to the precision the panel quotes in. The size is a suggestion you
  can edit; the amount you sign is always the one on screen.
- **It is not advice.** A fork is a pre-filled intent, nothing more. The coin may
  be a rug; the wallet you are following may be wrong. The panel shows you the
  pedigree and the risk verdict it has, and then it is your signature.

## Adding Fork to a surface

Three pieces, so a new page adopts it in a few lines.

For a page that renders rows with `innerHTML`:

```js
import { initFork, forkButton } from './fork-trade.js';

// once, on boot: delegates every [data-fork-mint] click and honors ?fork=
initFork();

// per row
row.innerHTML = `
  <td>${escapeHtml(coin.symbol)}</td>
  <td>${forkButton({ mint: coin.mint, symbol: coin.symbol, size: 0.5 }, { className: 'my-fork-btn' })}</td>`;
```

For a page that builds DOM nodes, or whose rows already claim the click (a card
that opens a drawer, for instance), bind the action directly so the event can be
stopped at the button:

```js
import { openFork } from './fork-trade.js';

btn.addEventListener('click', (e) => {
  e.stopPropagation();
  openFork({ mint: coin.mint, symbol: coin.symbol, name: coin.name });
});
```

To offer the share sheet instead of the trade panel, pass `share: true` to
`forkButton`. To build the link yourself, `forkShareUrl(trade)` returns the
absolute URL with the viewer's referral code attached.

Two things to remember when wiring a new surface:

1. **Call `initFork()` before the page's own `writeUrl()`**, or the page rewrites
   the query string and drops the inbound fork params before they are read.
2. **Add `<script src="/referral-capture.js"></script>`** to the page head. It
   parks an inbound `?ref=` code for signup attribution; without it a fork link
   still works but the referrer earns nothing.

### API

| Export | What it does |
| --- | --- |
| `initFork({ root, deepLink })` | Mount delegation and honor `?fork=`. The usual one-liner. |
| `openFork(trade)` | Open the trade panel for `{ mint, symbol, name, image, size }`. |
| `forkButton(trade, opts)` | Markup for a fork or share button (`label`, `className`, `share`, `title`). |
| `forkPath(trade, base)` | The `?fork=` query string for a path. |
| `forkShareUrl(trade, opts)` | Absolute shareable URL, with the viewer's referral code. |
| `mountForkLinks(root)` | Delegation only, no deep link. Idempotent per root. |
| `consumeForkLink()` | Deep link only. Returns whether one was present. |
| `clampForkSize(raw)` / `isMint(v)` | The input guards, exported for callers that validate first. |
| `MAX_FORK_SOL` | The size ceiling a link may pre-fill (10 SOL). |

The trade panel itself takes two options that Fork uses: `amount` (pre-fill the
buy input, SOL) and `elevate` (lift the modal above a page's sticky site nav,
which the /play HUD does not need).

## Related

- [Ghost-copy](ghost-copy.md): find out what a leader would have done to your
  budget before you fork anything.
- [Copy trading](copy-trading.md): when one fork at a time is not enough and you
  want a leader mirrored automatically under hard spend limits.
- [The trading surfaces](trading-surfaces.md): where every fork button lives.
- [Smart Money Radar](smart-money.md): the proven-wallet ledger behind the coin
  pedigree the panel shows you before you sign.
