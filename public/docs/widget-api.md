# Widget API

The slim widget shell (`/widget`) is an embeddable 3D viewer. It supports:

- **URL parameters** — declarative configuration (model, type, brand, poster, reveal mode).
- **JSON-RPC 2.0 over `postMessage`** — programmatic control from the parent page (camera, animation, screenshot).
- **Auto-poster + lazy boot** — show a static preview, defer WebGL until the visitor interacts. Critical on gallery / grid pages.

## Quick start

The simplest embed — a single `<script>` tag that injects a sized iframe and forwards resize events:

```html
<script async src="https://three.ws/embed.js"
        data-widget="wdgt_abc123def456"
        data-width="600"
        data-height="600"
        data-reveal="interaction"
        data-poster="auto"></script>
```

That's it. The script:

- Mounts an iframe at the script tag's location.
- Uses `/api/widgets/<id>/og` (the OG image we already generate) as a poster — visitors see the avatar instantly.
- Defers WebGL boot until the visitor clicks the play button.
- Lazy-loads the iframe with `IntersectionObserver`.

### `<script>` attributes

| Attribute       | Default     | Values                                | Notes |
|-----------------|-------------|---------------------------------------|-------|
| `data-widget`   | (required)  | `wdgt_...`                            | The widget id from your dashboard. |
| `data-width`    | type-aware  | px                                    | Iframe width. |
| `data-height`   | type-aware  | px                                    | Iframe height. |
| `data-radius`   | `12`        | px                                    | Border-radius on the iframe. |
| `data-border`   | `0`         | px                                    | Iframe border width. |
| `data-reveal`   | `auto`      | `auto` \| `interaction`               | `interaction` defers WebGL until the visitor clicks the poster. Use for gallery pages. |
| `data-poster`   | `auto`      | `auto` \| URL \| `off`                | Static preview shown until first frame. `auto` uses the widget's OG image. |
| `data-priority` | (unset)     | `high`                                | Sets `loading="eager"` + `fetchpriority="high"`. Use only when the widget is the page's LCP element. |
| `data-type`     | (unset)     | `turntable` \| `talking-agent` \| …   | Lets the script pick a sensible default size for the type. |

## URL forms

You can also embed by hand — useful when you control the iframe directly:

| URL                                       | Notes |
|-------------------------------------------|-------|
| `/widget#widget=<id>&kiosk=true`          | Canonical embed URL. Slim shell, no chrome. |
| `/widget#model=<glb-url>&kiosk=true`      | Embed any GLB without a saved widget. |
| `/w/<id>`                                 | Server-rendered share page with OG tags + iframe. |
| `/app#widget=<id>&kiosk=true`             | Legacy. Same engine but with the full marketing SPA shell — slower first paint. |

### Hash params

| Param            | Type     | Default   | Notes |
|------------------|----------|-----------|-------|
| `widget`         | id       | —         | Loads a saved widget config. |
| `model`          | URL      | —         | Direct GLB URL (mutually exclusive with `widget`). |
| `type`           | string   | `turntable` | Widget type. Determines the UI overlay. |
| `kiosk`          | bool     | `false`   | Hide all viewer chrome. Always `true` for embeds. |
| `reveal`         | string   | `auto`    | `auto` boots immediately. `interaction` shows a play button and only loads the engine on click. |
| `poster`         | URL      | —         | Static image shown until first frame. Use `/api/widgets/<id>/og` for the auto-generated card. |
| `preset`         | string   | —         | Environment preset (`neutral`, `venice-sunset`, `footprint-court`). |
| `cameraPosition` | csv      | —         | Initial camera position as `x,y,z`. |
| `accent`         | `#rrggbb`| —         | UI accent color. |

## JSON-RPC API

The widget exposes a JSON-RPC 2.0 server inside the iframe. Drive it from the parent page using the bundled client:

```html
<iframe id="agent" src="https://three.ws/widget#widget=wdgt_abc"></iframe>
<script src="https://three.ws/widget-client.js"></script>
<script>
  const client = ThreeWidget.attach(document.getElementById('agent'));

  await client.ready();
  await client.call('camera.setLookAt', {
    eye: [0, 1.6, 3], target: [0, 1, 0], duration: 1.5,
  });
  await client.call('animation.play', { name: 'av-waving' });

  const { dataUrl } = await client.call('screenshot.capture', { width: 800, height: 800 });
  console.log('PNG:', dataUrl);
</script>
```

### Client API

| Method                          | Returns           | Notes |
|---------------------------------|-------------------|-------|
| `ThreeWidget.attach(iframe)`    | `Client`          | Binds to an iframe. Validates `event.origin` against the iframe's `src`. |
| `client.ready(timeoutMs?)`      | `Promise<void>`   | Resolves on first `viewer.ready` event (or if the widget is already up). |
| `client.call(method, params?, timeoutMs?)` | `Promise<result>` | Calls an RPC method. Rejects with `Error` (`code` carries the JSON-RPC error code). |
| `client.on(event, fn)`          | `() => void`      | Subscribes to events. Returns an off-handle. `on('*', fn)` catches every event. |
| `client.close()`                | `void`            | Detaches the listener and rejects in-flight calls. |

### RPC methods (server)

| Method                  | Params                                              | Result                                  |
|-------------------------|-----------------------------------------------------|-----------------------------------------|
| `viewer.getInfo`        | —                                                   | `{ version, ready, model, widget, type }` |
| `viewer.setBackground`  | `{ color: '#rrggbb' }`                              | `{}`                                    |
| `viewer.setAutoRotate`  | `{ enabled?: bool, speed?: number }`                | `{}`                                    |
| `viewer.setEnvironment` | `{ preset: string }`                                | `{}`                                    |
| `camera.getLookAt`      | —                                                   | `{ eye: [x,y,z], target: [x,y,z], fov }`|
| `camera.setLookAt`      | `{ eye?, target?, duration?, ease? }`               | `{ eye, target }`                       |
| `camera.recenter`       | `{ duration?: seconds }`                            | `{}`                                    |
| `animation.list`        | —                                                   | `{ clips: [{ name, duration }] }`       |
| `animation.play`        | `{ name: string, loop?: bool }`                     | `{ name }`                              |
| `animation.stop`        | —                                                   | `{}`                                    |
| `screenshot.capture`    | `{ width?: int, height?: int, mime?: string }`      | `{ dataUrl: 'data:image/png;base64,…' }`|
| `model.load`            | `{ url: string }`                                   | `{ url }`                               |
| `ping`                  | —                                                   | `{ pong: true, t: <ms> }`               |

### Events (server → parent)

Notifications (no `id`) sent to the parent over `postMessage`:

| Event             | Payload                              | Fires when |
|-------------------|--------------------------------------|------------|
| `viewer.ready`    | `{}`                                 | First successful model frame. |
| `model.loaded`    | `{ url, success, error? }`           | After every `model.load` (success or failure). |
| `widget.revealed` | `{ mode: 'auto' \| 'interaction' }`  | Visitor clicked the play button (interaction mode) or auto mode booted. |
| `widget.resize`   | `{ width, height, id? }`             | The widget asks the host to resize its iframe. |

### Wire format

The server speaks JSON-RPC 2.0. Both request and response forms below:

```js
// Request (parent → iframe)
{ jsonrpc: '2.0', id: 7, method: 'camera.setLookAt',
  params: { eye: [0,1.6,3], target: [0,1,0], duration: 1.5 } }

// Response (iframe → parent)
{ jsonrpc: '2.0', id: 7, result: { eye: [...], target: [...] } }

// Error
{ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } }

// Notification (iframe → parent, no id)
{ jsonrpc: '2.0', method: 'viewer.ready', params: {} }
```

### Error codes

| Code     | Meaning |
|----------|---------|
| `-32700` | Parse error (malformed JSON). |
| `-32600` | Invalid request (missing `jsonrpc` or `method`). |
| `-32601` | Method not found. |
| `-32602` | Invalid params. |
| `-32603` | Internal error (wraps a thrown exception). |
| `-32000` | Viewer not ready (model still loading). |

## Performance patterns

### Gallery / grid pages

Use `reveal="interaction"` + `data-poster="auto"`. WebGL only initializes for the widgets the visitor opens — most browsers cap a tab at ~16 simultaneous WebGL contexts, so eager-loading a grid of 12 widgets is borderline.

```html
<!-- Repeat for each widget in the grid -->
<script async src="https://three.ws/embed.js"
        data-widget="wdgt_..."
        data-reveal="interaction"
        data-poster="auto"></script>
```

### Hero / above-the-fold

Use `data-priority="high"` so the browser prioritises the iframe in the resource queue. Only set this on the widget that's actually the LCP element — high-priority every embed and you've defeated the point.

```html
<script async src="https://three.ws/embed.js"
        data-widget="wdgt_..."
        data-priority="high"
        data-poster="auto"></script>
```

### Multiple widgets you control

If you have multiple widgets and want to coordinate them (sync camera, broadcast events), keep one `ThreeWidget.attach()` client per iframe. The clients are independent — there's no global state.

## Security

- The widget shell validates `event.source` on every incoming message — only messages from a known parent are processed.
- The client validates `event.origin` against the iframe's `src` origin. Pass `{ origin: '*' }` to `attach()` to opt out (e.g. for cross-origin embed-in-embed scenarios), but you give up the guarantee that the response came from us.
- `screenshot.capture` returns the rendered canvas, so the parent gets exactly what the visitor sees. Nothing private leaks across the boundary.
- `model.load` accepts any URL the iframe can fetch — same-origin policy still applies to the GLB itself. If you need a private model, gate it behind a cookie/header at the GLB host.
