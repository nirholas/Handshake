#!/usr/bin/env python3
"""Build a whole 3D asset pack from a list of prompts, in parallel.

Generates one GLB per prompt on the free three.ws lane, renders a PNG still of
each result, and writes a self-contained gallery you can open in a browser:

    out/
      manifest.json          every prompt, its GLB URL, local paths, timings
      index.html             an interactive gallery (orbit, zoom, AR on phones)
      models/<slug>.glb      the downloaded models
      stills/<slug>.png      a 1024px render of each model

Usage:

    python3 asset_pack.py "a clay flower pot" "a woven basket" "a brass watering can"
    python3 asset_pack.py --prompts-file prompts.txt --out ./garden-pack --workers 3

Standard library only. No API key, no account.

Recipe: https://three.ws/cookbook/parallel-asset-pack
API reference: https://three.ws/docs/3d-api
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

from text_to_3d import ForgeError, download, generate, slugify

RENDER_API = "https://three.ws/api/render/glb"
USER_AGENT = "three.ws-cookbook/asset_pack.py"

# The free lane is a shared GPU pool. Two or three concurrent jobs is the sweet
# spot: more does not finish sooner, it just queues behind itself and burns the
# poll budget. Raise it only if you have measured that the lane keeps up.
DEFAULT_WORKERS = 3


@dataclass
class Asset:
    """One prompt's journey through the pipeline, successful or not."""

    prompt: str
    slug: str
    ok: bool = False
    glb_url: str = ""
    viewer_url: str = ""
    ar_url: str = ""
    glb_path: str = ""
    still_path: str = ""
    seconds: float = 0.0
    error: str = ""
    warnings: list[str] = field(default_factory=list)


def render_still(glb_url: str, path: Path, size: int = 1024) -> None:
    """Render a GLB to a PNG still. Raises on any non-image response."""
    body = json.dumps({"glbUrl": glb_url, "width": size, "height": size}).encode()
    req = urllib.request.Request(
        RENDER_API,
        data=body,
        headers={
            "content-type": "application/json",
            "accept": "image/png",
            "user-agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=180) as res:
        content_type = res.headers.get("content-type", "")
        if not content_type.startswith("image/"):
            raise ForgeError(f"renderer returned {content_type}: {res.read()[:200]!r}")
        path.write_bytes(res.read())


def build_one(prompt: str, out: Path, slug: str) -> Asset:
    """Generate, download, and render a single prompt.

    A failed render is a warning, not a failure: the model is still usable, and
    a still is a convenience. A failed generation is a real failure.
    """
    asset = Asset(prompt=prompt, slug=slug)
    started = time.monotonic()
    try:
        result = generate(prompt, log=lambda *_a, **_k: None)
    except ForgeError as exc:
        asset.error = str(exc)
        asset.seconds = time.monotonic() - started
        return asset

    asset.glb_url = result["glbUrl"]
    asset.viewer_url = result.get("viewerUrl", "")
    asset.ar_url = result.get("arUrl", "")

    glb_path = out / "models" / f"{slug}.glb"
    try:
        download(asset.glb_url, str(glb_path))
        asset.glb_path = str(glb_path.relative_to(out))
    except (urllib.error.URLError, OSError) as exc:
        asset.error = f"download failed: {exc}"
        asset.seconds = time.monotonic() - started
        return asset

    still_path = out / "stills" / f"{slug}.png"
    try:
        render_still(asset.glb_url, still_path)
        asset.still_path = str(still_path.relative_to(out))
    except (ForgeError, urllib.error.URLError, OSError) as exc:
        asset.warnings.append(f"still render skipped: {exc}")

    asset.ok = True
    asset.seconds = time.monotonic() - started
    return asset


GALLERY_CSS = """
:root { color-scheme: dark light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: clamp(1.5rem, 4vw, 3rem);
  font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  background: #07070a; color: #e8e8ee;
}
@media (prefers-color-scheme: light) { body { background: #fbfbfd; color: #16161c; } }
h1 { font-size: clamp(1.5rem, 4vw, 2.25rem); margin: 0 0 .25rem; letter-spacing: -.02em; }
.sub { opacity: .65; margin: 0 0 2rem; }
.grid { display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card {
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 14px; overflow: hidden; background: color-mix(in srgb, currentColor 4%, transparent);
  transition: transform .18s ease, border-color .18s ease;
}
.card:hover, .card:focus-within { transform: translateY(-2px); border-color: color-mix(in srgb, currentColor 32%, transparent); }
model-viewer, .card img { width: 100%; aspect-ratio: 1; display: block; background: #000; }
.meta { padding: .85rem 1rem 1rem; }
.meta p { margin: 0 0 .5rem; font-size: .95rem; }
.meta a { color: inherit; opacity: .7; text-decoration: none; border-bottom: 1px solid currentColor; font-size: .8rem; margin-right: .75rem; }
.meta a:hover, .meta a:focus-visible { opacity: 1; }
.failed { border-style: dashed; opacity: .8; }
.failed .meta code { font-size: .75rem; opacity: .7; word-break: break-word; }
footer { margin-top: 2.5rem; opacity: .55; font-size: .85rem; }
footer a { color: inherit; }
"""


def write_gallery(out: Path, assets: list[Asset], elapsed: float) -> None:
    """Write a dependency-free gallery. model-viewer loads from a CDN; the
    stills are local, so the page still communicates without network access."""
    cards = []
    for a in assets:
        if not a.ok:
            cards.append(
                f'<article class="card failed"><div class="meta">'
                f"<p>{_esc(a.prompt)}</p><code>{_esc(a.error)}</code></div></article>"
            )
            continue
        viewer = (
            f'<model-viewer src="{_esc(a.glb_path)}" camera-controls auto-rotate '
            f'touch-action="pan-y" ar shadow-intensity="1" '
            f'alt="{_esc(a.prompt)}"></model-viewer>'
        )
        links = [f'<a href="{_esc(a.glb_path)}" download>GLB</a>']
        if a.still_path:
            links.append(f'<a href="{_esc(a.still_path)}">still</a>')
        if a.ar_url:
            links.append(f'<a href="{_esc(a.ar_url)}">AR</a>')
        cards.append(
            f'<article class="card">{viewer}<div class="meta">'
            f"<p>{_esc(a.prompt)}</p>{''.join(links)}</div></article>"
        )

    built = sum(1 for a in assets if a.ok)
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Asset pack ({built} models)</title>
<style>{GALLERY_CSS}</style>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>
</head>
<body>
<h1>Asset pack</h1>
<p class="sub">{built} of {len(assets)} prompts built in {elapsed:.0f}s on the free three.ws lane. Drag to orbit, scroll to zoom.</p>
<div class="grid">{''.join(cards)}</div>
<footer>Built with the <a href="https://three.ws/cookbook/parallel-asset-pack">parallel asset pack recipe</a>.</footer>
</body>
</html>
"""
    (out / "index.html").write_text(html, encoding="utf-8")


def _esc(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def unique_slugs(prompts: list[str]) -> list[str]:
    """Stable, collision-free filenames even when two prompts slugify alike."""
    seen: dict[str, int] = {}
    slugs = []
    for prompt in prompts:
        base = slugify(prompt)
        seen[base] = seen.get(base, 0) + 1
        slugs.append(base if seen[base] == 1 else f"{base}-{seen[base]}")
    return slugs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build a 3D asset pack from many prompts, in parallel.",
        epilog="Docs: https://three.ws/docs/3d-api",
    )
    parser.add_argument("prompts", nargs="*", help="one prompt per argument")
    parser.add_argument("--prompts-file", help="a text file with one prompt per line")
    parser.add_argument("--out", default="./asset-pack", help="output directory")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="concurrent jobs")
    args = parser.parse_args(argv)

    prompts = list(args.prompts)
    if args.prompts_file:
        lines = Path(args.prompts_file).read_text(encoding="utf-8").splitlines()
        prompts += [line.strip() for line in lines if line.strip() and not line.startswith("#")]
    if not prompts:
        parser.error("give at least one prompt, or --prompts-file")

    out = Path(args.out)
    (out / "models").mkdir(parents=True, exist_ok=True)
    (out / "stills").mkdir(parents=True, exist_ok=True)

    slugs = unique_slugs(prompts)
    workers = max(1, min(args.workers, len(prompts)))
    print(f"building {len(prompts)} models with {workers} workers into {out}/")

    started = time.monotonic()
    assets: list[Asset] = [None] * len(prompts)  # type: ignore[list-item]
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(build_one, prompt, out, slug): i
            for i, (prompt, slug) in enumerate(zip(prompts, slugs))
        }
        for future in concurrent.futures.as_completed(futures):
            index = futures[future]
            asset = future.result()
            assets[index] = asset
            mark = "ok  " if asset.ok else "FAIL"
            print(f"  [{mark}] {asset.prompt[:52]:<52} {asset.seconds:5.0f}s")
            for warning in asset.warnings:
                print(f"         note: {warning}")

    elapsed = time.monotonic() - started
    (out / "manifest.json").write_text(
        json.dumps(
            {
                "generator": "three.ws cookbook / parallel-asset-pack",
                "api": "https://three.ws/api/3d/generate",
                "tier": "free draft",
                "seconds": round(elapsed, 1),
                "assets": [asdict(a) for a in assets],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    write_gallery(out, assets, elapsed)

    built = sum(1 for a in assets if a.ok)
    print(f"\n{built}/{len(assets)} built in {elapsed:.0f}s")
    print(f"open {out / 'index.html'}")
    return 0 if built else 1


if __name__ == "__main__":
    sys.exit(main())
