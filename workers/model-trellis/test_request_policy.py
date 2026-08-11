"""Unit tests for the request policy: quality tiers and transient-fetch retry.

Pure stdlib plus httpx, no torch and no CUDA, so this runs anywhere:

    cd workers/model-trellis && python3 -m pytest test_request_policy.py -q

Everything here is on the hot path of every generation. The tier table decides
what the samplers actually do, the clamps are the only thing standing between a
caller value and a crashed bake, and the retry policy is what keeps one blip on
a public image host from failing a whole reconstruction.
"""

import httpx
import pytest

from request_policy import (
    FETCH_ATTEMPTS,
    QUALITY_DEFAULTS,
    TIER_PRESETS,
    call_with_retry,
    clamped_quality,
    is_transient_fetch_error,
    matte_enabled,
    normalize_tier,
    retry_delays,
)

# ---------------------------------------------------------------- quality tiers


def test_no_tier_keeps_historical_defaults():
    assert clamped_quality(None) == QUALITY_DEFAULTS


def test_every_tier_resolves_to_its_preset():
    for name, preset in TIER_PRESETS.items():
        assert clamped_quality(None, name) == preset, name


def test_tier_is_case_and_whitespace_tolerant():
    assert clamped_quality(None, "  MAX  ") == TIER_PRESETS["max"]


def test_unknown_tier_falls_back_to_defaults():
    assert clamped_quality(None, "ultra") == QUALITY_DEFAULTS


def test_quality_dict_overrides_the_tier_field_by_field():
    resolved = clamped_quality({"texture_size": 1024}, "max")
    assert resolved["texture_size"] == 1024
    # Every other field still comes from the tier.
    assert resolved["ss_steps"] == TIER_PRESETS["max"]["ss_steps"]
    assert resolved["simplify"] == TIER_PRESETS["max"]["simplify"]


def test_steps_and_cfg_clamp_to_the_l4_envelope():
    resolved = clamped_quality(
        {"ss_steps": 9999, "slat_steps": 0, "ss_cfg": 99.0, "slat_cfg": 0.0, "simplify": 1.0}
    )
    assert resolved["ss_steps"] == 50
    assert resolved["slat_steps"] == 8
    assert resolved["ss_cfg"] == 15.0
    assert resolved["slat_cfg"] == 1.0
    assert resolved["simplify"] == 0.98


def test_texture_size_snaps_down_to_a_power_of_two():
    # Regression: a 3072 request killed every generation at the nvdiffrast bake
    # (live 2026-07-16). It must land on 2048, never pass through.
    assert clamped_quality({"texture_size": 3072})["texture_size"] == 2048
    assert clamped_quality({"texture_size": 4096})["texture_size"] == 4096
    assert clamped_quality({"texture_size": 100})["texture_size"] == 512
    assert clamped_quality({"texture_size": 99999})["texture_size"] == 4096


def test_unparseable_values_fall_back_to_the_base_rather_than_failing():
    resolved = clamped_quality({"ss_steps": "many", "slat_cfg": None}, "draft")
    assert resolved["ss_steps"] == TIER_PRESETS["draft"]["ss_steps"]
    assert resolved["slat_cfg"] == TIER_PRESETS["draft"]["slat_cfg"]


def test_resolved_quality_always_carries_every_sampler_field():
    for tier in [None, *TIER_PRESETS]:
        assert set(clamped_quality(None, tier)) == set(QUALITY_DEFAULTS)


def test_normalize_tier():
    assert normalize_tier(None) is None
    assert normalize_tier("   ") is None
    assert normalize_tier(" High ") == "high"


def test_matte_defaults_on_only_for_max():
    assert matte_enabled(None, "max") is True
    assert matte_enabled(None, "high") is False
    assert matte_enabled(None, None) is False
    # An explicit caller value always wins over the tier default.
    assert matte_enabled(False, "max") is False
    assert matte_enabled(True, "draft") is True


# ------------------------------------------------------------------ fetch retry


def _timeout():
    return httpx.ReadTimeout("read timed out")


def _status(code):
    request = httpx.Request("GET", "https://example.invalid/a.png")
    response = httpx.Response(code, request=request)
    return httpx.HTTPStatusError(f"http {code}", request=request, response=response)


def test_transient_classification():
    assert is_transient_fetch_error(_timeout()) is True
    assert is_transient_fetch_error(httpx.ConnectError("refused")) is True
    assert is_transient_fetch_error(_status(503)) is True
    assert is_transient_fetch_error(_status(429)) is True
    # A URL that is wrong stays wrong: retrying it only wastes the job's budget.
    assert is_transient_fetch_error(_status(404)) is False
    assert is_transient_fetch_error(_status(403)) is False
    assert is_transient_fetch_error(ValueError("not an image")) is False


def test_retry_delays_back_off_exponentially():
    assert retry_delays(3, 1.0) == [1.0, 2.0]
    assert retry_delays(1, 1.0) == []


def test_returns_immediately_when_the_first_attempt_works():
    calls = []
    slept = []
    result = call_with_retry(
        lambda: (calls.append(1), "ok")[1], sleep=slept.append
    )
    assert result == "ok"
    assert len(calls) == 1
    assert slept == []


def test_recovers_from_a_transient_blip():
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise _timeout()
        return b"glb"

    slept = []
    assert call_with_retry(flaky, sleep=slept.append) == b"glb"
    assert len(attempts) == 3
    assert slept == [1.0, 2.0]


def test_gives_up_after_the_attempt_budget():
    attempts = []

    def always_times_out():
        attempts.append(1)
        raise _timeout()

    slept = []
    with pytest.raises(httpx.ReadTimeout):
        call_with_retry(always_times_out, sleep=slept.append)
    assert len(attempts) == FETCH_ATTEMPTS
    assert len(slept) == FETCH_ATTEMPTS - 1


def test_does_not_retry_a_permanent_failure():
    attempts = []

    def not_found():
        attempts.append(1)
        raise _status(404)

    slept = []
    with pytest.raises(httpx.HTTPStatusError):
        call_with_retry(not_found, sleep=slept.append)
    assert len(attempts) == 1
    assert slept == []


def test_on_retry_receives_the_attempt_delay_and_cause():
    seen = []

    def flaky():
        if len(seen) < 1:
            raise _timeout()
        return "ok"

    call_with_retry(flaky, sleep=lambda _: None, on_retry=lambda n, d, e: seen.append((n, d, type(e))))
    assert seen == [(1, 1.0, httpx.ReadTimeout)]
