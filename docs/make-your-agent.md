# Make your first agent

This guide walks you through creating a 3D AI agent in the browser — no code, no 3D software, no crypto wallet required.

**Time:** about 5 minutes  
**What you'll have at the end:** a live 3D AI character you can share or embed on any website

---

## Step 1 — Open the wizard

Go to [three.ws/start](/start). This is the new-agent wizard.

You'll be asked to sign in if you haven't already. See [Do I need crypto?](./do-i-need-crypto.md) if you're not sure which sign-in option to choose.

---

## Step 2 — Pick an avatar (the body)

The first step of the wizard asks you to choose a body for your agent.

**Your options:**

- **Browse the gallery** — hundreds of ready-made 3D characters, from realistic to stylized
- **Take a selfie** — upload a photo and get a 3D version of yourself in about a minute at [/create/selfie](/create/selfie)
- **Upload a GLB** — any rigged glTF/GLB file works. Drag it into the editor at [/app](/app) or import from a URL

Not sure what an avatar is vs. what an agent is? Read [Agents vs. Avatars](./agents-vs-avatars.md).

---

## Step 3 — Name your agent and describe its personality

Give your agent a name and a short description of who it is. For example:

> *"You are Aria, a helpful product guide for Acme Corp. You speak in a friendly, concise tone. You know everything about our products and can answer questions about pricing, features, and how to get started."*

This description is your agent's system prompt — the instructions it follows. You can always edit it later.

---

## Step 4 — Enable skills (optional)

Skills are extra capabilities you can give your agent. The wizard offers:

| Skill | What it does |
|---|---|
| **Memory** | The agent remembers what you tell it across sessions (on by default) |
| **Deep thinking** | The agent reasons step by step before answering (on by default) |
| **Web research** | The agent can look things up in real time |

There is also an optional crypto group (pump.fun monitoring/trading, a Solana wallet, and x402 pay-per-call) you can reveal and enable if you want an on-chain agent; skip it entirely otherwise.

You can add or remove skills at any time from the agent's edit page. Voice (microphone input and spoken replies) isn't a wizard skill: you configure it later on the Voice tab of the agent editor.

---

## Step 5 — Publish and get your embed

Once you hit **Publish**, your agent gets a live URL: something like `three.ws/agents/abc123` (plus a friendly handle URL like `three.ws/@aria` once you reserve a handle).

The wizard also gives you an **embed snippet**: a few lines of HTML you can paste into any webpage to make the agent appear there. You don't need to know HTML to do this — just copy and paste.

For more on where and how to embed, continue to [Share & embed →](./share-and-embed.md)

---

## Editing your agent later

Everything is editable after publishing. Go to your agent's page and click **Edit**. You can change:

- The avatar (swap the body without losing the personality)
- The system prompt / personality
- Which skills are active
- The agent's name, description, and thumbnail

Changes take effect immediately — no republishing needed for most settings.

---

## What's next

- **Put it on your website** → [Share & embed](./share-and-embed.md)
- **Understand how it all works** → [How it works](./how-it-works.md)
- **Give the agent a custom skill** → [Create a custom skill](./tutorials/custom-skill.md)
- **Make it yours permanently (on-chain)** → [Register on-chain](./tutorials/register-onchain.md)
