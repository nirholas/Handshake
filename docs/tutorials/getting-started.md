# Getting started: your first hosted agent

By the end of this tutorial you'll have a live 3D AI agent — a character with a body, a personality, and a public URL you can paste into a chat, a tweet, or a website. No code, no 3D software, no wallet. Five minutes, start to share.

This is the easiest entry point on the platform. Everything you do here is editable later, so don't overthink any single choice — the goal is to get something live and shareable.

**Prerequisites:** a modern browser (Chrome, Firefox, or Safari) and an email address. No coding experience, no 3D files, and no crypto required. You'll sign in once, partway through, to save your work.

---

## What you're building

A hosted agent is three things stacked together: a **body** (a 3D avatar), a **brain** (an LLM plus a personality you write), and a **public page** anyone can open.

```
You:    pick a body  →  name it  →  describe its personality
        ↓
Result: three.ws/@aria  →  a 3D character that talks, on a page you can share
```

![The body half of that stack, live. This is the platform default avatar, rendered here by the same viewer your agent page uses. Drag it.](figure:live:/avatars/default.glb)

A concrete example. Say you run a small coffee roaster and want a friendly guide on your site:

```
Name:        Aria
Personality: "You are Aria, the guide for Bean & Brew coffee roasters.
              You're warm and concise. You answer questions about our
              beans, brewing methods, and shipping. If you don't know
              something, you say so and point people to hello@beanbrew.co."
Shared at:   three.ws/@aria  (and embeddable on beanbrew.co)
```

That's the whole loop. Pick a body, give it a voice, share the link.

---

## The three pieces (one minute of concepts)

Before you start, it helps to know the difference between the two core objects on the platform:

| | What it is | The analogy |
|---|---|---|
| **Avatar** | A 3D model — the body, with a rig so it can move | The actor's body |
| **Agent** | An avatar **plus** a brain: an LLM and the personality you write | The character the actor plays |

You'll create an avatar first, then turn it into an agent by giving it a personality. The platform handles all the 3D rendering, the rig, and the animations — you never touch a 3D tool.

For a deeper take on the distinction, see [Agents vs. Avatars](/docs/agents-vs-avatars). To go straight through, just follow the steps below.

---

## Step 1: Open the create flow

Go to **[/create](/create)**. This is the launchpad for every way to make a body.

![The /create launchpad, with the customize, template, upload and scan starting points laid out as cards.](figure:page:/create)

You'll see a few starting points. For the fastest five-minute path, you have two good choices:

- **Customize a base avatar** (the recommended hero card) — click **Open editor** to sculpt a face, pick outfits, and adjust colors in the browser. Free, no sign-in to start, about a minute.
- **Start with a template** — click **Browse templates** to pick a ready-made character and make it yours. The fastest option at roughly 15 seconds.

If you already have a model, the **Upload your own GLB** card takes any glTF 2.0 / `.glb` file via **Choose file**. There's also **Scan yourself to 3D** (point your camera and hold still) if you'd rather star as your own agent — that one asks you to sign in first.

Pick one. For your first agent, **Start with a template** is the quickest way to reach the finish line; you can always swap the body later without losing the personality.

---

## Step 2: Name it and choose "Agent"

Whichever starting point you picked, you land on the **preview page** at [/create-review](/create-review). Your 3D character renders in the viewer — drag to orbit it, scroll to zoom.

On the right, fill in two things:

1. **Name & handle** — type a name in the field (placeholder: *"Give your avatar a name"*). As you type, a live handle preview shows the public URL your agent will get, like `three.ws/@aria`. There's a **Copy** button next to it once a handle is reserved.
2. **Is this an agent or an item?** — choose **Agent** (described as *"Thinks, talks, remembers — can go on-chain"*). The other option, **Item**, is for static 3D props with no brain — not what you want here.

Picking **Agent** is the choice that gives your character a mind. Don't pick Item.

---

## Step 3: Save it (sign in once)

Click the primary button. Its label depends on whether you're signed in:

- If you're already signed in, it reads **Save to my account**.
- If you're not, it reads **Sign in to save** — clicking it sends you to sign-in and brings you right back to this exact preview afterward, so you don't lose your work.

> The preview lives only in your browser until you save. That's why signing in is required at this step: it claims your handle and creates the agent record on the platform. Use the email sign-in option — no wallet needed. (Wondering about the crypto stuff? See [Do I need crypto?](/docs/do-i-need-crypto) — short answer: not for this.)

After it saves, you land on a short **"Your agent is ready"** screen with next steps. The first one — **Chat with your agent** — is where the personality gets set. Click it.

---

## Step 4: Give it a personality

**Chat with your agent** opens your agent in the app at `/app?agent=<your-agent-id>`. Here you can talk to it directly and shape how it behaves.

To write its personality properly, open the agent's editor: from your **[dashboard](/dashboard)**, find the agent and open **Edit** (the editor lives at `/agent/<id>/edit`). It's organized into tabs across the top — **Persona**, **Outfit**, **Voice**, **Knowledge**, **Skills**, **Publish**, **Embed**, and more.

Two fields define who your agent is:

- **Persona tab → Description** — a short, public-facing summary of the character (up to 500 characters). Click **Save** when you're done.
- **Publish tab → Agent Profile (system prompt)** — the real instructions the agent follows, in plain language (the placeholder shows *"You are a professor of computer science…"*). This is the heart of the personality. Write it in the second person, like you're briefing an employee:

```
You are Aria, the guide for Bean & Brew coffee roasters.
You're warm, concise, and never pushy. You answer questions about our
single-origin beans, brewing methods, and shipping. When you don't know
something, say so plainly and point the person to hello@beanbrew.co.
Keep replies to two or three sentences unless asked for detail.
```

The clearer and more specific you are, the better the agent behaves. State its name, its job, its tone, and what to do when it's unsure. You can also set a **Greeting (demo first message)** on the Publish tab so visitors get a warm opening line.

When you're happy, click **Publish to Marketplace** on the Publish tab to make the agent's public page live.

---

## Step 5: Share the URL

Your agent now has a public page at **`three.ws/agents/<id>`**, and a friendly handle URL like **`three.ws/@aria`**. Open it — anyone can talk to your agent there in 3D.

On the public agent page you'll find a **Share** button to copy the link, and an **EMBED THIS AGENT** section with three ready-to-copy snippets:

- **Web component** — a `<script>` tag plus an element you drop into any HTML page.
- **Iframe** — a self-contained frame for sites where you can't add scripts.
- **Direct link** — just the URL, for chats, emails, or social posts.

Each has its own **Copy** button. For sharing in a message, copy the **Direct link**. To put the live agent on your own website, copy the **Web component** snippet and paste it into your page — that's the whole integration.

That's it. You created a body, gave it a brain, and shipped a shareable URL.

### See the directory you just joined

Publishing puts your agent in the public directory, and that directory is a plain public API. Press Run below: this page calls it live, from your browser, with no key and no account.

```live
{ "step": "agents-public" }
```

Every field you filled in above (name, description, skills) is in that JSON, and the portrait rendered under it is the real avatar of the first agent in the list. That combination is what makes an agent embeddable, searchable, and reachable by other agents.

---

## Troubleshooting

- **The Save button says "Sign in to save" and I lost my preview.** You didn't — sign-in returns you to the same preview and resumes the save automatically. Finish signing in, and the button becomes **Save to my account**.
- **My 3D model doesn't appear in the preview.** Orbit and zoom first (drag / scroll) in case it loaded off-camera. If it still doesn't show, go back to [/create](/create) and pick a template instead of uploading — templates are guaranteed to render.
- **I uploaded a GLB and it was rejected.** The uploader only accepts valid `.glb` (glTF 2.0 binary) files. Re-export as `.glb`, or skip the upload and use a template for now.
- **I picked "Item" by mistake.** Items have no brain. Start over from [/create](/create) and choose **Agent** on the preview page — or, if you already saved it, open the agent editor and promote it.
- **The agent replies generically / ignores its personality.** The personality lives in **Publish → Agent Profile (system prompt)**, not just the Description. Make it specific (name, role, tone, fallback behavior), click **Publish to Marketplace**, then start a fresh chat to test.
- **"Sign in to save" but I don't want a wallet.** You don't need one. Use the email sign-in option — wallets are only for the optional on-chain step, which this tutorial skips entirely.
- **I hit an avatar limit.** The free plan caps how many avatars you can keep. Delete one you don't need from the [dashboard](/dashboard), then create the new one.

---

## Recap

You shipped a hosted agent in five minutes, no code:

1. **[/create](/create)** — picked a body (template, in-browser editor, upload, or selfie scan).
2. **[/create-review](/create-review)** — named it, chose **Agent**, and clicked **Save to my account** (signing in once).
3. **Chat with your agent** — opened it in the app, then the **Edit** view.
4. **Persona → Description** and **Publish → Agent Profile (system prompt)** — wrote the personality and clicked **Publish to Marketplace**.
5. **`three.ws/@your-handle`** — shared the public URL, or copied an **Embed** snippet to put it on your own site.

Everything is editable forever — swap the body, rewrite the prompt, add capabilities — without breaking the URL you shared.

**See also**

- [Make your first agent](/docs/make-your-agent) — the same path with extra screenshots and context.
- [Agents vs. Avatars](/docs/agents-vs-avatars) — the body-vs-brain distinction in depth.
- [Embed in 30 seconds](/docs/tutorials/embed-in-30-seconds) — put your agent on any web page with one line.
- [Create, enhance & edit agent memory](/docs/tutorials/create-and-edit-memory) — teach your agent durable facts it carries between sessions.
- [Build a custom skill](/docs/tutorials/custom-skill) — give your agent a new capability, like calling a live API.
- [Do I need crypto?](/docs/do-i-need-crypto) — honest answers on wallets and the optional on-chain step.
