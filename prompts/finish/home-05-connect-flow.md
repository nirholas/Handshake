# 05. The connect flow: `/home` onboarding, every state

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first. Order
[03](home-03-api-surface.md) must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated. Start the dev server and exercise this in a real browser; a UI
order that was never opened is not done.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
npm run dev &                                            # port 3000
curl -s localhost:3000/api/home -H "cookie: <dev session>" | head -c 300
grep -n "materialize" vercel.json | head -4              # the page-route pattern to copy
ls pages/ | grep -E "materialize|agent-detail" ; ls src/ | grep -E "materialize|agent-detail"
grep -n "^--" public/tokens.css | head -20               # the vocabulary you must use
```

## What this order owns

Getting a stranger from "I have a Home Assistant somewhere" to "my agent is connected", and
every way that goes wrong. It owns no 3D (order 06) and no voice (order 08).

Route `/home` via a `vercel.json` `routes` entry to `pages/home.html`, controller `src/home/connect.js`.
Follow the `/materialize` precedent exactly: a `routes` entry, a page file, a module in `src/`.

## The flow

1. **Signed out**: the value proposition and a sign-in, not a form that will fail.
2. **No home yet**: the connect card. Two fields, base URL and token, plus a link to the exact
   Home Assistant path for minting one (Profile, Security, Long-lived access tokens, Create
   token). Never make the user search for it.
3. **URL typed**: validate client-side with `normalizeBaseUrl` and `isPrivateHost` from
   `@three-ws/home-bridge`, **before** any network call, and say the true thing immediately:
   a `192.168.x.x` or `.local` address cannot be reached by three.ws. Offer the two real paths
   (a remote https URL now, or the add-on from order 10 when it lands) rather than a dead end.
4. **Verifying**: a real progress state naming what is happening ("opening a connection",
   "reading your rooms"), never a bare spinner and never a fake progress bar.
5. **Connected**: the house summarised. Rooms found, entities found, whether `mcp_server` is on
   and how many tools it exposes, the Home Assistant version. All measured, never assumed.
6. **Managing**: the list of homes, per-home status, the standing allowances with a revoke on
   each, the action log, and a disconnect that says plainly what it does to the stored token.

## Every state you must build

There are eleven, and a missing one is what makes a product feel unfinished. Each gets a
designed treatment using `public/tokens.css` primitives:

| # | State | Must |
|---|---|---|
| 1 | Signed out | explain the feature, offer sign-in, never a disabled form |
| 2 | Empty (no homes) | the connect card, with the token instructions inline |
| 3 | Validating input | inline, immediate, before the network |
| 4 | Private-host refusal | name the address class and give the two real options |
| 5 | Verifying | named steps, skeleton not spinner, cancellable |
| 6 | Connected | the measured summary, and a clear next action into `/home/:id` |
| 7 | `auth` failure | "create a new long-lived token", with the path, and the field refocused |
| 8 | `unreachable` failure | distinguishes "wrong address" from "house offline", offers a retry and the add-on path |
| 9 | Degraded (connected, breaker open, or stale) | the last known state visibly marked stale with its age, never an empty house |
| 10 | Revoked / disconnected | says the stored credential was scrubbed, offers reconnect |
| 11 | Many homes | the list scales past one without a redesign; long labels truncate without breaking layout |

## Quality bar (non-negotiable)

- Every interactive element has hover, active, focus-visible and disabled states.
- Keyboard: the whole flow is completable without a mouse. Focus moves to the error on failure.
- The token field is `type="password"` with a reveal toggle, `autocomplete="off"`, and is never
  written to `localStorage`, never logged, never put in a URL, and never echoed back by the API.
- Nothing shifts layout when async data lands. Reserve the space.
- 320px, 768px and 1440px all work. Test all three.
- Every user-supplied string (the label, entity names, area names) is rendered as text, never as
  HTML. This is the same untrusted-input rule as order 04, on the render side.
- Copy is plain language. "Your home is only on your local network" beats "ERR_PRIVATE_HOST".

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | Route and page shell, wired into `data/pages.json` so it is discoverable. | `vercel.json`, `pages/home.html`, `data/pages.json` |
| 2 | The connect controller with all eleven states. | `src/home/connect.js`, `src/home/home.css` |
| 3 | Client-side reachability validation using the published package, so the same logic runs both sides. | same |
| 4 | The manage view: list, status, grants with revoke, action log, disconnect. | `src/home/manage.js` |
| 5 | i18n: every string through the existing extraction path (`npm run i18n:extract`). | as generated |
| 6 | Playwright e2e covering the happy path and at least four failure states. | `tests/e2e/home-connect.spec.js` |
| 7 | Docs and changelog. | `docs/smart-home.md`, `data/changelog.json`, `STRUCTURE.md` |

## Definition of done

- [ ] Screenshots of all eleven states at 1440px, and states 2, 5, 6 and 8 at 320px.
- [ ] A real connect against a real local Home Assistant, in a real browser, with the network tab showing the real `POST /api/home/connect` and its real response.
- [ ] A private-host address produces the designed refusal with no network call. Prove it with an empty network tab.
- [ ] A wrong token produces state 7 with the field refocused, not a generic error.
- [ ] Stopping the Home Assistant container puts a connected home into state 9 with a visible staleness age, and the room list stays on screen.
- [ ] Zero console errors and zero console warnings from your code, on every state.
- [ ] `npm run audit:web` passes for `/home` (see `docs/ops/page-audit.md`; use `audit:web:login` first for the authed sweep).
- [ ] Keyboard-only completion of the connect flow, recorded as a step list in your report.
- [ ] `npx playwright test tests/e2e/home-connect.spec.js` passes.
- [ ] The token never appears in `localStorage`, in a URL, in a console line, or in any API response. Prove each with the command you used.
- [ ] `npm run audit:docs` clean, `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| No Home Assistant to connect to | Run one; the docker command is in the context file. Never build a UI against a fixture and call it verified. |
| No QA login | `AUDIT_EMAIL` / `AUDIT_PASSWORD` in `.env`, or `npm run audit:web:provision` to create one through the real register page. |
| A state is hard to reproduce | Force it: stop the container for state 9, use a junk token for 7, use `192.168.1.10` for 4. Every state here is reachable in under a minute. |
| Tempted to store the token client-side "to make reconnect easier" | Refuse. It goes to the server once, encrypted at rest, and never comes back. |
| The design feels sparse | Read `DESIGN-TOKENS.md` and a shipped surface (`/materialize`) before inventing anything. Consistency beats novelty here. |

## Report format

1. The screenshot set (eleven states, plus the four mobile ones).
2. The real connect transcript from the browser network tab.
3. The no-network-call proof for the private-host refusal.
4. The keyboard-only walkthrough.
5. The four token-leak proofs.
6. `audit:web`, Playwright and `check:rules` output.
7. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-05-connect-flow.md

Never delete it on a partial.
