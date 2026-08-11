# model-asl-recognition

Webcam ASL fingerspelling → **text**. A CPU-only FastAPI worker that turns a
stream of MediaPipe landmarks into transcribed text, so a user can sign into
their camera and talk to the platform's chat. The reverse direction of
[sign speech](../../docs/sign-language.md) (avatars signing replies).

## The model (and why it is legally clean)

The recognizer is the **1st-place solution of Google's 2023 ASL Fingerspelling
Recognition Kaggle competition** by Christof Henkel: an improved-Squeezeformer
encoder + transformer decoder, exported to TFLite, run here on CPU via LiteRT.

- Code and released weights: **Apache-2.0**
  (github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution).
- Training corpus: Google's **FSboard** (3M+ fingerspelled characters by 147
  Deaf signers), released **CC BY 4.0** explicitly for academic AND industry
  use. Attribution: FSboard (Google / Deaf Professional Arts Network).

This is the rare ASL stack with clean commercial provenance end to end; most
alternatives (WLASL, How2Sign, ASL Citizen derivatives) are research-only and
must not be shipped. It reads continuous fingerspelling (words, names, URLs,
phone numbers), not just static letter poses. Realistic webcam accuracy is a
10-20% character error rate; the chat LLM downstream is robust to that.

Users meet this worker through the webcam button in agent chat and the demo on
[/sign-language](https://three.ws/sign-language); the guided walkthrough is the
tutorial [Make your avatar sign](https://three.ws/tutorials/sign-with-your-avatar).
The public, keyless proxy in front of it is `/api/asl-recognition`, documented in
[docs/api-reference.md](../../docs/api-reference.md).

## API

Bearer auth on everything but `/health` (`Authorization: Bearer $API_KEY`,
the shared `avatar-reconstruction-key` secret).

```
GET  /health      → { ok, model_loaded }
GET  /schema      → { columns: [390 names], max_frames, min_frames }
POST /transcribe  { frames: [[390 numbers|null]…] }
                  → { text, confidence, frames, ms }
```

`frames` is a per-video-frame matrix of the landmark coordinates named by
`/schema`, in order (`x_face_0 … z_pose_21`, the competition's selected
MediaPipe Holistic columns; `inference_args.json` is the source of truth).
The 390 columns are three blocks of 130: all `x_`, then all `y_`, then all
`z_`. `null` marks a missing landmark (NaN to the model, which was trained for
it), so a capture where a hand leaves frame still decodes. Accepted capture
length is 8 to 1500 frames.

`confidence` is the mean softmax probability of the chosen character over the
decoded positions: near 1.0 for a clean decode, near 1/vocab for noise, 0.0
when nothing decodes. Chat uses it to warn instead of silently inserting
garbage.

The browser extracts landmarks client-side with MediaPipe tasks-vision, so no
video ever leaves the user's machine, only pose coordinates.

## Local run

```bash
cd workers/model-asl-recognition
pip install -r requirements.txt
gsutil cp gs://three-ws-model-weights/aslfr-1st-place/cfg_2-fold-1/model.tflite .
MODEL_PATH=./model.tflite API_KEY= uvicorn main:app --port 8087
```

That is the platform's mirror of the same 40,946,288-byte file the image pulls
from the release zip (sha256
`4dda856e82c4f909c3ae7eb7f070e5fc88afb143daab639683209b631e3cbfaa`); the zip
itself is 192 MB of every fold, so pull the single model unless you need the
others.

Tests. `test_decode.py` is pure NumPy and needs no weights. `test_model_smoke.py`
runs the real model end to end (full capture, a capture with the left hand
missing, the shortest accepted capture) and skips when no weights are present:

```bash
pip install pytest ai-edge-litert
python -m pytest -q -p no:cacheprovider                  # 11 pass, 3 skip
MODEL_PATH=./model.tflite python -m pytest -q -p no:cacheprovider   # 14 pass

# Or against the weights already baked into the image, no test-only install:
docker build -t model-asl-recognition:local .
docker run --rm -v "$PWD:/src" -w /src model-asl-recognition:local \
  python test_model_smoke.py
```

## Deploy

```bash
gcloud builds submit --config workers/model-asl-recognition/cloudbuild.yaml \
  --region us-central1 --project aerial-vehicle-466722-p5 \
  --substitutions=SHORT_SHA=manual$(date +%s)
```

Then point the API at it:

```bash
gcloud run services update three-ws-api --region us-central1 \
  --update-env-vars GCP_ASL_RECOGNITION_URL=<service url>
```

The model is baked into the image from the pinned GitHub release, so instances
cold-start ready and the service scales to zero. The same file is mirrored to
`gs://three-ws-model-weights/aslfr-1st-place/cfg_2-fold-1/model.tflite`, so if
that third-party release ever disappears the build has a first-party source to
point at. Recognition runs inside the
request and stays sub-second at any accepted capture length (measured on the
live service: 0.32s for 40 frames, 0.77s for both 300 and the 1500-frame cap,
since the encoder works to a fixed length), which is why the service is billed
per request rather than kept warm.

## Live

Cloud Run service `model-asl-recognition` in `us-central1`
(https://model-asl-recognition-93741856042.us-central1.run.app), gen2, CPU
only, scale to zero, called only through `/api/asl-recognition` on
`three-ws-api` (`GCP_ASL_RECOGNITION_URL`). Verify it end to end without a key:

```bash
curl -s https://model-asl-recognition-93741856042.us-central1.run.app/health
curl -s https://three.ws/api/asl-recognition | jq '.columns | length'   # 390
```

## Roadmap

Word-level recognition (250 everyday signs) comes from retraining the MIT
Kaggle ISLR 1st-place architecture on the PopSign ASL v1.0 corpus (CC BY 4.0),
a one-GPU-day job, and compiling both models behind this same endpoint.
