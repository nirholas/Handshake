// Build the MCP App UI into a single self-contained HTML file.
//
// Bundles app/avatar-app.js (which imports the MCP Apps SDK) with esbuild and
// inlines it into the HTML alongside a <model-viewer>. The result,
// src/avatar-app.html, is committed and shipped in the npm package — the stdio
// server serves it as the ui:// resource. model-viewer itself is loaded from a
// CDN (allowed by the resource's _meta.ui.csp.resourceDomains).
//
// Run: npm run build  (from packages/threews-avatar-mcp)

import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

const MODEL_VIEWER_SRC = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';

const result = await build({
	entryPoints: [join(here, 'avatar-app.js')],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2020',
	minify: true,
	write: false,
	legalComments: 'none',
});
const appJs = result.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>three.ws avatar</title>
<script type="module" src="${MODEL_VIEWER_SRC}"></script>
<style>
  html, body { margin: 0; height: 100%; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #stage { position: relative; width: 100%; height: 100vh; min-height: 360px; }
  model-viewer { width: 100%; height: 100%; --progress-bar-color: #6a5cff; --poster-color: transparent; }
  #name { position: absolute; left: 12px; bottom: 10px; padding: 4px 10px; border-radius: 999px;
          background: rgba(0,0,0,0.45); color: #fff; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            color: #8a8aa0; font-size: 14px; }
</style>
</head>
<body>
<div id="stage">
  <model-viewer id="viewer"
    camera-controls
    auto-rotate
    shadow-intensity="1.0"
    shadow-softness="0.9"
    exposure="1.5"
    tone-mapping="aces"
    environment-image="neutral"
    camera-orbit="0deg 80deg 2m"
    ar ar-modes="webxr scene-viewer quick-look"
    alt="three.ws avatar"></model-viewer>
  <div id="name"></div>
  <div id="status">Loading avatar…</div>
</div>
<script>${appJs}</script>
</body>
</html>`;

const out = join(pkgRoot, 'src', 'avatar-app.html');
await writeFile(out, html, 'utf8');
console.log(`avatar-app.html written (${(html.length / 1024).toFixed(1)} KB, app bundle ${(appJs.length / 1024).toFixed(1)} KB)`);
