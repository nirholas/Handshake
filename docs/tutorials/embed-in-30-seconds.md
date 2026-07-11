# Embed in 30 seconds

The fastest way to put a living 3D agent on a website is two lines of HTML. Paste a `<script>` tag that loads the runtime and an `<agent-3d>` tag that places the agent, save the file, refresh the browser — there's a 3D character animating in the corner of your page, ready to greet visitors. No build step, no npm install, no framework adapter, no API plumbing.

This tutorial walks through those two lines end to end. By the time you finish, you will have an agent live on a real page, you will know exactly which lines to copy, and you will know how to debug it when something gets in the way.

**What you'll build:**
- A live 3D agent embedded on an HTML page with two tags
- A working agent ID from the three.ws editor
- A floating widget that animates, greets, and chats out of the box
- A clear mental model of what the embed loader actually does

**Prerequisites:** A text editor and a browser. You do not need Node, npm, a framework, or any 3D experience.

---

## Step 1 — Get an agent ID

Every embedded agent on three.ws has a permanent ID. The `<agent-3d>` tag uses that ID to fetch the agent's body, personality, skills, and animations from the platform. Without one, there is nothing to embed.

Open [https://three.ws/create](https://three.ws/create) in a new tab. The editor loads with a default avatar in the centre of the canvas. You have two paths from here.

### Path A — Use the default and save

If you want to ship something working as fast as possible, skip every panel for now and click **Save** in the top-right of the editor. The platform creates an agent with the default body, the default personality, and a default greeting. Once saved, the URL in your browser's address bar becomes something like:

```
https://three.ws/agent/0xabc123…def
```

The string after `/agent/` is your agent ID. Copy it. You will paste it into the `<agent-3d>` tag in the next step.

### Path B — Customise first, then save

If you'd rather start from something you've picked yourself, open the avatar gallery on the right side of the editor and click any character. Type a name in the **Name** field at the top. Open the **Personality** panel and adjust the system prompt (or leave the default — you can always come back). Click **Save**.

Either way, the result is the same: a saved agent with a permanent ID. Copy the ID from the URL.

> **Don't have an account?** The first time you save, three.ws walks you through a one-tap sign-in using your wallet. There's no email signup form, no password to forget. The whole flow takes about ten seconds.

---

## Step 2 — Create a test page

Open your editor, create a new file called `index.html` anywhere on your computer, and paste this into it:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My site with an embedded agent</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 720px;
      margin: 80px auto;
      padding: 0 24px;
      line-height: 1.6;
      color: #1a1a1a;
    }
    h1 { font-size: 2.2rem; margin-bottom: 8px; }
    p  { color: #555; }
  </style>
</head>
<body>
  <h1>Welcome to my page</h1>
  <p>
    This is an ordinary HTML file. Scroll, click, do whatever you'd normally
    do. The 3D character in the corner is the embedded agent.
  </p>
  <p>
    Try clicking it. Try saying hi. It works the same in every browser.
  </p>

  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
  <agent-3d agent-id="YOUR_AGENT_ID" mode="floating"></agent-3d>
</body>
</html>
```

Replace `YOUR_AGENT_ID` with the ID you copied in Step 1. That is the only edit you need to make.

Save the file. Double-click it to open in your browser, or drag it into a browser tab.

You should see a 3D character appear in the bottom-right corner of the page within a couple of seconds. It will start an idle animation. Click on it and a chat panel slides open. Type a question, press Enter, and the agent replies — with voice and animation.

That's the whole feature. One script tag, one `<agent-3d>` tag, one working 3D agent.

---

## Step 3 — Understand what the two tags do

It is worth taking a minute to understand what just happened, because once you know, every other embed customisation is obvious.

When the browser hits these lines:

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
<agent-3d agent-id="YOUR_AGENT_ID" mode="floating"></agent-3d>
```

…the following happens in order:

1. The browser fetches `agent-3d.js` from the three.ws CDN. The file is a single self-contained bundle: it brings its own copy of Three.js, the glTF loader, the chat UI, the speech subsystem — everything. There are no other network dependencies at this stage.

2. The script registers `<agent-3d>` as a custom element. Every `<agent-3d>` tag on the page — including the one you just pasted — comes alive and reads its own attributes (`agent-id`, `mode`, and the others covered in the customisation tutorial).

3. The element calls the three.ws API to fetch the agent's manifest: name, body URL, personality, skills, default greeting, and the list of animation clips baked into the GLB.

4. In `mode="floating"`, the element pins itself to the bottom-right corner of the page and renders the 3D scene inside it.

5. Once the avatar is loaded, the element dispatches a `agent:ready` event you can listen to. The agent then begins its idle animation and waits for interaction.

Notice what is *not* on this list:
- No iframe. The agent renders directly in your page's DOM, which means it inherits your site's CSS scope intentionally (we'll cover styling shadows in the customisation tutorial).
- No second script tag. You don't need to load Three.js separately. You don't need to bundle anything.
- No build step. The script is plain JavaScript, served minified from a CDN edge.

The whole thing is by design: two tags, no setup, real 3D in any HTML page.

---

## Step 4 — Where to paste it on a real site

The example file above puts both tags right above `</body>`. That is the recommended placement for any page you embed on. Two reasons:

**Performance.** The script is a module, so it never blocks your page's HTML or critical CSS. Visitors see your headline and copy first, then the agent finishes loading and slides in.

**DOM availability.** When the script runs, every element your page might want to react to is already in the DOM. If you decide later to attach event listeners or call the JS API, you don't have to wrap them in `DOMContentLoaded`.

If your site is built on a framework or CMS, the right place depends on the template system:

- **WordPress** — Use a "Custom HTML" widget in the footer, or paste both tags via a footer scripts plugin like Insert Headers and Footers. Avoid the `<head>` section.
- **Shopify** — Edit `theme.liquid` and paste both tags right before `</body>`.
- **Webflow / Squarespace / Wix** — Each one has a "Custom code / Footer code injection" field in site settings. That is where the tags belong.
- **Next.js / React** — Load the bundle with the framework's script component (`next/script` with `strategy="afterInteractive"`, or a plain `useEffect` injection on the page), then render `<agent-3d agent-id="…" mode="floating"></agent-3d>` in your JSX. The script's only side effect is registering the custom element; it renders nothing on its own.
- **Static site generator (Astro, Eleventy, Hugo, Jekyll)** — Paste the raw tags into your base layout template above `</body>`.

The script never touches the rest of your DOM. The `<agent-3d>` element you placed is the only thing rendered, and in floating mode it pins itself to a corner. This means there's no risk of it conflicting with your existing layout.

---

## Step 5 — Verify it's working

Once the tag is in place and your file is saved, do these four checks in order. They take about thirty seconds and they catch the three most common embed problems.

### Check 1: The agent appears

Reload the page. Within two or three seconds, a 3D character should appear in the bottom-right corner. If it does, you're done — skip to the next section.

### Check 2: The browser console is clean

Open developer tools (F12 or right-click → Inspect → Console). You should see one or two informational lines from `agent-3d.js`, but no red errors. If you see red, the message text usually tells you exactly what to fix.

### Check 3: The network tab shows the right requests

In the Network tab, filter by `three.ws`. You should see:

- `agent-3d.js` (the bundle, around 1–2 MB gzipped)
- A request to the agents API with your agent ID
- A request for the avatar GLB
- A few smaller assets (animations, textures)

All of these should have a 200 status. A 404 on the agent ID lookup means the ID is wrong — recheck Step 1.

### Check 4: Chat actually responds

Click the agent. Type "hello" and press Enter. Within a few seconds you should see the agent speak back. If the chat panel opens but the agent never replies, the most likely cause is a missing brain configuration — go back to the editor at [https://three.ws/create](https://three.ws/create), open your agent, confirm a model is selected in the **Brain** panel, and save again.

---

## Step 6 — Troubleshooting

A short guide to the things that usually go wrong, in roughly the order of how often they show up.

### "I see nothing on the page"

Open the console first. The fix is almost always one of these three:

- **Wrong agent ID.** The most common cause. Copy it again from the URL in [https://three.ws/my-agents](https://three.ws/my-agents) — that's the page that lists every agent you've saved. Paste it into the `agent-id` attribute and reload.
- **One of the tags is malformed.** Check that you copied the full src URL (`https://three.ws/agent-3d/latest/agent-3d.js`), that the script tag has `type="module"`, and that the `<agent-3d>` tag is closed with `</agent-3d>` — custom elements are not self-closing.
- **The page is being served as plain `file://` and something is blocked.** This is uncommon — most browsers allow the embed to work from a local file — but if you hit it, run a quick local server: `python3 -m http.server 8080` and open `http://localhost:8080` instead.

### "The page says the script is blocked"

This is a content security policy (CSP) issue. Your site is allowed to load scripts only from specific domains, and `three.ws` isn't in the list. Open whatever file sets your `Content-Security-Policy` header (often `vercel.json`, `next.config.js`, a meta tag in your HTML, or the security headers section of your CMS) and add the three.ws CDN to the `script-src` and `connect-src` directives:

```
Content-Security-Policy: script-src 'self' https://three.ws; connect-src 'self' https://three.ws;
```

You may also need to add `img-src` and `media-src` if your CSP is strict about those. The agent loads textures and audio from the three.ws CDN too.

### "The avatar loads but it's invisible / a black square"

WebGL isn't working in this browser tab. Causes:

- Hardware acceleration is disabled in the browser settings. Re-enable it.
- A browser extension (ad blocker, privacy extension) is interfering. Try in a private window with extensions off.
- You are on a very old browser. The embed requires WebGL 2 — Chrome, Edge, Firefox, Safari from the last few years all support it.

### "It works in Chrome but not on iPhone Safari"

A few legitimate reasons:

- On iOS, audio cannot play until the user has tapped the page. The agent will appear and animate, but its greeting voice will only fire after the first tap or click. This is an Apple platform restriction, not a bug.
- Older iPads / iPhones with little RAM will throttle WebGL. If the device is more than five years old, the avatar may render at low resolution.

### "I want it not to appear on certain pages"

The simplest answer: just don't include the tags on those pages. If your CMS only lets you set one site-wide footer block, gate them with a tiny conditional based on `location.pathname`:

```html
<script>
  if (!location.pathname.startsWith('/admin')) {
    var s = document.createElement('script');
    s.type = 'module';
    s.src = 'https://three.ws/agent-3d/latest/agent-3d.js';
    document.body.appendChild(s);

    var el = document.createElement('agent-3d');
    el.setAttribute('agent-id', 'YOUR_AGENT_ID');
    el.setAttribute('mode', 'floating');
    document.body.appendChild(el);
  }
</script>
```

Same result, finer control.

---

## Step 7 — Confirm with a real share

Now that the agent is on a page, share that page with one other person. Send the URL to a colleague, a friend, anyone with a browser. Watch them open it for the first time.

This step matters because the embed is built for first-visitor experience — the moment a real human lands on a real page and sees the avatar appear. Watching someone else do it tells you, in fifteen seconds, whether your page is ready to share at scale.

If their page loads slowly: check the network tab on a throttled connection. The bundle is cached aggressively after the first load, so subsequent visits are fast, but the first one fetches everything fresh.

If they comment that the agent is in the wrong corner, or feels too big, or distracts from the page content — that's exactly what the next tutorial fixes.

---

## What you learned

You now know:
- How to get an agent ID from the editor at [https://three.ws/create](https://three.ws/create)
- The two tags that power every three.ws embed — the runtime script and the `<agent-3d>` element
- Where to paste them on different site stacks
- What the embed runtime actually does behind the scenes
- The fastest path to diagnose the three most common failure modes

A working embedded agent is the foundation everything else builds on. From here, every other tutorial in this tier is about turning that working embed into something that matches your brand, your voice, and your visitors.

---

## Next steps

- [Customize size, position and background](/tutorials/customize-appearance) — make the floating widget match your site exactly
- [Pick and swap an avatar in Studio](/tutorials/swap-avatar-in-studio) — change the agent's body without re-editing your snippet
- [Add a greeting and first speech line](/tutorials/greeting-and-first-speech) — make the agent introduce itself to every visitor
- [Share your agent](/tutorials/share-your-agent) — generate a public link, QR code, and rich social previews
- [Build your first agent](/tutorials/first-agent) — go deeper into manifests, skills, and custom chat UIs
- [Getting started](/tutorials/getting-started) — a full tour of the hosted product if you skipped it
