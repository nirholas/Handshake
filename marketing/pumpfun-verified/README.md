# pump.fun verified

Announcement graphics for $THREE becoming a verified project on pump.fun.

| File | Size | Use it for |
| --- | --- | --- |
| [three-ws-pumpfun-verified-16x9.png](three-ws-pumpfun-verified-16x9.png) | 3200x1800 (16:9) | Timeline posts, blog headers, link previews |
| [three-ws-pumpfun-verified-1x1.png](three-ws-pumpfun-verified-1x1.png) | 3200x3200 (1:1) | Anywhere the crop is square: profile posts, Telegram, chat previews |

Both render from one layout, [partnership-card.html](partnership-card.html).

## Regenerating

```bash
npm run render:pumpfun-verified
```

Edit `partnership-card.html`, run that, commit the PNGs. The script serves the
page over HTTP and fails loudly if any asset 404s, because a card that quietly
falls back to a system font looks fine until you set it beside the other house
cards. Pass `--scale=3` for a 3x render or `--out=<dir>` to write elsewhere.

## What is on the card

- **three.ws lockup**: `public/brand/three-ws-lockup-on-dark.png`, the standard
  on-dark lockup from the [brand kit](../brand/README.md).
- **pump.fun mark**: `public/marks/pump-fun-alpha.png`, the mark already shipped
  at `public/marks/pump-fun.png` with its light plate flood-filled to alpha so it
  sits on black. The wordmark beside it is set in Space Grotesk 700, matching the
  weight of the three.ws lockup rather than imitating pump.fun's own type.
- **$THREE + green check**, small, near the base: the verification itself.

Palette: `#0a0a0a` ground, `#4ade80` eyebrow, `#00d68f` check, `#1c1c1c` frame.
Type: Space Grotesk (wordmark), JetBrains Mono (eyebrow, footer), all from
`public/fonts/`.

## Copy rules

The card says **verified project**, not partner. pump.fun verification is that
platform's statement that the coin at `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`
is genuinely three.ws's, which is what separates it from the copies trading under
the same name and ticker. It is not a partnership, an endorsement, or an
investment, and copy that ships with these graphics must not imply otherwise.

The same verification renders live across the product from pump.fun's own flag,
never a hardcoded one: see the verification section of [docs/listings.md](../../docs/listings.md).
