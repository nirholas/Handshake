"""
Build the reconstruction benchmark's reference face set.

A fidelity score is only meaningful against a fixed, known set of faces, and
that set has to cover what the pipeline actually meets: every complexion, a wide
age range, both presentations, and the accessories that break landmark
detection. A benchmark drawn from whatever selfies were lying around measures
the photos, not the pipeline.

The faces are **synthesised, not collected**. That is a deliberate choice:

- No real person's biometrics sit in a benchmark that gets copied between
  machines, uploaded to buckets and quoted in reports.
- No licensing question. Scraped or stock faces carry terms that a permanent
  internal benchmark should not depend on.
- Reproducible. The grid below is deterministic, so any agent can rebuild the
  same set and get comparable numbers.

The diversity axes are imported wholesale from the platform's existing seeder
matrix (`api/_lib/avaturn-seed.js`) so the benchmark population matches the one
the rest of the product already reasons about.

Usage
-----
    python -m eval.make_refs --out eval/refs                # full grid (40)
    python -m eval.make_refs --out eval/refs --limit 8      # quick set
    python -m eval.make_refs --out eval/refs --upload       # mirror to GCS

Requires application-default credentials with Vertex AI access, which this
workspace already has (`gcloud auth print-access-token`).
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
# The live Gemini image model. The `imagen-3.0-*` :predict ids it replaced are
# past shutdown — see the model-landscape note in api/_mcp3d/vertex-imagen.js.
MODEL = "gemini-2.5-flash-image"
GCS_PREFIX = "gs://three-ws-avatar-reconstructions/eval-refs"

# Mirrors AGE_BANDS / ETHNICITIES / BUILDS in api/_lib/avaturn-seed.js. Kept as a
# deterministic grid rather than the seeder's random draw: a benchmark must be
# the same population every time it is rebuilt.
AGES = [
    ("young-adult", "in their early twenties"),
    ("adult", "in their early thirties"),
    ("middle-aged", "in their late forties, a few soft laugh lines"),
    ("senior", "in their late sixties, natural wrinkles and gentle age lines"),
]

ETHNICITIES = [
    ("east-asian", "East Asian"),
    ("southeast-asian", "Southeast Asian"),
    ("south-asian", "South Asian"),
    ("black-african", "Black African"),
    ("black-caribbean", "Afro-Caribbean"),
    ("latino", "Latin American"),
    ("middle-eastern", "Middle Eastern"),
    ("white-european", "White European"),
    ("nordic", "Nordic"),
    ("pacific-islander", "Pacific Islander"),
]

# Conditions that are *hard* for landmark detection and texture transfer, cycled
# across the grid so the benchmark contains the failures worth knowing about
# rather than forty easy passport photos.
CHALLENGES = [
    ("clean", "no glasses, no hat, hair kept clear of the face"),
    ("glasses", "wearing thin-rimmed prescription glasses"),
    ("beard", "with a full beard and moustache"),
    ("headscarf", "wearing a plain headscarf covering the hair"),
    ("long-hair", "with long loose hair partly framing the cheeks"),
]

BASE_PROMPT = (
    "photorealistic studio ID portrait of {who}, {challenge}, "
    "neutral relaxed expression, mouth closed, looking at the camera, "
    "plain light-grey seamless background, soft even frontal lighting, sharp focus, "
    "natural detailed skin texture, head facing the camera straight on, symmetrical framing"
)


def grid(limit: int | None = None) -> list[dict]:
    """The deterministic reference population: one entry per benchmark face."""
    samples = []
    for i, (eth_key, eth_desc) in enumerate(ETHNICITIES):
        for j, (age_key, age_desc) in enumerate(AGES):
            gender = "man" if (i + j) % 2 == 0 else "woman"
            challenge_key, challenge_desc = CHALLENGES[(i + j) % len(CHALLENGES)]
            # A beard on a woman is not the axis being tested — fall back to clean.
            if challenge_key == "beard" and gender == "woman":
                challenge_key, challenge_desc = CHALLENGES[0]
            samples.append({
                "slug": f"{eth_key}-{age_key}-{gender}-{challenge_key}",
                "prompt": BASE_PROMPT.format(
                    who=f"a {eth_desc} {gender} {age_desc}", challenge=challenge_desc
                ),
                "ethnicity": eth_key,
                "age": age_key,
                "gender": gender,
                "challenge": challenge_key,
            })
    return samples[:limit] if limit else samples


def access_token() -> str:
    return subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def generate(client: httpx.Client, token: str, prompt: str) -> bytes:
    """One face. Raises if the model returns no image (a safety block, usually)."""
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
    ap.add_argument("--out", type=Path, default=Path("eval/refs"))
    ap.add_argument("--limit", type=int, help="generate only the first N of the grid")
    ap.add_argument("--upload", action="store_true", help=f"mirror the set to {GCS_PREFIX}")
    ap.add_argument("--force", action="store_true", help="regenerate faces that already exist")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    samples = grid(args.limit)
    token = access_token()
    manifest = []

    with httpx.Client() as client:
        for i, sample in enumerate(samples, 1):
            path = args.out / f"{sample['slug']}.png"
            if path.exists() and not args.force:
                print(f"[{i}/{len(samples)}] {sample['slug']} — exists, skipping")
                manifest.append(sample)
                continue
            print(f"[{i}/{len(samples)}] {sample['slug']} … ", end="", flush=True)
            try:
                path.write_bytes(generate(client, token, sample["prompt"]))
                manifest.append(sample)
                print("ok")
            except Exception as exc:  # a blocked or failed generation must not stop the set
                print(f"FAILED — {exc}")

    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)}/{len(samples)} faces in {args.out}")

    if args.upload:
        subprocess.run(["gsutil", "-m", "rsync", "-r", str(args.out), GCS_PREFIX], check=True)
        print(f"mirrored → {GCS_PREFIX}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
