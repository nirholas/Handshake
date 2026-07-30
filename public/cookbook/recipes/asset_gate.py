#!/usr/bin/env python3
"""Quality-gate 3D assets in CI before they reach a user.

Generated geometry fails quietly. A model can download fine, validate fine, and
still be a 400k-triangle monster that drops a phone to 8fps, or a GLB whose
materials never loaded. This gate inspects every asset against an explicit
budget and exits non-zero when one busts it, so a bad asset fails the build
instead of the launch.

    python3 asset_gate.py model.glb                       # a local file
    python3 asset_gate.py https://example.com/model.glb   # or a URL
    python3 asset_gate.py assets/*.glb --max-triangles 50000 --json report.json

Exit codes: 0 all assets pass, 1 at least one failed, 2 the gate could not run.

Standard library only. No API key, no account.

Recipe: https://three.ws/cookbook/asset-quality-gate
API reference: https://three.ws/docs/3d-api
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

INSPECT_API = "https://three.ws/api/3d/inspect"
USER_AGENT = "three.ws-cookbook/asset_gate.py"

# Defaults sized for a model that has to load over mobile data and render in a
# web page next to other content. Override every one of them for your own bar.
DEFAULTS = {
    "max_triangles": 100_000,
    "max_size_mb": 8.0,
    "max_materials": 16,
    "min_triangles": 100,
    "require_textures": False,
    "require_materials": False,
}


@dataclass
class Report:
    """One asset's verdict, plus the numbers the verdict was made from."""

    asset: str
    passed: bool = False
    failures: list[str] = field(default_factory=list)
    advisories: list[str] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    size_bytes: int = 0


class GateError(RuntimeError):
    """The gate itself could not run (network, unreadable file, bad response)."""


def _post_bytes(url: str, filename: str, payload: bytes) -> dict:
    """Upload a model by sending its raw bytes as the request body.

    The inspect endpoint treats any non-JSON POST body as the model itself, so
    there is no multipart envelope to build.
    """
    content_type = "model/gltf+json" if filename.endswith(".gltf") else "model/gltf-binary"
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "content-type": content_type,
            "accept": "application/json",
            "user-agent": USER_AGENT,
        },
    )
    return _read_json(req)


def _read_json(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=180) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            detail = json.loads(raw).get("error_description") or json.loads(raw).get("error")
        except json.JSONDecodeError:
            detail = raw[:200]
        raise GateError(f"HTTP {exc.code} from the inspect API: {detail}") from exc
    except urllib.error.URLError as exc:
        raise GateError(f"could not reach the inspect API: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise GateError(f"the inspect API returned malformed JSON: {exc}") from exc


def inspect(asset: str) -> dict:
    """Inspect a local path or a URL and return the raw API payload."""
    if asset.startswith(("http://", "https://")):
        query = urllib.parse.urlencode({"url": asset})
        req = urllib.request.Request(
            f"{INSPECT_API}?{query}",
            headers={"accept": "application/json", "user-agent": USER_AGENT},
        )
        return _read_json(req)

    path = Path(asset)
    if not path.is_file():
        raise GateError(f"no such file: {asset}")
    return _post_bytes(INSPECT_API, path.name, path.read_bytes())


def evaluate(asset: str, payload: dict, budget: dict) -> Report:
    """Turn an inspect payload plus a budget into a pass or fail verdict."""
    stats = payload.get("stats") or {}
    validation = payload.get("validation") or {}
    size_bytes = int(payload.get("sizeBytes") or 0)
    report = Report(asset=asset, stats=stats, size_bytes=size_bytes)

    if not payload.get("valid", False):
        report.failures.append("the file is not a valid glTF/GLB container")

    errors = int(validation.get("numErrors") or 0)
    if errors:
        report.failures.append(f"glTF validator reported {errors} error(s)")

    triangles = int(stats.get("triangles") or 0)
    if triangles > budget["max_triangles"]:
        report.failures.append(
            f"{triangles:,} triangles exceeds the budget of {budget['max_triangles']:,}"
        )
    if triangles < budget["min_triangles"]:
        report.failures.append(
            f"only {triangles:,} triangles: generation probably collapsed "
            f"(minimum {budget['min_triangles']:,})"
        )

    size_mb = size_bytes / 1_048_576
    if size_mb > budget["max_size_mb"]:
        report.failures.append(f"{size_mb:.1f} MB exceeds the budget of {budget['max_size_mb']:.1f} MB")

    materials = int(stats.get("materials") or 0)
    if materials > budget["max_materials"]:
        report.failures.append(f"{materials} materials exceeds the budget of {budget['max_materials']}")

    textures = int(stats.get("textures") or 0)
    # Zero materials is NOT automatically broken. The free draft lane routinely
    # ships vertex-colored geometry: color lives in a COLOR_0 attribute, so the
    # model renders in full color with no material and no texture image. Treat
    # it as something to look at, and let a caller who genuinely needs PBR
    # materials opt into failing on it.
    if materials == 0:
        if budget["require_materials"]:
            report.failures.append("no materials, and --require-materials was set")
        else:
            report.advisories.append(
                "no materials: likely vertex-colored geometry, which renders in color "
                "but ignores your lighting setup. Pass --require-materials to fail on it."
            )
    if budget["require_textures"] and textures == 0:
        report.failures.append("no textures, and --require-textures was set")

    warnings = int(validation.get("numWarnings") or 0)
    if warnings:
        report.advisories.append(f"glTF validator reported {warnings} warning(s)")
    for rec in payload.get("recommendations") or []:
        if rec.get("severity") in ("warn", "warning", "error"):
            report.advisories.append(rec.get("issue", ""))

    report.passed = not report.failures
    return report


def render_line(report: Report) -> str:
    stats = report.stats
    return (
        f"{'PASS' if report.passed else 'FAIL'}  {Path(report.asset).name[:44]:<44} "
        f"{int(stats.get('triangles') or 0):>8,} tris  "
        f"{report.size_bytes / 1_048_576:>6.1f} MB  "
        f"{int(stats.get('materials') or 0):>2} mat  "
        f"{int(stats.get('textures') or 0):>2} tex"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail the build when a 3D asset busts its budget.",
        epilog="Docs: https://three.ws/docs/3d-api",
    )
    parser.add_argument("assets", nargs="+", help="local .glb paths or public URLs")
    parser.add_argument("--max-triangles", type=int, default=DEFAULTS["max_triangles"])
    parser.add_argument("--min-triangles", type=int, default=DEFAULTS["min_triangles"])
    parser.add_argument("--max-size-mb", type=float, default=DEFAULTS["max_size_mb"])
    parser.add_argument("--max-materials", type=int, default=DEFAULTS["max_materials"])
    parser.add_argument(
        "--require-textures",
        action="store_true",
        help="fail an asset that ships no texture images",
    )
    parser.add_argument(
        "--require-materials",
        action="store_true",
        help="fail an asset with no glTF materials (rejects vertex-colored-only geometry)",
    )
    parser.add_argument("--json", help="also write the full report to this path")
    args = parser.parse_args(argv)

    budget = {
        "max_triangles": args.max_triangles,
        "min_triangles": args.min_triangles,
        "max_size_mb": args.max_size_mb,
        "max_materials": args.max_materials,
        "require_textures": args.require_textures,
        "require_materials": args.require_materials,
    }

    reports: list[Report] = []
    for asset in args.assets:
        try:
            payload = inspect(asset)
        except GateError as exc:
            print(f"gate could not run on {asset}: {exc}", file=sys.stderr)
            return 2
        report = evaluate(asset, payload, budget)
        reports.append(report)
        print(render_line(report))
        for failure in report.failures:
            print(f"      fail: {failure}")
        for advisory in report.advisories:
            print(f"      note: {advisory}")

    if args.json:
        Path(args.json).write_text(
            json.dumps({"budget": budget, "reports": [asdict(r) for r in reports]}, indent=2),
            encoding="utf-8",
        )

    failed = [r for r in reports if not r.passed]
    print(f"\n{len(reports) - len(failed)}/{len(reports)} assets passed the budget")
    if failed and os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write(f"### 3D asset gate: {len(failed)} failed\n")
            for report in failed:
                summary.write(f"- `{report.asset}`: {'; '.join(report.failures)}\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
