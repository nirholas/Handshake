# Creator portfolio: /profile and /u/:username

Everything a creator makes on three.ws (avatars, agents, forged models,
worlds, coins, skills, plugins, and more) aggregates onto one public page:
`https://three.ws/u/<username>`. It is the platform's answer to "who made
this?": feed cards, search results, the diorama gallery, and the forge result
bar all deep-link here. This page documents the portfolio surface itself as
coded: what renders, what makes an item public, how following works from the
page, and every endpoint it calls. How the portfolio fits into the wider
feed/follow/rankings graph is covered in
[The social layer](./social-layer.md#creator-portfolio-uusername).

| Route | What it serves |
|---|---|
| `/u/:username` | The public portfolio. No auth required; anyone can view it. |
| `/profile` | Self-view resolver for the signed-in user (see below). |
| `/u/0x<40 hex>` | Legacy wallet-address profile: the on-chain agent list for that address ([src/erc8004/user-profile.js](../src/erc8004/user-profile.js)). Each chain is read through `readProvider()` from [src/erc8004/chain-meta.js](../src/erc8004/chain-meta.js), which fails over across keyless public RPC nodes so one rate-limited endpoint cannot blank the list. |

All three are served by [pages/profile.html](../pages/profile.html); the page
inspects the path segment and mounts the right view.

## /profile: self-view and claiming a handle

`/profile` resolves who is signed in via `GET /api/auth/me`:

- **Signed in with a username**: redirected to `/u/<username>`.
- **Signed in without a username**: usernames are claimed after signup, so
  instead of dead-ending, the page renders a claim-your-handle form. It
  suggests a handle from the display name or email, validates against
  `^[a-zA-Z0-9_-]{3,30}$`, and saves with `PATCH /api/auth/profile`
  (`{ username }`). A 409 means the name is taken. On success the browser
  lands on the freshly minted `/u/<handle>`. The handle can be changed later
  in `/dashboard/account`, but never cleared.
- **Signed out**: a sign-in link to `/login?next=/profile`.

## What renders on a portfolio

One request, `GET /api/users/:username`, returns the profile plus the first
page of every section; the page then paints in this order.

**Hero.** Optional banner image, profile picture, display name, `@handle`,
bio, and a meta line built only from fields that exist: location, website,
join month, and connected X and Farcaster accounts (from the user's verified
`social_connections`, not free text). Beside it, a live 3D hero: the first
public avatar with a model renders in an auto-rotating `<model-viewer>`.

**Wallet and name pills.** The user's custodial wallet address renders as a
pill. If `<username>.threews.sol` is claimed (checked against
[api/threews/subdomain.js](../api/threews/subdomain.js)), the domain renders
as a verified pill plus a pay-by-name button: visitors can send the creator a
stablecoin payment on Solana, resolved from the name on-chain and signed in
their own wallet ([src/sns/pay-by-name.js](../src/sns/pay-by-name.js)). If
the name is unclaimed and the viewer owns the profile, a claim CTA appears
instead.

**Walking-avatar hero.** The owner's primary avatar walks live in an embedded
`/walk-embed` iframe with two real CTAs: "Say hi" opens the avatar's live
chat surface (`/avatars/:id?view=chat` for an avatar, `/agents/:id#chat` for an
agent), "Walk with me" opens the full walk experience alongside the owner
([src/profile-walk-hero.js](../src/profile-walk-hero.js)).

**Stats strip.** Followers and Following lead and are clickable (they open
the follow-list modal). After them, one tile per non-zero count: Creations,
Avatars, Agents, Widgets, Skills, Plugins, Coins, Memories, For Sale, and
Widget Views. NFT and Accessories tiles append later if the lazy collectibles
call finds any.

**Streak and badges.** The creator's current daily streak and earned badges,
the same records that drive [/rankings](https://three.ws/rankings). The row
is hidden entirely for a user with neither, never an empty "0-day streak".

**Tabbed sections.** Only tabs with content render, the first non-empty tab
is active by default, and the bar hides when fewer than two tabs survive:

| Tab | Contents | Cards link to |
|---|---|---|
| Creations | Forged 3D models, saved worlds, and restyled models, merged by recency. Each card is a live rotating 3D thumbnail with the type badge (Model / World / Restyle), a remix tag where applicable, and a copy-the-prompt button. | `/viewer?src=<glb>` or `/diorama?id=<id>` |
| Avatars | Public avatars with tags, file size, fork count, and a Fork button. | `/avatars/:id` |
| Agents | Public agents with on-chain identity metadata (ERC-8004 id, wallet, `.sol` domain, X / Farcaster) and, when published, a Fork button. | `/agents/:id` |
| Widgets | Public widgets with type and view count. | `/w/:id` |
| Skills | Published marketplace skills with category, per-call price, and installs. | `/marketplace#<slug>` |
| Plugins | Published plugins with installs and rating. | rendered in place |
| For sale | Actively listed avatars, agents, and plugins with price. Cards deep-link to the item's own page, where the existing purchase flow lives; the profile never duplicates checkout. | the item's page |
| Coins | Coins launched through the user's public agents (name, symbol, mint, launch page link). | the coin's live page, else the launching agent |
| Memories | Agent memories the owner explicitly made public. | the owning agent |
| Collectibles | On-chain NFTs across the user's wallets (loaded lazily). | the explorer |
| Accessories | Premium cosmetics the user's wallets purchased. | rendered in place |

## What makes an item public

The portfolio shows only what its backing query allows; there is no separate
"publish to profile" step. As enforced in
[api/users/[username].js](../api/users/%5Busername%5D.js):

- **Avatars**: `visibility = 'public'` and not deleted.
- **Agents**: `is_public = true` and not deleted. Only *published* agents
  additionally get the Fork button.
- **Widgets**: `is_public = true` and not deleted.
- **Skills and plugins**: `is_public = true` on the marketplace record.
- **Coins**: the launch record lives on the agent that minted it; a coin
  appears only when that agent is public and has a confirmed mint.
- **Memories**: private by default. A memory appears only when the owner
  flagged it public, its agent is public, and it has not expired.
- **For sale**: active listings owned by the user whose underlying item
  still exists; a delisted or deleted asset never renders a dead card.
- **Creations**: forge models, worlds, and restyles are anonymous by design
  (they work with no account). A creation is attributed to a profile only
  when its creator was signed in at generation or save time; anonymous rows
  never appear on any profile, by construction.
- **Collectibles**: derived on-chain from the user's custodial wallet plus
  their public agents' wallets, so they follow the agents' own visibility.

The whole payload is public and cached (60 seconds at the edge); nothing on
the page requires the viewer to be signed in to read.

## Following from the portfolio

The portfolio is the home of the follow button documented in
[The social layer](./social-layer.md#follow-graph):

- **Signed-out viewers** see a Follow button that routes to
  `/login?return=/u/<username>` and never a dead control.
- **Signed-in non-owners** get the live button. Its label is derived from
  `GET /api/users/:username/follow`: "Follow", "Follow back" when the profile
  owner already follows the viewer, or "Following" (which flips to
  "Unfollow" on hover). Clicking sends `POST` or `DELETE` to the same
  endpoint; the response carries the fresh `followers_count`, so the stats
  strip updates in the same round trip. Both directions are idempotent, and
  a genuinely new follow rings the owner's notification bell exactly once.
- **Followers / Following counts** open a modal listing either side of the
  graph via `GET /api/users/:username/follows?type=followers|following`.
  Each row carries `is_following`, so the modal renders working follow-back
  buttons inline.
- **The owner** sees Edit profile instead of Follow: a modal that saves
  display name, bio, location, website, profile picture URL, and banner URL
  through `PATCH /api/auth/profile`.

## Forking from the portfolio

Two card-level actions let a visitor take a copy of what they find:

- **Fork an avatar** (`POST /api/avatars/fork` with `{ source_avatar_id }`,
  handler [api/avatars/fork.js](../api/avatars/fork.js)): clones the GLB,
  its agent, and a fresh wallet into the viewer's account. Downstream, forks
  of a paid avatar are what produce the `royalty_paid` notifications
  documented in [Notifications](./notifications.md).
- **Fork an agent** (`POST /api/marketplace/agents/:id/fork`, handler
  [api/marketplace/[action].js](../api/marketplace/%5Baction%5D.js)): clones
  a *published* agent into the viewer's account; unpublished agents render
  no button.

Signed-out visitors who click either are routed to login with a return path
back to the profile. Fork counts bump optimistically on success.

## Backing endpoints

Everything the page calls, in the order it calls them:

| Endpoint | Purpose | Source |
|---|---|---|
| `GET /api/users/:username` | The main payload: user, stats, streak, badges, social links, and the first page of every section. Public, cached 60 s. | [api/users/[username].js](../api/users/%5Busername%5D.js) |
| `GET /api/auth/me` | Resolve the viewer (owner vs visitor vs anonymous). | [api/auth/[action].js](../api/auth/%5Baction%5D.js) |
| `GET/POST/DELETE /api/users/:username/follow` | Follow state and toggling. | [api/users/[username]/follow.js](../api/users/%5Busername%5D/follow.js) |
| `GET /api/users/:username/follows` | Follower / following lists for the modal. | [api/users/[username]/follows.js](../api/users/%5Busername%5D/follows.js) |
| `GET /api/users/:username/creations?before=<iso>` | Cursor pagination for the Creations tab (pages of 24, `?type=model\|world\|restyle` to scope). Returns `{ items, next }`. | [api/users/[username]/creations.js](../api/users/%5Busername%5D/creations.js) |
| `GET /api/users/:username/collectibles` | Lazy wallets + NFTs + accessories. Split out because the NFT providers are slow and billed per call; the response is cached 10 minutes and the profile paints without it. Failure is silent: the surfaces stay absent, never broken. | [api/users/[username]/collectibles.js](../api/users/%5Busername%5D/collectibles.js) |
| `GET /api/threews/subdomain?label=<username>` | Is `<username>.threews.sol` claimed, and by whom. | [api/threews/subdomain.js](../api/threews/subdomain.js) |
| `PATCH /api/auth/profile` | Claim a handle; save profile edits (owner only). | [api/auth/[action].js](../api/auth/%5Baction%5D.js) |
| `POST /api/avatars/fork` | Fork an avatar into the viewer's account. | [api/avatars/fork.js](../api/avatars/fork.js) |
| `POST /api/marketplace/agents/:id/fork` | Fork a published agent. | [api/marketplace/[action].js](../api/marketplace/%5Baction%5D.js) |
| `GET /api/u-og?username=<name>` | The dynamic Open Graph image used when the profile is shared. | [api/u-og.js](../api/u-og.js) |

## Sharing

The header's share button opens a small menu: the native share sheet where
the browser supports it, share to X, and copy link. Page title, description,
and the OG/Twitter card (rendered live by
[api/u-og.js](../api/u-og.js)) are rewritten per profile, so a shared link
unfurls with the creator's actual name and stats. Because that image URL is
what a crawler resolves for `og:image`, a database blip while rendering it
degrades to a real card of the handle already known, sent `Cache-Control:
no-store`, rather than a JSON error body that a crawler would cache as the
unfurl; an unknown handle is still a cached 404 card.

---

## Related pages

- [The social layer](./social-layer.md): the follow graph, feed, and
  rankings this page plugs into.
- [Notifications](./notifications.md): the follow, remix, sale, and royalty
  events a portfolio generates for its owner.
- [Remix economy](./remix.md): what happens when someone remixes a creation
  they found here.
- [Forge](./forge.md), [Widgets](./widgets.md),
  [Marketplace](./marketplace.md): the creation surfaces whose output the
  portfolio aggregates.
