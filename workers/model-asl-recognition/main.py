"""ASL fingerspelling recognition worker.

Turns webcam signing into text: the browser extracts MediaPipe landmarks
client-side (tasks-vision), assembles the 390-column feature rows published by
GET /schema, and POSTs the frame matrix here; the worker runs the Kaggle-2023
1st-place fingerspelling model (Apache-2.0 weights, FSboard CC BY 4.0 corpus)
on CPU via LiteRT and returns the decoded text. Recognition is in-request
(sub-second for a typical utterance), so the service scales to zero.

API (bearer auth via API_KEY, same secret family as the reconstruction lanes):
  GET  /health      → { ok, model_loaded }
  GET  /schema      → { columns: [390 names], max_frames, min_frames }
  POST /transcribe  { frames: [[390 floats|null]...] }
                    → { text, confidence, frames, ms }
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from decode import FEATURE_COLUMNS, MAX_FRAMES, MIN_FRAMES, decode_with_confidence, validate_frames

MODEL_PATH = os.environ.get("MODEL_PATH", "/models/model.tflite")
API_KEY = os.environ.get("API_KEY", "")

_runner = None
_input_name = None
_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _runner, _input_name
    from ai_edge_litert.interpreter import Interpreter

    interp = Interpreter(model_path=MODEL_PATH)
    _runner = interp.get_signature_runner()
    _input_name = list(_runner.get_input_details().keys())[0]
    yield


app = FastAPI(lifespan=lifespan)


def _check_auth(request: Request) -> None:
    if not API_KEY:
        return
    header = request.headers.get("authorization", "")
    if header != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="unauthorized")


class TranscribeBody(BaseModel):
    frames: list[list[float | None]]


@app.get("/health")
async def health():
    return {"ok": True, "model_loaded": _runner is not None}


@app.get("/schema")
async def schema(request: Request):
    _check_auth(request)
    return {"columns": FEATURE_COLUMNS, "max_frames": MAX_FRAMES, "min_frames": MIN_FRAMES}


@app.post("/transcribe")
async def transcribe(body: TranscribeBody, request: Request):
    _check_auth(request)
    try:
        arr = validate_frames(body.frames)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    t0 = time.time()
    async with _lock:
        logits = await asyncio.to_thread(_infer, arr)
    text, confidence = decode_with_confidence(logits)
    return {
        "text": text,
        "confidence": round(confidence, 3),
        "frames": int(arr.shape[0]),
        "ms": int((time.time() - t0) * 1000),
    }


def _infer(arr: np.ndarray) -> np.ndarray:
    out = _runner(**{_input_name: arr})
    return next(iter(out.values()))
