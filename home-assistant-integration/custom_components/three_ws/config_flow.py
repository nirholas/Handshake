"""Pairing: a short code, shown in three.ws, typed in here, once.

The code is minted by three.ws, expires in ten minutes and is redeemable
exactly once. Redeeming it returns the relay address and this install's own
token. Nothing in this flow asks for, transmits or stores a Home Assistant
credential: three.ws never gets one for a relayed home.
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_INSTALL_TOKEN,
    CONF_LABEL,
    CONF_PLATFORM_URL,
    CONF_RELAY_ID,
    CONF_RELAY_URL,
    DEFAULT_PLATFORM_URL,
    DOMAIN,
    PROTOCOL_VERSION,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required("pairing_code"): str,
        vol.Optional(CONF_PLATFORM_URL, default=DEFAULT_PLATFORM_URL): str,
    }
)


class ThreeWsConfigFlow(ConfigFlow, domain=DOMAIN):
    """Pair this house with a three.ws account."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            code = str(user_input["pairing_code"]).strip().upper().replace(" ", "").replace("-", "")
            platform_url = str(user_input.get(CONF_PLATFORM_URL) or DEFAULT_PLATFORM_URL).rstrip("/")
            try:
                paired = await self._redeem(platform_url, code)
            except PairingError as err:
                errors["base"] = err.code
            else:
                await self.async_set_unique_id(paired[CONF_RELAY_ID])
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=paired[CONF_LABEL], data={**paired, CONF_PLATFORM_URL: platform_url})

        return self.async_show_form(
            step_id="user",
            data_schema=STEP_USER_SCHEMA,
            errors=errors,
            description_placeholders={"connect_url": f"{DEFAULT_PLATFORM_URL}/home"},
        )

    async def _redeem(self, platform_url: str, code: str) -> dict[str, str]:
        session = async_get_clientsession(self.hass)
        version = self.hass.data.get(f"{DOMAIN}_version", "1.0.0")
        try:
            response = await session.post(
                f"{platform_url}/api/home/pair/redeem",
                json={
                    "code": code,
                    "protocol": PROTOCOL_VERSION,
                    "agent": {"name": "three.ws Home Assistant integration", "version": version},
                },
                timeout=aiohttp.ClientTimeout(total=20),
            )
        except (aiohttp.ClientError, TimeoutError) as err:
            raise PairingError("cannot_connect") from err

        if response.status == 404:
            raise PairingError("invalid_code")
        if response.status == 409:
            raise PairingError("code_used")
        if response.status == 410:
            raise PairingError("code_expired")
        if response.status == 426:
            raise PairingError("upgrade_required")
        if response.status >= 400:
            _LOGGER.error("three.ws pairing failed with HTTP %s", response.status)
            raise PairingError("unknown")

        payload = await response.json()
        missing = [key for key in ("relayId", "relayUrl", "installToken") if not payload.get(key)]
        if missing:
            _LOGGER.error("three.ws pairing response was missing %s", ", ".join(missing))
            raise PairingError("unknown")

        return {
            CONF_RELAY_ID: payload["relayId"],
            CONF_RELAY_URL: payload["relayUrl"],
            CONF_INSTALL_TOKEN: payload["installToken"],
            CONF_LABEL: payload.get("label") or "three.ws",
        }


class PairingError(Exception):
    """A pairing attempt failed, with a code the strings file explains."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code
