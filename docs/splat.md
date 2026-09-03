# Splat Viewer: photoreal Gaussian-splat avatars in the browser

The Splat Viewer renders Gaussian-splat and radiance-field scenes right in your browser, the photoreal output of capture engines like GaussianAvatars and HumanGaussian. Load a `.ply`, `.splat`, or `.ksplat` by URL, drop a file in, or try a built-in sample, and orbit a photoreal avatar or scene with no plugin, no upload to a server, and no account. All decoding happens client-side.

Page: [/splat](https://three.ws/splat)

## Why it exists

Mesh avatars (GLB) are lightweight, riggable, and universal, and that is what most of three.ws generates. But the photoreal frontier of avatar capture is radiance fields: Gaussian splatting reconstructs a person or a scene as millions of tiny anisotropic blobs that render with real skin, hair, and lighting no polygon budget can match. Those captures ship as `.ply`, `.splat`, or `.ksplat` files, and most tools to view them are desktop apps. The Splat Viewer is the browser front door: a place to open any splat scene, evaluate a capture engine's output, and share a photoreal avatar with a link. It complements [/avatar-engines](https://three.ws/avatar-engines), which surveys the capture methods; the viewer is where their output actually renders.

## How it works

The viewer (`src/splat-viewer.js`) is entirely client-side. It uses `@mkkellogg/gaussian-splats-3d`, already a platform dependency (the same library the Forge Studio Lab uses), lazy-loaded on first render so the page shell paints instantly. Format is detected from the filename extension: `.ply` maps to the PLY scene format, `.ksplat` to the compressed KSplat format, and everything else to the antimatter15 `.splat` layout (32 bytes per splat). The decoded buffer is handed to a `GS.Viewer` with built-in orbit controls, and every state is designed: idle, fetching, decoding, error, and a live HUD showing the scene label.

There are three ways to load a scene:

- **By URL.** Paste a link and the viewer fetches the bytes and decodes them. To survive cross-origin blocks, it rewrites the human-facing URLs of common asset hosts to their CORS-enabled raw form: GitHub `raw`/`blob` links become `raw.githubusercontent.com`, Hugging Face `/blob/` becomes `/resolve/`, and Dropbox links are forced to a direct download. When a host still blocks the browser fetch, the error state tells you to download the file and upload it instead. Because the bytes are already in memory once a remote scene renders, the download control offers them back, so a scene you reached by URL is as saveable as one you uploaded.
- **By file.** Pick a file or drag and drop a `.ply`/`.splat`/`.ksplat` onto the stage. The file is read locally and never leaves your machine; a download button is offered for the loaded buffer.
- **Samples.** Two procedurally generated scenes ship in the page: a radiance shell (6,000 splats) and a synthetic head-and-shoulders bust (14,000 splats) that evokes what a real GaussianAvatars capture looks like in the viewer. These are synthetic, generated in-browser, and downloadable.

A deep link, `?src=<url>&name=<label>`, loads a scene straight from the URL on page load, so a photoreal avatar is shareable with a single link. A recenter control resets the camera on the live viewer, so it snaps back without dropping and rebuilding the WebGL context. Teardown is explicit: the renderer's graphics context is released by hand on every scene swap and when the page is hidden, because the splat library's own dispose stops short of that. If the browser drops the context anyway, after a GPU reset or under memory pressure, the stage reports it and offers a reload rather than freezing on the last frame.

## Walkthrough

1. Open [/splat](https://three.ws/splat).
2. Try a sample first: click the radiance shell or the head bust to see the viewer in action.
3. Load your own scene: paste a `.ply`/`.splat`/`.ksplat` URL and click Render, or drop a file onto the stage, or pick one from disk.
4. Orbit, zoom, and pan with the built-in controls. The HUD shows the scene label and splat count.
5. Recenter if the camera drifts. Download the loaded buffer, whether the scene came from a file, a sample, or a URL.
6. Share a scene by appending `?src=<url>` to the page URL.

## Examples

The viewer is driven by the URL, so sharing and embedding is just a link.

```
# Open a scene directly by deep link.
https://three.ws/splat?src=https://huggingface.co/<user>/<repo>/resolve/main/avatar.ply&name=My%20Avatar

# A GitHub-hosted splat: the viewer rewrites blob/raw links to the CORS raw host automatically.
https://three.ws/splat?src=https://github.com/<user>/<repo>/blob/main/scene.splat
```

Supported inputs at a glance:

- `.ply`: Gaussian-splat point cloud in PLY format.
- `.splat`: the antimatter15 layout (32 bytes per splat).
- `.ksplat`: the compressed KSplat format for faster loads.

## States and limits

- **Idle**: prompts you to load a splat, drop a file, or try a sample.
- **Fetching / decoding**: shows the host and the buffer size in MB; large radiance fields take a moment to decode.
- **Error**: an invalid file reports "that file isn't a valid splat"; a blocked fetch explains the CORS limit and suggests downloading then uploading; the retry loads a sample so the stage is never dead.
- **CORS**: only hosts that send permissive cross-origin headers load by URL; the viewer auto-rewrites GitHub, Hugging Face, and Dropbox links, but other hosts may require a local upload.
- **Client-side only**: files you upload are decoded in the browser and never sent to a server. There is no generation here; this is a viewer for captures produced elsewhere.
- Rendering runs on WebGL; very large scenes are bounded by your device's GPU and memory.

## Related

- [/avatar-engines](https://three.ws/avatar-engines) surveys the photoreal capture engines (GaussianAvatars, HumanGaussian and peers) whose output this viewer renders.
- [Avatar creation](./avatar-creation.md) and [avatar pipeline](./avatar-pipeline.md) cover the mesh (GLB) avatar path.
- [Scene Capture](./capture.md) reconstructs point clouds from video, a related radiance-adjacent capture flow.
- Pages: [/create](https://three.ws/create), [/scene](https://three.ws/scene).
