# Guardian console: recover and inherit agent wallets, without ever touching a key

The Guardian console is the inbox for the other side of social recovery. When a friend names you a guardian or a beneficiary of their agent, that agent shows up here. This is where you help them back in: approve a recovery you trust, decline one you do not, confirm an inheritance when someone is truly gone, or push a ready process over the line. Every action runs through a threshold-approved, time-locked process that only ever changes who owns the agent. A private key is never decrypted, displayed, or moved.

Page: [/guardian](https://three.ws/guardian)
API: `GET /api/agents/recovery-inbox`, and the per-agent recovery actions under `/api/agents/:id/recovery/...`

## Why it exists

A funded agent should not die with a lost password, or with its owner. But the usual answer, exporting a seed phrase to a trusted contact, just moves the single point of failure. three.ws takes a different position: recovery and inheritance are ownership transfers, never key exports. The wallet secret stays encrypted at rest; the platform simply re-points the agent to a new owner account and signs for them afterward. There is nothing for an attacker to intercept.

The owner sets this up from their own wallet hub (naming guardians, an approval threshold, and optionally a beneficiary). But the owner is, by definition, the person who is locked out or gone, so they cannot be the one who acts. The guardian console is the surface for the people who can: the guardians and beneficiaries. They are not the owner, so they never see the owner-only Recovery tab inside the agent's hub. Being someone's safety net is a real, visible role in the graph, and this page gives it the weight it deserves.

## How it works

`GET /api/agents/recovery-inbox` lists every agent where you hold an active guardian or beneficiary role (`agent_recovery_guardians`). Each agent is decorated with its live recovery or inheritance process if one is open (`getActiveRequest`, `decorateRequest`), and a `needs_action` flag computed for you specifically:

- For a **recovery**, a guardian who is not the requester and has not already voted needs to act.
- For an **inheritance**, a beneficiary whose confirmation is awaited, or any guardian who has not voted, needs to act.

The response sorts agents that need your action first, then those with an open process, then the rest, and reports how many need you.

**The safety rails** (detailed in [custody](./custody.md)) are enforced by the recovery API, not the console:

- The requester cannot approve their own takeover; at least one other guardian must approve.
- The wallet auto-freezes for autonomous spend the moment a request opens (the real owner's own withdrawal stays open).
- Threshold approvals start a time-lock before the transfer can complete.
- The real owner can cancel instantly at any point; their presence defeats the request.
- Unmet requests expire.

**Inheritance** is a dead-man's switch: the owner enables it with an inactivity threshold and a grace window, "alive" is inferred from real activity or an explicit check-in, and when inactivity crosses the line an inheritance request opens to the beneficiary. It needs guardian confirmation (or the beneficiary's own, if no guardians are set) and the grace window before it completes.

**Actions** the console fires (all CSRF-protected, owner or guardian gated, never exposing a key):

- Approve or decline a recovery: `POST /api/agents/:id/recovery/requests/:rid/{approve,decline}`
- Confirm or decline an inheritance: `POST /api/agents/:id/recovery/requests/:rid/{confirm,decline}`
- Complete a ready transfer: `POST /api/agents/:id/recovery/requests/:rid/complete`
- Arm inheritance, as the beneficiary or a guardian, when the owner has gone silent past their threshold: `POST /api/agents/:id/recovery/inheritance/arm`

## Walkthrough

1. Open [/guardian](https://three.ws/guardian). Signed out, it prompts you to sign in. Signed in with no roles, it explains what the console is for and invites you to ask a friend to name you.
2. Each agent you protect renders as a card: its name (linked to its profile), who owns it, when you were trusted, and your roles (guardian, beneficiary, or both). A badge at the top counts how many agents need your action.
3. If a process is open, the card tells its story in the agent's own voice ("I'm being recovered. If you trust this person is really my owner, approve."), plus the approval count, the safety-window countdown, and when it opened.
4. Act. For a recovery you trust, click **Approve recovery** (or **Decline**). For an inheritance you believe is real, click **Confirm inheritance**. Each action asks you to confirm, because these are consequential.
5. When the safety window has elapsed and the process is ready, click **Complete transfer** to pass control of the agent and its wallet to the new owner.
6. If you are the beneficiary or a guardian and the owner has gone silent past their threshold with no active process, you can try to arm inheritance, which begins the grace window.

## Examples

Read your guardian inbox:

```bash
curl -s https://three.ws/api/agents/recovery-inbox \
  -H 'authorization: Bearer YOUR_TOKEN' \
  | jq '.data | {need_your_action: .actionable,
      agents: [.items[] | {agent: .agent_name, roles, needs_action,
        process: .active_request.kind, status: .active_request.status}]}'
```

The console reads this on load, resolves your viewer id (so it can tell whether you have already voted), and renders each item. Write actions are performed with a CSRF token; the console fetches one before every non-GET call.

## Guardrails, states, and limits

- **A key is never exposed.** Recovery and inheritance change ownership only. The wallet secret stays encrypted; completing a process re-points the agent, it does not reveal or move a secret.
- **You are not the owner here.** The console only ever shows agents where you are a guardian or beneficiary. It never exposes anyone's funds or keys, only the power to help them back in.
- **No self-takeover.** A recovery requester cannot approve their own request; an independent guardian approval is required.
- **Time-locked and cancelable.** Threshold approvals start a safety window; the real owner can cancel any time before completion, and their return defeats the request outright.
- **Auto-freeze during a dispute.** An open request freezes autonomous spend (owner withdrawal stays open), tracked separately so it lifts on resolution without overriding a freeze the owner set.
- **Confirmation on every consequential action.** Approve, confirm, decline, and complete each prompt for confirmation before firing.
- **Signed-out, empty, and error states** are all designed: sign-in prompt, "no one's named you yet", and an inline retry on failure.
- **Not the content-safety Guardian.** This console is unrelated to `@three-ws/guardian`, the AI content-moderation package that shares the name.

## Related

- [Custody you can verify](./custody.md) - the full recovery and inheritance model, the freeze switch, spend limits, and proof-of-custody
- [Financial controls](./financial-controls.md) - the plain-English spend rules on the same wallet rails
- `GET /api/custody/integrity` - the public Merkle attestation of every custodial wallet, as JSON (the page that rendered it is switched off while on-chain anchoring is unavailable)
- [/proof](https://three.ws/proof) - verify your own wallet's inclusion in the attestation, in your browser
