# 10. The dial-out add-on and relay for LAN-only homes

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`. Read [00-CONTEXT.md](home-00-CONTEXT.md) first, in particular the
reachability section. Orders [02](home-02-bridge-runtime.md) and [03](home-03-api-surface.md)
must have landed.

## Binding operating clause

Finish 100%. Never end with a question or an unexecuted plan. All CLAUDE.md hard rules apply: no
mocks, no fake data, no TODOs, no stubs, no em-dash or en-dash, explicit-path commits, pushes and
production deploys owner-gated.

**Nothing in this file is a status claim to trust.** Step 0 re-measures.

---

## Step 0: re-derive the current state

```bash
node -e "import('./packages/home-bridge/src/url.js').then(m=>console.log(['homeassistant.local','192.168.1.10','abc.ui.nabu.casa'].map(h=>h+' private='+m.isPrivateHost(h))))"
ls api/_lib/home/                                        # store, verify, runtime, tools
grep -rn "transport" api/_lib/migrations/*home_connections*.sql
```

Order 01's schema already carries `transport` (`direct` or `relay`) and `relay_id`. This order
fills in the `relay` half.

## The problem, stated exactly

Most Home Assistant installs are reachable only from inside the house. three.ws is on the public
internet. Orders 01 to 08 work for users with a remote https URL and are useless for everyone
else, which is the majority. This order is what makes the product available to them, and it is
the single largest reach multiplier in the campaign.

## The design: the house dials us, never the reverse

```
Home Assistant (LAN)  --outbound wss-->  three.ws relay  <--wss--  api/_lib/home/runtime.js
    three.ws add-on
```

- A small add-on installed inside the user's Home Assistant opens **one outbound WebSocket** to
  the relay. Nothing is ever listened for on the user's network, no port is forwarded, no tunnel
  daemon is installed, and no inbound firewall change is needed.
- The relay is a three.ws service that terminates those connections and multiplexes requests from
  the bridge runtime onto them.
- To `api/_lib/home/runtime.js` this is a transport swap and nothing more. The `HomeBridge` API,
  the room graph, the gate, the tools and the UI are unchanged. **If this order requires changes
  above the transport, the design is wrong; fix the transport.**

## Security, because this is a tunnel into someone's house

This section is the order. Everything else is plumbing.

1. **The add-on holds the credential, not us.** In relay mode we store no Home Assistant token.
   The add-on authenticates to Home Assistant locally with its own supervisor token and to the
   relay with a per-install key. Order 01's `access_token_enc` is empty for a relay connection,
   and the store must permit that without weakening the direct path.
2. **Pairing is explicit, short-lived and single-use.** A code shown in three.ws, entered in the
   add-on (or the reverse). No discovery, no long-lived shared secret, no code that works twice.
3. **The relay is a dumb pipe with an allowlist.** It forwards only the message types the bridge
   needs. It never forwards arbitrary HTTP into the LAN, never proxies a path the caller chooses,
   and never exposes the connection to anything but the owning user's requests.
4. **Every relayed action is logged** to `home_action_log` exactly like a direct one. The
   transport must not create an audit gap.
5. **Revocation is immediate and both-ended.** Revoking in three.ws drops the socket; uninstalling
   the add-on drops it too and the connection goes to `unreachable` with an honest reason.
6. **A compromised relay must not equal a compromised house.** State the blast radius honestly in
   the README and in `docs/`. The gate from order 04 still sits between any request and any
   physical action, and confirmations are still minted and redeemed on our side by a human.
7. **Rate limits per install**, so a bug in the add-on cannot flood a house.

Write the threat model into `docs/` as part of this order. Order 11 reviews it; it does not
write it for you.

## Distribution

Ship it through [HACS](https://github.com/hacs/integration) (7,674 stars, MIT), which is how
Home Assistant users install third-party code. That means a public repository with the required
structure, a version, a release, and documentation that stands on its own. Per CLAUDE.md, this is
also the giving-back half of the open-source rule: the add-on is public, not private to our users.

Pushing a public repository is owner-gated. Prepare everything so the publish is one command and
batch the owner action into a single message.

## Every state

1. Not installed: the instructions, with the HACS path and the manual path.
2. Pairing: the code and its countdown.
3. Paired and connected: identical to a direct connection from here on.
4. Add-on offline (Home Assistant restarted, host rebooted): the honest reason, and it should
   recover by itself when the add-on returns.
5. Add-on version too old for the relay protocol: named, with the upgrade path.
6. Pairing expired or reused.
7. Revoked from either end.

## Tasks

| # | Task | Files |
|---|---|---|
| 1 | The relay protocol: message types, framing, versioning, the allowlist. Pure and testable. | `services/home-relay/src/protocol.js`, tests |
| 2 | The relay service, its container and its deploy config. | `services/home-relay/` |
| 3 | `RelayTransport` for `packages/home-bridge`, so `HomeBridge` accepts it in place of the direct socket. | `packages/home-bridge/src/transport-relay.js` |
| 4 | Runtime and store support for `transport: 'relay'`, including the empty-credential case. | `api/_lib/home/runtime.js`, `api/_lib/home/store.js` |
| 5 | Pairing endpoints and UI. | `api/home/pair.js`, `src/home/pair.js` |
| 6 | The add-on itself: a Home Assistant custom integration or add-on, whichever the community expects for this shape (state your choice and the reason). | a new public repo, prepared locally |
| 7 | `README.md` in every new directory. Threat model in `docs/`. | required |
| 8 | All seven states. | as above |

## Definition of done

- [ ] A real Home Assistant on a network the server cannot route to, connected through the relay, with a real light toggled from three.ws. Recorded. Simulate the LAN by binding the instance to an address the API container cannot reach, and say exactly how you did it.
- [ ] The full order 04 gate still applies over the relay: a guarded unlock returns 409, the confirmation redeems, the real door unlocks. Same transcripts as order 04, over the new transport.
- [ ] `home_action_log` rows for relayed actions are indistinguishable in completeness from direct ones. Paste both.
- [ ] Nothing above the transport changed: show the diff and confirm `api/_lib/home/tools.js`, the UI and the room graph are untouched.
- [ ] A relay connection stores no Home Assistant token. Prove it with the row.
- [ ] Pairing code reuse, expiry, and cross-user redemption all refused. Three transcripts.
- [ ] Killing the add-on puts the home in state 4 and restarting it recovers with no user action. Recorded.
- [ ] The relay refuses a message type outside the allowlist. Prove it.
- [ ] `README.md` present in every new directory; `npm run audit:docs` clean.
- [ ] The threat model doc is written and linked.
- [ ] `npm run check:rules -- --paths <your files>` clean.

## Never blocked

| Blocker | Do this |
|---|---|
| Tempted to use a generic tunnel product | Do not add a paid third-party dependency (CLAUDE.md forbids onboarding one without approval), and do not ask users to install a tunnel daemon. One outbound websocket to our own service is smaller, safer and explainable. |
| Cannot test a genuinely unroutable LAN | Bind the Home Assistant container to a network namespace the API cannot reach, or run it on a second machine. Do not test the relay against localhost and call it proven. |
| The relay protocol wants to be "just proxy HTTP" | Refuse. An arbitrary-path proxy into a home network is the single worst thing this campaign could ship. Allowlist the message types the bridge actually uses. |
| Publishing the add-on repo is blocked | Repository creation and pushes are owner-gated. Prepare the repo contents in-tree, verify with a local install, and batch the publish into one owner message. |
| Someone proposes storing the Home Assistant token in relay mode "just in case" | Refuse. Not holding it is a feature and a selling point. |

## Report format

1. The unroutable-LAN setup description and the recorded end-to-end run.
2. The gate transcripts over the relay.
3. The action log comparison.
4. The diff proving nothing above the transport changed.
5. The three pairing refusals and the allowlist refusal.
6. The kill-and-recover recording.
7. The exact owner action needed to publish, in one paragraph.
8. Anything in this file you found to be wrong, and what you changed it to.

## Retire this prompt when it is done (required)

Verify every line against real output, append to `prompts/finish/home-PROGRESS.md`, commit with
explicit paths, and delete this file in that commit:

       git rm prompts/finish/home-10-addon-relay.md

If the publish is the only outstanding step, leave the file in place, say so, and name the owner
action. Never delete it on a partial.
