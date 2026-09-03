"""The allowlist, enforced a second time, inside the house.

The relay already refuses anything outside this list. This module refuses it
again, here, on the user's own machine. That redundancy is the point: the relay
is operated by three.ws and is therefore the component a user has the least
reason to trust, so a compromised relay must not become a compromised house.

The rules are not transcribed. They are loaded from `allowlist.json`, which is
generated from `services/home-relay/src/protocol.js` and shipped byte-identical
into this integration, so the two enforcement points cannot silently diverge.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_ALLOWLIST_PATH = Path(__file__).parent / "allowlist.json"


@lru_cache(maxsize=1)
def manifest() -> dict[str, Any]:
    """The generated protocol manifest, read once per process."""
    return json.loads(_ALLOWLIST_PATH.read_text(encoding="utf-8"))


async def async_preload(hass: Any) -> None:
    """Warm the cache off the event loop.

    Every allowlist check happens on a hot path inside the loop, and Home
    Assistant rightly refuses to let an integration read a file there. Reading
    it once in an executor at setup makes every later check pure CPU.
    """
    await hass.async_add_executor_job(manifest)


class Denied(Exception):
    """A message was refused by the allowlist.

    Carries the same coded reasons the relay uses, so a refusal reads
    identically wherever it happened.
    """

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def check_outbound(msg: Any) -> None:
    """Refuse anything three.ws must not be able to send into this house."""
    rules = manifest()
    if not isinstance(msg, dict):
        raise Denied("malformed", "A Home Assistant message must be an object.")

    msg_type = msg.get("type")
    if not isinstance(msg_type, str) or msg_type not in rules["outboundTypes"]:
        raise Denied(
            "not_allowed",
            f'"{_describe(msg_type)}" is not a message type three.ws may send into this home.',
        )

    if msg_type == "subscribe_events":
        event_type = msg.get("event_type")
        if not isinstance(event_type, str) or event_type not in rules["allowedEventTypes"]:
            allowed = ", ".join(rules["allowedEventTypes"])
            raise Denied(
                "not_allowed",
                f'subscribe_events is limited to {allowed}; "{_describe(event_type)}" would expose more of this home than the room graph needs.',
            )

    if msg_type == "call_service":
        _check_service_call(msg, rules)


def _check_service_call(msg: dict[str, Any], rules: dict[str, Any]) -> None:
    domain = msg.get("domain")
    service = msg.get("service")
    if not isinstance(domain, str) or not domain or not isinstance(service, str) or not service:
        raise Denied("malformed", "call_service needs a domain and a service.")
    if domain in rules["deniedServiceDomains"]:
        raise Denied(
            "not_allowed",
            f'The "{domain}" domain administers this Home Assistant install rather than a device, so the three.ws integration never runs it.',
        )
    if f"{domain}.{service}" in rules["deniedServices"]:
        raise Denied(
            "not_allowed",
            f'"{domain}.{service}" changes this Home Assistant install itself, so the three.ws integration never runs it.',
        )


def check_inbound(msg: Any) -> None:
    """Refuse anything this house must not send out to three.ws."""
    rules = manifest()
    if not isinstance(msg, dict):
        raise Denied("malformed", "A Home Assistant message must be an object.")
    msg_type = msg.get("type")
    if not isinstance(msg_type, str) or msg_type not in rules["inboundTypes"]:
        raise Denied(
            "not_allowed",
            f'"{_describe(msg_type)}" is not a message type this home sends out through the relay.',
        )


def _describe(value: Any) -> str:
    text = value if isinstance(value, str) else repr(value)
    return text[:64] + "..." if len(text) > 64 else text
