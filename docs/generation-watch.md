# Generation Watch (/watch)

[three.ws/watch](https://three.ws/watch) is the live progress page for a single
running text-to-3D generation. Open it with a `?job=` link and it shows a real
countdown ring, the concept art the generator painted as its first step, and
then hands you off into the interactive 3D viewer automatically the moment the
model is ready. It exists so someone waiting on a generation started outside
the browser (for example inside a ChatGPT conversation) can watch it happen in
a real tab instead of polling a chat window.

The page is a single self-contained file,
[public/watch.html](../public/watch.html), served at `/watch`.

## How a generation gets a watch URL

Watch links are minted by the 3D Studio Actions surface, `POST /api/3d/studio`
([api/3d/studio.js](../api/3d/studio.js)), the REST contract behind the
[three.ws 3D Studio custom GPT](./chatgpt-3d-studio-gpt.md). Fast generations
return `status: "done"` with the model URLs directly and never need a watch
page. When a job cannot finish inside the request window, the response is
`status: "pending"` and carries three handles:

- `job`: the job token (a signed handle or a bare prediction id),
- `poll`: the API path to poll (`/api/3d/studio?job=<id>`),
- `watchUrl`: `https://three.ws/watch?job=<id>&title=<prompt>`.

The GPT hands `watchUrl` to the user; every subsequent pending poll response
repeats it. The optional `title` parameter is the prompt: the page puts it in
the header and the tab title, and carries it through to the viewer so the
finished model opens labeled.

You can build the same link by hand for any valid job token. A missing or
malformed `job` parameter (the page enforces the same handle shape the API
does) lands on the designed empty state, which points to
[three.ws/forge](https://three.ws/forge) instead of erroring.

## What the page shows

The page polls `GET /api/3d/studio?job=<id>` and moves through four states:

- **Waiting.** A countdown ring with the estimated time remaining, updated
  locally at 4 Hz between polls so the timer never freezes. Until the API
  reports a first `etaSeconds` estimate, the ring spins in indeterminate mode
  and the label shows elapsed time ("warming up"); once an estimate arrives the
  ring fills toward completion. The phase line reflects the pipeline's real
  two-step flow: "Painting the concept" while the reference image is being
  generated, then "Sculpting the 3D mesh" once it exists, with the quality tier
  (draft, standard, high) named when known.
- **Concept art.** As soon as the poll response carries `previewImageUrl` (the
  painted reference image, the first step of the text-to-3D pipeline), it fades
  in with the caption "Concept art, now being sculpted into 3D". This is the
  same paint-then-reconstruct flow described in
  [How the Forge works](./how-forge-works.md).
- **Ready.** When the poll returns `status: "done"`, the page shows "opening
  the viewer" and redirects itself into the interactive viewer after a short
  beat, using the API's `viewerUrl` (or building a `/viewer?src=<glb>` link
  from `glbUrl`). A manual link is rendered in case the redirect is blocked.
- **Error.** An upstream failure (`status: "error"`), a stale or malformed
  link (HTTP 400), or a job that produces no viewer link shows an honest error
  with a one-click "Forge it again" path. Generation is free, so retrying
  costs nothing.

Polling is adaptive: the interval scales with the remaining estimate (clamped
between 4 and 10 seconds), a 429 respects the server's `retry_after`, and a
network blip just retries after 6 seconds. If nothing has finished after 40
minutes the page stops itself and says so, rather than spinning forever in a
forgotten tab.

## Relation to background generation

The watch page is a viewport, not the tracker. All job state lives
server-side: the platform tracks every generation to completion whether or not
any tab is watching, finished models land in the creator's gallery, and
unattended completions notify through the bell, push, and email channels. That
machinery is documented in
[Background generation and completion notifications](./forge-background-generation.md).
Closing the watch tab mid-job therefore loses nothing; reopening the same
`?job=` link resumes exactly where the generation actually is.

## Related

- [How the Forge works](./how-forge-works.md): the pipeline behind the
  countdown.
- [Background generation](./forge-background-generation.md): server-side
  tracking, resume, and notifications.
- [The 3D Studio GPT](./chatgpt-3d-studio-gpt.md): the main surface that hands
  out watch links.
- [API reference](./api-reference.md): the full `/api/3d/studio` contract.
