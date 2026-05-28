# API Endpoint Inventory

Generated reference of every HTTP endpoint under `/api/`. Paths reflect the externally-visible URL (after `vercel.json` rewrites). Auth column: `session` = `__Host-sid` cookie; `bearer` = OAuth access token or API key; `public` = no auth; `cron` = Vercel Cron header or `CRON_SECRET`.

## Agents

| Path                           | Methods                 | Auth                                      | Description                                                                 | Input                                                                      | Response                   |
| ------------------------------ | ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| `/api/agents`                  | GET, POST               | session or bearer                         | List caller's agents / create new agent identity                            | GET: `?limit&cursor`; POST: `{name,description,avatarId,...,animations[]}` | `{agents}` / `{agent}`     |
| `/api/agents/me`               | GET                     | session or bearer                         | Get or auto-create caller's default agent                                   | —                                                                          | `{agent}`                  |
| `/api/agents/:id`              | GET, PUT, PATCH, DELETE | public GET; session PUT/DELETE            | Fetch (public fields if not owner), update, soft-delete                     | PATCH body: partial agent                                                  | `{agent}`                  |
| `/api/agents/:id/wallet`       | POST, DELETE            | session                                   | Link/update or unlink agent wallet                                          | `{address,signature?}`                                                     | `{wallet}`                 |
| `/api/agents/:id/actions`      | GET                     | session or bearer (owner or public agent) | Paginated signed action log (EIP-191 verified)                              | `?limit&cursor`                                                            | `{actions[]}`              |
| `/api/agents/:id/sign`         | POST                    | session or bearer (owner)                 | Sign arbitrary EIP-191 message with agent's server wallet                   | `{message,kind?}`                                                          | `{address,signature}`      |
| `/api/agents/:id/embed-policy` | GET, PUT, DELETE        | public GET; session owner PUT/DELETE      | Read/write/clear embed policy (origins, surfaces, brain)                    | PUT: policy object                                                         | `{policy}`                 |
| `/api/agents/:id/usage`        | GET                     | session (owner)                           | LLM proxy usage stats (monthly + 30-day daily)                              | —                                                                          | `{month,quota,daily[]}`    |
| `/api/agents/by-address/:addr` | GET                     | public (rate-limited)                     | DB-first agent lookup by owner address; RPC fallback via ERC-721 enumerable | `?chainId`                                                                 | `{agents[]}`               |
| `/api/agents/by-wallet`        | GET                     | public (rate-limited)                     | DB lookup by agent wallet address                                           | `?address&chain_id`                                                        | `{agents[]}`               |
| `/api/agents/check-name`       | GET                     | session or bearer                         | Validate agent name availability (denylist + regex)                         | `?name&agent_id?`                                                          | `{available,reason?}`      |
| `/api/agents/ens/:name`        | GET                     | public (rate-limited)                     | Resolve ENS name then look up agents owned by that address                  | —                                                                          | `{address,agents[]}`       |
| `/api/agents/suggest`          | GET                     | public (rate-limited)                     | @-mention autocomplete ranked search                                        | `?q&limit`                                                                 | `{agents[]}`               |
| `/api/agents/register-prep`    | POST                    | session                                   | Build canonical registration JSON + pin IPFS, return CID for signing        | `{name,description,avatarId,brain?}`                                       | `{cid,metadataURI,prepId}` |
| `/api/agents/register-confirm` | POST                    | session                                   | Verify on-chain registration tx, upsert agent_identities row                | `{prepId,chainId,agentId,txHash}`                                          | `{agentId}`                |
| `/api/agent-actions`           | GET, POST               | session or bearer                         | Append-only global action log (provenance trail)                            | GET: `?agent_id&limit&cursor`; POST: action body                           | `{actions[]}` / `{action}` |
| `/api/agent-memory`            | GET, POST               | session or bearer                         | Backup for LLM agent memories                                               | GET: `?agentId&type&since&limit`; POST: memory upsert                      | `{memories[]}`             |
| `/api/agent-memory/:id`        | DELETE                  | session or bearer                         | Forget a memory entry                                                       | —                                                                          | `{ok}`                     |
| `/api/agent/:id/og`            | GET                     | public                                    | Open Graph image: 302 to avatar thumbnail or SVG card                       | —                                                                          | image/svg+xml or 302       |
| `/api/oembed`                  | GET                     | public                                    | oEmbed rich payload for agent URLs (Notion/Discord/etc.)                    | `?url&format`                                                              | oEmbed JSON                |
| `/api/a/:chain/:id/og`         | GET                     | public                                    | On-chain agent OG image (302 to manifest image or SVG)                      | `?format=json?`                                                            | image/svg+xml or JSON      |
| `/a/:chain/:id`                | GET                     | public                                    | Server-rendered HTML with OG/Twitter/oEmbed/Frame tags                      | —                                                                          | text/html                  |

## Avatars

| Path                             | Methods            | Auth                                              | Description                                                          | Input                                                                                | Response                          |
| -------------------------------- | ------------------ | ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| `/api/avatars`                   | GET, POST          | bearer `avatars:read`/`:write` or session         | List caller avatars / register metadata after R2 upload              | GET: `?limit&cursor&visibility&include_public`; POST: `{storage_key,size_bytes,...}` | `{avatars[]}` / `{avatar}`        |
| `/api/avatars/public`            | GET                | public                                            | Public gallery search                                                | `?q&tag&limit&cursor`                                                                | `{avatars[]}`                     |
| `/api/avatars/presign`           | POST               | bearer `avatars:write` or session                 | Short-lived R2 presigned PUT URL for direct upload                   | `{size_bytes,content_type,slug?}`                                                    | `{storage_key,upload_url,...}`    |
| `/api/avatars/:id`               | GET, PATCH, DELETE | public if visible; session/bearer owner for write | Fetch/update metadata/soft-delete; PATCH with `glbUrl` saves version | PATCH: `{name?,description?,visibility?,tags?,glbUrl?}`                              | `{avatar}`                        |
| `/api/avatars/:id/versions`      | GET                | optional auth                                     | Ancestor+descendant chain via `parent_avatar_id`                     | —                                                                                    | `{versions[]}`                    |
| `/api/avatars/:id/glb-versions`  | GET                | session or bearer (owner)                         | Explicit GLB save-back snapshots                                     | —                                                                                    | `{versions[]}`                    |
| `/api/avatars/:id/rollback`      | POST               | session or bearer (owner)                         | Restore `storage_key` from a saved version (10/h)                    | `{versionId}`                                                                        | `{avatar}`                        |
| `/api/avatars/:id/session`       | POST               | session or bearer (owner)                         | Avaturn edit session for existing avatar                             | —                                                                                    | `{session_url,expires_at?}`       |
| `/api/avatars/:id/storage-mode`  | GET, PUT           | owner (PUT) / session for private GET             | Read/write `storage_mode` JSONB (ipfs/attestation)                   | PUT: storage-mode schema                                                             | `{storage_mode}`                  |
| `/api/avatars/:id/pin-ipfs`      | POST               | session (owner)                                   | STUB pin to IPFS; flips pinned flag                                  | —                                                                                    | `{storage_mode,stub:true}`        |
| `/api/avatars/regenerate`        | POST               | session or bearer `avatars:write`                 | Enqueue remesh/retex/rerig/restyle job (501 until provider set)      | `{sourceAvatarId,mode,params?}`                                                      | `{jobId}`                         |
| `/api/avatars/regenerate-status` | GET                | session or bearer `avatars:read`                  | Poll regen job                                                       | `?jobId`                                                                             | `{status,resultAvatarId?,error?}` |
| `/api/animations/presign`        | POST               | session or bearer `avatars:write`                 | Presigned PUT for animation .glb clips (100 MB cap)                  | `{size_bytes,content_type,slug?,checksum_sha256?}`                                   | `{storage_key,upload_url,...}`    |

## Auth

| Path                          | Methods     | Auth                  | Description                                           | Input                                     | Response                          |
| ----------------------------- | ----------- | --------------------- | ----------------------------------------------------- | ----------------------------------------- | --------------------------------- | --------------------- |
| `/api/auth/register`          | POST        | public (rate-limited) | Email or username signup; creates session             | `{email                                   | username,password,display_name?}` | `{user}` + Set-Cookie |
| `/api/auth/login`             | POST        | public (rate-limited) | Verify password, mint session                         | `{email,password}`                        | `{user}` + Set-Cookie             |
| `/api/auth/logout`            | POST        | session               | Destroy current session                               | —                                         | `{ok}`                            |
| `/api/auth/logout-everywhere` | POST        | session               | Revoke all sessions for caller                        | —                                         | `{revoked}`                       |
| `/api/auth/me`                | GET         | session               | Who am I                                              | —                                         | `{user}`                          |
| `/api/auth/sessions`          | GET, DELETE | session               | List active sessions / revoke all except current      | —                                         | `{sessions[]}`                    |
| `/api/auth/sessions/:id`      | DELETE      | session               | Revoke one session (not current)                      | —                                         | `{revoked}`                       |
| `/api/auth/session/list`      | GET         | session               | List sessions with ipHash + current flag              | —                                         | `{sessions[]}`                    |
| `/api/auth/session/refresh`   | POST        | session               | Rotate session cookie                                 | —                                         | `{user}` + Set-Cookie             |
| `/api/auth/session/revoke`    | POST        | session               | Revoke by `{sessionId}` or `{all:true}`               | `{sessionId?,all?}`                       | `{ok,revoked}`                    |
| `/api/auth/siwe/nonce`        | GET         | public (rate-limited) | EIP-4361 nonce + CSRF cookie                          | —                                         | `{nonce}`                         |
| `/api/auth/siwe/verify`       | POST        | CSRF + signature      | Verify SIWE; create/link user + session               | `{message,signature}`                     | `{user}` + Set-Cookie             |
| `/api/auth/privy/verify`      | POST        | public (rate-limited) | Exchange Privy idToken for session                    | `{idToken}`                               | `{user,wallet}` + Set-Cookie      |
| `/api/auth/wallet/link`       | POST        | session               | Link wallet via SIWE to logged-in account             | `{message,signature}`                     | `{wallet}`                        |
| `/api/auth/wallet/unlink`     | POST        | session               | Unlink one wallet                                     | `{address}`                               | `{ok}`                            |
| `/api/auth/wallets`           | GET, POST   | session               | List linked wallets / link new (nonce-based)          | POST: `{address,message,signature,nonce}` | `{wallets[]}` / `{wallet}`        |
| `/api/auth/wallets/:address`  | DELETE      | session               | Unlink by address (blocks last wallet if no password) | —                                         | `{ok}`                            |
| `/api/auth/wallets/nonce`     | POST        | session               | Issue SIWE-like nonce for wallet link                 | —                                         | `{nonce,message}`                 |

## OAuth (MCP clients)

| Path                                            | Methods   | Auth                           | Description                                           | Input                                   | Response                         |
| ----------------------------------------------- | --------- | ------------------------------ | ----------------------------------------------------- | --------------------------------------- | -------------------------------- |
| `/oauth/authorize`                              | GET, POST | session (POST consent)         | OAuth 2.1 authorization endpoint (PKCE S256 required) | query or form                           | 302 redirect with code           |
| `/oauth/consent`                                | GET, POST | session                        | Alias of `/oauth/authorize` (consent form)            | —                                       | —                                |
| `/oauth/token`                                  | POST      | client creds (if confidential) | Exchange auth code or refresh token                   | form-encoded                            | `{access_token,refresh_token?}`  |
| `/oauth/register`                               | POST      | public (rate-limited)          | RFC 7591 dynamic client registration                  | `{redirect_uris,client_name?,...}`      | `{client_id,client_secret?,...}` |
| `/oauth/revoke`                                 | POST      | client creds                   | RFC 7009 refresh token revocation                     | form `{token,client_id,client_secret?}` | 200                              |
| `/oauth/introspect`                             | POST      | client creds                   | RFC 7662 token introspection (own tokens only)        | form `{token,client_id,client_secret?}` | `{active,...}`                   |
| `/.well-known/oauth-authorization-server`       | GET       | public                         | RFC 8414 AS metadata                                  | —                                       | metadata JSON                    |
| `/.well-known/oauth-protected-resource`         | GET       | public                         | RFC 9728 protected-resource metadata                  | —                                       | metadata JSON                    |
| `/api/mcp/.well-known/oauth-protected-resource` | GET       | public                         | Same as above under MCP base                          | —                                       | metadata JSON                    |

## API Keys

| Path                | Methods   | Auth                        | Description                                       | Input                                              | Response                       |
| ------------------- | --------- | --------------------------- | ------------------------------------------------- | -------------------------------------------------- | ------------------------------ |
| `/api/api-keys`     | GET, POST | session or bearer `profile` | List keys / mint new `sk_live_…` (plaintext once) | POST: `{name,scope?,expires_at?}`                  | `{data[]}` / `{key,plaintext}` |
| `/api/api-keys/:id` | DELETE    | session or bearer `profile` | Revoke key                                        | —                                                  | `{id,revoked}`                 |
| `/api/keys`         | GET, POST | session                     | Alt developer key mgmt (`sk_live_`/`sk_test_`)    | POST: `{name,scope?,expires_in_days?,environment}` | `{keys[]}`                     |
| `/api/keys/:id`     | DELETE    | session                     | Revoke key                                        | —                                                  | `{ok}`                         |

## Widgets

| Path                           | Methods            | Auth                                            | Description                                                          | Input                                                | Response                           |
| ------------------------------ | ------------------ | ----------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `/api/widgets`                 | GET, POST          | session or bearer (`avatars:read`/`:write`)     | List/create caller's widgets                                         | POST: `{type,name,avatar_id?,config,is_public}`      | `{widgets[]}` / `{widget}`         |
| `/api/widgets/:id`             | GET, PATCH, DELETE | public GET (if `is_public`); owner PATCH/DELETE | Widget detail with avatar join; increments view_count for non-owners | PATCH: `{name?,config?,is_public?,avatar_id?,type?}` | `{widget}`                         |
| `/api/widgets/:id/chat`        | POST               | public (per-widget brain config)                | Visitor SSE chat for Talking Agent widgets                           | `{message,history?}`                                 | SSE stream                         |
| `/api/widgets/:id/duplicate`   | POST               | session owner (+`avatars:write`)                | Clone widget                                                         | —                                                    | `{widget}`                         |
| `/api/widgets/:id/stats`       | GET                | session owner (+`avatars:read`)                 | Aggregate view/referer/country stats                                 | —                                                    | `{view_count,recent_views_7d,...}` |
| `/api/widgets/:id/view`        | POST               | public                                          | Anonymous view logger (country + referer host)                       | —                                                    | 204                                |
| `/api/widgets/:id/og`          | GET                | public                                          | 302 to avatar thumbnail or 1200x630 SVG card                         | —                                                    | image/svg+xml                      |
| `/api/widgets/oembed`          | GET                | public                                          | oEmbed rich payload                                                  | `?url&format&maxwidth?&maxheight?`                   | oEmbed JSON                        |
| `/api/widgets/page` (`/w/:id`) | GET                | public                                          | SSR HTML with OG/oEmbed discovery                                    | `?id`                                                | text/html                          |

## ERC-8004 / On-chain

| Path                   | Methods | Auth                  | Description                                                | Input                          | Response                 |
| ---------------------- | ------- | --------------------- | ---------------------------------------------------------- | ------------------------------ | ------------------------ |
| `/api/erc8004/hydrate` | GET     | session               | Agents owned by user's linked wallets (from crawler index) | —                              | `{agents[]}`             |
| `/api/erc8004/import`  | POST    | session               | Import on-chain agent into local `agent_identities`        | `{chainId,agentId}`            | `{agent}`                |
| `/api/erc8004/pin`     | POST    | session               | Pin raw GLB/JSON/image bytes (IPFS + R2 fallback)          | raw body                       | `{cid,url}`              |
| `/api/explore`         | GET     | public                | Paginated indexed ERC-8004 directory                       | `?only3d&chain&q&cursor&limit` | `{agents[],next_cursor}` |
| `/api/showcase`        | GET     | public (rate-limited) | Public directory, three.ws only, keyset pagination        | `?chainIds&sort&limit&cursor`  | `{agents[],next_cursor}` |

## Permissions (ERC-7710 delegations)

| Path                        | Methods | Auth                            | Description                                                  | Input                  | Response                        |
| --------------------------- | ------- | ------------------------------- | ------------------------------------------------------------ | ---------------------- | ------------------------------- | ----------------- |
| `/api/permissions/grant`    | POST    | session                         | Persist signed delegation after verification                 | delegation + signature | `{id,hash}`                     |
| `/api/permissions/list`     | GET     | public (rate-limited)           | List delegations filtered by agent or delegator              | `?agentId              | delegator&status&chainId&limit` | `{delegations[]}` |
| `/api/permissions/verify`   | GET     | public (rate-limited, CORS any) | On-chain delegation validity check                           | `?hash&chainId`        | `{valid,reason?}`               |
| `/api/permissions/metadata` | GET     | public (rate-limited, CORS any) | Chain + DelegationManager addresses                          | `?chainId?`            | `{chains[]}`                    |
| `/api/permissions/revoke`   | POST    | session                         | Mirror on-chain `disableDelegation` into DB                  | `{id,txHash}`          | `{revoked}`                     |
| `/api/permissions/redeem`   | POST    | bearer `permissions:redeem`     | Server-side gas-paying relayer (feature-flagged, idempotent) | `{delegation,...}`     | `{txHash}`                      |

## DCA / Subscriptions

| Path                      | Methods           | Auth              | Description                      | Input                                                                                        | Response         |
| ------------------------- | ----------------- | ----------------- | -------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `/api/dca-strategies`     | GET, POST, DELETE | session           | Manage Uniswap-V3 DCA strategies | POST: `{agent_id,delegation_id,chain_id,token_in,token_out,...,period_seconds,slippage_bps}` | `{strategy}`     |
| `/api/dca-strategies/:id` | GET, DELETE       | session           | Fetch/soft-delete one            | —                                                                                            | `{strategy}`     |
| `/api/subscriptions`      | GET, POST, DELETE | session or bearer | Recurring subscription records   | POST: `{agentId,delegationId,periodSeconds,amountPerPeriod}`                                 | `{subscription}` |

## Cron

| Path                          | Methods   | Auth                                     | Description                                                           | Schedule       |
| ----------------------------- | --------- | ---------------------------------------- | --------------------------------------------------------------------- | -------------- |
| `/api/cron/erc8004-crawl`     | GET, POST | `x-vercel-cron` or `Bearer $CRON_SECRET` | Etherscan V2 log crawl → `erc8004_agents_index` + metadata enrichment | `*/15 * * * *` |
| `/api/cron/index-delegations` | GET, POST | cron                                     | Index `DelegationDisabled`/`Redeemed` events; expiry sweep            | `*/5 * * * *`  |
| `/api/cron/run-dca`           | GET, POST | cron                                     | Execute pending DCA strategies via Uniswap V3 SwapRouter              | `0 * * * *`    |
| `/api/cron/run-subscriptions` | GET, POST | cron                                     | Process due subscription charges via skill handler                    | `0 * * * *`    |

## LLM / Chat / MCP

| Path                 | Methods           | Auth                    | Description                                                            | Input                                           | Response            |
| -------------------- | ----------------- | ----------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------- |
| `/api/chat`          | POST              | session or bearer       | Stateless Anthropic chat with viewer control tools                     | `{message,context?,history?,model?,maxTokens?}` | `{reply,actions[]}` |
| `/api/llm/anthropic` | POST              | embed-policy + quota    | "We-pay" LLM proxy with per-agent origin/quota enforcement             | Anthropic messages body + `?agentId`            | Anthropic response  |
| `/api/mcp`           | GET, POST, DELETE | bearer OAuth or API key | MCP Streamable HTTP (JSON-RPC); SSE notifications; session termination | JSON-RPC                                        | JSON or SSE         |

## Onboarding / Avaturn / TTS

| Path                              | Methods | Auth                              | Description                                       | Input                                                 | Response                    |
| --------------------------------- | ------- | --------------------------------- | ------------------------------------------------- | ----------------------------------------------------- | --------------------------- |
| `/api/onboarding/avaturn-session` | POST    | session or bearer `avatars:write` | Trade 3 selfies for Avaturn session URL           | `{photos:{frontal,left,right},body_type,avatar_type}` | `{session_url,expires_at?}` |
| `/api/onboarding/link-avatar`     | POST    | session or bearer                 | Link avatar to user's primary agent               | `{avatarId,force?}`                                   | `{agentId}`                 |
| `/api/tts/eleven`                 | POST    | session or bearer                 | ElevenLabs TTS proxy with R2 cache (1000 chars/h) | `{voiceId,text,modelId?}`                             | audio/mpeg                  |
| `/api/tts/eleven/voices`          | GET     | session or bearer                 | List ElevenLabs voices (safe fields)              | —                                                     | `{enabled,voices[]}`        |

## LobeHub

| Path                     | Methods | Auth                  | Description                                                       | Input                   | Response                  |
| ------------------------ | ------- | --------------------- | ----------------------------------------------------------------- | ----------------------- | ------------------------- |
| `/api/lobehub/config`    | GET     | public (open CORS)    | LobeHub plugin manifest (from `/.well-known/lobehub-plugin.json`) | —                       | manifest JSON             |
| `/api/lobehub/manifest`  | GET     | public                | LobeHub plugin manifest (from `public/lobehub/plugin.json`)       | —                       | manifest JSON             |
| `/api/lobehub/handshake` | POST    | public (rate-limited) | Return iframe URL + embed policy for a LobeHub host               | `{agentId,hostOrigin?}` | `{iframeUrl,embedPolicy}` |

## Pinning

| Path                  | Methods | Auth                  | Description                                         | Input                 | Response               |
| --------------------- | ------- | --------------------- | --------------------------------------------------- | --------------------- | ---------------------- |
| `/api/pinning/pin`    | POST    | session or bearer     | Pin manifest or GLB to IPFS via Pinata/Web3.Storage | multipart or data URL | `{cid,provider}`       |
| `/api/pinning/status` | GET     | public (rate-limited) | Cross-provider pin status                           | `?cid`                | `{pinned,providers[]}` |

## Usage / Config / Artifact / CZ

| Path                 | Methods   | Auth                        | Description                                                    | Input                                              | Response                   |
| -------------------- | --------- | --------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | -------------------------- | --------- |
| `/api/usage/summary` | GET       | session or bearer `profile` | Dashboard usage counters + plan quota                          | —                                                  | `{plan,counts}`            |
| `/api/config`        | GET       | public                      | Non-secret client config (walletconnect id)                    | —                                                  | `{walletConnectProjectId}` |
| `/api/artifact`      | GET       | public                      | Self-contained HTML for Claude.ai artifacts (viewer or agent)  | `?agent=<id>                                       | ?model=<glbUrl>`           | text/html |
| `/api/cz/claim`      | GET, POST | public (ECDSA signature)    | CZ agent claim: issue nonce / verify sig → on-chain tx payload | GET: `?address`; POST: `{address,signature,nonce}` | `{nonce}` / `{tx}`         |

## Notes & Gaps

- **Route quirks**: `/api/agents/me` is rewritten to `/api/agents` (handler detects `/me` from pathname). `/api/agents/:id` delegates to handlers re-exported from `api/agents.js`.
- **Duplicate key surfaces**: `/api/api-keys` and `/api/keys` are two parallel key-management endpoints with different token formats and schemas — likely candidates for consolidation.
- **Unfinished / stub**:
    - `/api/avatars/:id/pin-ipfs` returns a stub CID (`stub:sha256-…`) — real Pinata/Web3.Storage pinning not wired.
    - `/api/avatars/regenerate` returns 501 until `AVATAR_REGEN_PROVIDER` is set.
    - `/api/permissions/metadata` dynamically imports `src/erc7710/abi.js` with a try/catch — legacy shim for pre-task-03 state.
- **Open CORS on auth surfaces**: `/api/permissions/verify` and `/api/permissions/metadata` set `access-control-allow-origin: *` explicitly (by design, for cross-origin delegation viewers).
- **SSE**: `/api/widgets/:id/chat` and `/api/mcp` (GET) both declare SSE, but `/api/widgets/:id/chat` currently does a single-shot Anthropic call framed as SSE for forward-compat.
- **vercel.json catch-all**: `{"src": "/api/(.*)", "dest": "/api/$1"}` after explicit rewrites means every `api/**/*.js` file is reachable even without an explicit route entry. Endpoints like `/api/agents/check-name`, `/api/agents/register-prep`, `/api/agents/register-confirm`, `/api/permissions/*`, `/api/subscriptions`, `/api/avatars/*`, `/api/auth/*`, `/api/usage/summary`, `/api/tts/*`, `/api/lobehub/*`, `/api/pinning/*`, `/api/onboarding/*`, `/api/config`, `/api/chat`, `/api/api-keys`, `/api/keys`, `/api/cron/*`, `/api/erc8004/pin` are served via this catch-all.
- **Dynamic segments under catch-all**: `/api/agents/ens/:name` and `/api/avatars/:id/versions`, `/rollback`, `/glb-versions`, `/session` rely on Vercel's file-based `[param]` resolution since they lack explicit `vercel.json` rewrites.
- **Cron auth**: all four cron endpoints accept manual `POST` with `Bearer $CRON_SECRET` in addition to the Vercel header.
