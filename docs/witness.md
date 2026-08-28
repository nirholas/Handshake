# Witness: bug reports that arrive as failing tests

A bug report is a description of an experiment somebody else has to reconstruct.
The reconstruction is the expensive part, it is where most reports die, and it is
the part a machine can do.

`@three-ws/witness` records what a person actually did, and compiles it into a
Playwright spec that is **red while the bug exists and green once it is fixed**.

- Package: [`packages/witness/`](../packages/witness) (`@three-ws/witness`, Apache-2.0, no dependencies)
- On three.ws: the corner companion attaches a trace to every report, and
  [`/feedback`](./feedback.md) hands you the compiled test with one click.
- Standalone: it works on any site, with or without the rest of three.ws.

## The idea in one screen

```
The visitor's session                    The compiled spec
─────────────────────                    ─────────────────
goto   /avatar-studio                    await page.goto('/avatar-studio');
click  the button "Export"               await page.getByTestId('export').click();
fill   "Model name" (11 chars)           await page.getByLabel('Model name').fill('xxxxxxxxxxx');
click  the button "Download"             await page.getByRole('button', { name: 'Download' }).click();
xhr    POST /api/export -> 500           expect(failedRequests).toEqual([]);   <- RED
error  TypeError: exportGLB is not a fn  expect(pageErrors).toEqual([]);       <- RED
```

The last two lines are the whole design. The spec asserts the failure is **gone**,
not that it happened. A recorder that emitted `expect(status).toBe(500)` would
write a test that passes while the site is broken and fails once it is fixed,
which is worse than no test at all.

## Why not session replay

Session replay records the DOM mutation stream. It is megabytes per session, it
costs real money to keep, and what it gives you is a video. You still have to
reproduce the bug yourself afterwards.

Witness records intent, at about two kilobytes per session. Small enough to leave
on permanently, and that is the point: **the trace already exists at the moment
somebody decides to complain.** Nobody can reproduce a bug on request; everybody
has just done it.

| | Session replay | Witness |
| --- | --- | --- |
| Records | DOM mutations, pixels | Intents, failures, stable selectors |
| Size | megabytes | ~2 KB |
| Output | a video to watch | a test to run |
| Answers "is it fixed?" | you rewatch and judge | the test goes green |
| Typed values | usually captured, then masked | never held |

## Using it on three.ws

Nothing to do. Every page runs the corner companion, which starts the recorder
before the page finishes booting. When something breaks the companion asks what
you were doing, and the session rides along with the answer.

At [`/feedback`](https://three.ws/feedback) a cluster with a recorded session
shows a **Recorded session** card: the replay confidence, the narrated steps, and
**Show test** / **Copy test** / **Download**.

From the shell:

```bash
npm run feedback:repro -- --list          # reports with a replayable session
npm run feedback:repro -- <report-id>     # writes tests/repros/<id>.spec.js
npm run feedback:repro -- <report-id> --run   # writes it, then runs it
npm run feedback:repro -- <id> --base http://localhost:3000   # replay locally
```

Repros live in `tests/repros/` with [their own Playwright
config](../tests/repros/playwright.config.mjs), deliberately outside the
`tests/e2e` suite: a reproduction is red by definition until its bug is fixed, so
folding them into the default run would mean `npm test` fails for every open
report.

```bash
npx playwright test -c tests/repros/playwright.config.mjs
```

Over HTTP (admin session required):

```bash
curl -s 'https://three.ws/api/feedback/repro?id=<id>' -H "cookie: $SESSION" \
  > tests/repros/export-does-nothing.spec.js
```

Add `&format=json` for the source plus the narrated steps and confidence, which
is what the queue page renders.

And from an agent over MCP (`/api/mcp`, scope `feedback:read`, admin account):

| Tool | What it does |
| --- | --- |
| `list_feedback` | The queue, one row per problem, flagging which ones are replayable |
| `get_feedback_repro` | Compiles one report into a spec, with steps and confidence |

Both are read-only. An agent can reproduce a reported bug and verify its own fix
against the real session, and it still cannot change a status or touch the
product: see the boundary in [feedback.md](./feedback.md#the-boundary-that-makes-this-safe).

## Replay confidence

Every trace carries a score equal to its **weakest** selector, because one
fragile locator breaks the whole spec:

| Score | Meaning |
| --- | --- |
| 80-100 | Every step is anchored to a test id, an id, an aria-label, or a role and name. |
| 60-79 | A step relies on visible text, which moves when copy changes. |
| 40-59 | A step is anchored to a class name, which a restyle can break. |
| 0-39 | A step falls back to a structural path and will not survive a refactor. |

That number is honest feedback about your own markup, and it is actionable: add
`data-testid` to the primary action on a page and every future report from that
page compiles into a sturdier test. The full ladder is in the
[package README](../packages/witness/README.md#the-selector-ladder).

## Privacy

Enforced at capture time, not by scrubbing afterwards. A recorder that captures
everything and cleans up later has already put the secret in memory.

- **Typed values are never held.** A filled field records `text:11`: eleven
  characters of ordinary text. The characters do not exist in the trace.
- **Password, hidden, email, tel and date inputs record nothing**, and neither
  does any field whose name, id, `autocomplete`, label, or placeholder suggests
  it holds something personal.
- **URLs are stripped at capture**: userinfo and the hash go entirely, credential
  parameter values are redacted, parameter names are kept.
- **Free text is scanned** for emails, JWTs, API keys, card numbers, wallet
  addresses, and long base58 runs.
- **`data-witness="off"`** excludes a subtree completely. three.ws marks its own
  feedback panel with it, because the act of reporting a bug is not part of the
  bug.

The visitor can see all of this before they send: the panel shows the exact step
count and expands to the full list, above the line "Nothing you typed into a
field is recorded, only how much."

## When it cannot help, it says so

If a session recorded no exception and no failed request, the visitor judged the
*result* wrong, and no recorder can see that. The compiler does not invent an
assertion to look useful:

```js
// The browser recorded no exception or failed request for this report:
// the visitor judged the RESULT wrong, which no recorder can see.
// Replace this with the assertion that states what should have happened.
expect(pageErrors, 'no page errors during the reported flow').toEqual([]);
test.fail(true, 'Add the assertion this report is really about.');
```

You get the reproduction steps for free and write the one line only a human can.

## Using it on your own site

```bash
npm install @three-ws/witness
```

```js
import { witness } from '@three-ws/witness';
witness.start();
witness.onFailure(() => openYourFeedbackForm());

// when they submit:
sendToYourBackend({ note, trace: witness.trace() });
```

```js
import { compileToPlaywright } from '@three-ws/witness/compile';
const { source, filename, confidence } = compileToPlaywright(trace, { title: note });
```

The recorder is browser-only; `compile` is pure and runs in Node, which is what
lets one trace produce the maintainer's English steps in a dashboard and the
engineer's spec file on disk. Full API in the
[package README](../packages/witness/README.md#api).

## Related

- [Feedback](./feedback.md): the loop this is the second half of, and the
  untrusted-input boundary that governs all of it.
- [Notifications](./notifications.md): the same companion, delivering the other way.
