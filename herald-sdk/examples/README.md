# @three-ws/herald examples

Three runnable examples, smallest first. Each one is a single file with no
build step: open the HTML in a browser, or run the Node file with `node`.

| File | What it shows |
| --- | --- |
| [`plain-html.html`](./plain-html.html) | The whole feature in one `<script type="module">`, no bundler, no install |
| [`feed.html`](./feed.html) | Point it at a live feed, with custom scoring and quiet hours |
| [`ci-notify.mjs`](./ci-notify.mjs) | Announce from a build script or a GitHub Action step |

## Run them

```sh
# from the repo root
npx serve herald-sdk/examples     # or any static server
open http://localhost:3000/plain-html.html
```

`ci-notify.mjs` needs a key with the `herald:announce` scope:

```sh
export THREE_WS_API_KEY=sk_live_...
node herald-sdk/examples/ci-notify.mjs "Nightly build finished" 0
```
