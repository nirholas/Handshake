export { HomeBridge, toBridgeError } from './bridge.js';
export { ERR, HomeBridgeError } from './errors.js';
// The two connection sentinels a custom socket factory has to reject with, so a
// server that supplies one (api/_lib/home-url-guard.js pins the socket to the
// addresses its SSRF guard validated) speaks the same error vocabulary as the
// default factory without taking its own direct dependency on the transport.
export { ERR_CANNOT_CONNECT, ERR_INVALID_AUTH } from 'home-assistant-js-websocket';
export { MACROS, matchMacro, resolveIntent } from './intents.js';
export { connectHomeMcp } from './mcp.js';
export { buildHomeGraph, domainOf, flattenEntities, summarizeClimate, summarizeLighting, summarizeSecurity } from './rooms.js';
export { classifyCall, classifyMcpCall, createAllowList, isSafetyAction, isSafetyMcpCall, resolveMcpTargets, GUARDED_COVER_CLASSES, GUARDED_DOMAINS } from './safety.js';
export { createRelayTransport, relayCloseError, RELAY_PROTOCOL_VERSION } from './transport-relay.js';
export { isPrivateHost, normalizeBaseUrl } from './url.js';
