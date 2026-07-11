# The agent shell — your agent, the command line, and persistent navigation

three.ws is the platform where every user owns a living, embodied AI agent — and
the agent shell makes that agent the way you *use* the site, not just something
you build on it. It has three layers, each usable on every page:

1. **Your agent, in the first five seconds.** Every visitor gets a named agent
   immediately — no account, no wallet.
2. **An agentic ⌘K command line.** The search palette executes real work in
   place: generate a 3D model, read the day's news, quote a coin, ask a
   question.
3. **A persistent shell.** On shell-enabled pages, navigation swaps only the
   page content — the header, the command line, and your walking agent are
   never torn down.

---

## 1. Your agent (the companion with an identity)

On a first visit, the corner companion summons itself a couple of seconds after
the page loads and introduces itself with a generated name ("Turbo Kraken",
"Chrome Koi") and a light 3D body. The identity is an **ephemeral agent
draft** stored locally — nothing is created server-side until the visitor
claims it.

- The chip under the avatar shows the agent's name. For guests it carries a
  **Claim →** link into `/create-agent`, which prefills the wizard from the
  draft; finishing the wizard `POST /api/agents` creates the real agent (with
  its wallets) and clears the draft. Signed-in visitors see their canonical
  agent's name (from [src/agents/active-agent.js](../src/agents/active-agent.js)).
- The agent reacts to work done through the ⌘K palette — it waves and comments
  when a forge finishes or a digest arrives (`tws:palette-action` DOM events,
  mirrored onto the agent bus as `action:taken`).
- Auto-summon is polite: it waits for `load` + idle, skips visitors with
  `prefers-reduced-motion` or `Save-Data`, skips full-screen 3D/camera routes
  (`/play`, `/tour`, `/scan`, …), and never re-summons after the visitor closes
  the companion. The existing nav "Walk" toggle keeps working exactly as
  before.

Key modules: [src/agents/guest-agent.js](../src/agents/guest-agent.js) (draft
store), [src/shared/agent-names.js](../src/shared/agent-names.js) (namer),
[src/walk-companion-identity.js](../src/walk-companion-identity.js) (chip,
introduction, reactions), auto-start gate in [public/nav.js](../public/nav.js).

## 2. The ⌘K command line

Press **⌘K / Ctrl-K** anywhere. Beyond search, the palette parses executable
verbs and runs them in place against the real public APIs — no account needed:

| Command | Example | What happens |
| --- | --- | --- |
| `forge <prompt>` (also `make`, `generate`, `imagine`) | `forge a bronze dragon statue` | `POST /api/forge` on the free text→3D lane, polls to completion, returns open/download/refine links for the real GLB |
| `digest` (also `briefing`, `what happened today`) | `digest` | `GET /api/news/digest` — the last 24h clustered into narratives, rendered as rows |
| `price <coin>` or `$ticker` | `price btc`, `$sol` | `GET /api/coin/markets` + `/detail`, falling back to pump.fun token search |
| `ask <question>` (or any query ending in `?`) | `ask what is x402?` | `POST /api/chat` — the site agent's answer streamed into the panel; honors the free lane's `retry_after` backoff when it's at capacity |

Grammar rules: commands are strict verb-first parses — a bare verb (`forge`)
or a plain search query is never hijacked. A natural question ("how do agents
pay each other?") is *offered* as an Ask row under the search results, never
auto-run. `Esc` steps back from a run panel to the results; typing does the
same.

For other surfaces: `window.__twsSearch.parseCommand(q)` exposes the grammar,
and `window.__twsSearch.runCommand(q)` opens the palette and executes — both in
[public/search.js](../public/search.js).

## 3. The persistent shell

Pages that mark themselves with `data-shell` on their root `html` element get
same-document navigation: clicking between two shell pages fetches the
destination, swaps only the `main` element (plus title/meta), and pushes
history — the header, footer, corner stack, palette, and companion survive
untouched. Back/forward work the same way. Anything unexpected (an unmarked
destination, a fetch error) falls back to a normal full navigation, so the
shell can only ever *add* continuity.

Page modules opt in through one contract —
[src/shell/page-lifecycle.js](../src/shell/page-lifecycle.js):

```js
import { onPageReady } from './shell/page-lifecycle.js';

onPageReady(({ signal }) => init(), {
	match: (path) => path.replace(/\/$/, '') === '/markets',
});
```

`init` runs on first load and again on every shell navigation back to a
matching path; the previous run's `AbortSignal` is aborted first, so intervals
and document listeners registered with `{ signal }` clean themselves up.

Requirements for a shell page:

- `data-shell` on the `html` element, and `main` as a **direct child of
  `body`** (the standard page skeleton).
- The page's module initializes via `onPageReady` and its async renderers
  tolerate their target elements disappearing mid-flight (a navigation can land
  while a fetch is pending).

Live proof pages: `/markets` and `/coins`
([pages/markets.html](../pages/markets.html),
[pages/coins.html](../pages/coins.html)). The swapper lives in
[src/view-transitions.js](../src/view-transitions.js), which is inlined on
every page by the `view-transitions` plugin in
[vite.config.js](../vite.config.js).

**Caution for that inlined file:** it must stay dependency-free, keep exactly
one `export function`, and contain no HTML-looking sequences in comments or
strings — in dev, runtime-fetched fragments would otherwise render its source
as DOM (the plugin also explicitly skips `nav.html`/`footer.html` fragments for
this reason).

---

## How the pieces reinforce each other

The shell is one loop, not three features: the visitor lands and meets their
agent → the agent points them at ⌘K → a command does real work (a forged model,
a digest) → the agent reacts, building the relationship → **Claim** turns the
relationship into an account with a real agent. Ambient discovery routes
through the agent too — the old "have you tried…" toast stays out of the corner
while the companion is live.

Related: [web-component.md](web-component.md) (the embeddable `agent-3d`
avatar), [coin-pages.md](coin-pages.md) (the market surfaces the shell
navigates), [STRUCTURE.md](../STRUCTURE.md) (surface map).
