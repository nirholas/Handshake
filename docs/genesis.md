# Instant Agent Genesis: prompt or selfie to a living agent

Genesis is the one-minute on-ramp for the whole platform. You give it a text
prompt, a selfie, or a public avatar to remix. It returns a rigged 3D AI agent
that already owns a custodial Solana wallet, a custodial EVM wallet, a synthesized
persona and voice, and an optional verifiable on-chain identity. Every step is
real: the 3D body comes off the same reconstruction pipeline `/create` uses, the
wallet addresses are real custodial addresses, and the on-chain record returns a
real transaction hash. Nothing is mocked or faked as it runs.

Page: [/genesis](https://three.ws/genesis) · APIs: `/api/avatars/reconstruct`, `/api/avatars/regenerate-status`, `/api/avatars/fork`, `/api/agents`, `/api/agents/:id/wallet/provision`, `/api/persona/extract`, `/api/agents/:id`

## Why it exists

Creating a usable agent used to mean stitching together five surfaces: generate a
model, rig it, mint a wallet, write a system prompt, pick a voice, register an
identity. Each one is its own page, its own wait, its own chance to give up.
Genesis collapses that into a single guided flow with a real progress bar driven by
real job state, so a first-time visitor goes from an idea to a wallet-holding,
animation-ready agent they fully own in under a minute of active work. It is the
front door: the artifact it produces is a first-class agent that plugs straight
into [Agent Studio](./agent-studio.md), the [economy](./autonomous-economy.md),
[breeding](./genome.md), and every embed surface.

## How it works

Genesis is a state machine over the platform's existing production endpoints. It
never invents a shortcut path; it orchestrates the real ones.

- **Body.** The `text` and `selfie` modes both POST to `/api/avatars/reconstruct`
  (a prompt or a photo), then poll `/api/avatars/regenerate-status` with capped
  exponential backoff (1.5s first poll, 1.4x backoff, 12s ceiling, 8-minute
  deadline). This is the identical rigged-avatar pipeline behind `/create/prompt`
  and `/create/selfie`. The reconstruction model returns a textured mesh; when the
  mesh has no skeleton and the active provider has a rig model configured, the
  pipeline chains an auto-rig job (GCP UniRig / Hunyuan3D `generation_all`) and only
  surfaces the avatar once it can be animated, so you never receive a T-posed
  static mesh. The `remix` mode instead POSTs to `/api/avatars/fork`, forking a
  public avatar into a fresh one you own.
- **Agent and wallets.** Reconstruct and fork auto-provision the agent record.
  Genesis resolves it via `GET /api/agents?avatar_id=...`, then calls
  `POST /api/agents/:id/wallet/provision` to guarantee both a custodial Solana
  address and a custodial EVM address exist. These are real custodial keys held for
  the agent (see [Agent Wallets](./agent-wallets.md) and [Custody](./custody.md)),
  Solana first because Solana is the home chain.
- **Persona and voice.** `POST /api/persona/extract` synthesizes a structured
  in-character system prompt from your description, running through the shared LLM
  helper with Anthropic-first ordered failover (server Anthropic, then Groq, then
  OpenRouter) so a single upstream 429 or 5xx never returns a hard error. Voices
  load from `/api/tts/voices`. Your chosen name, persona, and voice are persisted
  with `PATCH /api/agents/:id`.
- **On-chain identity (optional).** The final step mints a real
  [ERC-8004](./erc8004.md) identity record for the agent and returns a real tx
  hash, defaulting to Base (chain id 8453) to match the rest of the platform's EVM
  identity layer. This step is optional: the agent is fully functional without it.

## Walkthrough

1. **Open [/genesis](https://three.ws/genesis).** Pick a mode: type a prompt, drop
   a selfie, or remix one of the featured public avatars loaded from
   `/api/avatars/featured`.
2. **Sign in if prompted.** Genesis works signed-out for generation, but claiming
   the agent and its wallets requires a wallet sign-in (the banner wires
   `signInWithWallet`).
3. **Kick off generation.** The step bar tracks the real reconstruction job:
   queued, generating, rigging, ready. Progress reflects the job state, not a timer.
4. **Watch the agent resolve.** Once the avatar is ready, Genesis resolves the
   auto-provisioned agent and provisions both wallets. The real Solana and EVM
   addresses appear.
5. **Name it and give it a voice.** Persona extraction proposes a system prompt from
   your prompt; edit the name and pick a voice, then save.
6. **Optionally bind an on-chain identity.** One click registers the ERC-8004 record
   and shows the returned transaction hash.
7. **You now own a complete agent.** Open it in [Agent Studio](./agent-studio.md) to
   keep authoring, drop it on a site via [Integrations](./integrations.md), or breed
   it in [Agent Genome](./genome.md).

## Examples

Genesis is a browser flow, but its endpoints are the public agent APIs. This drives
the same body-generation step from a script (see
[API reference](./api-reference.md) and [Authentication](./authentication.md) for
the session cookie or bearer token):

```bash
# 1. Start a text-to-avatar reconstruction
JOB=$(curl -s -X POST https://three.ws/api/avatars/reconstruct \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $THREEWS_TOKEN" \
  -d '{"prompt":"A silver-haired explorer in a teal flight jacket"}')
echo "$JOB"

# 2. Poll status until the rigged model is ready
JOB_ID=$(echo "$JOB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')
curl -s "https://three.ws/api/avatars/regenerate-status?jobId=$JOB_ID" \
  -H "authorization: Bearer $THREEWS_TOKEN"
```

```bash
# 3. Resolve the auto-provisioned agent and guarantee both wallets
AVATAR_ID=... # from the finished status payload
AGENT=$(curl -s "https://three.ws/api/agents?avatar_id=$AVATAR_ID" \
  -H "authorization: Bearer $THREEWS_TOKEN")
AGENT_ID=$(echo "$AGENT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["agents"][0]["id"])')

curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/wallet/provision" \
  -H "authorization: Bearer $THREEWS_TOKEN"
# returns { solana_address, wallet_address (EVM), ... } with real custodial addresses
```

## States and limits

- **Signed out.** Generation runs, but wallet provisioning and identity binding
  require sign-in. The auth banner is always reachable.
- **Generation deadline.** Reconstruction has an 8-minute deadline and the
  agent-resolve step a 60-second deadline; both surface a designed error with a
  retry action rather than hanging.
- **Rigging fallback.** If no rig model is configured or rigging fails, the pipeline
  delivers the static mesh tagged `unrigged` so you are never left empty-handed. Any
  humanoid avatar drives the pre-baked clip library via bone-name canonicalization,
  so the rig is not limited to a curated allowlist.
- **On-chain identity is optional and reversible in practice.** Skipping it leaves a
  fully working agent; you can bind an identity later.
- **Selfie framing.** The reconstruction path is a face pipeline. A clean headshot
  reconstructs far more reliably than a full-body photo.
- **Ownership.** The agent, both wallets, and the identity are yours. Remix forks a
  public avatar into a new agent you own; it never mutates the source.

## Related

- [Agent Studio](./agent-studio.md): keep authoring the agent Genesis created
- [Agent Genome](./genome.md): breed two agents into an inherited child
- [Avatar Reconstruction](./avatar-reconstruction.md): the selfie-to-3D pipeline
- [Agent Wallets](./agent-wallets.md) and [Custody](./custody.md): the custodial keys
- [ERC-8004](./erc8004.md): the on-chain identity record
- [Persona Hub](./persona-hub.md): how personas are synthesized
- Pages: [/genesis](https://three.ws/genesis), [/create](https://three.ws/create), [/agent-studio](https://three.ws/agent-studio)
