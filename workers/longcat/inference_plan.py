"""Pure inference-planning helpers for the LongCat avatar worker.

Everything in here is dependency-light and side-effect free so it can be unit
tested without a GPU, without model weights, and without GCP credentials. The
Docker build runs test_inference_plan.py against this module as a build gate.

Three concerns live here, all of them things that were previously wrong or
missing in main.py:

  1. ``segments_for_audio``: upstream generates a fixed 93-frame clip per
     segment. Passing the default ``--num_segments=1`` silently truncated every
     input longer than 3.72 s, which is nearly every real voice clip.
  2. ``select_output_video``: upstream's ``save_video_ffmpeg`` leaves three
     MP4s per save (``<name>-temp.mp4`` with no audio, ``<name>-cropvideo.mp4``
     with no audio, and the final muxed ``<name>.mp4``). Picking the first glob
     hit uploaded a silent video roughly two times out of three.
  3. ``ProgressTracker``: a per-segment tqdm bar restarts at 0 % on every
     segment, so raw bar percentages walk backwards across a multi-segment job.
"""

from __future__ import annotations

import math
import re
from pathlib import PurePosixPath
from typing import Iterable, Optional

# Inference geometry for --model_type avatar-v1.5, read from upstream's
# run_demo_avatar_single_audio_to_video.py (meituan-longcat/LongCat-Video):
# save_fps = 25 and audio_stride = 1 for v1.5, num_frames = 93,
# num_cond_frames = 13.
SAVE_FPS = 25
NUM_FRAMES = 93
NUM_COND_FRAMES = 13

# Segment 1 covers num_frames/save_fps seconds. Every continuation segment
# re-generates num_cond_frames of overlap with the previous one, so it only adds
# (num_frames - num_cond_frames)/save_fps seconds of new video. This mirrors
# upstream's own generate_duration formula.
FIRST_SEGMENT_SECONDS = NUM_FRAMES / SAVE_FPS
CONTINUATION_SEGMENT_SECONDS = (NUM_FRAMES - NUM_COND_FRAMES) / SAVE_FPS

# Names save_video_ffmpeg writes as intermediates next to the real output. Both
# are video-only: the audio is muxed in only for the final "<name>.mp4".
_INTERMEDIATE_STEM_SUFFIXES = ("-temp", "-cropvideo")

_CONTINUATION_RE = re.compile(r"video_continue_(\d+)")

# Stage-1 outputs, in the order we prefer them when no continuation segment ran.
_STAGE1_STEMS = ("ai2v_demo_1", "at2v_demo_1")


def segment_span_seconds(segments: int) -> float:
    """Video length upstream produces for ``segments`` segments."""
    if segments < 1:
        raise ValueError("segments must be >= 1")
    return FIRST_SEGMENT_SECONDS + (segments - 1) * CONTINUATION_SEGMENT_SECONDS


def segments_for_audio(seconds: Optional[float], max_segments: int) -> int:
    """Number of segments needed to cover ``seconds`` of audio.

    Upstream pads the audio with silence up to the generated duration, so
    overshooting by a fraction of a segment is harmless; undershooting drops the
    tail of the speech. Round up, then clamp to ``max_segments`` so one long
    upload cannot monopolise the GPU.

    ``seconds`` is Optional because ffprobe can fail on an exotic container. In
    that case fall back to upstream's own default of a single segment rather
    than failing the job.
    """
    if max_segments < 1:
        raise ValueError("max_segments must be >= 1")
    if seconds is None or not math.isfinite(seconds) or seconds <= 0:
        return 1
    extra = seconds - FIRST_SEGMENT_SECONDS
    if extra <= 0:
        return 1
    segments = 1 + math.ceil(extra / CONTINUATION_SEGMENT_SECONDS)
    return min(segments, max_segments)


def select_output_video(names: Iterable[str]) -> Optional[str]:
    """Pick the final, audio-muxed MP4 from the files upstream left behind.

    ``names`` are paths relative to the run's output directory. Returns the
    chosen name, or None when the run produced no usable video.

    Preference order:
      1. the highest-numbered ``video_continue_N.mp4``, each continuation save
         re-encodes every frame generated so far, so the last one is the whole
         video, not just its final segment;
      2. the stage-1 output (``ai2v_demo_1.mp4``, then ``at2v_demo_1.mp4``);
      3. any remaining non-intermediate MP4, lowest name first for determinism.
    """
    finals: list[str] = []
    for name in names:
        path = PurePosixPath(name)
        if path.suffix.lower() != ".mp4":
            continue
        if any(path.stem.endswith(suffix) for suffix in _INTERMEDIATE_STEM_SUFFIXES):
            continue
        finals.append(name)

    if not finals:
        return None

    continuations: list[tuple[int, str]] = []
    for name in finals:
        match = _CONTINUATION_RE.fullmatch(PurePosixPath(name).stem)
        if match:
            continuations.append((int(match.group(1)), name))
    if continuations:
        return max(continuations, key=lambda pair: pair[0])[1]

    for stem in _STAGE1_STEMS:
        for name in sorted(finals):
            if PurePosixPath(name).stem == stem:
                return name

    return sorted(finals)[0]


# Inner-progress patterns, tried in order. Each yields a 0-1 float describing
# how far the CURRENT segment has come. Covers tqdm bars ("42%|"), "frame X/Y",
# "step X/Y", and a bare "X%".
_INNER_PATTERNS: list[tuple[re.Pattern, object]] = [
    (re.compile(r"^\s*(\d+)%\|"), lambda m: float(m.group(1)) / 100),
    (
        re.compile(r"frames?\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE),
        lambda m: int(m.group(1)) / int(m.group(2)) if int(m.group(2)) > 0 else None,
    ),
    (
        re.compile(r"steps?\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE),
        lambda m: int(m.group(1)) / int(m.group(2)) if int(m.group(2)) > 0 else None,
    ),
    (re.compile(r"\b(\d{1,3})%"), lambda m: min(float(m.group(1)) / 100, 1.0)),
]

# Upstream prints this once per segment, from rank 0 only.
_SEGMENT_RE = re.compile(r"Generating segment\s+(\d+)\s*/\s*(\d+)")


def parse_inner_progress(line: str) -> Optional[float]:
    """Fraction of the current segment implied by ``line``, or None."""
    for pattern, extractor in _INNER_PATTERNS:
        match = pattern.search(line)
        if match:
            try:
                value = extractor(match)
            except (ZeroDivisionError, ValueError):
                continue
            if value is not None and 0.0 <= value <= 1.0:
                return value
    return None


class ProgressTracker:
    """Turns upstream's interleaved log lines into one monotonic 0-1 fraction.

    A multi-segment run restarts its inner bar at 0 % for every segment, so the
    raw percentages are not a job-level progress signal on their own. Combining
    the segment counter with the inner bar gives a fraction that only ever
    moves forward, which is what the polling client renders.
    """

    def __init__(self, expected_segments: int = 1) -> None:
        if expected_segments < 1:
            raise ValueError("expected_segments must be >= 1")
        self.total = expected_segments
        self.segment = 1
        self.value: float = 0.0

    def update(self, line: str) -> Optional[float]:
        """Feed one log line. Returns the new fraction only when it advances."""
        segment_match = _SEGMENT_RE.search(line)
        if segment_match:
            index, total = int(segment_match.group(1)), int(segment_match.group(2))
            if total > 0:
                self.total = total
            if index >= 1:
                self.segment = index
            return self._advance((self.segment - 1) / self.total)

        inner = parse_inner_progress(line)
        if inner is None:
            return None
        return self._advance((self.segment - 1 + inner) / self.total)

    def _advance(self, candidate: float) -> Optional[float]:
        candidate = max(0.0, min(candidate, 1.0))
        # Report only forward movement, and only in steps big enough to be worth
        # a Firestore write: an 8-step bar emits hundreds of lines per segment.
        if candidate <= self.value + 1e-9 or candidate - self.value < 0.01:
            return None
        self.value = candidate
        return candidate
