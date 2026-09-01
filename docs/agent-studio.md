# Agent Studio: author brain, memory, body, money, and skills in one place

Agent Studio is the full editing surface for an agent. A persistent live 3D avatar
stage sits beside a tabbed authoring panel: Brain, Memory, Body, Money, and Skills.
Every edit persists to the real agent record and the live avatar updates in place,
so the studio is the single canvas where you shape what an agent knows, remembers,
looks like, charges, and can do. It is sign-in only, because it edits an agent you
own.

Page: [/agent-studio](https://three.ws/agent-studio) (auth required) · APIs: `/api/agents/me`, `/api/agents/:id` (PUT), `/api/brain/chat`, `/api/agent-memory`, `/api/memory/*`, `/api/agents/:id/pricing`, `/api/agents/:id/payments`, `/api/agents/:id/strategies`

## Why it exists

An agent is not one thing; it is a brain, a memory, a body, a wallet, and a set of
skills, and until now each of those lived on a different page. Agent Studio unifies
them into one workspace so you can see the whole agent at once and watch changes take
effect immediately. It is the deep-authoring counterpart to the fast on-ramp in
[Instant Agent Genesis](./genesis.md): Genesis gets you a complete agent in a minute,
Studio is where you make it exactly what you want. For the broader model of what an
agent is, see [Agent System](./agent-system.md).

## How it works

The studio is a shell plus five independently mounted sub-studios, wired over the
real agent APIs.

- **The shell** (`src/studio/studio-shell.js`) builds the layout, the auth, loading,
  empty, and error states, and a persistent `<agent-presence data-mode="stage">` live
  avatar that reuses the platform renderer. It loads the caller's agent (auto-creating
  a default via `/api/agents/me` when needed) and fires `studio-shell:ready` so each
  sub-studio boots without racing.
- **The store** (`src/studio/agent-studio-store.js`) is the shared state. Calling
  `studio.patch(partial)` deep-merges the edit optimistically, then flushes a
  debounced `PUT /api/agents/:id` through the shared `apiFetch` (CSRF and cookie
  handled). A failed PUT rolls the optimistic edit back and emits an `error`, so the
  UI never drifts from the server. Each sub-studio writes only its own domain: a key
  under `meta.studio` (brain, memory, body, money, trading), or the agent's top-level
  `skills` list for the Skills tab.
- **The five tabs**, each a mount point the sub-studio fills:
  - **Brain**: model and provider selection plus the reasoning setup, exercised live
    against `/api/brain/chat` (the same multi-LLM backend documented in
    [Multi-LLM Brain](./brain.md)).
  - **Memory**: what the agent remembers and for how long, over `/api/agent-memory`
    and the `/api/memory/*` context, search, graph, and curate endpoints.
  - **Body**: the 3D avatar, outfit, and animations, reflected live on the stage via
    `/api/avatars/*`.
  - **Money**: wallet, payouts, and per-call pricing via `/api/agents/:id/pricing`
    and `/api/agents/:id/payments`.
  - **Skills**: the capabilities the agent can perform and sell, plus trading
    strategies via `/api/agents/:id/strategies` and `/api/strategies`.

Because the live stage and the editing panel read the same store, an edit in any tab
that changes appearance re-renders the avatar everywhere it appears in the studio at
once.

## Walkthrough

1. **Open [/agent-studio](https://three.ws/agent-studio) and sign in.** The shell
   loads your agent, or creates a default one via `/api/agents/me` on first visit.
2. **Meet the live stage.** The avatar renders beside the tabs and stays mounted as
   you move between them.
3. **Brain.** Pick the model and provider, then test a prompt inline against
   `/api/brain/chat` to hear the agent in its own voice before you commit.
4. **Memory.** Decide what the agent retains and for how long; inspect its memory
   graph and search what it already knows.
5. **Body.** Adjust the avatar, outfit, and animation set. The stage updates as you
   edit.
6. **Money.** Set the wallet, payout, and per-call pricing so the agent can charge
   for its skills.
7. **Skills.** Enable the capabilities the agent can perform and sell, and attach
   trading strategies where relevant.
8. **Everything persists as you go.** Each change deep-merges optimistically and
   flushes a debounced `PUT /api/agents/:id`; a failed write rolls back and tells you.

## Examples

The studio saves through the standard agent update endpoint, so the same edits are
scriptable. Read your agent, then patch a domain under `meta.studio` (see
[Authentication](./authentication.md)):

```bash
# Load (or lazily create) your agent
curl -s https://three.ws/api/agents/me \
  -H "authorization: Bearer $THREEWS_TOKEN"

# Persist a brain edit under the Brain tab's namespace. The tab itself stores a
# node graph plus a compiled summary at meta.studio.brain:
# { version, graph, compiled: { personaPrompt, provider, model } }
curl -s -X PUT https://three.ws/api/agents/<agent-id> \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $THREEWS_TOKEN" \
  -d '{"meta":{"studio":{"brain":{"compiled":{"provider":"claude-sonnet-4-6"}}}}}'
```

Set per-call pricing from the Money tab's endpoint:

```bash
curl -s https://three.ws/api/agents/<agent-id>/pricing \
  -H "authorization: Bearer $THREEWS_TOKEN"
```

## States and limits

- **Auth required.** Studio edits an agent you own, so it is sign-in only. Signed-out
  visitors get a designed auth state, not a broken page.
- **First visit.** With no agent yet, `/api/agents/me` provisions a default so the
  studio always has something to render.
- **A dead backend is a load error, not a silent draft.** `AgentIdentity` never
  throws when the server is unreachable: it falls back to a localStorage copy or
  synthesises a default whose id exists nowhere on the server. Editing that
  record would look normal and fail on every `PUT`, so the store refuses it
  (`not_confirmed`) and the shell renders its real, retryable error state instead.
- **Optimistic with rollback.** Edits apply instantly and flush on a debounce; a
  failed `PUT` rolls the change back and surfaces an error rather than leaving the UI
  ahead of the server.
- **Domain isolation.** Each sub-studio writes only its own key under `meta.studio`,
  so tabs never clobber each other.
- **Live stage fidelity.** The stage reuses the production renderer, so what you see
  in the studio is what renders in embeds and on the agent's profile.

## Related

- [Agent System](./agent-system.md): the full model of what an agent is
- [Instant Agent Genesis](./genesis.md): create the agent Studio edits
- [Multi-LLM Brain](./brain.md): the model backend behind the Brain tab
- [Agent Skills](./agent-skills.md): the capabilities the Skills tab manages
- [Agent Wallets](./agent-wallets.md): the wallet behind the Money tab
- Pages: [/agent-studio](https://three.ws/agent-studio), [/genesis](https://three.ws/genesis), [/brain](https://three.ws/brain)
