# Add a 3D avatar assistant to your site, step by step

This tutorial builds a [three.ws assistant widget](/docs/assistant-widget) from nothing to a polished, branded embed: a floating launcher that opens an animated 3D avatar with a chatbot and a speak mode. By the end you will know every option, how to drive it from your own code, and how to have an AI agent generate the embed for you.

What you need: any web page you can edit, and a browser with WebGL. No account, no key, no build step for the basic path.

---

## Step 1: the one-tag embed

Drop this before `</body>` on any page:

```html
<script src="https://three.ws/assistant/v1.js" async></script>
```

Reload. A launcher button appears in the bottom-right corner. Click it and a 3D avatar rises into a panel with a message box. Type a question and it answers; the reply streams into a speech bubble over the avatar's head. That is the whole widget, running on the free model chain, no configuration.

The avatar, the chat, and the speech all run inside an iframe hosted on three.ws. Your page only loaded a small loader script, so your page never handles a model key and the widget never touches your page's DOM.

## Step 2: make it yours

Everything is a `data-*` attribute. Pick an avatar, name it, tell it about your site, and give it your brand color:

```html
<script src="https://three.ws/assistant/v1.js" async
  data-avatar="/avatars/selfie-girl.glb"
  data-name="Aria"
  data-greeting="Hi! Ask me anything about Acme."
  data-context="Acme is a design studio. Plans start at $20/month. Support: help@acme.example."
  data-accent="#22c55e"></script>
```

`data-context` is the important one: it is what the chatbot knows about your site, injected into its system prompt, so answers are grounded in your business instead of generic. Design all of this visually and copy the exact snippet at [three.ws/assistant](https://three.ws/assistant); that page runs the real widget, so the preview is the product.

## Step 3: choose a background

By default the background is `transparent`, so the avatar stands directly on your page. You can instead paint the panel with a color or a gradient:

```html
  data-bg="ember"                      <!-- a named preset -->
  data-bg="#101820"                    <!-- a solid color -->
  data-bg="gradient:#0b0714,#9d174d,200"  <!-- a custom gradient -->
```

The presets are `ember`, `ocean`, `violet`, `forest`, `dusk`, and `slate`. Anything that is not a valid color, preset, or gradient is rejected inside the frame and falls back to transparent, so a typo never breaks the look.

## Step 4: the two modes

The widget ships with both a **chat** mode and a **speak** mode, and shows a toggle between them. Speak mode is the party trick: the visitor types a line and the avatar says it out loud, with a speech bubble and a talking animation, using the browser's built-in text-to-speech. Lock the widget to one mode with `data-mode="chat"` or `data-mode="speak"`; leave it off (or `both`) to show the toggle.

Speech and spoken chat replies cost nothing and need no key: they use the Web Speech API in the visitor's browser. If a browser has no speech engine, the bubble and animation still play for the estimated duration, so the assistant never looks frozen.

## Step 5: bring your own model key (optional)

Free-lane chat needs no setup. If a visitor wants a private, higher-limit lane, they can open the widget's settings and paste their own Groq or OpenRouter key. That key is stored only in their browser and requests go straight from their browser to the provider; it never passes through three.ws or your page. You do nothing to enable this; it is built into every widget.

## Step 6: drive it from your own code

Install the package if you are in a bundler project:

```bash
npm install @three-ws/assistant
```

```js
import ThreeAssistant from '@three-ws/assistant';

ThreeAssistant.init({ avatar: '/avatars/michelle.glb', name: 'Aria', bg: 'transparent' });

// Later, from anywhere on your page:
document.querySelector('#sale-banner').addEventListener('click', () => {
  ThreeAssistant.say('The spring sale ends tonight, 30% off everything!');
});
```

`say()` opens the widget and speaks the line. You also get `open()`, `close()`, `toggle()`, `setMode('chat' | 'speak')`, and `destroy()`. To react to the widget, listen once on `window`:

```js
window.addEventListener('three-assistant', (e) => {
  if (e.detail.type === 'message') {
    console.log(e.detail.payload.role, e.detail.payload.content);
  }
});
```

The event types are `ready`, `open`, `close`, `message`, `speak:start`, `speak:end`, and `error`.

## Step 7: let an AI agent build it for you

If you use an MCP client (Claude Code, Cursor, Claude Desktop), you can skip the docs entirely. Add the free assistant-widget MCP server:

```json
{
  "mcpServers": {
    "assistant-widget": {
      "command": "npx",
      "args": ["-y", "@three-ws/assistant-mcp"]
    }
  }
}
```

Then ask, in plain language: "build a 3D assistant widget named Aria with an ocean background for my design studio site." The agent calls `build_assistant_widget` and hands back the exact `<script>` snippet, a frame URL, and a `ThreeAssistant.init({...})` call. Ask "what avatars can it use?" and it calls `list_assistant_options`. The server validates every field, so whatever it generates is a working, well-formed embed.

## Where to go next

- The full option reference and API: [Assistant widget docs](/docs/assistant-widget)
- A support chat panel grounded in your page instead of a full-body avatar: [Concierge](/concierge)
- Make a custom avatar to use as `data-avatar`: [the Forge](/forge)
- Every three.ws MCP server: [the MCP catalog](/docs/mcp)
