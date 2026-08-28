# @three-ws/create-agent

**One command from a sentence to a rigged 3D character you can put on your site.**

```bash
npm create @three-ws/agent "a friendly cartoon astronaut in a glossy white suit"
```

```
three.ws building "a friendly cartoon astronaut in a glossy white suit"
  a rigged humanoid, free lane, no account needed

· sent to the three.ws forge
· generating the figure (15s)
· generating the figure, then the skeleton (60s)
✓ model ready
· downloading the model

Friendly Cartoon Astronaut is ready in 94s

  folder  a-friendly-cartoon-astronaut/
          index.html
          agent.json
          README.md
          agent.glb (3.4 MB)
  viewer  https://three.ws/viewer?src=…

  Paste this anywhere:

  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

  <agent-3d body="https://three.ws/cdn/…/rigged.glb"
            name="Friendly Cartoon Astronaut"
            style="width:100%;max-width:420px;height:520px"></agent-3d>

  Open the demo:  npx serve a-friendly-cartoon-astronaut
```

No account. No API key. No signup. The generation runs on the three.ws free lane, and the platform's own provider keys cover it.

## What you get

| File | What it is |
| --- | --- |
| `agent.glb` | The model, with a humanoid skeleton, so it can be posed and animated. Opens in Blender, Unity, Godot, or any glTF tool. |
| `index.html` | A working demo page. Double click it. |
| `agent.json` | The record: prompt, hosted URLs, backend, timing. |
| `README.md` | How to embed it and where to go next. |

## Options

```bash
npm create @three-ws/agent "a knight in worn steel armor" --out ./knight
npm create @three-ws/agent --photo https://example.com/me.jpg --name "Me"
npm create @three-ws/agent "a small ceramic frog figurine" --object
```

| Option | Meaning |
| --- | --- |
| `--photo <url>` | Build from a public https reference image instead of a description |
| `--out <dir>` | Where to write the project (default: a slug of the description) |
| `--name <name>` | Display name (default: derived from the description) |
| `--object` | An object or prop (mesh only, free lane) instead of a rigged character |
| `--no-download` | Keep the hosted model URL, skip writing `agent.glb` |
| `--json` | Print the result as JSON and nothing else |
| `--origin <url>` | API origin (default `https://three.ws`) |

Describe **one full-body humanoid in a neutral standing pose** for the best rig. Lead with the subject, then materials and colours: the free lane conditions on roughly the first 77 characters, so front-load what matters.

## Programmatic use

```js
import { createAgent } from '@three-ws/create-agent';

const made = await createAgent({
	prompt: 'a friendly cartoon astronaut',
	out: './astro',
	onProgress: ({ message }) => console.log(message),
});

made.result.glbUrl; // hosted, durable
made.result.rigged; // true
made.dir; // absolute path to the project
```

| Export | What it does |
| --- | --- |
| `createAgent(opts)` | The whole pipeline: generate, scaffold, download |
| `callForge({ tool, args, ... })` | One forge call (`forge_avatar` or `forge_free`) |
| `downloadModel(url)` | Fetch the model bytes with a deadline |
| `projectFiles(...)`, `demoPage(...)`, `embedSnippet(...)` | The scaffold, as pure functions |
| `ForgeError` | Carries `code`: `timeout`, `unreachable`, `no_model`, `rpc_error`, `http_<status>` |

Everything takes `{ fetchImpl, signal, origin }`, so it runs against a local three.ws, a proxy, or a test double.

## How long it takes

A rigged character is generation plus rigging, usually one to three minutes; rigging is the slow half. An `--object` is faster. Every call carries an explicit deadline (10 minutes) and reports real elapsed time, never an invented progress bar. If the deadline hits, the job may still finish: finished models land at <https://three.ws/creations>.

## Related

- The full pipeline in a browser: <https://three.ws/create>
- `<agent-3d>` attribute reference: <https://three.ws/docs/web-component>
- Your agent's live status on a home screen or in a README: [@three-ws/agent-glance](../agent-glance)
- Docs: <https://three.ws/docs/create-agent>

## License

Apache-2.0
