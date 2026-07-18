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

## How to tell which page you're on

- Avatar pages (`/avatars/<id>`) show a type pill reading `Avatar · 3D Body`, with a help link that leads back to this page.
- Agent pages live at `/agents/<id>` and show the agent's name, on-chain badge (if registered), and chat surface. If a page can talk back, it's an agent.

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
