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
must not be shipped. It reads continuous fingerspelling — words, names, URLs,
phone numbers — not just static letter poses. Realistic webcam accuracy is a
10–20% character error rate; the chat LLM downstream is robust to that.

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
POST /transcribe  { frames: [[390 numbers|null]…] } → { text, frames, ms }
```

`frames` is a per-video-frame matrix of the landmark coordinates named by
`/schema`, in order (`x_face_0 … z_pose_21` — the competition's selected
MediaPipe Holistic columns; `inference_args.json` is the source of truth).
`null` marks a missing landmark (NaN to the model, which was trained for it).
The browser extracts landmarks client-side with MediaPipe tasks-vision, so no
video ever leaves the user's machine — only pose coordinates.

## Local run

```bash
cd workers/model-asl-recognition
pip install -r requirements.txt
# fetch cfg_2/fold-1/model.tflite from the release zip, then:
MODEL_PATH=./model.tflite API_KEY= uvicorn main:app --port 8087
python -m pytest test_decode.py -q     # pure decode/schema tests, no model
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

The model (40 MB) is baked into the image from the pinned GitHub release, so
instances cold-start ready and the service scales to zero (recognition runs
inside the request, sub-second per utterance).

## Roadmap

Word-level recognition (250 everyday signs) comes from retraining the MIT
Kaggle ISLR 1st-place architecture on the PopSign ASL v1.0 corpus (CC BY 4.0)
— a one-GPU-day job — and compiling both models behind this same endpoint.
