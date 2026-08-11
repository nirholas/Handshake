"""Unit tests for inference_plan.py: pure planning rules, no GPU, no weights.

    python3 workers/longcat/test_inference_plan.py

Also run as a Docker build gate (see Dockerfile), so a regression in the segment
math, the output-file choice, or the progress tracker fails the image build
rather than shipping a truncated or silent video.

These pin three defects found in the 2026-08-11 audit of this worker:

  * every job passed --num_segments=1, so any audio longer than 3.72 s was
    silently cut off at 3.72 s;
  * the uploaded MP4 was picked with glob("**/*.mp4")[0], which selects
    upstream's audio-less "-temp.mp4" / "-cropvideo.mp4" intermediates roughly
    two times out of three;
  * progress was the raw tqdm percentage, which restarts at 0 % on every
    segment and therefore walks backwards on a multi-segment job.
"""

from __future__ import annotations

import sys

from inference_plan import (
    CONTINUATION_SEGMENT_SECONDS,
    FIRST_SEGMENT_SECONDS,
    ProgressTracker,
    parse_inner_progress,
    segment_span_seconds,
    segments_for_audio,
    select_output_video,
)

PASS = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS
    if not condition:
        print(f"FAIL  {name}  {detail}")
        sys.exit(1)
    PASS += 1


# ── segment geometry ───────────────────────────────────────────────────────────

check(
    "first segment is 93/25 s",
    abs(FIRST_SEGMENT_SECONDS - 3.72) < 1e-9,
    f"got {FIRST_SEGMENT_SECONDS}",
)
check(
    "continuation segment is 80/25 s",
    abs(CONTINUATION_SEGMENT_SECONDS - 3.2) < 1e-9,
    f"got {CONTINUATION_SEGMENT_SECONDS}",
)
check(
    "one segment spans the first-segment length",
    abs(segment_span_seconds(1) - 3.72) < 1e-9,
    f"got {segment_span_seconds(1)}",
)
check(
    "five segments span 3.72 + 4*3.2",
    abs(segment_span_seconds(5) - 16.52) < 1e-9,
    f"got {segment_span_seconds(5)}",
)

# Short audio never needs a continuation pass.
for seconds in (0.5, 1.0, 3.0, 3.72):
    check(
        f"{seconds}s audio needs 1 segment",
        segments_for_audio(seconds, 8) == 1,
        f"got {segments_for_audio(seconds, 8)}",
    )

# Just past the first segment needs exactly one continuation.
check("3.8s audio needs 2 segments", segments_for_audio(3.8, 8) == 2)
check("6.9s audio needs 2 segments", segments_for_audio(6.92, 8) == 2)
check("7.0s audio needs 3 segments", segments_for_audio(7.0, 8) == 3)
check(
    "20s audio needs 7 segments",
    segments_for_audio(20.0, 8) == 7,
    f"got {segments_for_audio(20.0, 8)}",
)

# Whatever the answer, the plan must actually cover the audio (or hit the cap).
for seconds in (1.0, 4.0, 7.5, 12.3, 19.9, 25.0):
    segments = segments_for_audio(seconds, 32)
    check(
        f"{seconds}s is fully covered by {segments} segment(s)",
        segment_span_seconds(segments) >= seconds - 1e-9,
        f"span {segment_span_seconds(segments)} < {seconds}",
    )

check("the cap is respected", segments_for_audio(600.0, 8) == 8)
check("the cap of 1 is respected", segments_for_audio(600.0, 1) == 1)

# An unreadable duration falls back to upstream's own default rather than
# failing the job or planning an unbounded run.
check("None duration falls back to 1 segment", segments_for_audio(None, 8) == 1)
check("zero duration falls back to 1 segment", segments_for_audio(0.0, 8) == 1)
check("negative duration falls back to 1 segment", segments_for_audio(-4.0, 8) == 1)
check("nan duration falls back to 1 segment", segments_for_audio(float("nan"), 8) == 1)
check("inf duration falls back to 1 segment", segments_for_audio(float("inf"), 8) == 1)

for bad in (0, -1):
    try:
        segments_for_audio(5.0, bad)
        check(f"max_segments={bad} rejected", False, "no ValueError raised")
    except ValueError:
        check(f"max_segments={bad} rejected", True)

try:
    segment_span_seconds(0)
    check("segment_span_seconds(0) rejected", False, "no ValueError raised")
except ValueError:
    check("segment_span_seconds(0) rejected", True)


# ── output selection ───────────────────────────────────────────────────────────

# Exactly what upstream's save_video_ffmpeg leaves behind for a single-segment
# ai2v run: the final muxed MP4 plus two audio-less intermediates.
single_segment = [
    "ai2v_demo_1-cropvideo.mp4",
    "ai2v_demo_1-temp.mp4",
    "ai2v_demo_1.mp4",
]
check(
    "single-segment run picks the muxed output",
    select_output_video(single_segment) == "ai2v_demo_1.mp4",
    f"got {select_output_video(single_segment)}",
)
check(
    "sorted order does not change the choice",
    select_output_video(sorted(single_segment)) == "ai2v_demo_1.mp4",
)
check(
    "reversed order does not change the choice",
    select_output_video(list(reversed(single_segment))) == "ai2v_demo_1.mp4",
)

# A three-segment run: each continuation save re-encodes every frame so far, so
# video_continue_3.mp4 is the whole video and video_continue_2.mp4 is a prefix.
three_segments = [
    "ai2v_demo_1-cropvideo.mp4",
    "ai2v_demo_1-temp.mp4",
    "ai2v_demo_1.mp4",
    "video_continue_2-cropvideo.mp4",
    "video_continue_2-temp.mp4",
    "video_continue_2.mp4",
    "video_continue_3-cropvideo.mp4",
    "video_continue_3-temp.mp4",
    "video_continue_3.mp4",
]
check(
    "multi-segment run picks the last continuation",
    select_output_video(three_segments) == "video_continue_3.mp4",
    f"got {select_output_video(three_segments)}",
)
check(
    "segment 10 beats segment 9 numerically, not lexically",
    select_output_video(["video_continue_9.mp4", "video_continue_10.mp4"])
    == "video_continue_10.mp4",
)

check(
    "at2v output is recognised when no ai2v output exists",
    select_output_video(["at2v_demo_1-temp.mp4", "at2v_demo_1.mp4"]) == "at2v_demo_1.mp4",
)
check(
    "ai2v is preferred over at2v",
    select_output_video(["at2v_demo_1.mp4", "ai2v_demo_1.mp4"]) == "ai2v_demo_1.mp4",
)
check(
    "an unexpected name is still usable",
    select_output_video(["something_else.mp4"]) == "something_else.mp4",
)
check(
    "unexpected names are chosen deterministically",
    select_output_video(["b.mp4", "a.mp4"]) == "a.mp4",
)
check("no candidates yields None", select_output_video([]) is None)
check(
    "only intermediates yields None",
    select_output_video(["ai2v_demo_1-temp.mp4", "ai2v_demo_1-cropvideo.mp4"]) is None,
)
check(
    "non-video files are ignored",
    select_output_video(["ai2v_demo_1-cropaudio.wav", "config.json"]) is None,
)
check(
    "nested paths keep their prefix",
    select_output_video(["seg/ai2v_demo_1-temp.mp4", "seg/ai2v_demo_1.mp4"])
    == "seg/ai2v_demo_1.mp4",
)
check(
    "uppercase extensions count as video",
    select_output_video(["AI2V_DEMO_1.MP4"]) == "AI2V_DEMO_1.MP4",
)


# ── progress ───────────────────────────────────────────────────────────────────

check("tqdm bar parses", abs(parse_inner_progress(" 42%|####      | 3/8") - 0.42) < 1e-9)
check("step counter parses", abs(parse_inner_progress("step 2/8") - 0.25) < 1e-9)
check("frame counter parses", abs(parse_inner_progress("frames 25/100") - 0.25) < 1e-9)
check("bare percent parses", abs(parse_inner_progress("done 75% of it") - 0.75) < 1e-9)
check("noise yields None", parse_inner_progress("Loading INT8 quantized DiT model") is None)
check("a zero denominator does not divide by zero", parse_inner_progress("step 1/0") is None)

# A single-segment job maps the inner bar straight through.
tracker = ProgressTracker(expected_segments=1)
check("50% of one segment is 0.5", abs(tracker.update(" 50%|##   |") - 0.5) < 1e-9)
check("progress never goes backwards", tracker.update(" 10%|#    |") is None)
check("tiny forward steps are not reported", tracker.update(" 50%|##   |") is None)
check("a real step forward is reported", abs(tracker.update(" 75%|###  |") - 0.75) < 1e-9)

# A three-segment job: the bar restarting at 0 % must not undo earlier segments.
tracker = ProgressTracker(expected_segments=3)
check(
    "segment 2 of 3 reports one third",
    abs(tracker.update("Generating segment 2/3") - (1 / 3)) < 1e-9,
)
check(
    "half of segment 2 reports half of the middle third",
    abs(tracker.update(" 50%|##   |") - 0.5) < 1e-9,
)
check(
    "entering segment 3 of 3 reports two thirds",
    abs(tracker.update("Generating segment 3/3") - (2 / 3)) < 1e-9,
)
check(
    "segment 3's bar restarting at 30% does not regress below two thirds",
    abs(tracker.update(" 30%|#    |") - (2.3 / 3)) < 1e-9,
)
check(
    "segment 3's bar going back to 10% is ignored",
    tracker.update(" 10%|     |") is None,
)
check("the tracker never exceeds 1.0", tracker.update(" 100%|#####|") == 1.0)
check("nothing is reported once complete", tracker.update(" 100%|#####|") is None)

# The tracker trusts the log over its own estimate: upstream is the authority on
# how many segments are actually running.
tracker = ProgressTracker(expected_segments=1)
tracker.update("Generating segment 2/4")
check("an unexpected segment count is adopted", tracker.total == 4)
check("the current segment is adopted", tracker.segment == 2)

try:
    ProgressTracker(expected_segments=0)
    check("expected_segments=0 rejected", False, "no ValueError raised")
except ValueError:
    check("expected_segments=0 rejected", True)

print(f"OK  {PASS} inference-plan checks passed")
