# OpenAI Select Partner announcement pack

Everything three.ws needs to announce its **OpenAI Select Partner** status in the
OpenAI Partner Network, plus the rules that govern how the badge may be used.

| File | What it is | Status |
| --- | --- | --- |
| [`press-release.md`](press-release.md) | Draft press release, written against OpenAI's partner template | **Needs OpenAI approval before publishing** (see below) |
| [`social-copy.md`](social-copy.md) | Approved-messaging LinkedIn / X copy, ready to post | Ready |
| [`badge-usage.md`](badge-usage.md) | Where the badge assets live and how they may be used | Ready |
| [`cards/social-card.html`](cards/social-card.html) | Layout source for the two announcement graphics; renders with `npm run build:openai-cards` | Ready |
| `openai-press-release-template.docx` | OpenAI's original template, unmodified, kept as the source of truth for the draft | Reference |

## Badge assets

The badge ships with the site, so it can be referenced from any page, deck, or
announcement by URL:

| Asset | Path | URL |
| --- | --- | --- |
| SVG (preferred, scales cleanly) | `public/partners/openai/openai-select-partner.svg` | `https://three.ws/partners/openai/openai-select-partner.svg` |
| PNG @3x (1125 × 531) | `public/partners/openai/openai-select-partner@3x.png` | `https://three.ws/partners/openai/openai-select-partner@3x.png` |

Both are the assets OpenAI supplied, unmodified. See
[`badge-usage.md`](badge-usage.md) before using either one.

## Announcement graphics

Attach these to posts instead of the bare badge. Both are 3200 × 1800 (16:9).

| Card | URL | Use it for |
| --- | --- | --- |
| Announcement | `https://three.ws/partners/openai/social-card-announcement.png` | The tier-status post on X and LinkedIn, the press release, link previews for `/openai` and the blog post |
| 3D Studio | `https://three.ws/partners/openai/social-card-studio.png` | The product post in the X thread (no badge, so it stays clear of implying endorsement) |

Edit [`cards/social-card.html`](cards/social-card.html), run
`npm run build:openai-cards`, commit the regenerated PNGs.

## Where this is already live on the site

| Surface | Path |
| --- | --- |
| Partner page | [`/openai`](https://three.ws/openai) — `pages/openai/index.html` |
| Announcement post | [`/blog/three-ws-openai-select-partner`](https://three.ws/blog/three-ws-openai-select-partner) |
| Partner directory card | [`/partners`](https://three.ws/partners) |
| History timeline marker | [`/timeline`](https://three.ws/timeline) — `data/timeline.json` |
| Changelog entry | [`/changelog`](https://three.ws/changelog) — `data/changelog.json` |

## The one blocking step

OpenAI requires written approval before a partner publishes a press release
about its tier status. The draft in [`press-release.md`](press-release.md) is
complete and ready to send:

1. Fill in the two bracketed fields at the top of the draft (city and executive
   name/title) if they should differ from the defaults noted there.
2. Email the full release to **rachel.kim@c-openai.com** for OpenAI review.
3. Wait for written approval.
4. Only then publish or distribute it.

Nothing else in this pack is gated. The badge, the site pages, and the social
copy all use OpenAI's own approved assets and approved messaging.

## Training and tier progression

PartnerU (role-based enablement and badging) and the OPN Policy Guide are in the
OpenAI Partner Portal. Partner Locator listing is a benefit of the Advanced and
Elite tiers, not Select, so three.ws will not appear there until it progresses;
the tier requirements are in the OPN Policy Guide.
