# Live steps: documentation that runs

Most API documentation asks you to believe it. A sample response was true when someone pasted it, the endpoint may have changed since, and the only way to find out is to leave the page, open a terminal, and try.

Live steps remove that gap. A tutorial can embed a card that performs a **real request against the live three.ws API, from your browser, right now**, and renders the real response. Nothing is recorded, mocked, or replayed. If the platform changed, the page shows you the change.

Open [Add wallet sign-in to your app](/tutorials/wallet-sign-in) and press **Run it** on the nonce step to see one.

---

## What a reader gets

Each card shows the method and path it will call, a plain-language line about what you are about to observe, and an editable set of query parameters where the endpoint takes them. Pressing the button performs the call and reports:

- the real HTTP status, the round-trip time in milliseconds, and the response size
- the response body, pretty-printed and syntax-coloured, with one-click copy
- for a failure, what actually went wrong and what to do about it, rather than a raw status code

Steps also **chain**. A step can publish named values out of its response, and a later step on the same page can consume them. In the wallet sign-in tutorial the nonce step publishes `nonce`, `domain`, and `uri`, and the next step assembles the exact bytes a wallet would sign from those values. Press the second button without the first and it runs the prerequisite for you, then continues.

When a page carries more than one live step, a **Run every step** bar appears above the first one and walks the whole flow in order.

---

## The security model

Documentation is content, and content must never be able to choose what request a page makes. If a markdown file could name a URL, then anyone who can land a pull request on the docs could make every reader's browser call anything, with the reader's cookies attached.

So live steps invert it: **markdown selects, code decides.**

A `live` block may only name an id that already exists in the registry in [public/live-steps.js](https://github.com/nirholas/three.ws/blob/main/public/live-steps.js). Adding an endpoint to that registry is a code change, reviewed like any other code change. Five invariants back that up, and four of them are checked at load time by `validateRegistry`, which throws rather than degrading:

| Invariant | Why |
|---|---|
| Every step is a `GET` | A live step can never mutate platform state. A registry entry with any other method fails at load. |
| Paths are literal constants matching `/^\/api\/...$/` | Nothing interpolates into the path or the origin, so a step cannot be pointed at another host. Traversal and protocol-relative paths are rejected. |
| Reader input reaches only query values, through `URLSearchParams` | A hostile value is encoded, not obeyed. `../../admin` stays a parameter value. |
| Responses render through the DOM, never `innerHTML` | A hostile response body cannot inject markup into the docs page. |
| Session-shaped fields are redacted before display | Covered below. |

An id that is not registered renders a visible "this live step is not registered" card and issues no request at all, so a typo is loud for the author and inert for the reader.

### Redaction

Fields whose names look like credentials are replaced in the rendered copy, and the card says how many were hidden. The match is on the exact key name, case-insensitively, against a fixed list: `sid`, `csrf`, `csrf_token`, `token`, `access_token`, `refresh_token`, `id_token`, `secret`, `session`, `password`, `authorization`, `cookie`, `api_key` / `apikey`, and `private_key` / `privatekey`. A key outside that list (`foo_token`, say) is shown as is, so name new credential fields from the list. This matters because documentation gets screenshotted, recorded, and pasted into issues, and a page that displays a working session identifier will eventually leak one.

Redaction only touches the **display**. Chained exports read the raw response body, so a step can consume a value that was never shown on screen.

---

## Authoring a live step

### 1. Write the block

In any file under `docs/tutorials/`, add a fenced block with the language `live` containing JSON:

````markdown
```live
{ "step": "siws-nonce" }
```
````

Two optional keys override the card's copy when the surrounding prose needs a different emphasis:

```json
{
  "step": "agents-public",
  "title": "See what the directory returns",
  "note": "Raise the limit and watch the cursor field appear."
}
```

On GitHub, and in any renderer that does not load the viewer, the block degrades to a small visible JSON snippet. Keep a static sample response nearby in the prose so the page still teaches when the card does not render.

### 2. If the endpoint is not registered yet, register it

Add an entry to `STEPS` in [public/live-steps.js](https://github.com/nirholas/three.ws/blob/main/public/live-steps.js):

```js
{
  id: 'platform-stats',
  kind: 'request',
  method: 'GET',
  path: '/api/platform/stats',
  title: 'Read the live platform counters',
  summary: 'Agents, avatars, widgets and chains, counted at request time.',
  docs: '/docs/#api-reference',
  credentials: 'omit',
  inputs: [],
  exports: {},
}
```

- `credentials: 'include'` sends the reader's cookies. Use it only where the answer depends on who is asking, and expect to see the signed-out shape most of the time.
- `inputs` become editable text fields and are sent as query parameters. Give each one a `value` (the default), a `placeholder`, and a `hint`.
- `exports` maps a variable name to a key in the response body, making it available to later steps on the page.

### 3. If the response points at something you can see, render it

Printing JSON proves the API answered. It does not show what the answer *is*. When a response carries the URL of a portrait, a thumbnail, or a GLB, add a `renders` block and the card mounts that asset live underneath the body, so "call the endpoint" and "look at what it returned" collapse into one card:

```js
renders: {
  pick: 'agents[0].avatar_thumbnail',
  kind: 'image',
  alt: 'The portrait of the first agent in the live public directory',
}
```

- `pick` is a dotted path with optional numeric indexes, read from the raw response body. The registry declares it; markdown never supplies one.
- `kind` is `image`, `model`, or `auto` to infer it from the file extension. A `model` mounts in `model-viewer`, orbitable, and drops its auto-rotate under `prefers-reduced-motion`. A host page that has not registered `model-viewer` gets a real link to the file instead of an empty box.
- `alt` is required. A step that renders an asset without alt text fails at load.

The URL comes off the network, so it is treated as untrusted: it must be `https:` or a same-origin absolute path before it can become a subresource, and it is applied with `setAttribute` on a fresh element. A `javascript:` or `data:` value in that field renders nothing. When the field is simply absent, the card stays quiet, because a directory whose first entry has no portrait is a normal response rather than an error.

### 4. For something that is not a request, add a derivation

A `derive` step runs a named pure function in the same file and performs no network call. Use it when the thing worth showing is a transform rather than a response, such as assembling the exact message a wallet signs:

```js
{
  id: 'siws-message',
  kind: 'derive',
  derive: 'siwsMessage',
  title: 'Build the exact bytes to sign',
  summary: 'Composed locally from the nonce response.',
  docs: '/tutorials/wallet-sign-in',
  uses: ['nonce', 'domain', 'uri'],
  inputs: [{ name: 'address', label: 'address', value: '', placeholder: 'Your Solana address' }],
}
```

The function itself lives in the `DERIVATIONS` map and receives one object holding every chained variable plus the reader's input values. A derivation named in a step but missing from that map fails at load.

### 5. Verify

```bash
npx vitest run tests/live-steps.test.js
```

The suite evaluates the shipped `public/live-steps.js`, exercises every invariant above against hostile inputs, and scans every markdown file under `docs/` to confirm each `live` block is valid JSON naming a registered step. A tutorial that references a step you renamed fails there rather than in a reader's browser.

---

## Where it renders

The viewer at [pages/tutorial.html](https://github.com/nirholas/three.ws/blob/main/pages/tutorial.html) loads `/live-steps.js` and `/live-steps.css` and calls `LiveSteps.mount(article)` after parsing the markdown, before the syntax-highlight pass. Any other markdown viewer can adopt live steps with the same three lines.

The card follows the reader's theme through the canonical tokens in `tokens.css`, collapses to a single column under 640px, and drops its spinner and pulse under `prefers-reduced-motion`.

---

## Currently registered steps

| id | Call | Publishes | Renders |
|---|---|---|---|
| `version` | `GET /api/version` | `commit` | |
| `platform-stats` | `GET /api/platform/stats` | | |
| `agents-public` | `GET /api/agents/public` | | first agent's portrait |
| `pump-launches` | `GET /api/pump/launches` | | launching agent's portrait |
| `pump-trending` | `GET /api/pump/trending` | | |
| `skills-catalog` | `GET /api/skills` | | |
| `three-leaderboard` | `GET /api/leaderboard` | | |
| `auth-me` | `GET /api/auth/me` | | |
| `siws-nonce` | `GET /api/auth/siws/nonce` | `nonce`, `domain`, `uri`, `expiresAt` | |
| `siws-message` | local derivation | | |

Run `npx vitest run tests/live-steps.test.js` after editing the registry; the suite asserts this table's invariants against the shipped file.

---

## Related

- [Authentication](/docs/#authentication) covers the endpoints behind the sign-in steps
- [Add wallet sign-in to your app](/tutorials/wallet-sign-in) is the tutorial that uses them
- [API reference](/docs/#api-reference) documents every route a step can call
