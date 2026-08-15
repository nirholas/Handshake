# Examples: @three-ws/vision-mcp

Two runnable examples. Both spawn this package's own MCP server over stdio (the
same `node src/index.js` entry point the README documents), speak real MCP
JSON-RPC to it, and hit the live three.ws vision pipeline. Neither one needs a
key and neither one costs anything.

| File | What it does | Run |
|---|---|---|
| [`list-tools.mjs`](list-tools.mjs) | Prints all 3 tools with titles, annotation hints, and full input schemas. | `node examples/list-tools.mjs` |
| [`read-an-image.mjs`](read-an-image.mjs) | Probes the lane with `get_vision_status`, gets alt text from `describe_image`, then reads the text off the same image with `analyze_image`. | `node examples/read-an-image.mjs` |

Run them from the package directory:

```bash
cd packages/vision-mcp
node examples/list-tools.mjs
node examples/read-an-image.mjs
```

Nothing to install and nothing to configure: the vision lane serves anonymous
callers on the free NVIDIA NIM models. The server prints a one-line banner to
stderr on connect (`[vision-mcp@x.y.z] connected over stdio with 3 tools`),
which is normal.

## list-tools.mjs

Runs the MCP `initialize` handshake, then `tools/list`, and formats every tool.
Expected output (abridged):

```
server:       vision-mcp v0.1.1 (stdio)
capabilities: tools
tools:        3

1. analyze_image
   title: Analyze an image against a prompt
   hints: read-only, open-world
   params:
     - prompt (required; string, maxLength 2000)
     - imageUrl (optional; string)
     ...
```

Every tool is read-only, so the hint line never says `destructive`.

## read-an-image.mjs

The end-to-end path an agent takes when it needs to see something:

```
get_vision_status: is the lane live?
  configured:  true
  image types: image/jpeg, image/png, image/webp, image/gif
  max size:    12 MB

describe_image: alt text for https://three.ws/og-image.png
  served: nvidia/nemotron-nano-12b-v2-vl (nvidia lane)
  alt:    An advertisement for a website called three.ws that allows users to create a 3D AI agent.

analyze_image: read the text in that same image (OCR through a VLM)
  served: nvidia/nemotron-nano-12b-v2-vl (nvidia lane)
  text:   three.ws
          PLATFORM
          The 3D agent layer of the
          internet.
          ...
```

A VLM is non-deterministic, so the exact wording changes between runs; the
shape does not.

Point it at your own image with `IMAGE_URL`:

```bash
IMAGE_URL=https://example.com/screenshot.png node examples/read-an-image.mjs
```

The image must be a public https URL serving JPEG, PNG, WebP, or GIF (the vision
server fetches it, so private and loopback hosts are rejected). To read a local
file instead, base64 it and pass `image` + `imageType` to the same tools.

A free NIM lane can exceed its deadline under load; the example retries an
`upstream_error` / `timeout` / `network_error` once, then reports the tool's own
error code rather than a stack trace.
