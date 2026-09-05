# @three-ws/assets

Find a ready-made 3D prop, rigged character, or motion clip on [three.ws](https://three.ws)
and put it in your project, with the code that renders it.

Free and public. No account, no API key, no payment, nothing to sign up for. The catalog it
searches is the platform's published CC0 object library, ready-made character library, and
motion-clip library: **3,492 assets** as of September 2026.

```bash
npx @three-ws/assets search wooden chair --kind object
npx @three-ws/assets add object:painted_wooden_chair_01
```

The second command downloads the GLB into `public/three-ws/` and prints this, ready to paste:

```html
<script
  type="module"
  src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"
  integrity="sha384-sr9b4Ux0WhAUGclJ0ym0FSY2zSOMmNSn0bP/SA0e6bNCrpn/5W3QL8mm+LdlQMKw"
  crossorigin="anonymous"
></script>

<model-viewer
  src="/three-ws/painted_wooden_chair_01.glb"
  alt="Painted Wooden Chair 01"
  camera-controls
  auto-rotate
  ar
  shadow-intensity="1"
  style="width:100%;height:420px"
></model-viewer>
```

Note the `src`: the snippet points at the copy on your disk, not at our CDN. Your site keeps
working if we are down.

## Install

Nothing to install. `npx @three-ws/assets <command>` runs the current version. To pin it:

```bash
npm install --save-dev @three-ws/assets
```

Requires Node 18 or newer (it uses the built-in `fetch`).

## Commands

### `search <terms…>`

Search all three libraries at once.

```bash
three-ws-assets search industrial lamp
three-ws-assets search wave --kind animation --limit 5
three-ws-assets search --kind character --json
```

| Flag | Meaning |
| --- | --- |
| `--kind <k>` | `object` (CC0 props), `character` (rigged humanoids), `animation` (motion clips) |
| `--category <c>` | Exact category, from the `categories:` line of a previous result |
| `--tag <t>` | Exact tag |
| `--limit <n>` | 1 to 50, default 12 |
| `--offset <n>` | Page offset, printed as `more:` when there are more results |
| `--json` | Raw JSON on stdout |

Every word of the query has to match something (title, name, tag, or category), which is what
keeps a two-word search precise. If nothing matches all of the words, you get the partial
matches with a warning on stderr rather than an empty list.

Exits `1` when nothing matches, so a script can branch on it.

### `show <id>`

Print one item's facts plus paste-ready source, without downloading anything.

```bash
three-ws-assets show object:painted_wooden_chair_01
three-ws-assets show character:abe --framework three
three-ws-assets show animation:mx-wave-abc123 --json
```

With no `--framework` you get the one that fits the item and the names of the others. With
one, you get only that snippet, so `three-ws-assets show <id> --framework three > model.js`
produces a usable file.

### `add <id>`

Download the asset into your project and print the snippet rewritten to point at the local
copy.

```bash
three-ws-assets add object:painted_wooden_chair_01
three-ws-assets add character:abe --dir src/models --framework agent-3d
three-ws-assets add animation:mx-wave-abc123 --thumb
```

| Flag | Meaning |
| --- | --- |
| `--dir <path>` | Where to write. Defaults to `public/three-ws/` when the project has a `public/` directory, otherwise `three-ws-assets/` |
| `--framework <f>` | `agent-3d`, `model-viewer`, `three`, or `react` |
| `--thumb` | Download the thumbnail alongside the asset |
| `--force` | Overwrite a file whose contents changed since it was added |
| `--json` | Written paths, the local url, and the snippet, as JSON |

`add` is safe to put in a setup script:

- a re-run that would write identical bytes reports the file as already up to date and
  changes nothing;
- a file you edited after adding it is **never** overwritten without `--force`, and the
  command exits `1` instead;
- parent directories are created as needed.

When the target directory is not under a `public/` directory we cannot prove the file will be
served, so the snippet uses a project-relative path and the command says so on stderr.

## Frameworks

| Framework | What you get |
| --- | --- |
| `model-viewer` | The `<model-viewer>` tag, build, and integrity hash the three.ws browse grids themselves render with. The default for props. |
| `agent-3d` | The `<agent-3d>` web component, pinned to the exact published version with its Subresource Integrity hash. Never `latest`. The default for rigged characters. |
| `three` | Plain three.js: `GLTFLoader` for a model, `THREE.AnimationClip.parse` for a motion clip. The default for clips. |
| `react` | The same wrapped as a React component, or a hook for a clip. |

## Licensing

Every object in the CC0 library is public domain: use it commercially, modify it, no
attribution required. Characters and motion clips carry their own `license` field, printed by
`show` and `add` and present in `--json` output. Check it before shipping.

## Configuration

| Variable | Purpose |
| --- | --- |
| `THREE_WS_API` | Catalog origin. Defaults to `https://three.ws`. Also settable per call with `--api <origin>`. |
| `NO_COLOR` | Disable colored output (also `--no-color`). |
| `FORCE_COLOR` | Force color when stdout is not a TTY. |

## Programmatic use

The catalog client is exported, so a build script can skip the CLI:

```js
import { resolveApi, searchCatalog, fetchItem, downloadAsset } from '@three-ws/assets/api';

const origin = resolveApi();
const { items } = await searchCatalog(origin, { q: 'desk lamp', kind: 'object', limit: 5 });
const { item, snippets } = await fetchItem(origin, items[0].id);
const bytes = await downloadAsset(item.url);
```

Or talk to the endpoint directly: `GET https://three.ws/api/catalog?q=desk+lamp&kind=object`.

## The same catalog from an AI client

Every three.ws MCP client gets the same data through three free tools, `search_catalog`,
`get_catalog_item`, and `get_item_source`. Add the server and ask for a chair in plain
language:

```json
{ "mcpServers": { "three-ws": { "type": "http", "url": "https://three.ws/api/mcp" } } }
```

See [docs/mcp.md](https://three.ws/docs/mcp) for the tool schemas.

## License

Apache-2.0. The tool is Apache-2.0; the assets it downloads carry their own licenses, as
above.
