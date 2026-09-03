"""Shared constants for the three.ws Home Assistant integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "three_ws"

# What the config entry stores. Note what is absent: no Home Assistant token,
# because none is ever sent to three.ws. The integration mints its own local
# credential and keeps it inside this instance.
CONF_RELAY_URL: Final = "relay_url"
CONF_RELAY_ID: Final = "relay_id"
CONF_INSTALL_TOKEN: Final = "install_token"
CONF_PLATFORM_URL: Final = "platform_url"
CONF_LABEL: Final = "label"
CONF_USER_ID: Final = "user_id"
CONF_REFRESH_TOKEN_ID: Final = "refresh_token_id"

DEFAULT_PLATFORM_URL: Final = "https://three.ws"

# The system user this integration creates for its own local connection, the
# same pattern the first-party Supervisor integration uses. It is visible in
# Settings, People, so an owner can always see that it exists.
SYSTEM_USER_NAME: Final = "three.ws relay"

# Must match services/home-relay/src/protocol.js.
PROTOCOL_VERSION: Final = 1

RECONNECT_MIN_SECONDS: Final = 2
RECONNECT_MAX_SECONDS: Final = 120
LOCAL_CONNECT_TIMEOUT: Final = 20

SIGNAL_STATUS: Final = f"{DOMAIN}_status"
