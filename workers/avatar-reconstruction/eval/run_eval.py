"""
Batch identity evaluation — score a whole reference set against a live
reconstruction worker, and compare two revisions head to head.

This is the regression gate for the reconstruction pipeline. Point it at a
directory of reference selfies and a deployed worker; it submits every photo,
waits for the GLBs, scores each with `identity_eval`, and writes a report. Run
it against two service URLs (or the same service before and after a change) to
get a defensible answer to "did that actually improve fidelity?" instead of
comparing screenshots.

Usage
-----
    export RECON_KEY=$(gcloud secrets versions access latest \
        --secret=avatar-reconstruction-key --project=aerial-vehicle-466722-p5)

    # score one deployment
    python -m eval.run_eval --photos eval/refs --url https://<service>.run.app \
        --out eval/reports/v2.json

    # compare a report against an earlier one
    python -m eval.run_eval --compare eval/reports/v1.json eval/reports/v2.json

Reference set
-------------
`--photos` is a directory of frontal selfies. Use faces that span the axes the
pipeline is expected to handle — skin tone, age, face shape, facial hair,
glasses, lighting — because a mean over a narrow set hides exactly the failures
that matter. Each file is one sample; sub-directories are ignored.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eval.identity_eval import EvalError, evaluate  # noqa: E402

POLL_INTERVAL_S = 3.0
JOB_TIMEOUT_S = 300.0
SUBMIT_TIMEOUT_S = 60.0
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def _data_url(path: Path) -> str:
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def reconstruct(client: httpx.Client, url: str, key: str, photo: Path, body_type: str) -> bytes:
    """Submit one photo, wait for the job, return the finished GLB bytes."""
    headers = {"authorization": f"Bearer {key}"}
    submit = client.post(
        f"{url}/reconstruct",
        headers=headers,
        json={"images": [_data_url(photo)], "body_type": body_type},
        timeout=SUBMIT_TIMEOUT_S,
    )
    submit.raise_for_status()
    job_id = submit.json()["job_id"]

    deadline = time.monotonic() + JOB_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_S)
        job = client.get(f"{url}/jobs/{job_id}", headers=headers, timeout=SUBMIT_TIMEOUT_S).json()
        status = job.get("status")
        if status == "done":
            glb_url = job.get("glb_url")
            if not glb_url:
                raise EvalError(f"{photo.name}: job finished without a glb_url")
            glb = client.get(glb_url, timeout=120.0)
            glb.raise_for_status()
            return glb.content
        if status == "failed":
            detail = (job.get("error") or "unknown").strip().splitlines()[-1]
            raise EvalError(f"{photo.name}: {detail}")

    raise EvalError(f"{photo.name}: job {job_id} did not finish within {JOB_TIMEOUT_S:.0f}s")


def run(photos: Path, url: str, key: str, out: Path, body_type: str, keep_glb: bool) -> dict:
    samples = sorted(p for p in photos.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES)
    if not samples:
        raise EvalError(f"no photos in {photos} (looked for {', '.join(sorted(PHOTO_SUFFIXES))})")

    glb_dir = out.parent / f"{out.stem}-glb"
    if keep_glb:
        glb_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    failures: list[dict] = []

    with httpx.Client(follow_redirects=True) as client:
        health = client.get(f"{url}/health", timeout=30.0).json()
        print(f"worker: {health.get('pipeline')}  geometry_morph={health.get('geometry_morph')}")

        for i, photo in enumerate(samples, 1):
            print(f"[{i}/{len(samples)}] {photo.name} … ", end="", flush=True)
            try:
                glb_bytes = reconstruct(client, url, key, photo, body_type)
                glb_path = (glb_dir if keep_glb else out.parent) / f"{photo.stem}.glb"
                glb_path.parent.mkdir(parents=True, exist_ok=True)
                glb_path.write_bytes(glb_bytes)
                result = evaluate(photo, glb_path)
                if not keep_glb:
                    glb_path.unlink()
                results.append(result)
                print(f"ISE {result['ise']:.4f}")
            except (EvalError, httpx.HTTPError) as exc:
                failures.append({"selfie": photo.name, "error": str(exc)})
                print(f"FAILED — {exc}")

    if not results:
        raise EvalError("every sample failed — nothing to summarise")

    scores = [r["ise"] for r in results]
    regions = sorted({name for r in results for name in r["regions"]})
    report = {
        "url": url,
        "pipeline": health.get("pipeline"),
        "geometry_morph": health.get("geometry_morph"),
        "samples": len(results),
        "failed": len(failures),
        "ise_mean": statistics.fmean(scores),
        "ise_median": statistics.median(scores),
        "ise_worst": max(scores),
        "region_mean": {
            name: statistics.fmean([r["regions"][name] for r in results if name in r["regions"]])
            for name in regions
        },
        "results": results,
        "failures": failures,
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2))
    print(f"\n{report['samples']} scored, {report['failed']} failed")
    print(f"  ISE mean   {report['ise_mean']:.4f}")
    print(f"  ISE median {report['ise_median']:.4f}")
    print(f"  ISE worst  {report['ise_worst']:.4f}")
    print(f"  report → {out}")
    return report


def compare(before: Path, after: Path) -> int:
    a, b = json.loads(before.read_text()), json.loads(after.read_text())
    delta = b["ise_mean"] - a["ise_mean"]
    pct = (-delta / a["ise_mean"] * 100) if a["ise_mean"] else 0.0

    print(f"{before.name}  ({a.get('pipeline')})  ISE {a['ise_mean']:.4f}  n={a['samples']}")
    print(f"{after.name}   ({b.get('pipeline')})  ISE {b['ise_mean']:.4f}  n={b['samples']}")
    print(f"\n{'IMPROVED' if delta < 0 else 'REGRESSED'} {abs(pct):.1f}%")

    print("\nby region:")
    for name in sorted(set(a["region_mean"]) & set(b["region_mean"])):
        av, bv = a["region_mean"][name], b["region_mean"][name]
        arrow = "↓" if bv < av else "↑"
        print(f"  {name:8s} {av:.4f} → {bv:.4f}  {arrow}{abs(bv - av) / av * 100:5.1f}%")

    # Per-face movement catches a change that improves the mean while making
    # some faces materially worse — the failure mode a mean alone hides.
    by_name = {r["selfie"]: r["ise"] for r in a["results"]}
    regressions = [
        (r["selfie"], by_name[r["selfie"]], r["ise"])
        for r in b["results"]
        if r["selfie"] in by_name and r["ise"] > by_name[r["selfie"]] * 1.02
    ]
    if regressions:
        print(f"\n{len(regressions)} face(s) got worse:")
        for name, av, bv in sorted(regressions, key=lambda t: t[1] - t[2]):
            print(f"  {name:30s} {av:.4f} → {bv:.4f}")

    return 0 if delta < 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--photos", type=Path, help="directory of reference selfies")
    ap.add_argument("--url", help="worker base URL")
    ap.add_argument("--key", default=os.environ.get("RECON_KEY"), help="worker API key (or $RECON_KEY)")
    ap.add_argument("--out", type=Path, default=Path("eval/reports/latest.json"))
    ap.add_argument("--body-type", default="neutral", choices=["male", "female", "neutral"])
    ap.add_argument("--keep-glb", action="store_true", help="keep the GLBs for visual inspection")
    ap.add_argument("--compare", nargs=2, type=Path, metavar=("BEFORE", "AFTER"))
    args = ap.parse_args()

    if args.compare:
        return compare(*args.compare)

    if not (args.photos and args.url and args.key):
        ap.error("--photos, --url and --key (or $RECON_KEY) are required unless --compare is used")

    try:
        run(args.photos, args.url.rstrip("/"), args.key, args.out, args.body_type, args.keep_glb)
    except EvalError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
