# Integrations: drop-in 3D agents for any site

Integrations is the catalog of ways to put a three.ws agent on a website you do not
control the runtime of. One script tag gives any page a 3D avatar viewer, a talking
chat agent, a walk companion that roams the corner of the screen, a page narrator, a
live token market widget, or an MCP server that lets Claude and other AI tools drive
your agents. Every option is a paste-in snippet with no backend to run.

Page: [/integrations](https://three.ws/integrations)

## Why it exists

The platform's agents are only as useful as the places they can appear. Integrations
is the distribution layer: it turns an agent, a saved widget, or a live token feed
into something a marketer can paste into a CMS, a developer can wire into a framework,
or an AI assistant can call as a tool. It is the front page of embedding; the deep
per-method references live in [Embedding](./embedding.md) and [Widgets](./widgets.md),
and this doc is the map that points you to the right one.

## How it works

Every integration is a static, self-contained snippet loaded from three.ws. The
avatar, chat, and token widgets share one loader (`/embed.js`) that upgrades custom
elements or `data-widget` script tags into live iframes or web components. The walk
companion and page narrator ship their own small SDKs. Nothing needs an API server on
your side; the agent runtime, rendering, and (for chat) the model calls all run on
three.ws.

The catalog covers six integration types:

- **Avatar Viewer**: a `<threews-avatar>` web component that renders a rigged 3D
  avatar with optional JS control (`play('wave')`, poses, `hide-chrome`).
- **Talking Chat Agent**: a saved widget that renders a 3D agent which listens,
  answers, and speaks, driven by a `data-widget` id from [Widget Studio](https://three.ws/widgets).
- **Walk Companion**: a floating 3D character fixed to a corner of the page that
  walks, gestures, and speaks, loaded from `/walk-embed-sdk.js`.
- **Page Narrator**: an agent that reads and narrates the page it lives on, shipped as
  the `@three-ws/page-agent` package.
- **Token Market Widget**: a live pump.fun-style token feed rendered as a widget,
  driven by a `data-widget` id and the `pumpfun-feed` type.
- **MCP Integration**: the `@three-ws/avatar-agent` server (from the
  `packages/avatar-agent-mcp` workspace), so Claude, Cursor, or any MCP-compatible
  assistant can render, speak, gesture, and emote your agents. See [MCP](./mcp.md).

## Walkthrough

1. **Open [/integrations](https://three.ws/integrations).** Filter the catalog by type
   (avatar, chat, companion, narrator, token, MCP).
2. **Try the live demo.** Each card has a working preview and a Try Live button that
   opens the real embed in a modal.
3. **Copy the snippet.** Every card exposes its exact paste-in code.
4. **Swap in your ids.** Replace the demo widget or avatar id with your own from
   [Widget Studio](https://three.ws/widgets).
5. **Paste it into your site.** Drop the snippet anywhere in your HTML, CMS block, or
   framework component.

## Examples

Avatar Viewer (web component):

```html
<!-- Load once -->
<script src="https://three.ws/embed.js" defer></script>

<!-- Drop anywhere in your HTML -->
<threews-avatar avatar-id="avatar_demo_disk_cz" hide-chrome pose="idle"></threews-avatar>

<!-- Optional: JS control -->
<script>
  const el = document.querySelector('threews-avatar');
  await el.ready;
  el.play('wave');
</script>
```

Talking Chat Agent (saved widget):

```html
<script
  src="https://three.ws/embed.js"
  data-widget="wdgt_demo_talking"
  data-type="talking-agent"
  defer
></script>
<!-- Replace wdgt_demo_talking with your widget ID from three.ws/widgets -->
```

Walk Companion:

```html
<script
  src="https://three.ws/walk-embed-sdk.js"
  data-avatar="avatar_demo_disk_cz"
  data-position="bottom-right"
  data-env="studio"
  defer
></script>
```

Page Narrator:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@three-ws/page-agent/dist/page-agent.global.js"
  data-page-agent
  data-avatar="nova"
  data-auto-narrate
  defer
></script>
```

Token Market Widget:

```html
<script
  src="https://three.ws/embed.js"
  data-widget="wdgt_demo_pumpfun"
  data-type="pumpfun-feed"
  data-width="420"
  data-height="600"
  defer
></script>
```

MCP Integration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "avatar-agent": {
      "command": "npx",
      "args": ["-y", "@three-ws/avatar-agent"]
    }
  }
}
```

The core 3D tools (`inspect_glb`, `validate_glb`, `optimize_glb`, `thumbnail_glb`,
`viewer_url`) and `pump_snapshot` work with no environment variables. Voice,
generation, and signing tools take their own provider keys via `env` (for example
`SOLANA_RPC_URL`, `OPENAI_API_KEY`, `REPLICATE_API_TOKEN`); see the package README
for the full table.

## States and limits

- **Get your own ids.** Demo ids in the snippets are live examples. Create your own
  avatars and widgets in [Widget Studio](https://three.ws/widgets) and swap them in.
- **Self-contained by design.** The embeds run entirely off three.ws; you host no
  backend. The chat and token widgets make their model and data calls server-side.
- **One loader, many widgets.** `/embed.js` can be loaded once and drive multiple
  avatar, chat, and token embeds on the same page.
- **MCP keys are per-tool.** The `@three-ws/avatar-agent` server needs no key for its
  core 3D tools; voice, generation, and signing tools each read their own provider
  key from the environment. The embeds are public and need no key.
- **Deeper control lives elsewhere.** This page is the catalog. For the full web
  component API, iframe and oEmbed options, CSS, and events, use the references below
  rather than duplicating them here.

## Related

- [Embedding Guide](./embedding.md): the full per-method reference (web component, iframe, oEmbed)
- [Widget Types](./widgets.md): every widget type and how to configure one
- [Embody](./embody.md): giving an agent a body in more contexts
- [MCP](./mcp.md): the avatar MCP server for AI assistants
- Pages: [/integrations](https://three.ws/integrations), [/widgets](https://three.ws/widgets)
