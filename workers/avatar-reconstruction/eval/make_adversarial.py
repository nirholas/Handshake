"""
Build the adversarial half of the benchmark — the inputs that should NOT drive a
face morph.

`make_refs.py` produces clean portraits, which measure fidelity. They cannot
measure safety, because nothing in them is wrong. This produces the opposite: a
set where the correct behaviour is either "detect nothing" or "detect something
and refuse to use it".

The distinction that matters is between two failure modes:

- **Detection fails.** Safe. `face_pipeline` falls back to texture-only and the
  user gets a template-shaped head rather than a corrupted one.
- **Detection succeeds on the wrong thing.** Dangerous, and the reason this file
  exists. MediaPipe FaceMesh is a *fitted model*: it does not answer "is this a
  face", it answers "where would a face be if there were one". Handed a pet, a
  painting, a mask or a statue it will happily return 468 confident, internally
  coherent landmarks. Every point is wrong in a *correlated* way, so the
  per-control-point clamp in `morph_head_to_landmarks` — which only bounds how
  far any single point may travel — sees nothing unusual and passes the whole
  distorted geometry through to the mesh.

Categories, chosen because each defeats a different assumption:

  non_face   — a face-like thing that is not a person (pet, statue, doll, mask)
  depicted   — a real face, but a picture of one inside a scene (poster, phone
               screen, painting): correct detection, wrong subject, and often a
               severe perspective skew
  crowd      — several faces, so "the" face is ambiguous
  extreme    — a real person past the pose/quality envelope the pipeline assumes
               (near-profile, hard backlight, heavy motion blur)

Usage
-----
    python -m eval.make_adversarial --out eval/adversarial
    python -m eval.make_adversarial --out eval/adversarial --upload

Then measure what the pipeline does with them:

    python -m eval.detection_guard --adversarial eval/adversarial --photos eval/refs
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path

import httpx

PROJECT = "aerial-vehicle-466722-p5"
LOCATION = "us-central1"
MODEL = "gemini-2.5-flash-image"
GCS_PREFIX = "gs://three-ws-avatar-reconstructions/eval-adversarial"

SAMPLES = [
    # ── non_face: face-like, not a person ────────────────────────────────────
    ("non_face", "golden-retriever", "a close-up photograph of a golden retriever dog's face looking straight at the camera, plain grey background, sharp focus"),
    ("non_face", "tabby-cat", "a close-up photograph of a tabby cat's face looking directly at the camera, plain background, sharp focus"),
    ("non_face", "marble-statue", "a frontal photograph of a classical white marble bust of a human head on a plain grey background, museum lighting"),
    ("non_face", "porcelain-doll", "a frontal photograph of an antique porcelain doll's head and shoulders, plain background"),
    ("non_face", "carnival-mask", "a frontal photograph of a decorated venetian carnival mask hanging on a plain grey wall"),
    ("non_face", "shop-mannequin", "a frontal photograph of a featureless retail shop mannequin head on a plain background"),

    # ── depicted: a real face, but not the photographer's subject ────────────
    ("depicted", "wall-poster", "a wide photograph of a city street wall with a large advertising poster of a smiling person's face on it, seen at an angle, other buildings visible"),
    ("depicted", "phone-screen", "a photograph of a hand holding a smartphone that is displaying a portrait photo of a person on its screen, indoor background"),
    ("depicted", "oil-painting", "a photograph of an ornately framed renaissance oil portrait painting hanging on a gallery wall"),
    ("depicted", "magazine-page", "an overhead photograph of an open glossy magazine lying on a wooden table, showing a full-page portrait photograph"),

    # ── crowd: which face? ───────────────────────────────────────────────────
    ("crowd", "group-photo", "a photograph of six friends standing together smiling at the camera outdoors, all faces clearly visible"),
    ("crowd", "two-people", "a photograph of two people standing side by side facing the camera, both faces equally visible, plain background"),

    # ── extreme: a real subject, past the envelope ───────────────────────────
    ("extreme", "near-profile", "a photograph of a person's head in near-complete side profile, ninety degrees to the camera, plain grey background"),
    ("extreme", "hard-backlight", "a photograph of a person standing directly in front of a bright window, face in deep shadow and heavily backlit, silhouette-like"),
    ("extreme", "motion-blur", "a photograph of a person's face with severe motion blur from fast camera movement, barely legible features"),
    ("extreme", "extreme-closeup", "an extreme macro photograph showing only a person's eye and part of the nose, filling the entire frame"),
]


def access_token() -> str:
    return subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def generate(client: httpx.Client, token: str, prompt: str) -> bytes:
    url = (
        f"https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}"
        f"/locations/{LOCATION}/publishers/google/models/{MODEL}:generateContent"
    )
    response = client.post(
        url,
        headers={"Authorization": f"Bearer {token}"},
        json={
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "responseModalities": ["IMAGE"],
                "imageConfig": {"aspectRatio": "3:4"},
            },
        },
        timeout=300.0,
    )
    response.raise_for_status()
    payload = response.json()
    for part in payload.get("candidates", [{}])[0].get("content", {}).get("parts", []):
        if "inlineData" in part:
            return base64.b64decode(part["inlineData"]["data"])
    raise RuntimeError(f"no image returned: {json.dumps(payload)[:200]}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("eval/adversarial"))
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    token = access_token()
    manifest = []

    with httpx.Client() as client:
        for i, (category, slug, prompt) in enumerate(SAMPLES, 1):
            name = f"{category}-{slug}"
            path = args.out / f"{name}.png"
            entry = {"name": name, "category": category, "prompt": prompt}
            if path.exists() and not args.force:
                print(f"[{i}/{len(SAMPLES)}] {name} — exists, skipping")
                manifest.append(entry)
                continue
            print(f"[{i}/{len(SAMPLES)}] {name} … ", end="", flush=True)
            try:
                path.write_bytes(generate(client, token, prompt))
                manifest.append(entry)
                print("ok")
            except Exception as exc:
                print(f"FAILED — {exc}")

    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)}/{len(SAMPLES)} in {args.out}")

    if args.upload:
        subprocess.run(["gcloud", "storage", "rsync", "-r", str(args.out), GCS_PREFIX], check=True)
        print(f"mirrored → {GCS_PREFIX}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
