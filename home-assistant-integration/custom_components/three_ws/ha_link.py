"""One authenticated WebSocket connection from this integration to its own
Home Assistant, on localhost.

Why a loopback WebSocket rather than calling `hass` directly: three.ws speaks
Home Assistant's own WebSocket protocol, including the compressed entity
subscription format. Reimplementing those wire shapes here would be a second,
subtly different Home Assistant API that drifts every release. Talking to the
real one keeps every shape authentic and keeps this integration small enough to
audit.

The credential never leaves this machine. It is a system refresh token this
integration mints for a system user it creates, exactly as the first-party
Supervisor integration does, and the short-lived access tokens derived from it
are used only against 127.0.0.1. three.ws never sees any of it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

import aiohttp
from homeassistant.core import HomeAssistant

from .const import LOCAL_CONNECT_TIMEOUT

_LOGGER = logging.getLogger(__name__)


class LocalHomeAssistantError(Exception):
    """The local Home Assistant WebSocket API refused or dropped us."""


class LocalLink:
    """A post-authentication view of the local Home Assistant WebSocket API."""

    def __init__(
        self,
        hass: HomeAssistant,
        url: str,
        access_token: str,
        on_message: Callable[[dict[str, Any]], Any],
        on_close: Callable[[], Any],
    ) -> None:
        self._hass = hass
        self._url = url
        self._access_token = access_token
        self._on_message = on_message
        self._on_close = on_close
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._reader: asyncio.Task[None] | None = None
        self.ha_version: str = ""

    async def connect(self) -> None:
        """Open the socket and complete Home Assistant's auth handshake."""
        # A dedicated session, not the shared HA one: this connection is
        # long-lived and closing it must not disturb anything else.
        self._session = aiohttp.ClientSession()
        try:
            self._ws = await self._session.ws_connect(
                self._url, heartbeat=30, timeout=aiohttp.ClientWSTimeout(ws_close=LOCAL_CONNECT_TIMEOUT)
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as err:
            await self._cleanup()
            raise LocalHomeAssistantError(f"Could not reach the local Home Assistant API at {self._url}: {err}") from err

        try:
            await self._authenticate()
        except Exception:
            await self._cleanup()
            raise

        self._reader = self._hass.async_create_background_task(self._read_loop(), "three_ws local link")

    async def _authenticate(self) -> None:
        required = await self._receive_json()
        if required.get("type") != "auth_required":
            raise LocalHomeAssistantError(f"Unexpected first message from Home Assistant: {required.get('type')!r}")
        await self._ws.send_json({"type": "auth", "access_token": self._access_token})
        result = await self._receive_json()
        if result.get("type") != "auth_ok":
            raise LocalHomeAssistantError(
                "Home Assistant rejected the integration's own access token. Remove and re-add the three.ws integration."
            )
        self.ha_version = str(result.get("ha_version") or "")

    async def _receive_json(self) -> dict[str, Any]:
        try:
            msg = await asyncio.wait_for(self._ws.receive(), timeout=LOCAL_CONNECT_TIMEOUT)
        except asyncio.TimeoutError as err:
            raise LocalHomeAssistantError("Home Assistant did not answer its own WebSocket API in time.") from err
        if msg.type is not aiohttp.WSMsgType.TEXT:
            raise LocalHomeAssistantError(f"Home Assistant closed the local connection ({msg.type.name}).")
        return json.loads(msg.data)

    async def _read_loop(self) -> None:
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if msg.type is not aiohttp.WSMsgType.TEXT:
                    break
                try:
                    payload = json.loads(msg.data)
                except json.JSONDecodeError:
                    _LOGGER.debug("Dropped a non-JSON frame from the local Home Assistant API")
                    continue
                # Home Assistant coalesces results into arrays when the client
                # asked for it, which this integration does not, but handling
                # both shapes costs one branch and removes a whole class of bug.
                for message in payload if isinstance(payload, list) else [payload]:
                    await _maybe_await(self._on_message(message))
        except (aiohttp.ClientError, asyncio.CancelledError, OSError):
            pass
        finally:
            await _maybe_await(self._on_close())

    async def send(self, message: dict[str, Any]) -> None:
        if self._ws is None or self._ws.closed:
            raise LocalHomeAssistantError("The local Home Assistant connection is closed.")
        await self._ws.send_json(message)

    async def close(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            self._reader = None
        await self._cleanup()

    async def _cleanup(self) -> None:
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        self._ws = None
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None


async def _maybe_await(value: Any) -> None:
    if asyncio.iscoroutine(value):
        await value
