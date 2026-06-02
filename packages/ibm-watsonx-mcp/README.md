# @nirholas/ibm-watsonx-mcp

An [MCP](https://modelcontextprotocol.io) server for **IBM watsonx.ai**. It exposes IBM Granite (and any model in your watsonx.ai account) to MCP clients — Claude Desktop, Claude Code, Cursor, and any other MCP host — as five tools: chat, text generation, embeddings, tokenization, and model discovery.

The server talks **directly** to the watsonx.ai as-a-Service REST API using **your own IBM Cloud credentials**. It mints an IAM bearer token from your API key, caches it until just before expiry, and scopes every call to your project. No intermediary backend, no telemetry, no mock data.

> Community-built and not affiliated with IBM. Registry name: `io.github.nirholas/ibm-watsonx`.

## Tools

| Tool | What it does |
| --- | --- |
| `watsonx_chat` | Chat completion from a list of role/content messages. Returns reply + token usage. |
| `watsonx_generate` | Raw prompt completion with decoding control (greedy/sample, stop sequences). |
| `watsonx_embed` | Embedding vectors for one or more texts. Returns one vector per input. |
| `watsonx_tokenize` | Token count (and optionally the tokens) for a text against a model tokenizer. |
| `watsonx_list_models` | List foundation models available to your account/region, optionally filtered. |

## Prerequisites

1. An IBM Cloud account with watsonx.ai provisioned — [sign up](https://dataplatform.cloud.ibm.com/registration/stepone?context=wx) (free tier available).
2. An **IBM Cloud API key** — create one at <https://cloud.ibm.com/iam/apikeys>.
3. Your **watsonx.ai project id** — open the project → **Manage** → **General** → **Project ID**.

## Configuration

| Env var | Required | Default |
| --- | --- | --- |
| `WATSONX_API_KEY` | ✅ | — |
| `WATSONX_PROJECT_ID` | ✅ (or `WATSONX_SPACE_ID`) | — |
| `WATSONX_URL` | | `https://us-south.ml.cloud.ibm.com` |
| `WATSONX_MODEL_ID` | | `ibm/granite-3-8b-instruct` |
| `WATSONX_EMBED_MODEL_ID` | | `ibm/granite-embedding-278m-multilingual` |
| `WATSONX_API_VERSION` | | `2024-05-31` |

Regional hosts: `us-south`, `eu-de`, `eu-gb`, `jp-tok`, `au-syd`, `ca-tor` — e.g. `https://eu-de.ml.cloud.ibm.com`.

## Use with Claude Desktop / Claude Code / Cursor

Add to your MCP config (`claude_desktop_config.json`, or via `claude mcp add`):

```json
{
  "mcpServers": {
    "ibm-watsonx": {
      "command": "npx",
      "args": ["-y", "@nirholas/ibm-watsonx-mcp"],
      "env": {
        "WATSONX_API_KEY": "your-ibm-cloud-api-key",
        "WATSONX_PROJECT_ID": "your-watsonx-project-id"
      }
    }
  }
}
```

## Run standalone

```bash
WATSONX_API_KEY=... WATSONX_PROJECT_ID=... npx @nirholas/ibm-watsonx-mcp
```

Inspect the tool surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @nirholas/ibm-watsonx-mcp
```

## Example calls

```jsonc
// watsonx_chat
{ "messages": [{ "role": "user", "content": "Explain MCP in one sentence." }] }

// watsonx_generate
{ "input": "Write a haiku about Kubernetes.", "decoding_method": "sample", "temperature": 0.7, "max_new_tokens": 60 }

// watsonx_embed
{ "inputs": ["lakehouse", "data warehouse"] }

// watsonx_list_models
{ "filter": "function_embedding" }
```

## How auth works

`WATSONX_API_KEY` is exchanged for a short-lived IAM bearer token at
`https://iam.cloud.ibm.com/identity/token` (`grant_type=urn:ibm:params:oauth:grant-type:apikey`).
The token is cached in-process and refreshed ~5 minutes before it expires. Your API
key never leaves your machine except in that single IAM exchange.

## License

Apache-2.0
