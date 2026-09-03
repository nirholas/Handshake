"""three.ws: put a 3D agent with a voice in front of this home.

This integration exists for the majority of Home Assistant installs, the ones
that only exist on a LAN. It opens one outgoing WebSocket to the three.ws relay
and keeps it. Nothing listens on the user's network, no port is forwarded, and
no Home Assistant credential ever leaves this machine: the integration mints a
system refresh token for itself, exactly as the first-party Supervisor
integration does, and uses it only against 127.0.0.1.

What three.ws can do through this connection is fixed by `allowlist.py`, which
is enforced here as well as in the relay, and is far narrower than a
long-lived access token: reads, the four registries, and service calls, with
the ones that administer this machine refused outright.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.auth.const import GROUP_ID_ADMIN
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_send

from .const import (
    CONF_INSTALL_TOKEN,
    CONF_REFRESH_TOKEN_ID,
    CONF_RELAY_ID,
    CONF_RELAY_URL,
    CONF_USER_ID,
    DOMAIN,
    SIGNAL_STATUS,
    SYSTEM_USER_NAME,
)
from .relay_client import RelayClient

_LOGGER = logging.getLogger(__name__)
PLATFORMS: list[Platform] = [Platform.BINARY_SENSOR]


def _version() -> str:
    manifest = json.loads((Path(__file__).parent / "manifest.json").read_text(encoding="utf-8"))
    return str(manifest.get("version", "0.0.0"))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Mint this install's local credential and start dialling out."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[f"{DOMAIN}_version"] = _version()

    refresh_token = await _async_get_or_create_token(hass, entry)

    def mint_access_token() -> str:
        # Access tokens are short-lived by design, so one is minted per local
        # session rather than held. The refresh token that produces them never
        # leaves this machine.
        return hass.auth.async_create_access_token(refresh_token)

    client = RelayClient(
        hass,
        relay_url=entry.data[CONF_RELAY_URL],
        install_token=entry.data[CONF_INSTALL_TOKEN],
        local_ws_url=_local_ws_url(hass),
        mint_access_token=mint_access_token,
        integration_version=_version(),
        on_status=lambda status: async_dispatcher_send(hass, f"{SIGNAL_STATUS}_{entry.entry_id}", status),
    )
    hass.data[DOMAIN][entry.entry_id] = client
    client.start()

    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, lambda _event: client.stop()))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _LOGGER.info("three.ws is dialling relay %s", entry.data[CONF_RELAY_ID])
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    client: RelayClient | None = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    if client is not None:
        await client.stop()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Removing the integration must actually remove its access to this home.

    Revocation is both-ended: three.ws drops the relay socket from its side, and
    this deletes the local credential from ours, so an install token that leaked
    before removal opens nothing afterwards.
    """
    token_id = entry.data.get(CONF_REFRESH_TOKEN_ID)
    user_id = entry.data.get(CONF_USER_ID)
    if token_id:
        token = await hass.auth.async_get_refresh_token(token_id)
        if token is not None:
            await hass.auth.async_remove_refresh_token(token)
    if user_id:
        user = await hass.auth.async_get_user(user_id)
        if user is not None and user.system_generated:
            await hass.auth.async_remove_user(user)
    _LOGGER.info("three.ws removed its local credential for relay %s", entry.data.get(CONF_RELAY_ID))


async def _async_get_or_create_token(hass: HomeAssistant, entry: ConfigEntry) -> Any:
    """The local credential, created once and reused.

    A system user in the admin group, with a system refresh token, is the same
    shape the Supervisor integration uses for its own access to core. It is
    visible in Settings, People, so an owner can always see it exists and
    remove it.
    """
    token_id = entry.data.get(CONF_REFRESH_TOKEN_ID)
    if token_id:
        existing = await hass.auth.async_get_refresh_token(token_id)
        if existing is not None:
            return existing

    user = None
    user_id = entry.data.get(CONF_USER_ID)
    if user_id:
        user = await hass.auth.async_get_user(user_id)
    if user is None:
        user = await hass.auth.async_create_system_user(SYSTEM_USER_NAME, group_ids=[GROUP_ID_ADMIN])

    refresh_token = await hass.auth.async_create_refresh_token(user)
    hass.config_entries.async_update_entry(
        entry,
        data={**entry.data, CONF_USER_ID: user.id, CONF_REFRESH_TOKEN_ID: refresh_token.id},
    )
    return refresh_token


def _local_ws_url(hass: HomeAssistant) -> str:
    """Home Assistant's own WebSocket API, on loopback.

    Loopback rather than `internal_url`: the integration runs in the same
    process as the HTTP server, so 127.0.0.1 is always right and never depends
    on a reverse proxy, a certificate, or a URL the user configured for
    browsers rather than for this.
    """
    port = hass.http.server_port if hass.http is not None else 8123
    return f"ws://127.0.0.1:{port}/api/websocket"
