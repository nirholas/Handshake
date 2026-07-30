# MCP examples

Two zero-dependency walkthroughs of the MCP Streamable HTTP lifecycle against the live three.ws server at `https://three.ws/api/mcp` (MCP 2025-06-18, JSON-RPC 2.0). Both cover: initialize, notifications/initialized, tools/list, one free tool call (`getting_started`), and DELETE session termination. Nothing here requires an account, token, wallet, or payment.

## curl-session.sh

The whole lifecycle in plain curl.

```bash
bash examples/curl-session.sh
```

## client.mjs

The same lifecycle from Node with plain `fetch`. Node 20+, no packages.

```bash
node examples/client.mjs
```

## Why the headers matter

The live server (source: `api/_mcp/auth.js` in the repo) distinguishes client types by headers. Sending `Accept: text/event-stream`, `MCP-Protocol-Version`, or `Mcp-Session-Id` marks you as an OAuth-capable MCP protocol client, and discovery answers 401 with a `WWW-Authenticate` challenge so that flow can start. Plain JSON clients, like these examples, get free discovery and the free `getting_started` tool with no credentials. Paid tools respond with an x402 payment envelope; see the [package README](../README.md#payment-flow) for the payment flow.

Point either example at another deployment with `MCP_URL=<url>`.
