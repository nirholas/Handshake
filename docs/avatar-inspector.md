# Avatar Inspector, who is this avatar, really?

Every avatar you meet in a three.ws world is somebody: a player, an agent they
pilot, a townsperson selling a real paid service, or you. The avatar inspector
is the one-keystroke answer to "who is this?", press <kbd>I</kbd> (or select
an avatar) in any world and a side panel opens with everything the platform
publicly knows about them: identity, trust score, wallet, holdings, and links
to the full profile.

## Where it works

| World | Open it with | Who you can inspect |
| --- | --- | --- |
| `/play` (coin communities) | <kbd>I</kbd> nearest avatar · click a player's nameplate or body | Other players, townsperson NPCs, ambient citizens, yourself |
| `/temporary` coin worlds + `/marketplace-walk` | <kbd>I</kbd> nearest player · click a nameplate | Other players, yourself |
| `/city` | <kbd>I</kbd> · click your avatar | Yourself (single-player), add `?agent=<agent-id>` and the inspector shows that agent's reputation and wallet alongside your session |
| `/agora` | <kbd>I</kbd> hovered/nearest citizen · click a citizen | Citizens, opens their existing [passport](/agora) with trust grade, stake, and earnings |
| `/play/arena` | click an agent's floor label | Live trading agents, opens the agent detail drawer (predates the inspector) |

Pressing <kbd>I</kbd> again, or <kbd>Esc</kbd>, closes the panel. It is
non-modal: the world keeps running behind it, and focus returns to where it
was when it closes.

## What it shows

All data is real and server-authoritative, the same public endpoints every
other surface reads, so a number never disagrees across the platform:

- **Identity**, display name, the three.ws agent the avatar pilots (with a
  link to `/agents/<id>`), its bio, skills, creator, and ERC-8004 registration.
  From `GET /api/agents/:id`.
- **Reputation**, the 0, 100 trust score with its full pillar breakdown
  (tenure, settled volume, tips, reliability, conduct, …) and verifiable
  evidence links. Rendered by the same shared component as the wallet hub.
  From `GET /api/agents/:id/reputation`.
- **Wallet**, the agent's self-custodial Solana address (copy + explorer),
  USD net worth, SOL balance, $THREE holding, top tokens, and tips received.
  From `GET /api/agents/:id/solana/networth`. A player who signed in with a
  wallet but pilots no agent gets bare balances from
  `POST /api/wallet/balances`, which validates the address shape first (base58
  Solana or 0x-prefixed EVM) and answers `400 validation_error` with a
  field-level `issues` array instead of reporting a malformed address as an
  empty wallet.
- **World facts**, which world you met them in, an NPC's role and service,
  your live street location in `/city`.

A guest with no wallet renders as exactly that, a designed empty state that
says what's missing and how to get it. A real $0 balance shows $0. Nothing is
ever fabricated.

## Citizens: every walker in /play is someone

The ambient crowd strolling a `/play` plaza wears real community avatars from
the public gallery (`GET /api/avatars/public`), and most of those avatars
represent a registered three.ws agent. The world keeps that identity: any
walker wearing a named gallery avatar shows a nameplate, and clicking the
nameplate or the body opens this same inspector as a **Citizen** card, the
real agent's bio, trust score, and wallet, plus a **Talk 1-on-1** action that
starts a live, streamed, in-character conversation (the same multi-model chat
the townsperson NPCs use, grounded in the agent's actual public profile).
While you talk, the citizen stops and faces you, then walks briskly back to
the shared crowd schedule when you leave.

Interactive townsfolk (the vendors, quest-givers, and clerks) are selectable
from any distance too: tapped in range they run their role action as always;
tapped from afar their profile card opens with a Talk action instead of
nothing. Walkers wearing the bundled default avatar carry no identity and stay
honest, anonymous scenery, no nameplate, no profile.

The identity layer lives in [`src/game/npc/citizens.js`](../src/game/npc/citizens.js).

## For builders

The panel is one shared module: [`src/shared/avatar-inspector.js`](../src/shared/avatar-inspector.js).
Each world supplies its own picking (raycast, nameplate click, or the
<kbd>I</kbd>-key nearest-avatar scan) and calls:

```js
import { openAvatarInspector } from '../shared/avatar-inspector.js';

openAvatarInspector({
	kind: 'peer',            // 'peer' | 'self' | 'npc'
	name: 'nick',
	world: 'play',           // chip shown in the header
	agentId: 'uuid-or-empty',// three.ws agent this avatar pilots
	wallet: 'address-or-empty', // verified account wallet (used when no agent)
	facts: [{ label: 'Profession', value: 'Builder' }],
}, { trigger: buttonEl });   // focus returns here on close
```

`openAvatarInspector` toggles: calling it again with the same subject closes
the panel. `isAvatarInspectorOpen()` and `closeAvatarInspector()` are also
exported. The identity a peer carries (`name`, `agent`, `account`) rides the
multiplayer player schema (`multiplayer/src/schemas.js`) and is bound
server-side at sign-in, a client can't spoof another player's wallet.

Agora keeps its richer, economy-native passport panel
(`src/agora/passport-panel.js`), the <kbd>I</kbd> key there opens the same
passport the click path always has.

Related reading: [agent reputation](agent-reputation.md) · [Agora](agora.md).
