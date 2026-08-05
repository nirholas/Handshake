# OpenAI Select Partner badge: usage rules

The badge is OpenAI's asset, supplied to three.ws with its tier status. These
are the rules that came with it, plus where the files live in this repo.

## The assets

| Format | Repo path | Public URL | Size |
| --- | --- | --- | --- |
| SVG | `public/partners/openai/openai-select-partner.svg` | `https://three.ws/partners/openai/openai-select-partner.svg` | 375 × 177 (vector) |
| PNG @3x | `public/partners/openai/openai-select-partner@3x.png` | `https://three.ws/partners/openai/openai-select-partner@3x.png` | 1125 × 531 |

Prefer the SVG anywhere it renders (web, decks that accept vector). Use the PNG
wherever a raster of the bare badge is required.

For social posts and link previews, post the announcement card below rather than
the bare badge: the badge alone reads as OpenAI's mark, not as our announcement,
and carries none of the required independence line.

## The social cards

Built from the badge, not a redraw of it. Source and renderer:

| Card | Headline | Repo path | Public URL |
| --- | --- | --- | --- |
| Announcement (carries the badge) | "three.ws is an OpenAI Select Partner." | `public/partners/openai/social-card-announcement.png` | `https://three.ws/partners/openai/social-card-announcement.png` |
| Announcement, short phrasing (carries the badge) | "three.ws is an OpenAI Partner." | `public/partners/openai/social-card-openai-partner.png` | `https://three.ws/partners/openai/social-card-openai-partner.png` |
| 3D Studio connector (no badge) | "3D, natively, inside ChatGPT." | `public/partners/openai/social-card-studio.png` | `https://three.ws/partners/openai/social-card-studio.png` |
| Two-mark lockup on white (no badge, no copy) | none | `public/partners/openai/three-ws-openai-lockup.png` | `https://three.ws/partners/openai/three-ws-openai-lockup.png` |
| Two-mark lockup on black (no badge, no copy) | none | `public/partners/openai/three-ws-openai-lockup-dark.png` | `https://three.ws/partners/openai/three-ws-openai-lockup-dark.png` |

## The two-mark lockup uses OpenAI's logomark, not the badge

`three-ws-openai-lockup.png` is the three.ws mark and the OpenAI mark side by side
on white, with a hairline between them and nothing else. It is the asset to reach
for when a post or slide needs to read "these two companies work together" at a
glance and there is no room for copy. `three-ws-openai-lockup-dark.png` is the
same lockup on flat black, with the OpenAI mark in white, for dark surfaces.

Two things to know before using it:

1. **It is not the partner badge.** The badge is the asset OpenAI supplied and the
   only one their partner guidance explicitly grants for the uses listed above.
   The lockup uses OpenAI's logomark, which their brand guidelines govern
   separately, and a co-branded lockup is the kind of use those guidelines
   normally expect a partner to clear first. Owner's call, made 2026-07-28. If
   the goal is a compliant announcement graphic, use `social-card-announcement.png`.
2. **The OpenAI mark in it is not a redraw.** `openai-logomark.svg` is the
   logomark path lifted verbatim from the badge artwork OpenAI supplied, given a
   tight viewBox and `currentColor`. The curves are theirs. It renders solid
   black on light and solid white on dark, which are OpenAI's own treatments;
   never any other colour. Do not add effects, and do not merge it with the
   three.ws cube into a single glyph.

The three.ws side is `marketing/openai-select-partner/cards/three-ws-mark.png`,
the shipped app-icon cube (`public/pwa-512x512.png`) trimmed of its transparent
margin so the two marks can be spaced from their artwork rather than their
bounding boxes.

## Why two announcement wordings exist

The short-phrasing card exists because the owner chose "OpenAI Partner" for the X
post on 2026-07-28. It is the X card only. Every long-lived surface (`/openai`,
the blog post, the press release, LinkedIn, link previews) uses the full-phrase
card, which is what OpenAI's guidance asks for. The badge inside both cards is
untouched and reads "OpenAI Select Partner" either way.

Both are 3200 × 1800 (16:9, X's in-post ratio). The layout lives in
[`cards/social-card.html`](cards/social-card.html); regenerate with
`npm run build:openai-cards` after any copy change, and commit the PNGs.

Only the announcement card carries the badge. The Studio card is a product claim,
so it deliberately shows no badge, which keeps the product copy clear of anything
that could read as an OpenAI endorsement.

## Approved uses

- LinkedIn and other social posts
- The three.ws website and partner pages
- Newsroom and announcement posts
- Event materials
- Sales and customer-facing presentations

## Rules

1. **Use the badge as provided.** Do not recolor it, crop it, rotate it, add
   effects, place it inside another lockup, or rebuild it from parts. The badge
   is white with a black keyline; on a dark surface, place it on a white plate
   with padding rather than inverting it. Both `/openai` and the announcement
   post do exactly this (`.badge-plate`).
2. **Keep clear space around it.** Nothing else inside roughly half the badge's
   cap height on any side.
3. **When referring to the status in copy, write "OpenAI Select Partner."** Not
   "OpenAI partner", not "OpenAI Premier/Advanced/Elite", not "partnered with
   OpenAI on <product>".
4. **Never imply OpenAI endorses a three.ws product.** The partner designation is
   the only claim the badge supports. Every surface that uses it carries a
   trademark and independence line; keep that pattern.
5. **Do not use the badge as a product logo, favicon, app icon, or in any
   position where it reads as the mark of the page itself.**

## Where it is used on the site today

| Surface | File | How it appears |
| --- | --- | --- |
| `/openai` | `pages/openai/index.html` | Full badge on a white plate below the hero; announcement card as the Open Graph image |
| `/blog/three-ws-openai-select-partner` | `blog/three-ws-openai-select-partner.html` | Full badge on a white plate under the headline; announcement card as the Open Graph image |
| `/partners` | `pages/partners.html` | No badge. The card is text only, linking to `/openai` |
| Announcement card | `marketing/openai-select-partner/cards/social-card.html` | Badge as supplied, on a white plate with clear space, alongside the independence line |

If you add a new surface that uses the badge, add a row here.
