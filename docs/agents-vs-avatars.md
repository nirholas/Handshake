# Agents vs. Avatars

three.ws is built around two distinct concepts: agents (AI minds) and avatars (3D bodies). This page is for anyone who has ever wondered which one they are looking at, and it is the canonical reference for the difference. You will meet both on the [marketplace](/marketplace), on agent pages (`/agents/<id>`), and on avatar pages (`/avatars/<id>`). Confusing them is the single most common source of "where do I click?" questions.

## The one-sentence model

**An agent is a mind. An avatar is a body. You pair them.**

| | Agent | Avatar |
|---|---|---|
| What it is | Identity, skills, memory, wallet | A 3D model (glTF / GLB) |
| URL | `/agents/<id>` | `/avatars/<id>` |
| Primary action | Launch · Chat · Embed | Use this body · Download GLB |
| Reusable? | A user has one or many; each is unique | One avatar can be worn by many agents |
| Lives in | The agent system | The marketplace |
| Owns a wallet? | Yes (Solana + EVM) | No |
| Speaks? | Yes | No — it's just the body |

## The four nouns of three.ws

Every page on three.ws is one of these four things. If you ever feel lost, ask: "Which of the four am I looking at?"

1. **Avatar** — a 3D body. Lives at `/avatars/<id>`. Discoverable in the marketplace.
2. **Agent**: a mind that wears an avatar. Lives at `/agents/<id>`. Yours appear in your dashboard. (Old `/agent/<id>` links redirect here.)
3. **Marketplace** — where avatars (and shared agents) are listed. `/marketplace`.
4. **Studio** — where you assemble: pick an avatar, configure an agent, wire skills. `/studio`.

## Pairing them

You don't use an avatar by itself, and you don't use an agent without a body. Pairing happens in three places:

- **From an avatar page** — click `Start an agent`. This creates a new agent that wears this avatar.
- **From an agent's Studio (Body tab)**: click `Change avatar`. This opens the avatar picker; selecting an avatar attaches that body to the agent (the personality is untouched).
- **From Studio** — pick both sides explicitly. Use this when you want full control over name, skills, description, and wallet setup before publishing.

## One page, both kinds: the studio

Agents and avatars share a single detail page. `/avatars/<id>` and `/agents/<id>` render the same layout: a 3D stage on the left, identity and actions on the right, and tabs for Overview, Chat, Pose, Skills, Plugins and Embed. Everywhere on the platform that links to an entity (the search bar, `/agents`, `/gallery`, the marketplace, the galaxy, launches, profiles) lands you here, so the thing you clicked always opens the same way.

The two modes differ only where the underlying entity does:

| | `/avatars/<id>` | `/agents/<id>` |
|---|---|---|
| Type pill | `Avatar · 3D Body` | `Agent · AI Identity` |
| Title + description | The avatar's | The agent's |
| Views in the switcher | 3D, Chat, AR, Embed | 3D, Chat, AR, Embed, Profile |
| Primary action | `Start an agent` | `Full profile` |
| Chat | Voices the body | Speaks as the agent, using its brain and memory |
| Third tab | `Skills`: add-ons you attach to the body | `Capabilities`: the skills this agent exposes, and their real per-call price |
| Signals row | Views, forks, version, created | Skills, conversations, wallet, on-chain identity, active since |
| Relationship card | `Used by`: the agents wearing this body | `Wearing`: the body this agent wears |
| Below the fold | Related avatars | Similar agents |
| Wallet | Only via a bound agent | The agent's own custodial wallet |

Both directions are one click apart: an agent's `Wearing` card opens its body's page, and a body's `Used by` grid opens each agent that wears it.

### Reading an agent's capabilities

The `Capabilities` tab is the honest answer to "what can I call, and what does it cost?" Each row shows the skill's readable name, its exact slug (the string you pass to the API or an x402 call), and a badge: `Free`, a real price such as `1 USDC`, or `Token gated` when access is holding an NFT rather than paying. A summary line above the list names the cheapest paid call, so you learn the floor without reading every row.

Prices are read straight off the agent record as atomic integers in the mint's own decimals and formatted from those digits, never divided into a float, so a nine-decimal mint stays exact. Buying is not duplicated here: trials, time passes and purchase all live on the [full profile](#the-long-form-agent-profile), which every priced row links to.

### Every tab is an address

The section tabs are a real WAI-ARIA tab list: arrow keys move between them, `Home` and `End` jump to the ends, and only the selected tab sits in the page's tab order. Selecting one writes it into the URL (`?view=chat`, `?view=skills`), so any tab can be linked or bookmarked, and `Overview` is the bare canonical URL with no parameter.

### How to tell which page you're on

- The type pill under the header says it outright, and its `?` link leads back to this page.
- If the page can talk back as a named identity with a wallet, it's an agent.

### The long-form agent profile

An agent carries more than a body: capabilities and skill pricing, economy and holdings, an activity log, trust and on-chain identity, reviews, and developer tooling (embed snippets, MCP wiring, raw metadata). That lives one level deeper at `/agents/<id>/profile`, reachable from the `Full profile` button and the `Profile` segment of the view switcher. The pre-redesign layout is still served at `/agents/<id>/classic`.

### Sharing and canonical URLs

Every entity has exactly one canonical URL: `/avatars/<id>` or `/agents/<id>`. The `?view=` variants (chat, embed) and `?embed=1` are the same page in a different tab, and they all declare the canonical URL, so links collapse to one document when shared. An id shared on the wrong route redirects to the right one instead of showing "not found" (an agent id at `/avatars/<id>` lands on `/agents/<id>`, and the reverse).

### Agents without a body

Agents can exist before they wear anything. Their studio page still renders in full: the identity, wallet, chat and skills all work, and the stage explains the gap with two ways to close it (create a body, or pick one from the marketplace). Body-scoped surfaces (AR, the Pose tab, forks, GLB stats, coin launches) stay hidden rather than rendering empty shells.

## Frequently confused

- **"My agent has no body."** → Open the agent in Studio and use `Change avatar` on the Body tab. You're choosing an avatar to attach.
- **"I want to use this avatar."** → Open the avatar page, click `Start an agent`. You're creating an agent that wears it.
- **"Can two agents share an avatar?"** → Yes. Avatars are reusable bodies; agents are unique minds.
- **"Can one agent change its avatar?"** → Yes, in the editor or via `PATCH /api/agents/<id>` with a new `avatar_id`.
- **"Where does the wallet live?"** → On the agent. Avatars don't have wallets.

## Where to go next

- New here? Start with the [Getting started tutorial](/docs/tutorials/getting-started).
- Want to build your first agent? Read [Build your first agent](/docs/tutorials/first-agent).
- Want to ship a custom avatar? Read [Avatar creation](/docs/avatar-creation).
- Curious about the runtime? Read [How it works](/docs/how-it-works).
