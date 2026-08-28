# Portal World v1

The wire format behind [`/api/portal`](../docs/portal.md). One web page, reduced to a place you can walk.

- **Endpoint:** `GET https://three.ws/api/portal?url=<address>`
- **Media types:** `application/json` (default), `model/gltf-binary` (`format=glb`)
- **Reference implementation:** [`packages/portal/src/layout.js`](../packages/portal/src/layout.js) (`buildWorld`), published as [`@three-ws/portal`](../packages/portal/README.md)
- **Companion specs:** [SPATIAL_MCP.md](SPATIAL_MCP.md) (returning 3D as a tool result), [EMBED_SPEC.md](EMBED_SPEC.md) (the 3D embed)

## Why it exists

Two documents could have been one. They are deliberately separate because they fail differently.

The **outline** is what a page says: its heading spine, the weight of each section, where it links, what it shows. Reading it needs the network, an HTML parser, a robots.txt check and a fetch budget. It can fail in a dozen ways that all mean "the web is the web".

The **world** is what that page looks like as a place. Building it needs nothing at all: no network, no DOM, no renderer, no clock, no randomness that is not seeded. Given the same outline it always returns the same world, byte for byte.

Keeping them apart is what makes a Portal link shareable. The person who opens your link runs the same pure function over the same cached outline and stands in the same city you did. It is also what lets the layout run in four places without drifting: the page renderer, the server's GLB exporter, the MCP tools, and anyone who installs the npm package.

## SiteOutline

```json
{
  "version": 1,
  "url": "https://example.com/docs",
  "canonical": "https://example.com/docs",
  "host": "example.com",
  "title": "Docs",
  "description": "How to use the thing.",
  "siteName": "Example",
  "themeColor": "#3366ff",
  "image": "https://example.com/og.png",
  "icon": "https://example.com/favicon.ico",
  "lang": "en",
  "words": 1840,
  "linkCounts": { "internal": 38, "external": 4 },
  "sections": [
    {
      "id": "getting-started",
      "level": 2,
      "heading": "Getting started",
      "summary": "Install it, then point it at a page.",
      "words": 210,
      "paragraphs": 6,
      "codeBlocks": 2,
      "links": [{ "href": "https://example.com/install", "text": "install", "internal": true }],
      "images": [{ "src": "https://example.com/shot.png", "alt": "The console" }]
    }
  ]
}
```

Rules a consumer can rely on:

- **Sections open at every `h1`, `h2` and `h3`**, in document order, and own everything until the next heading. A page whose prose starts before any heading gets one section named after the document title, so a page with no headings still has a place.
- **`id` is stable and unique.** It is a slug of the heading, suffixed on collision, so a world keeps its node names across rebuilds.
- **Prose is counted once.** A `<p>` inside a `<blockquote>` is one paragraph, not two, and `<pre><code>` is one code block, not two.
- **Chrome is not content.** `script`, `style`, `noscript`, `template`, `svg`, `iframe`, `form`, `nav`, `header` and `footer` are removed before reading, so a navigation menu never becomes a section full of doors.
- **Every list is bounded**: 24 sections, 8 links and 4 images per section, and clamped strings (see `LIMITS` in [`api/_lib/portal/outline.js`](../api/_lib/portal/outline.js)). One hostile page cannot produce an unbounded world.
- **Links are absolute `http(s)` URLs.** `mailto:`, `javascript:` and bare fragments are dropped. `internal` compares against the host of the page the link was found on.

## PortalWorld

```json
{
  "version": 1,
  "meta": { "url": "…", "canonical": "…", "host": "example.com", "title": "Docs",
            "description": "…", "siteName": "Example", "lang": "en",
            "seed": 2748619284, "words": 1840, "sections": 12,
            "links": { "internal": 38, "external": 4 } },
  "palette": { "primary": "#…", "secondary": "#…", "accent": "#…",
               "ground": "#…", "sky": "#…", "fog": "#…", "monolith": "#…" },
  "ground": { "radius": 74.2, "color": "#…", "sky": "#…", "fog": "#…" },
  "plaza": { "radius": 11, "monument": { "label": "Docs", "sub": "…", "h": 5.4 } },
  "spawn": { "x": 0, "z": 6.05, "yaw": 3.14159 },
  "districts": [{ "id": "d-getting-started", "sectionId": "getting-started", "x": 17, "z": 0, "radius": 9.1 }],
  "buildings": [{ "id": "b-getting-started", "sectionId": "getting-started", "kind": "hall",
                  "label": "Getting started", "summary": "…", "words": 210,
                  "x": 17, "z": 0, "w": 7.5, "d": 6.1, "h": 9.4, "rot": 3.14159,
                  "color": "#…", "floors": 3 }],
  "doors": [{ "id": "door-getting-started-0", "buildingId": "b-getting-started",
              "href": "https://example.com/install", "label": "install", "internal": true,
              "x": 20.7, "z": 0, "yaw": 3.14159, "w": 1.6, "h": 2.6, "color": "#…" }],
  "props": [{ "id": "img-getting-started-0", "kind": "billboard", "x": 12, "z": 3,
              "yaw": 0, "w": 3.2, "h": 2, "src": "https://example.com/shot.png",
              "label": "The console", "color": "#…" }]
}
```

### The mapping

| On the page | In the world | Rule |
| --- | --- | --- |
| The page | The plaza and its obelisk | Always at the origin, radius `METRICS.plazaRadius` |
| A section | One district, one building | Placed on a phyllotaxis spiral: `angle = i · golden`, `radius = 17 + 7.6·√i` |
| Its word count | Building height | `log10(max(10, words))` scaled, clamped to `[3.5, 26]` metres |
| Its block count | Building footprint | Paragraph count widens it, clamped to `[4.5, 13]` metres |
| Heading level | Silhouette | `1 → tower`, `2 → hall`, `3 → kiosk` (kiosks cap at 6 m) |
| A link | A door on a wall | Two per face, starting at the plaza-facing wall, always flush and never inside |
| An image | A billboard | Fanned out behind the building, angled back toward the plaza |
| A code block | A monolith | Up to four, in a short row beside the building |
| `theme-color`, else the host | The palette | Theme hue when present, else `FNV-1a(host) % 360` |

### Invariants

Every one of these is covered by [`tests/portal-layout.test.js`](../tests/portal-layout.test.js):

1. **Deterministic.** `buildWorld(outline)` is pure. The seed is `FNV-1a(canonical || url)`, and all randomness runs through `seededRandom(seed)` (mulberry32).
2. **Bounded.** Height, footprint and ground radius are clamped; the ground always contains every building.
3. **Non-overlapping.** No two buildings intersect, at any section count up to the outline cap.
4. **Walkable.** `spawn` is outside every collider returned by `collidersFor(world)`.
5. **Log-scaled.** A section with five times the words is taller, but not five times taller.
6. **Additive versioning.** `version` is `1`. A consumer must ignore fields it does not know, and may assume the fields above keep their meaning within a major version.

### Doors are the navigation model

A door carries the real `href`. Internal doors rebuild the world at that address (the renderer pushes `/portal?url=…`, so the browser's back button walks back through the sites you visited). External doors open the page. A consumer that renders worlds without a browser (a game engine, a Blender import) can treat `doors` as an adjacency list and crawl the site as a graph.

## GLB export

`format=glb` returns the same world as glTF 2.0 binary: one node per building, door, billboard and monolith, named `building:<sectionId>` and so on, plus a ground disc, the plaza, the obelisk and two `KHR_lights_punctual` lights. Geometry is instanced from one box and one cylinder, and materials are deduplicated by colour, so a 24-district city is tens of kilobytes rather than tens of megabytes. The `asset.copyright` field records the page the structure came from.

## Manners

Portal is a crawler that runs on a person's request:

- Identifies as `ThreeWSPortalBot/1.0 (+https://three.ws/portal)`.
- Reads `robots.txt` first and honours a `Disallow` for that token with `403 robots_disallowed`. Matching follows RFC 9309: most specific user-agent group, longest matching rule, `Allow` wins a tie, `*` and `$` supported ([`api/_lib/portal/robots.js`](../api/_lib/portal/robots.js)).
- Fetches each page once; worlds are cached fleet-wide for an hour.
- Bounded at 3 MB of HTML and a 12 second deadline, through the IP-pinned SSRF guard, which re-validates every redirect hop.

## Error codes

`invalid_url`, `robots_disallowed`, `blocked_host`, `not_html`, `no_structure`, `too_large`, `unreachable`, `upstream_status`, `rate_limited`. Every one arrives as `{ "error": "<code>", "error_description": "<sentence a person can act on>" }`.
