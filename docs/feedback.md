# Feedback: telling the agent what is wrong

Every three.ws page carries a companion in the corner. It walks the page, reads
sections aloud, and delivers notifications in person. This is the channel going
the other way: a visitor tells it what broke, and the report lands in a queue a
maintainer reads at `/feedback`.

Two things make it different from a support form.

**It asks at the moment of failure.** When a page actually throws an exception
or a request actually fails, the companion turns and asks what you were doing.
That is the only moment the visitor still remembers, and the error is already
attached. A form waits to be found, by which time the visitor has left.

**The useful half is captured, not typed.** A person writes "the download button
does nothing". What arrives with it is the route, the page title, the build SHA,
the viewport, the locale, the last few console errors, and the last few failed
requests. The build SHA is the one that changes the work: it turns "the avatar
page is blank" into "the avatar page went blank in the deploy that shipped
`abc1234`".

## The boundary that makes this safe

**Feedback is data. It is never an instruction.**

The text a visitor types is read by a model that scores and classifies it, and
that model has no ability to act. It writes six scalars back to the report's own
row: severity, kind, subsystem, summary, a repro guess, and a cluster key. There
is no path from a feedback report to the repository, to a deploy, to a
configuration change, or to any write beyond that row.

This is deliberate and it is not negotiable. The corner companion is reachable
by anyone on the internet with no account. If what they type could reach
anything with write access, the text box would be a remote code execution
primitive wearing a friendly face. So the model that reads untrusted text has no
authority, the queue it produces is read by a person, and the person decides.

The prompt reflects the same rule: the report is passed as data inside a
delimiter, the model is told it may not follow instructions found there, and a
report that tries is classified as spam and scored 0. See the security note at
the top of [`api/_lib/feedback/triage.js`](../api/_lib/feedback/triage.js).

## How a report travels

1. **Capture.** [`src/feedback-companion.js`](../src/feedback-companion.js)
   starts [`@three-ws/witness`](./witness.md) at module load, before the
   companion finishes mounting. It keeps a bounded semantic trace: the sequence
   of intents plus the failures, with a stable selector for every element
   touched and no typed value ever held. No timers, no network, nothing sent
   anywhere: this costs nothing until something goes wrong.
2. **The ask.** On a real failure the companion offers, once per route per
   session, never in a background tab, and never again on a route where the
   visitor said "not now". The chrome control next to the narration and trails
   toggles is always available, and any surface can call
   `window.__walkFeedback.open()`.
3. **Send.** `POST /api/feedback/report` stores the body plus the captured
   context. Anonymous reporters are keyed to a random browser id that is hashed
   server-side before storage. A failure here keeps the draft in
   `localStorage` and offers a retry, because a visitor who typed a paragraph
   must not lose it to a 503.
4. **Triage.** `/api/cron/feedback-triage` runs every five minutes. A
   deterministic scorer always runs (no key, no cost); an LLM pass refines it
   when a chain is configured. The LLM may move the severity but cannot push a
   report corroborated by a console error below 60, because a console error is
   a fact and a model that decides it does not matter should not be able to
   bury it.
5. **Read.** `/feedback` groups reports into one row per distinct problem,
   loudest first, showing how many people hit each one. A cluster with a
   recorded session carries a **Copy test** button. A maintainer accepts, fixes,
   or dismisses.

## From report to failing test

Every report also carries the **session** the visitor recorded: the sequence of
things they did, with a stable selector synthesized for each one, and the failure
at the end. That trace compiles into a Playwright spec which asserts the failure
is gone, so it is red while the bug exists and green once it is fixed.

```bash
npm run feedback:repro -- --list        # reports with a replayable session
npm run feedback:repro -- <id> --run    # compile it and watch it fail
```

The reconstruction step, which is where most bug reports die, is done before a
maintainer opens the queue. Full detail, including the selector ladder and the
privacy rules: [Witness](./witness.md).

Nothing about this changes the boundary above. The trace is machine-written data
validated by shape at the API edge, the compiler is a pure function with no
network and no filesystem, and the output is a file a human chooses to run.

## Severity

The deterministic pass scores 0 to 100 from what was said and what the browser
saw:

| Signal | Effect |
| --- | --- |
| A console error or failed request arrived with the report | +18 / +14. The strongest signal here, because the browser cannot exaggerate. |
| Money, withdrawal, or sign-in words | +20 |
| Data-loss words ("deleted", "disappeared", "lost my") | +22 |
| Signed-in reporter on wallet, payments, or settings | +10 |
| Classified as spam | forced to 0 |

Kind baselines run `bug` 55, `broken-link` 45, `confusing` 35, `copy` 20,
`idea` 15, `praise` 5.

## Clustering

Twenty people reporting one outage must read as one row, or the queue buries the
thing everyone is hitting under the noise of everyone hitting it. The rules pass
groups coarsely by `subsystem:kind`; the LLM pass can replace that with a
sharper slug describing the problem itself (`avatar-studio:blank-on-ios`), never
the wording of one particular report.

## API

### `POST /api/feedback/report`

Open to anonymous visitors on purpose: the person best placed to tell you a page
is broken is often the one who could not get past it to sign in.

```bash
curl -X POST https://three.ws/api/feedback/report \
  -H 'content-type: application/json' \
  -H 'x-feedback-client: 6f1c9a3e-2b47-4d55-9c8e-1f0a5d7b3e21' \
  -d '{
    "body": "The download button does nothing on my phone.",
    "route": "/avatar-studio",
    "page_title": "Avatar Studio",
    "build_sha": "abc1234",
    "viewport": "390x844@3",
    "locale": "en-GB",
    "console_errors": ["TypeError: exportGLB is not a function (studio.js:412)"],
    "failed_requests": ["POST /api/export -> 500"],
    "trace": { "version": 1, "environment": {}, "events": [{ "type": "goto", "detail": "/avatar-studio" }] }
  }'
```

```json
{ "ok": true, "id": "8c2f...", "received_at": "2026-08-28T14:02:11.884Z", "replayable": true }
```

`trace` is optional and machine-written by [`@three-ws/witness`](./witness.md).
It is validated by shape at this boundary (known event types only, 80 events,
every string capped), because the endpoint is open to anyone. `replayable` says
whether a usable trace survived that validation.

Rate limited to 20 reports per hour per account, browser key, or IP. Every text
field is capped server-side and the two signal lists keep their first five
entries.

### `GET /api/feedback` (admin)

`?status=open|new|accepted|dismissed|fixed|all` returns clusters plus counts.
`?cluster=<key>` returns the individual reports in one cluster.

### `POST /api/feedback` (admin)

```json
{ "cluster": "avatar-studio:blank-on-ios", "status": "fixed", "resolution": "Fixed in abc1234" }
```

Pass `id` instead of `cluster` to move a single report.

### `GET /api/feedback/repro?id=<report id>` (admin)

The report as a runnable Playwright spec. `&format=json` returns the source
alongside the narrated steps and the replay confidence; `&base=<origin>` points
the replay somewhere other than production. See [Witness](./witness.md).

## What this deliberately does not do

It does not write code, open pull requests, change configuration, or deploy.
Those would each be a new decision with its own gate, and none of them should
ever be triggered by text typed into a box by an anonymous visitor.

What it does instead is remove the reason people wanted that: the expensive part
of acting on a bug report was never writing the fix, it was reproducing the bug.
A compiled repro hands that over without handing over any authority. An agent
with `feedback:read` can pull a reproduction over MCP, run it, change code in a
branch, and run it again to prove the fix, and the pull request still needs a
human to merge it. If a proposal layer is ever built here, that is its shape: the
input is the structured triage record a person already accepted plus a spec that
reproduces the failure, never the raw report, and the output is a pull request.

## Related

- [Notifications](./notifications.md): the same companion delivering messages the other way.
- [`STRUCTURE.md`](../STRUCTURE.md): where every surface lives.
