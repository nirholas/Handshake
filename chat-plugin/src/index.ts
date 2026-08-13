/**
 * @three-ws/chat-plugin
 *
 * Entry point for the three.ws LobeHub plugin.
 * Exports the main React component and configuration.
 */

export { AgentPane, type AgentPaneProps } from './AgentPane.js';
export { AgentBridge, type BridgeOptions } from './bridge.js';
export { settingsSchema, DEFAULT_API_ORIGIN, type PluginSettings } from './config-schema.js';

// The install manifests are served by the platform, not this package:
// /.well-known/chat-plugin.json (LobeChat, from public/lobehub/plugin.json)
// and /.well-known/sperax-plugin.json (SperaxOS, from public/sperax/manifest.json).
