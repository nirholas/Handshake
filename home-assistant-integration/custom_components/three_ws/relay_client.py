"""The outbound connection: this house dials three.ws, three.ws never dials it.

One WebSocket leaves this machine and stays open. Nothing listens on the user's
network, no port is forwarded, and no inbound firewall rule exists. When the
platform wants to read the room graph or run a service, it asks the relay, the
relay pushes a `session.open` down this socket, and this module opens a local
Home Assistant connection for it.

Every frame that arrives is checked against `allowlist.py` before it reaches
Home Assistant, and every frame that leaves is checked before it reaches the
relay. That check is independent of the relay's own, on purpose: see the module
docstring in `allowlist.py`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Any, Callable

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import allowlist
from .const import PROTOCOL_VERSION, RECONNECT_MAX_SECONDS, RECONNECT_MIN_SECONDS
from .ha_link import LocalHomeAssistantError, LocalLink

_LOGGER = logging.getLogger(__name__)

# Frame types. Mirrors FRAME in services/home-relay/src/protocol.js.
F_HELLO = "hello"
F_HELLO_OK = "hello.ok"
F_HELLO_ERR = "hello.err"
F_PING = "ping"
F_PONG = "pong"
F_SESSION_OPEN = "session.open"
F_SESSION_READY = "session.ready"
F_SESSION_CLOSE = "session.close"
F_HA = "ha"


class RelayClient:
    """Keeps one dial-out socket alive, and multiplexes sessions over it."""

    def __init__(
        self,
        hass: HomeAssistant,
        relay_url: str,
        install_token: str,
        local_ws_url: str,
        mint_access_token: Callable[[], str],
        integration_version: str,
        on_status: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        self._hass = hass
        self._relay_url = relay_url.rstrip("/")
        self._install_token = install_token
        self._local_ws_url = local_ws_url
        self._mint_access_token = mint_access_token
        self._version = integration_version
        self._on_status = on_status

        self._task: asyncio.Task[None] | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._sessions: dict[str, LocalLink] = {}
        self._stopping = False

        self.connected = False
        self.last_error: str | None = None
        self.denied_count = 0
        self.session_count = 0

    @property
    def open_sessions(self) -> int:
        """How many Home Assistant sessions three.ws currently holds open."""
        return len(self._sessions)

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self._stopping = False
        self._task = self._hass.async_create_background_task(self._run(), "three_ws relay client")

    async def stop(self) -> None:
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            self._task = None
        await self._close_all_sessions("going_away", "Home Assistant is shutting down.")
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        self._ws = None
        self._set_status(False, None)

    async def _run(self) -> None:
        """Dial, serve, and dial again. The house always initiates."""
        attempt = 0
        while not self._stopping:
            try:
                await self._connect_once()
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 - the retry loop is the handler
                self._set_status(False, str(err))
                _LOGGER.debug("three.ws relay connection ended: %s", err)
            if self._stopping:
                return
            attempt += 1
            # Full jitter, so a relay restart does not bring every house back at
            # the same instant.
            ceiling = min(RECONNECT_MAX_SECONDS, RECONNECT_MIN_SECONDS * (2 ** min(attempt, 6)))
            await asyncio.sleep(random.uniform(RECONNECT_MIN_SECONDS, ceiling))

    async def _connect_once(self) -> None:
        session = async_get_clientsession(self._hass)
        url = f"{self._relay_url}/v1/agent"
        async with session.ws_connect(
            url,
            headers={"Authorization": f"Bearer {self._install_token}"},
            heartbeat=30,
            timeout=aiohttp.ClientWSTimeout(ws_close=30),
        ) as ws:
            self._ws = ws
            await ws.send_json(
                {
                    "v": PROTOCOL_VERSION,
                    "t": F_HELLO,
                    "protocol": PROTOCOL_VERSION,
                    "agent": {
                        "name": "three.ws Home Assistant integration",
                        "version": self._version,
                        "ha": self._hass.config.as_dict().get("version", ""),
                    },
                }
            )
            async for msg in ws:
                if msg.type is not aiohttp.WSMsgType.TEXT:
                    break
                try:
                    frame = json.loads(msg.data)
                except json.JSONDecodeError:
                    _LOGGER.warning("three.ws relay sent a frame that was not JSON")
                    break
                if not isinstance(frame, dict) or frame.get("v") != PROTOCOL_VERSION:
                    _LOGGER.warning("three.ws relay sent a frame this integration does not speak")
                    break
                await self._handle_frame(frame)
        self._ws = None
        self._set_status(False, self.last_error)
        await self._close_all_sessions("agent_offline", "The relay connection dropped.")

    # ---------------------------------------------------------------- frames

    async def _handle_frame(self, frame: dict[str, Any]) -> None:
        kind = frame.get("t")

        if kind == F_HELLO_OK:
            self._set_status(True, None)
            _LOGGER.info("three.ws relay connected (relay %s)", frame.get("relayId"))
            return

        if kind == F_HELLO_ERR:
            message = str(frame.get("message") or frame.get("code") or "The relay refused this connection.")
            self.last_error = message
            self._set_status(False, message)
            _LOGGER.error("three.ws relay refused this home: %s", message)
            return

        if kind == F_PING:
            await self._send({"v": PROTOCOL_VERSION, "t": F_PONG, "ts": frame.get("ts")})
            return

        sid = frame.get("sid")
        if not isinstance(sid, str) or not sid:
            return

        if kind == F_SESSION_OPEN:
            await self._open_session(sid)
            return

        if kind == F_SESSION_CLOSE:
            await self._close_session(sid)
            return

        if kind == F_HA:
            await self._forward_into_home(sid, frame.get("msg"))

    async def _open_session(self, sid: str) -> None:
        if sid in self._sessions:
            return
        try:
            link = LocalLink(
                self._hass,
                self._local_ws_url,
                self._mint_access_token(),
                on_message=lambda message: self._forward_out(sid, message),
                on_close=lambda: self._on_local_closed(sid),
            )
            await link.connect()
        except (LocalHomeAssistantError, Exception) as err:  # noqa: BLE001
            _LOGGER.error("three.ws could not open a local Home Assistant session: %s", err)
            await self._send(
                {
                    "v": PROTOCOL_VERSION,
                    "t": F_SESSION_CLOSE,
                    "sid": sid,
                    "code": "ha_unreachable",
                    "reason": str(err),
                }
            )
            return
        self._sessions[sid] = link
        self.session_count += 1
        await self._send({"v": PROTOCOL_VERSION, "t": F_SESSION_READY, "sid": sid, "haVersion": link.ha_version})

    async def _forward_into_home(self, sid: str, message: Any) -> None:
        link = self._sessions.get(sid)
        if link is None:
            return
        try:
            allowlist.check_outbound(message)
        except allowlist.Denied as denied:
            self.denied_count += 1
            _LOGGER.warning("three.ws refused a relayed message: %s", denied.reason)
            message_id = message.get("id") if isinstance(message, dict) else None
            if isinstance(message_id, int):
                await self._send(
                    {
                        "v": PROTOCOL_VERSION,
                        "t": F_HA,
                        "sid": sid,
                        "msg": {
                            "id": message_id,
                            "type": "result",
                            "success": False,
                            "error": {"code": denied.code, "message": denied.reason},
                        },
                    }
                )
            return
        try:
            await link.send(message)
        except LocalHomeAssistantError as err:
            _LOGGER.debug("Local Home Assistant send failed: %s", err)
            await self._close_session(sid)

    def _forward_out(self, sid: str, message: Any) -> Any:
        try:
            allowlist.check_inbound(message)
        except allowlist.Denied as denied:
            self.denied_count += 1
            _LOGGER.warning("three.ws did not send a local message out: %s", denied.reason)
            return None
        return self._send({"v": PROTOCOL_VERSION, "t": F_HA, "sid": sid, "msg": message})

    async def _on_local_closed(self, sid: str) -> None:
        if sid not in self._sessions:
            return
        self._sessions.pop(sid, None)
        await self._send(
            {
                "v": PROTOCOL_VERSION,
                "t": F_SESSION_CLOSE,
                "sid": sid,
                "code": "ha_unreachable",
                "reason": "The local Home Assistant connection closed.",
            }
        )

    async def _close_session(self, sid: str) -> None:
        link = self._sessions.pop(sid, None)
        if link is not None:
            await link.close()

    async def _close_all_sessions(self, code: str, reason: str) -> None:
        for sid in list(self._sessions):
            link = self._sessions.pop(sid, None)
            if link is not None:
                await link.close()
        _LOGGER.debug("three.ws closed every relay session: %s (%s)", reason, code)

    async def _send(self, frame: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json(frame)
        except (aiohttp.ClientError, ConnectionResetError) as err:
            _LOGGER.debug("three.ws relay send failed: %s", err)

    def _set_status(self, connected: bool, error: str | None) -> None:
        self.connected = connected
        self.last_error = error
        if self._on_status is not None:
            self._on_status({"connected": connected, "error": error, "sessions": len(self._sessions)})
