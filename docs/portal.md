# Portal: walk any website in 3D

Paste a web address and Portal builds a place out of it. Every section of the page becomes a building sized by what it says, every link becomes a door you step through, every image becomes a billboard, every code block becomes a monolith. You walk it with your own avatar, hand the link to anyone, download the world as a `.glb`, embed it in your own site, or let an agent read the shape of a site over MCP.

Page: [/portal](https://three.ws/portal) · API: `/api/portal` · Package: [`@three-ws/portal`](../packages/portal/README.md) · Spec: [`specs/PORTAL_WORLD.md`](../specs/PORTAL_WORLD.md)

## Why it exists

Every tool that visualizes a website draws a node graph. A graph tells you a site has forty pages. It does not tell you which section carries the weight, where the dead ends are, or what it feels like to arrive. A place does, because size, distance and direction are things people read without being taught.

There is a second reason, and it is the one that matters to this platform: an agent that fetches a page gets a wall of text. Over Portal it gets the page's *shape*, which is small enough to reason about and spatial enough to hand back as somewhere a human can go. That is three.ws's whole thesis applied to the web that already exists.

## Walkthrough

1. Open [/portal](https://three.ws/portal) and type an address (`three.ws`, `en.wikipedia.org/wiki/Three.js`, your own site).
2. The build panel names each real step: asking the site and its `robots.txt`, reading the structure, laying out districts, rendering.
3. You arrive on the plaza, in front of an obelisk carrying the page title. Walk with `WASD` or the arrows, hold `Shift` to run, drag to look, and on a phone use the on-screen stick.
4. Buildings are labelled with their section headings. The taller one said more. The minimap shows the whole city with you in it.
5. Stand at a door and press `Enter`. A same-site door rebuilds the world at that address and pushes it into your browser history, so `Back` walks back through the sites you visited. An outside link opens the page it points at.
6. **Copy link** shares the exact world you are standing in. **Embed** copies an iframe snippet. **Download GLB** hands you the whole city as a glTF binary you can open in Blender, drop into Unity, or view in AR.

## How it works

Portal is two documents and one pure function.

**Reading the page** ([`api/_lib/portal/fetch-site.js`](../api/_lib/portal/fetch-site.js), [`outline.js`](../api/_lib/portal/outline.js)). The address is normalized, `robots.txt` is fetched and matched against our token, and the page is read once through the IP-pinned SSRF guard with a 3 MB ceiling and a 12 second deadline. The HTML becomes a `SiteOutline`: the heading spine, the weight of each section (words, paragraphs, code blocks), its links and its images. Chrome (`nav`, `header`, `footer`, `script`) is removed before reading, so a navigation menu never becomes a district full of doors.

**Laying out the world** ([`packages/portal/src/layout.js`](../packages/portal/src/layout.js)). `buildWorld(outline)` is pure: no network, no DOM, no three.js, and no randomness that is not seeded from the page's canonical URL. Sections land on a phyllotaxis spiral so districts never collide, height comes from word count on a log scale so one long essay cannot dwarf a city, and the palette comes from the page's own `theme-color` (or a stable hue hashed from its host). Because it is pure and seeded, the person who opens your link builds the identical city.

**Rendering it** ([`src/portal/render.js`](../src/portal/render.js)). A three.js scene with a gradient sky, a plaza, labelled buildings that fade their signage by distance, doors that brighten as you approach, and your avatar driven by the platform's universal clip library, so the rig walks and idles correctly rather than sliding in the bind pose. Billboards load the page's real images through our own image proxy, because a foreign host with no CORS header would otherwise render a black panel.

**Exporting it** ([`api/_lib/portal/world-glb.js`](../api/_lib/portal/world-glb.js)). The same world document, composed into one glTF binary with `@gltf-transform`: named nodes, instanced geometry, deduplicated materials, two lights, and an `asset.copyright` recording the page the structure came from.

## API

```bash
# The world, and the outline it was built from
curl "https://three.ws/api/portal?url=example.com"

# Just one of them
curl "https://three.ws/api/portal?url=example.com&include=world"
curl "https://three.ws/api/portal?url=example.com&include=outline"

# The same world as a 3D file
curl -o example.glb "https://three.ws/api/portal?url=example.com&format=glb"
```

| Parameter | Values | Default |
| --- | --- | --- |
| `url` | any public http(s) address, with or without a scheme | required |
| `include` | `both`, `world`, `outline` | `both` |
| `format` | `json`, `glb` | `json` |

The response carries `ok`, `cached`, `stale`, `built_at`, `user_agent`, and whichever documents you asked for. CORS is open, because the SDK runs in other people's pages and every byte is already public on the site it read.

Failures arrive as `{ "error": "<code>", "error_description": "<a sentence you can act on>" }` with codes `invalid_url`, `robots_disallowed`, `blocked_host`, `not_html`, `no_structure`, `too_large`, `unreachable`, `upstream_status`, `rate_limited`.

## SDK

```bash
npm install @three-ws/portal
```

```js
import { fetchWorld, describeWorld, mountPortal } from '@three-ws/portal';

const { world } = await fetchWorld('example.com');
console.log(describeWorld(world).tallest); // the section that says the most

mountPortal(document.querySelector('#stage'), { url: 'example.com', height: 560 });
```

The layout is exported on its own for anyone who wants to build worlds from their own data:

```js
import { buildWorld, collidersFor } from '@three-ws/portal/layout';
```

Full reference: [`packages/portal/README.md`](../packages/portal/README.md).

## CLI

```bash
npx @three-ws/portal three.ws                    # the world, summarized
npx @three-ws/portal three.ws --glb site.glb     # save it as a 3D file
npx @three-ws/portal three.ws --json world.json  # save the world document
npx @three-ws/portal three.ws --open             # print the walkable link
```

## MCP

```bash
claude mcp add portal -- npx -y @three-ws/portal portal-mcp
```

| Tool | Returns |
| --- | --- |
| `walk_site` | The world: districts, doors with their targets, billboards, plus a walkable link and a GLB URL |
| `site_shape` | The heading spine with the weight of each section. The cheap structural read |

## Manners

Portal is a crawler that runs on a visitor's request, and behaves like one. It identifies itself as `ThreeWSPortalBot/1.0 (+https://three.ws/portal)`, reads `robots.txt` before the page and honours a `Disallow` for that token with a clean refusal, fetches each page once (worlds are cached fleet-wide for an hour, so a link shared with a thousand people is one request to the origin), and stays inside a 3 MB, 12 second, SSRF-guarded budget. Rate limits are per address and fleet-wide, and a cached world never touches them.

## Embedding

```html
<iframe
	src="https://three.ws/portal?url=example.com&embed=1"
	width="100%" height="520" style="border:0;border-radius:14px"
	loading="lazy" title="Walk example.com in 3D"></iframe>
```

`embed=1` hides the chrome that only makes sense on our own page. The **Embed** button copies this snippet for the world you are standing in.

## Tests

- [`tests/portal-robots.test.js`](../tests/portal-robots.test.js): the RFC 9309 rules, including group specificity, longest-match and the `Allow` tie-break.
- [`tests/portal-outline.test.js`](../tests/portal-outline.test.js): section attribution, nested prose counted once, chrome dropped, determinism, and the caps that bound a hostile page.
- [`tests/portal-layout.test.js`](../tests/portal-layout.test.js): determinism, log scaling, non-overlap, doors on walls rather than inside them, and a spawn that is never inside a solid.
- [`tests/portal-endpoint.test.js`](../tests/portal-endpoint.test.js): the response contract, error mapping, both rate-limit buckets, the GLB export, and the CORS preflight.
- [`tests/e2e/portal.spec.js`](../tests/e2e/portal.spec.js): a real browser builds a world from a real address and walks it, asserting the avatar actually moved.
