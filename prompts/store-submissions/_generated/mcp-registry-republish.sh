#!/usr/bin/env bash
# Republish stale/new three.ws MCP servers to the official MCP registry.
# GENERATED 2026-09-03 by build-registry-republish.mjs — regenerate after any manifest bump.
# DO NOT run unattended. A human must be logged in and review each publish.
# 3 servers need a republish; 47 are already current.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# 1. Authenticate once (device flow / browser):
#   mcp-publisher login github

# 2. Publish each manifest whose local version is newer than (or absent from) the registry:

# io.github.nirholas/herald-mcp: registry — -> local 0.1.0   [NEW]
mcp-publisher publish "packages/herald-mcp/server.json"

# io.github.nirholas/home-mcp: registry — -> local 0.1.0   [NEW]
mcp-publisher publish "packages/home-mcp/server.json"

# io.github.nirholas/knock-mcp: registry — -> local 0.1.0   [NEW]
mcp-publisher publish "packages/knock-mcp/server.json"

# 3. Verify all versions match the manifests:
# node scripts/publish-mcp-servers.mjs --dry-run
