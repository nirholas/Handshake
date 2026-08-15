# MCP tool safety

Every tool three.ws publishes over the [Model Context Protocol](mcp.md) carries an
`annotations` block. Those hints are not decoration: an MCP client reads them to
decide whether a tool can run **without stopping to ask the user**. A tool marked
read-only gets executed silently; a tool marked destructive gets a confirmation
prompt, or gets refused outright by a cautious client.

three.ws publishes tools that mint on Solana, settle USDC payments, and write to a
database. So we treat those hints as a security contract and verify them
mechanically, on every build, against what each tool's code actually does.

This page is the contract. If you are **integrating** three.ws tools, the first two
sections tell you what you can rely on. If you are **adding a tool** to this repo,
the rest tells you how the check works and how to satisfy it.

- Browse every tool and its safety class: [MCP Tool Catalog](/mcp-tools)
- Machine-readable, same data: [`/mcp-catalog.json`](/mcp-catalog.json)

[![The MCP Tool Catalog filtered to the irreversible tools, each card showing its safety class, price, and host server](/docs/img/mcp-catalog-irreversible.png)](/mcp-tools?safety=irreversible)

*The catalog filtered to the tools that cannot be undone. Every filter is in the
URL, so [that view](/mcp-tools?safety=irreversible) is a link you can send someone.*

---

## What the hints mean here

| Hint | Meaning on three.ws |
| --- | --- |
| `readOnlyHint: true` | The call changes nothing you can observe. Safe to run unattended. |
| `readOnlyHint: false` | The call changes something: a stored avatar, an embed, an on-chain asset, a payment. |
| `destructiveHint: true` | The change cannot be undone. A transfer, a tip, a delete. Confirm every call. |
| `destructiveHint: false` | The change is additive, so a follow-up call can correct it. |
| `idempotentHint: true` | Repeating the identical call produces the identical result. |
| `openWorldHint: true` | The answer depends on a live external system (a chain, a market feed), so two identical calls can legitimately differ. |

The catalog collapses the first two rows into one **safety class** per tool, which
is what the catalog page filters on:

| Class | Derived from |
| --- | --- |
| `read` | `readOnlyHint: true` |
| `write` | `readOnlyHint: false`, `destructiveHint: false` |
| `irreversible` | `readOnlyHint: false`, `destructiveHint: true` |

For how many tools are in each class right now, read the catalog rather than a
number typed into a doc:

```bash
curl -s https://three.ws/mcp-catalog.json | jq '.counts'
```

---

## What you can rely on

**A read-only tool never changes anything you asked about.** A few read tools warm
an internal cache while they answer you (the Oracle conviction cache, the on-chain
attestation cache). Those writes are the server's own bookkeeping, they are wrapped
so a failure still returns your answer, and they never change your result. They are
recorded as reviewed exceptions in the build check, each with a written reason.

**Anything that spends is labelled as spending.** Tools that mint, tip, or settle a
payment declare `readOnlyHint: false`, and the irreversible ones declare
`destructiveHint: true`. Price is advertised separately: `tools/list` returns a
`pricing` block per paid tool, and the catalog carries the same number.

**An unannotated tool cannot ship.** The MCP spec says `destructiveHint` defaults to
`true` when omitted, so a tool with no annotations tells every client that a
harmless read might be dangerous. The build fails on that.

Opening any tool shows the four hints it declares, its price, and a call
snippet. For a paid tool the snippet names the payment step rather than handing
you a command that answers `402`.

[![The detail view for mint_3d_asset: a plain-language safety note, a table of the four annotation hints, the price, the source file, and a copyable call snippet](/docs/img/mcp-tool-detail.png)](/mcp-tools?tool=mint_3d_asset)

### Reading it from a client

```bash
curl -s -X POST https://three.ws/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools[] | select(.annotations.readOnlyHint == true) | .name'
```

Or, without calling a server at all, straight from the catalog:

```bash
curl -s https://three.ws/mcp-catalog.json \
  | jq -r '.tools[] | select(.safety == "irreversible") | "\(.name)\t\(.server.title)"'
```

A client that wants to auto-run only the safe surface can gate on one field:

```js
const res = await fetch('https://three.ws/mcp-catalog.json');
const { tools } = await res.json();

const autoRunnable = new Set(
  tools.filter((t) => t.safety === 'read' && t.price.free).map((t) => t.name),
);

// Later, before dispatching a tool call the model asked for:
if (!autoRunnable.has(name)) await confirmWithUser(name);
```

---

## Turn it into client configuration

Verified labels are only worth having if a client can act on them. `GET /api/mcp-policy`
turns the catalog into a ready-to-paste allowlist: you choose how much you want
automated, and it names exactly the tools that qualify.

[![The trust policy builder: three profiles with their split of run-on-their-own, ask, and blocked counts, a Claude/VS Code/portable format switch, and the generated settings block](/docs/img/mcp-trust-policy.png)](/mcp-tools#mc-policy)

Three profiles, each a different answer to "how much do I automate":

| Profile | Runs unattended | Asks first | Refused outright |
| --- | --- | --- | --- |
| `strict` | verified reads that are also free | everything else | anything irreversible |
| `balanced` (default) | every verified read | everything that changes state | nothing |
| `open` | reads and reversible writes | irreversible actions only | nothing |

The ladder only ever widens: a tool `strict` trusts is still trusted by
`balanced` and `open`, so loosening never silently revokes something. **No profile
auto-approves an irreversible action**, and `tests/api/mcp-policy.test.js` pins
both properties.

### For Claude

```bash
curl -s 'https://three.ws/api/mcp-policy?profile=balanced&format=claude'
```

```json
{
  "permissions": {
    "allow": ["mcp__three.ws__get_avatar", "mcp__activity-mcp__get_trending_coins"],
    "ask":   ["mcp__three.ws__mint_3d_asset"],
    "deny":  []
  }
}
```

Merge that into `.claude/settings.json` in your project (or your user settings).

### For VS Code

```bash
curl -s 'https://three.ws/api/mcp-policy?profile=strict&format=vscode'
```

Returns a `chat.tools.autoApprove` map where a tool is `true` only if the policy
would run it unattended. Paste into `settings.json`.

### Portable

`format=json` (the default) returns the full document: every tool with its
bucket, its namespaced permission id, its safety class, and its price, plus the
verification claim and a pointer back to the catalog it came from.

```bash
curl -s https://three.ws/api/mcp-policy | jq '.counts'
```

Refetch it rather than pinning a copy. Tools get added; a policy fetched at build
time goes stale, and a stale allowlist is how a new mutating tool ends up trusted
by an old config.

> Nine tool names are published by two different servers (`sns_resolve`,
> `find_services`, `pay_and_call`, `list_animations`, `render_avatar`,
> `kol_leaderboard`, `create_agent_persona`, `get_agent_persona`, `persona_say`).
> The namespaced `mcp__<server>__<tool>` id is the key, not
> the bare name. The `<server>` segment is the name **you** gave that server in
> your own client config; the policy uses the id three.ws publishes for it.
>
> That list grows as servers are added, so re-derive it rather than trusting the
> names above:
>
> ```bash
> curl -s https://three.ws/mcp-catalog.json \
>   | jq -r '.tools | group_by(.name)[] | select(length > 1) | .[0].name'
> ```

---

## How the check works

`npm run audit:mcp-safety` parses every tool-definition file in the repo with
`acorn` and compares each tool's declared annotations against evidence gathered
from its handler.

**Evidence** is:

- a `sql` tagged template whose text opens with `insert`, `update`, `delete`,
  `truncate`, `drop`, or `alter`
- a call to a known transaction-signing, transaction-sending, payment-settling,
  fund-transferring, or minting helper

It is collected over the handler's **call closure**: functions in the same module
are followed to any depth, and a call into an imported function is followed one
module hop.

Following a *call* is evidence. Merely *importing* a module that could mutate is
not. That distinction is load-bearing: a dozen genuinely read-only tools import the
same Solana RPC helper, and treating the import as evidence flagged every one of
them.

### The three rules

1. `readOnlyHint: true` on a handler with mutation evidence fails the build.
2. Evidence of an irreversible action (a send, a sign, a settle, a transfer, a
   mint) with `destructiveHint: false` fails the build.
3. A tool with no annotations at all fails the build.

### Why not classify by name

The first version of this check read the tool's name, the way a lot of lint rules
do. It was wrong in both directions on this codebase:

- `vanity_open` lists *open bounties*. "Open" is an adjective. Read-only, flagged.
- `link_agent` derives an id and reads chain state over HTTP POST. Read-only,
  flagged.
- `persona_tip` and `pump_collect_fees` both move money. Not flagged.

A name says what a tool is called. Only the code says what it does, so the check
reads the code.

---

## Adding a tool

Declare annotations explicitly. Never omit the block, and never write a value you
have not checked against your own handler.

```js
export const toolDefs = [
  {
    name: 'list_widgets',
    title: 'List widgets',
    // Reads a table and returns rows. Nothing is written, so a client may run
    // this unattended. openWorldHint: the rows change as the DB changes.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: 'List the widgets owned by the caller, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      additionalProperties: false,
    },
    async handler(args) {
      const rows = await sql`select id, name from widgets order by created_at desc limit ${args.limit ?? 20}`;
      return { content: [{ type: 'text', text: JSON.stringify(rows) }], structuredContent: { rows } };
    },
  },
];
```

A tool that spends declares both flags honestly:

```js
annotations: {
  readOnlyHint: false,
  destructiveHint: true, // settles USDC; there is no undo
  idempotentHint: false,
  openWorldHint: true,
},
```

Then run the check:

```bash
npm run audit:mcp-safety            # exit 1 on any violation
npm run audit:mcp-safety -- --list  # every tool, its hints, and the evidence found
```

Both forms of annotation declaration are understood, so you can follow whichever
convention the server you are editing already uses: inline on the tool (including
a shared `Object.freeze({...})` constant, and spreads of one), or a name-keyed
overlay map alongside the tool list, the way the pump.fun server declares
`TOOLS` and `TOOL_ANNOTATIONS` as separate exports.

### When a read genuinely writes

If your read-only tool warms a cache while answering, add a reviewed exemption in
`scripts/audit-mcp-safety.mjs` with the reason:

```js
const EXEMPTIONS = new Map([
  [
    'oracle_coin:db-write',
    'scoreCoin(..., { persist: true }) caches the verdict it just computed so the next read is warm.',
  ],
]);
```

The exemption is keyed `tool:evidence`, so exempting a cache write does not
silence a later transaction send from the same tool. Exemptions live in one
reviewed file rather than as a flag scattered through the tool definitions.

---

## Related build checks

| Command | What it guards |
| --- | --- |
| `npm run audit:mcp-safety` | Annotations match handler behavior (this page) |
| `npm run audit:mcp-golden` | The public contract of every tool (name, description, schema, annotations) has not drifted silently |
| `npm run audit:mcp-catalog` | `/mcp-catalog.json` still matches the code |
| `npm run audit:mcp` | Every MCP registry manifest is publishable |

All four run in `npm run gate`.

---

## Related

- [MCP Tool Catalog](/mcp-tools): browse every tool by safety, price, and server
- [MCP](/docs/mcp): connecting a client, auth, and the tool reference
- [MCP Tools Catalog](/docs/mcp-tools): which server hosts what, and how paid tools charge
- [x402](/docs/x402): the USDC rail behind the paid tools
