# Button + Pill Migration Map (B04)

**Canonical system:** `public/style.css` — `.btn` base + BEM modifiers + `.pill` base + semantic modifiers.
**Tokens:** B01 primitives in `public/tokens.css`; component tokens (`--btn-*`, `--badge-*`, `--focus-ring-*`, `--disabled-*`) layered in `public/style.css`.

---

## Canonical classes

### Buttons

| Class | Description |
|---|---|
| `.btn` | Base (secondary): glass surface, border, white text |
| `.btn.btn--primary` | White fill, dark ink — main CTA |
| `.btn.btn--secondary` | Explicit secondary (same as base, for readability) |
| `.btn.btn--ghost` | Transparent, text-only |
| `.btn.btn--danger` | Red-tinted |
| `.btn.btn--sm` | Small size |
| `.btn.btn--lg` | Large size |
| `.btn.btn--block` | Full-width |
| `.btn.btn--icon` | Square icon-only |

States handled automatically: `:hover`, `:active`, `:focus-visible` (visible focus ring), `[disabled]` / `[aria-disabled]` (pointer-events:none, reduced opacity), `[aria-busy="true"]` (CSS spinner, no setTimeout).

### Pills / badges

| Class | Description |
|---|---|
| `.pill` | Base neutral badge |
| `.pill.pill--onchain` | Green — deployed on-chain |
| `.pill.pill--devnet` | Amber — testnet/devnet |
| `.pill.pill--success` | Green — success state |
| `.pill.pill--warn` | Amber — warning |
| `.pill.pill--danger` | Red — error/danger |
| `.pill.pill--new` | Neutral — "New" label |
| `.pill.pill--md` | Medium size |
| `.pill__dot` | Animated pulse status dot inside a pill |

Linked pills: use `<a class="pill pill--onchain">` — gets hover/focus states automatically.

---

## Migrated surfaces (done)

| Surface | Old classes | New classes added |
|---|---|---|
| `/deploy` (register-ui.js) | `erc8004-btn`, `erc8004-btn--primary`, `erc8004-btn--ghost`, `erc8004-btn--close`, `erc8004-btn--wallet`, `erc8004-btn--x` | Added `btn btn--primary/--ghost/--secondary/--icon` alongside |
| Pump launch modal (launch-token-modal.js) | `ltm-btn`, `ltm-btn-primary` | Added `btn btn--secondary/--primary` alongside |
| Homepage pump launcher (homepage-launcher.js) | `ltm-btn`, `ltm-btn-primary` | Added `btn btn--secondary/--primary` alongside |
| Nav drawer (nav.html) | `btn primary` | Added `btn--primary` BEM modifier |
| On-chain badge (onchain-badge.js) | `tws-ocb`, `tws-ocb--md`, `tws-ocb--devnet` | Added `pill pill--onchain/--devnet pill--md` |

---

## Remaining long tail — classes → canonical equivalent

These classes are defined across the codebase. Follow-up agents should replace them with canonical classes (keep old class as needed for scoped CSS overrides).

### Button class names → canonical

| Old class(es) | Canonical equivalent |
|---|---|
| `explore-btn` | `.btn.btn--secondary` |
| `explore-btn--primary` | `.btn.btn--primary` |
| `explore-btn--ghost` | `.btn.btn--ghost` |
| `explore-btn--sm` | `.btn.btn--sm` |
| `erc8004-quickstart-btn` | `.btn.btn--primary` |
| `deploy-wallet-btn` | `.btn.btn--secondary` (already has `btn` class) |
| `ch-btn-primary` | `.btn.btn--primary` |
| `ad-btn`, `ad-btn-primary` | `.btn` / `.btn.btn--primary` |
| `as-btn`, `as-btn-primary`, `as-btn-ghost`, `as-btn-sm` | `.btn` + modifiers |
| `br-btn`, `br-btn-primary`, `br-btn-ghost`, `br-btn-secondary`, `br-btn-sm`, `br-btn-danger` | `.btn` + modifiers |
| `ae-btn`, `ame-btn`, `ame-console-btn` | `.btn.btn--secondary` |
| `ar-btn`, `ar-btn--active`, `ar-launch-btn`, `ar-share-btn` | `.btn` + modifiers |
| `fm-btn` | `.btn.btn--secondary` |
| `bento-action-btn`, `bento-pill-btn` | `.btn.btn--ghost` / `.pill` |
| `market-empty-cta-btn`, `market-empty-cta-btn.primary` | `.btn` / `.btn.btn--primary` |
| `btn-primary`, `btn-secondary` | `.btn.btn--primary` / `.btn.btn--secondary` |
| `capture-btn` | `.btn.btn--ghost` |
| `anim-btn`, `anim-btn--active`, `anim-btn--loading` | `.btn` + `[aria-busy]` for loading |
| `ltm-toggle-btn` | `.btn.btn--ghost` |
| `back-btn` | `.btn.btn--secondary` |
| `abort-btn`, `add-btn`, `assign-btn` | `.btn.btn--secondary` / `.btn.btn--danger` |
| `pay-btn` | `.btn.btn--primary` |
| `model-btn`, `anim-upload-btn`, `anim-repin-btn`, `anim-stop-btn` | `.btn.btn--ghost` |

### Pill/badge class names → canonical

| Old class(es) | Canonical equivalent |
|---|---|
| `explore-chain-badge` | `.pill` |
| `explore-chain-badge--testnet` | `.pill.pill--devnet` |
| `explore-card-3dpill` | `.pill` (with custom color overrides) |
| `deploy-svc-pill` | `.pill` |
| `erc8004-brand-badge` | `.pill.pill--onchain` |
| `tws-ocb` (onchain-badge) | `.pill.pill--onchain` (already generalized in B04) |
| `.price-badge` | `.pill` |
| `nav-pill-sm` | `.pill.pill--new.pill--sm` |

---

## Forge page note

`pages/forge.html` defines its own inline `.btn` and `.btn-ghost` styles that shadow the canonical system within that page. To fully migrate:

1. Remove the inline `.btn` / `.btn-ghost` definitions from forge.html's `<style>` block.
2. Update forge buttons: `class="btn"` → `class="btn btn--primary"`, `class="btn btn-ghost"` → `class="btn btn--ghost"`.
3. Retain any forge-specific sizing overrides in a scoped `.forge-stage .btn { ... }` block.

## Marketplace page note

`pages/marketplace.html` defines inline `.btn-primary` / `.btn-secondary` styles. Migration:

1. Remove inline button CSS.
2. Replace `btn-primary` → `btn btn--primary`, `btn-secondary` → `btn btn--secondary`.
3. Replace `market-empty-cta-btn.primary` → `btn btn--primary`.
