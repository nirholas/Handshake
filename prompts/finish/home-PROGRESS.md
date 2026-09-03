# home/: cross-chat handoff log

The only memory between sessions for the three.ws Home campaign. Every agent that finishes an
order appends to it, in the same commit that deletes the order file. Read
[00-CONTEXT.md](home-00-CONTEXT.md) for the campaign's shared facts; this file is history, not
architecture.

**Append, never rewrite.** Someone else's entry is their evidence, not your draft.

---

## Format

One section per finished order, newest at the bottom:

```
## <order number>. <title> (<UTC date>)

**Shipped:** what now exists that did not before, in one paragraph.
**Measured:** the numbers, with how they were read.
**Deviations:** anything in the order file that was wrong, and what it was changed to.
**Left open:** anything not done, who owns it, and why. "Nothing" is a valid answer.
**Commits:** the SHAs.
```

---

## Campaign state

| Order | State | Finished |
|---|---|---|
| 00 CONTEXT | shared facts | n/a |
| 01 connection store | open | |
| 02 bridge runtime | open | |
| 03 API surface | open | |
| 04 agent tools | open | |
| 05 connect flow | open | |
| 06 3D home scene | open | |
| 07 floorplan editor | open | |
| 08 voice loop | open | |
| 09 Wyoming satellite | open | |
| 10 add-on relay | open | |
| 11 security | open | |
| 12 households and RBAC | open | |
| 13 observability | open | |
| 14 reliability and scale | open | |
| 15 privacy and retention | open | |
| 16 test program | open | |
| 17 a11y, i18n, mobile | open | |
| 18 docs and SDK | open | |
| 19 plans and entitlements | open | |
| 20 launch readiness | standing | |
| 21 Matter direct | horizon | |

Update the row in the same commit that retires the order. The directory shrinking is the real
ledger; this table is the readable one.

---

## Before the campaign

**2026-09-02.** The investigation and the client library landed ahead of the campaign, in commits
`480d8d7db` and `f54b124df`:

- [`docs/smart-home.md`](../../docs/smart-home.md): the open-source landscape measured from the
  GitHub API, the decision to write zero device code, the reachability constraint, and the
  verification table.
- [`packages/home-bridge/`](../../packages/home-bridge): the client library, 36 tests, verified
  against a real Home Assistant (docker `stable`, demo integration, 122 entities).
- The finding that shapes the whole campaign: Home Assistant's `intent__HassTurnOff` performs an
  **unlock** on a lock, confirmed live with a lock exposed to Assist. The gate exists because of
  it.

Nothing of that is wired into the product. Order 01 is the first order that changes that.
