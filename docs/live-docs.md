# Live Docs

Every code sample in these docs is editable, and the ones that can be run have a
**Run** button. An `<agent-3d>` snippet renders a real, animated avatar right
under the code. A `curl` line sends a real request to the live three.ws API and
shows you the status, the latency, and the response. A `js` snippet executes and
prints its console output.

You are reading the feature's own documentation, so every sample below is live.
Press **Edit**, change something, and press <kbd>⌘</kbd>/<kbd>Ctrl</kbd> +
<kbd>Enter</kbd>.

---

## Try it: a live avatar

This is the same embed snippet from the [`<agent-3d>` reference](web-component.md).
Press **Run preview** and it renders. Then press **Edit**, swap `michelle.glb`
for `xbot.glb`, and run it again.

```html
<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

<agent-3d
  body="https://three.ws/avatars/michelle.glb"
  animation="idle"
  style="width:320px;height:420px"
></agent-3d>
```

Other bodies you can paste in: `xbot.glb`, `cesium-man.glb`,
`realistic-female.glb`, `default.glb`. The full catalogue is on
[/character-library](/character-library).

## Try it: a real API call

```bash
curl https://three.ws/api/version
```

That is the deployed commit and Cloud Run revision serving this page right now.
Here is one with a query string worth editing:

```bash
curl "https://three.ws/api/search?q=robot&limit=3"
```

## Try it: a script

```js
const res = await fetch('https://three.ws/api/coin/markets?limit=3');
const body = await res.json();
console.log('status', res.status);
console.log(body);
```

---

## What becomes runnable

The runner never guesses. A block is offered a **Run** button only when it
matches one of these three shapes.

| Fence language | Becomes runnable when | What Run does |
| --- | --- | --- |
| `html`, `xml`, `svg` | The snippet renders something visible: an `<agent-3d>` / `<model-viewer>` element, a full document, or ordinary structural markup | Renders it in a sandboxed frame under the code |
| `bash`, `sh`, `shell`, `zsh`, `console`, `curl` | The block is exactly one `curl` command | Sends the request from your browser and shows status, latency, size, body, and response headers |
| `js`, `javascript`, `mjs` | The snippet calls `fetch` or `console.*`, and is not a Node or bundler sample | Runs it as a module in a sandboxed frame and streams the console back |

Everything else stays exactly as it was: a `python` block, an `npm install`
line, a `json` payload, a `<meta>` tag sample. A block that would render an empty
box or produce no output is deliberately left alone, because a Run button that
does nothing visible teaches you the feature is broken.

## What can never run

A documentation page is read by people who are often signed in, evaluating the
platform, and clicking things. So the runner is narrow by construction, and the
rules are enforced in a [tested pure
module](https://github.com/nirholas/three.ws/blob/main/public/docs-live-core.js)
rather than in a click handler:

- **Only three.ws.** A sample pointing at any other host is not runnable. It
  cannot be made runnable by editing the URL to something else, either: the
  check re-runs on every keystroke.
- **Money paths are never runnable, on any verb.** Anything whose path contains
  `/pay`, `/send`, `/transfer`, `/withdraw`, `/fund`, `/swap`, `/trade`, `/buy`,
  `/sell`, `/wallet`, `/mint`, `/launch`, `/autopilot`, `/x402`, `/checkout`,
  `/billing`, `/subscribe`, `/sniper` or `/vault` is refused outright. Copy those
  and run them yourself, where you can see what you are signing.
- **Writes need a second click.** `GET` and `HEAD` send on one click. `POST`,
  `PUT`, `PATCH` and `DELETE` arm the button first and print the exact method and
  URL, and only send when you confirm.
- **Requests are anonymous.** Every fetch is sent with `credentials: 'omit'`, so
  your three.ws session never authorizes a sample by accident. If an endpoint
  needs a key, the sample says so and you supply it (see below).
- **Frames are sandboxed with no same-origin access.** Previews and scripts run
  with `sandbox="allow-scripts"` and without `allow-same-origin`, so a snippet
  gets an opaque origin: it can load the three.ws web component over the network
  but cannot read this page, its cookies, or its storage.

## Filling in placeholders

When a sample contains a slot such as `$THREEWS_API_KEY`, `<agent-id>`, or
`YOUR_WALLET`, the runner renders one input per slot and substitutes your values
before sending. Nothing is rewritten in the printed sample, so the page still
shows the canonical form.

Values for ordinary slots (an agent id, a wallet address) persist in
`sessionStorage` for the tab, so typing an agent id on one page carries to the
next. Values whose name looks like a credential (`KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `AUTH`, `PRIVATE`) are held in memory only and are never written to
any storage.

An unfilled slot is left in the URL verbatim rather than substituted with an
empty string, so a forgotten field shows up as `/api/agents/<agent-id>` in the
request line instead of silently calling `/api/agents/`.

---

## For doc authors

Nothing is required. Write a normal fenced code block and the runner decides.

**To opt a block out**, put an HTML comment on the line above it:

````markdown
<!-- live:off -->
```html
<agent-3d body="https://example.com/private.glb"></agent-3d>
```
````

Use that when a sample is illustrative rather than correct: a snippet with a
placeholder host, a deliberately broken example, or markup whose point is the
attribute list rather than the render.

**Keep samples real.** The runner makes a wrong sample visibly wrong, which is
the best reason yet to follow the existing rule that every doc sample uses a live
three.ws avatar URL and a real endpoint. A sample that 404s now 404s in front of
the reader.

**Absolute URLs are left exactly as published; relative ones resolve against the
page you are reading.** A sample correctly hardcodes
`https://three.ws/agent-3d/…` because that is what someone pastes into their own
site, and the preview loads precisely that. A relative URL such as
`/avatars/michelle.glb` would otherwise resolve against `about:srcdoc` and load
nothing, so the frame carries a `<base>` pointing at the reader's own origin.

---

## How it is put together

| File | Role |
| --- | --- |
| [`public/docs-live-core.js`](https://github.com/nirholas/three.ws/blob/main/public/docs-live-core.js) | Pure decisions: block classification, shell tokenizing, the `curl` parser, the safety verdict, placeholder detection, preview document construction. No DOM, no network. |
| [`public/docs-live.js`](https://github.com/nirholas/three.ws/blob/main/public/docs-live.js) | The runner: toolbar, inline editor, placeholder fields, sandboxed frames, response rendering. |
| [`public/docs-live.css`](https://github.com/nirholas/three.ws/blob/main/public/docs-live.css) | Styling, derived from the docs design tokens so the runner reads as part of the page. |
| [`tests/docs-live-core.test.js`](https://github.com/nirholas/three.ws/blob/main/tests/docs-live-core.test.js) | Pins every safety rule above, plus the parser and formatter behaviour. |

The split is the point. Everything that decides what a reader is allowed to fire
is a pure function, so it is unit-tested rather than trusted to a click handler.

The runner is loaded lazily by the docs viewer after the first page renders, and
attaches per block, so a page with no runnable samples costs nothing beyond one
cached module.

## Keyboard

| Key | Where | Action |
| --- | --- | --- |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> | In the editor | Run the sample |
| <kbd>Esc</kbd> | In the editor | Leave the editor, keeping your changes |
| <kbd>Tab</kbd> | In the editor | Insert a tab (it does not move focus) |
| <kbd>Enter</kbd> | In a placeholder field | Run the request |

## Related

- [`<agent-3d>` Web Component API Reference](web-component.md) — the element most previews render
- [API reference](api-reference.md) — the endpoints most `curl` samples call
- [Embed and share](embedding.md) — putting an avatar on your own site
- [MCP tool safety](mcp-safety.md) — the same read/write/irreversible split, applied to agent tools
