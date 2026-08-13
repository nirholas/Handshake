# Token-gated 3D embeds

> **Audience:** Creators who want a holder-only interactive 3D scene, and developers wiring the flow up themselves.

three.ws already lets you embed a live, interactive 3D avatar or on-chain agent on any page with one script tag ([Share & embed](./share-and-embed.md), [Embedding Guide](./embedding.md)). Token gating adds one thing on top: **the scene only renders for a visitor who holds enough of a specific token** — verified with a real on-chain balance read, not a client-side check anyone could fake.

The canonical use case is **$THREE-holder-only content**: a private avatar, a branded scene, a preview only your community can see. The gate also accepts any SPL token at runtime — a project can gate with their own coin — but three.ws never markets or defaults to anything other than `$THREE`.

---

## How it's different from a private link

A private/unlisted embed link keeps a scene off search and off the marketplace, but anyone who has the URL can view it. A **gated** embed is public by URL — you can post it anywhere — and still only renders the real 3D scene for a wallet that clears the bar. Below the bar, visitors see a designed locked teaser instead of the model.

---

## Creating a gated embed

You need to already own the asset you're gating (an avatar you uploaded, or an on-chain agent registered to your linked wallet).

### Via the MCP tool (Claude / any MCP client)

```
create_gated_embed({
  asset_id: "avatar:8e3c9b1a-...",
  min_amount: 5000
  // mint omitted → defaults to $THREE
})
```

Returns a `gate_id`, the gate terms, and a ready-to-paste embed snippet. See [docs/mcp.md#create_gated_embed](./mcp.md#create_gated_embed) for the full tool schema.

### Via the REST API

```bash
curl -X POST https://three.ws/api/embed/gate-create \
  -H "content-type: application/json" \
  -H "authorization: Bearer $YOUR_API_KEY" \
  -d '{
    "assetId": "avatar:8e3c9b1a-0000-4000-8000-000000000001",
    "gate": { "minAmount": 5000, "chain": "solana" }
  }'
```

```json
{
  "gateId": "a1b2c3d4e5f6",
  "assetId": "avatar:8e3c9b1a-0000-4000-8000-000000000001",
  "gate": { "mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump", "minAmount": 5000, "chain": "solana" },
  "embed": {
    "scriptSrc": "https://three.ws/embed/v1.js",
    "snippet": "<script src=\"https://three.ws/embed/v1.js\" async></script>\n<three-d agent=\"avatar:8e3c9b1a-...\" interactive></three-d>",
    "previewUrl": "https://three.ws/embed/v1/gated.html?asset=avatar%3A8e3c9b1a-..."
  }
}
```

Gating with a community's own token instead of $THREE — pass a `mint`:

```json
{ "assetId": "avatar:...", "gate": { "mint": "<your SPL mint>", "minAmount": 1000 } }
```

Setting a new requirement on an already-gated asset replaces the old gate — every access token issued against the old requirement stops working immediately.

---

## Sharing it

Two ways to place a gated embed, same underlying gate either way:

1. **Script tag + custom element** — works on your own site, Webflow, Framer, a blog, anywhere you can drop HTML. This is the primary form: it runs in the visitor's own top-level page, so their wallet extension (Phantom, Backpack, Solflare) is directly reachable.
   ```html
   <script src="https://three.ws/embed/v1.js" async></script>
   <three-d agent="avatar:8e3c9b1a-..." interactive></three-d>
   ```
2. **Standalone URL** — for platforms that only accept a link (Notion, a Claude artifact, an iframe-only CMS): `https://three.ws/embed/v1/gated.html?asset=avatar:8e3c9b1a-...`. A wallet extension needs to be reachable from inside the iframe for the connect flow to work — most extensions inject into top-level embeds reliably; iframe support varies by extension.

---

## What a visitor sees

**Locked** — a blurred poster teaser, "Hold {min_amount} {symbol} to unlock", and a **Connect wallet** button. No wallet installed → the button becomes a "Get a wallet" link to Phantom instead of a dead control.

**Unlocking** — clicking Connect wallet:
1. Connects the visitor's Solana wallet (Phantom / Backpack / Solflare — whichever is injected).
2. Prompts a message signature (no transaction, no gas, nothing leaves the wallet) proving ownership of the address.
3. The server reads the wallet's **real** SPL balance for the gate's mint via Solana RPC.
4. If it clears `min_amount`, the scene fades in and becomes fully interactive (orbit/zoom/pan). If not, the card shows exactly what they hold vs. what's required, with a retry.

**Session** — a successful check is remembered in the browser tab for **10 minutes** (an access token, not the wallet connection itself), so the visitor isn't re-signing on every interaction. Past that, the embed automatically reverts to locked and prompts a fresh connect — this is what keeps a wallet that sold off its holding from staying "unlocked" indefinitely.

---

## Why this can't be faked

Every check that matters happens on the server:

- The balance read is a live Solana RPC call (`getTokenAccountsByOwner`) against the gate's mint — never a number the browser reports.
- Wallet ownership is proven with a signed, single-use, expiring nonce (SIWS) — a visitor can't just paste an address they don't control.
- The access token that unlocks subsequent fetches is HMAC-signed server-side and tied to the exact gate, asset, and wallet it was issued for; it can't be forged, replayed against a different gate, or extended past its 10-minute TTL.
- `POST /api/embed/gate-verify` is rate-limited per IP **and** per wallet, so scripted brute-forcing (guessing your way to a "holder" balance, or hammering the RPC lane) is bounded.

---

## Reference

- Spec (wire formats, resolver contract, token format): [specs/EMBED_SPEC.md § Token Gating](../specs/EMBED_SPEC.md#token-gating)
- MCP tool: [docs/mcp.md § create_gated_embed](./mcp.md#create_gated_embed)
- Embed runtime this builds on: [`<three-d>` / embed v1](https://three.ws/embed/v1/preview), [Share & embed](./share-and-embed.md)
- Nothing rendering where you pasted the snippet? The [Embed Doctor](https://three.ws/embed-doctor) loads your page in a real browser and names the line to change. It checks a `<three-d>` gated snippet exactly like an ungated `<agent-3d>` one, and a locked embed reads as healthy: the lock is the product working, not a failure.
- Related: [Hold-to-access tiers](./hold-to-access.md) (site-wide $THREE tiers, distinct from per-embed gates)
