# Embed a three.ws agent on Your Website

This tutorial walks you through every path for adding a three.ws agent to your site — from a no-code copy-paste to a full React integration. Pick the path that matches how you build.

**What you'll learn:**
- Get an embed snippet from the Studio (no coding required)
- Add an agent to a plain HTML page
- Wire it into React or Next.js
- Add it to Webflow, WordPress, or Squarespace
- Show or hide the agent based on scroll position, page URL, or a timer

---

## Before you start

You need an agent ID. Go to [three.ws/studio](https://three.ws/studio), select or create an agent, and note its ID — it looks like `a_abc123` or is a number paired with a chain ID like `42` on Base.

---

## Path 1: Get your embed code (no-code, fastest)

If you don't want to write code, the Studio generates the snippet for you.

1. Go to [three.ws/studio](https://three.ws/studio)
2. Select an agent (or create one — the Talking Agent widget is the most popular starting point)
3. Click **Get Embed Code** in the top-right corner
4. Choose your widget type and placement
5. Copy the snippet

The Studio offers two snippet formats. Here's what each one looks like and when to use it:

**iframe snippet** — works everywhere, more secure sandboxing, no extra script tag needed:
```html
<iframe
  src="https://three.ws/a/8453/42/embed"
  width="320"
  height="420"
  frameborder="0"
  allow="microphone"
  style="border-radius: 16px;"
></iframe>
```

**Web component snippet** — faster to load, more control over styling, requires a `<script>` tag on the page:
```html
<!-- One-time: add to <head> -->
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
  crossorigin="anonymous"
></script>

<!-- Where you want the agent -->
<agent-3d agent-id="42" chain-id="8453" mode="floating"></agent-3d>
```

The iframe is the safer default for platforms where you can't control the `<head>` (Notion, Substack, Medium). The web component is the right choice anywhere you control the full page — it gives you CSS theming, JS events, and better performance.

---

## Path 2: Plain HTML

The complete setup for a static site — no build tool, no framework, no npm.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>My Site</title>

  <!-- 1. Load the agent runtime once, in <head> -->
  <script
    type="module"
    src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
    crossorigin="anonymous"
  ></script>
</head>
<body>

  <h1>Welcome</h1>
  <p>Your page content here.</p>

  <!-- 2. Place the agent wherever you want it -->
  <agent-3d
    agent-id="42"
    chain-id="8453"
    mode="floating"
    position="bottom-right"
    width="320px"
    height="420px"
  ></agent-3d>

</body>
</html>
```

**Placement modes** — the `mode` attribute controls how the agent sits on the page:

| Mode | Behavior | Best for |
|---|---|---|
| `mode="inline"` | Flows with the document, takes up space | Product pages, portfolios |
| `mode="floating"` | Fixed overlay in a corner, always visible | Support chat, site-wide greeter |
| `mode="section"` | Fills its parent container at aspect-ratio | Hero sections, feature spotlights |
| `mode="fullscreen"` | Takes over the entire viewport | Immersive experiences, demos |

For an inline embed with explicit dimensions:
```html
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="inline"
  width="400px"
  height="520px"
></agent-3d>
```

**Lazy loading is on by default.** The agent won't boot until it scrolls into the viewport (powered by `IntersectionObserver`). Add `eager` to load immediately regardless:
```html
<agent-3d agent-id="42" chain-id="8453" eager></agent-3d>
```

---

## Path 3: React / Next.js

### Install

```bash
npm install @three-ws/sdk
```

### Create a wrapper component

```jsx
// components/Agent3D.jsx
'use client'; // Required for Next.js App Router

import { useEffect, useRef } from 'react';
import '@three-ws/sdk'; // registers <agent-3d> as a custom element

export default function Agent3D({ agentId, chainId = '8453', mode = 'floating' }) {
  const ref = useRef();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Listen for conversation events
    const handleMessage = (e) => {
      console.log('Agent said:', e.detail.content);
    };
    const handleReady = (e) => {
      console.log('Agent ready:', e.detail.manifest?.name);
    };

    el.addEventListener('brain:message', handleMessage);
    el.addEventListener('agent:ready', handleReady);

    return () => {
      el.removeEventListener('brain:message', handleMessage);
      el.removeEventListener('agent:ready', handleReady);
    };
  }, []);

  return (
    <agent-3d
      ref={ref}
      agent-id={agentId}
      chain-id={chainId}
      mode={mode}
      style={{ width: '400px', height: '500px', display: 'block' }}
    />
  );
}
```

### Use it in a page

```jsx
// app/page.jsx (Next.js App Router)
import Agent3D from '@/components/Agent3D';

export default function Page() {
  return (
    <main>
      <h1>Welcome</h1>
      <Agent3D agentId="42" mode="floating" />
    </main>
  );
}
```

**Next.js note:** `<agent-3d>` uses browser APIs (`IntersectionObserver`, `WebGL`, `SpeechRecognition`) that don't exist on the server. The `'use client'` directive at the top of the component handles this for the App Router. For the Pages Router, dynamically import with `ssr: false`:

```js
// pages/index.js
import dynamic from 'next/dynamic';
const Agent3D = dynamic(() => import('@/components/Agent3D'), { ssr: false });
```

**TypeScript:** The custom element isn't in the default JSX type definitions. Add a declaration file to silence type errors:

```ts
// types/agent-3d.d.ts
declare namespace JSX {
  interface IntrinsicElements {
    'agent-3d': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      'agent-id'?: string;
      'chain-id'?: string;
      mode?: 'inline' | 'floating' | 'section' | 'fullscreen';
      width?: string;
      height?: string;
      eager?: boolean;
    };
  }
}
```

---

## Path 4: Webflow

### Inline embed on a single page

1. In the Webflow Designer, drag an **Embed** block to the spot where you want the agent
2. Click the `</>` icon to open the code editor
3. Paste:
```html
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
></script>
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="inline"
  width="100%"
  height="480px"
></agent-3d>
```
4. Click Save and preview — the agent appears in place

### Floating agent across all pages

To show a floating agent on every page of your site:

1. Go to **Project Settings → Custom Code**
2. In **Head Code**, add the script tag:
```html
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
></script>
```
3. In **Footer Code** (before `</body>`), add the element:
```html
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="floating"
  position="bottom-right"
></agent-3d>
```
4. Publish — the agent appears on every page of your published site

---

## Path 5: WordPress

### With the "Insert Headers and Footers" plugin (easiest)

1. Install and activate the [Insert Headers and Footers](https://wordpress.org/plugins/insert-headers-and-footers/) plugin
2. Go to **Settings → Insert Headers and Footers**
3. In **Scripts in Header**, paste:
```html
<script
  type="module"
  src="https://three.ws/agent-3d/1.5.1/agent-3d.js"
></script>
```
4. Save

Now on any page or post, switch to the **Code Editor** view (the `</>` icon in the block toolbar), find where you want the agent, and insert a **Custom HTML** block:
```html
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="inline"
  width="100%"
  height="480px"
></agent-3d>
```

For a floating agent on all pages, add this to **Scripts in Footer** instead (step 3 above, use the footer field):
```html
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="floating"
></agent-3d>
```

### With a child theme (advanced)

Add to your child theme's `functions.php`:

```php
function add_3dagent_script() {
    echo '<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>';
}
add_action('wp_head', 'add_3dagent_script');
```

Then add a **Custom HTML** block in the Gutenberg editor wherever you want the agent:
```html
<agent-3d agent-id="42" chain-id="8453"></agent-3d>
```

---

## Path 6: Squarespace

### On a specific page

1. Edit the page, click **Add Block**, choose **Code**
2. Paste the complete snippet (script + element together — Squarespace Code blocks don't share scope):
```html
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="inline"
  style="width: 100%; height: 500px; display: block;"
></agent-3d>
```
3. Click **Apply**

### Floating agent on all pages

1. Go to **Settings → Advanced → Code Injection**
2. In the **Footer** field, paste:
```html
<script type="module" src="https://three.ws/agent-3d/1.5.1/agent-3d.js"></script>
<agent-3d
  agent-id="42"
  chain-id="8453"
  mode="floating"
></agent-3d>
```
3. Save — the agent appears on every page after your next preview or publish

---

## Controlling when the agent appears

### Show after scrolling past the fold

```js
const agent = document.querySelector('agent-3d');
agent.style.display = 'none'; // hidden initially

window.addEventListener('scroll', () => {
  agent.style.display = window.scrollY > 500 ? 'block' : 'none';
}, { passive: true });
```

### Show only on a specific page

```js
if (window.location.pathname === '/contact') {
  document.getElementById('agent-container').style.display = 'block';
}
```

### Greet users who stay on the page for 30 seconds

```js
setTimeout(() => {
  document.querySelector('agent-3d').say('Hey! Can I help with anything?');
}, 30000);
```

### React to agent events

```js
const agent = document.querySelector('agent-3d');

agent.addEventListener('agent:ready', () => {
  console.log('Agent is loaded and ready');
});

agent.addEventListener('brain:message', (e) => {
  if (e.detail.role === 'assistant') {
    console.log('Agent replied:', e.detail.content);
  }
});
```

---

## Customizing the appearance

CSS on the `agent-3d` element controls the container size and position. Internals live inside a shadow DOM, so page CSS can't leak in — but CSS custom properties cross the boundary:

```css
/* Container size and shape */
agent-3d {
  width: 400px;
  height: 600px;
  border-radius: 24px;
}

/* Floating position — override the default bottom-right */
agent-3d[mode="floating"] {
  bottom: 24px;
  right: 24px;
}

/* Theme the UI chrome via custom properties */
agent-3d {
  --agent-accent: #7c3aed;        /* button and highlight color */
  --agent-surface: rgba(15, 23, 42, 0.95); /* chat bubble background */
  --agent-on-surface: #f8fafc;    /* text color */
  --agent-bubble-radius: 20px;    /* corner radius on chat bubbles */
  --agent-shadow: 0 25px 80px rgba(0,0,0,0.4);
}
```

Set a background color with the `background` attribute:

```html
<!-- Transparent (default) — composites over your page -->
<agent-3d agent-id="42" background="transparent"></agent-3d>

<!-- Dark scene background -->
<agent-3d agent-id="42" background="dark"></agent-3d>

<!-- Light scene background -->
<agent-3d agent-id="42" background="light"></agent-3d>
```

---

## Troubleshooting

**Agent doesn't appear at all**
Open the browser console and look for a 404 on `agent-3d.js`. Verify the CDN URL is correct and that the script tag has `type="module"`.

**Agent appears but shows a blank white or black box**
The 3D model couldn't load. Check for CORS errors in the console — your hosting may be blocking cross-origin requests for the `.glb` file. The model URL needs `Access-Control-Allow-Origin: *`.

**Floating agent is hidden behind other elements**
The element has a built-in `z-index` of ~2 billion, but a parent with `position: relative` and a conflicting stacking context can trap it. Add to the parent:
```css
.parent { isolation: isolate; z-index: auto; }
```
Or if the parent truly needs to stack above the agent, wrap the `<agent-3d>` in a sibling element outside that stacking context.

**Agent is too small / too large**
Set explicit `width` and `height` attributes (CSS length values):
```html
<agent-3d agent-id="42" width="480px" height="640px"></agent-3d>
```

**Next.js hydration error**
You're rendering the component server-side. Add `'use client'` at the top of the component file, or use `dynamic(() => import('./Agent3D'), { ssr: false })` in the Pages Router.

**WordPress: agent loads on some pages but not others**
The "Insert Headers and Footers" plugin sometimes conflicts with caching plugins. Clear your page cache (WP Rocket, W3 Total Cache, etc.) after making changes. If the script still doesn't load on cached pages, add the script URL to your caching plugin's "excluded scripts" list.

**Squarespace: agent shows in preview but not after publishing**
Squarespace's developer preview and published output can differ. Try adding the snippet to a code block and republishing. If using Code Injection (footer), check that your Squarespace plan supports it — it requires Business or above.

**Agent not responding to voice input**
`SpeechRecognition` requires a secure origin (`https://`) and explicit browser permission. On HTTP localhost, voice input is available. On a deployed site, make sure you're serving over HTTPS. The browser will prompt for microphone permission on first use — if the user dismissed that prompt, they'll need to re-enable it in browser settings.
