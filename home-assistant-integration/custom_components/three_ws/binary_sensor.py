"""A connectivity entity, so the state of the link is visible in Home Assistant.

Someone whose agent has gone quiet should be able to see why from inside their
own house, without opening three.ws. This entity is that answer: connected or
not, with the last reason as an attribute.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_LABEL, CONF_RELAY_ID, DOMAIN, SIGNAL_STATUS
from .relay_client import RelayClient


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    async_add_entities([ThreeWsRelaySensor(hass.data[DOMAIN][entry.entry_id], entry)])


class ThreeWsRelaySensor(BinarySensorEntity):
    """Is this home currently reachable from three.ws."""

    _attr_has_entity_name = True
    _attr_translation_key = "relay"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_should_poll = False

    def __init__(self, client: RelayClient, entry: ConfigEntry) -> None:
        self._client = client
        self._entry = entry
        self._attr_unique_id = f"{entry.data[CONF_RELAY_ID]}_relay"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.data[CONF_RELAY_ID])},
            name=entry.data.get(CONF_LABEL) or "three.ws",
            manufacturer="three.ws",
            configuration_url="https://three.ws/home",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, f"{SIGNAL_STATUS}_{self._entry.entry_id}", self._handle_status)
        )

    @callback
    def _handle_status(self, _status: dict[str, Any]) -> None:
        self.async_write_ha_state()

    @property
    def is_on(self) -> bool:
        return self._client.connected

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "relay_id": self._entry.data[CONF_RELAY_ID],
            "open_sessions": self._client.open_sessions,
            "refused_messages": self._client.denied_count,
            "last_error": self._client.last_error,
        }
