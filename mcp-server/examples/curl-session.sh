#!/usr/bin/env bash
# MCP Streamable HTTP lifecycle against the live three.ws server, in plain curl.
#
# The live endpoint is https://three.ws/api/mcp (MCP 2025-06-18, JSON-RPC 2.0
# over Streamable HTTP). Discovery (initialize, notifications/initialized,
# tools/list, ping) and the free getting_started tool need no account, token,
# or payment.
#
# Header rules, straight from the server implementation (api/_mcp/auth.js):
# a request carrying "Accept: text/event-stream", "MCP-Protocol-Version", or
# "Mcp-Session-Id" is treated as an OAuth-capable MCP protocol client and gets
# a 401 challenge to start the OAuth flow. A plain JSON client (like this
# script) gets free discovery instead, so we send only content-type and a JSON
# accept. The server is stateless per request and never issues a session id;
# per spec, Mcp-Session-Id is only required when the server assigns one.

set -euo pipefail

MCP_URL="${MCP_URL:-https://three.ws/api/mcp}"
H_CT='content-type: application/json'
H_ACC='accept: application/json'

echo "== 1. initialize =="
curl -sS -X POST "$MCP_URL" -H "$H_CT" -H "$H_ACC" -d '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "curl-session-example", "version": "1.0.0" }
  }
}'
echo; echo

echo "== 2. notifications/initialized (a notification: no id, null response) =="
curl -sS -X POST "$MCP_URL" -H "$H_CT" -H "$H_ACC" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo; echo

echo "== 3. tools/list =="
curl -sS -X POST "$MCP_URL" -H "$H_CT" -H "$H_ACC" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo; echo

echo "== 4. tools/call getting_started (free, no payment or account) =="
curl -sS -X POST "$MCP_URL" -H "$H_CT" -H "$H_ACC" -d '{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "getting_started", "arguments": {} }
}'
echo; echo

echo "== 5. terminate session (DELETE, expect HTTP 204) =="
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' -X DELETE "$MCP_URL"
