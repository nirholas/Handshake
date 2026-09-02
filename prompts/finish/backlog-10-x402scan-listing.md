# 10. Finish the x402scan listing

Read [00-INDEX.md](backlog-00-INDEX.md) first.

> **Commit gate.** This touches a third-party registry. Any commit into three.ws
> whose diff names it needs owner approval first.

## Where this stands

The indexer lists settlements per facilitator address from a registry in the
upstream repo. Our self-hosted Solana facilitator settles from fee payer
`WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW`.

Done already:

- **PR #1032** (branch `add-three-ws-facilitator`) adds the three.ws facilitator.
  Open since 2026-07-17, mergeable, no reviews.
- The `discoveryConfig` addition was pushed to that branch on 2026-07-25.
- `GET https://three.ws/api/x402-facilitator/discovery/resources` is **live in
  production**: the facilitator-standard v1 catalog, projected in
  [api/_lib/x402/discovery-resources.js](../../api/_lib/x402/discovery-resources.js)
  over `buildX402DiscoveryDoc()` from [api/wk.js](../../api/wk.js).

Three steps remain.

## The work

1. **Re-verify the PR is still mergeable and the discovery endpoint still
   matches** what the PR claims. Six weeks of drift on either side breaks a
   listing quietly.
   ```sh
   gh pr view 1032 --repo <upstream> --json state,mergeable,reviews
   curl -s https://three.ws/api/x402-facilitator/discovery/resources | python3 -m json.tool | head -40
   ```

2. **Post the reviewer-verification comment on PR #1032.** This is the one step
   that has been blocked: the fine-grained PAT on this machine is scoped to
   `nirholas` repos and returns "Resource not accessible by personal access token"
   when commenting on a third-party repo. Two ways through, both owner-owned:
   a classic PAT with `public_repo`, or the owner comments directly. Prepare the
   comment text in full so it is a copy-paste for the owner, including the live
   discovery URL, the facilitator address, and the settlement evidence.

3. **Register the origin.** Sign in at the indexer with the platform wallet and
   register origin `https://three.ws`. Wallet sign-in is a signature, not a spend,
   but it binds an identity: render what is being signed and get an owner yes.

4. **Optional Base leg.** The code already routes Base settlement through CDP when
   `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are set on Cloud Run. Creating those
   keys is an owner action. It is a nice-to-have: **never re-point Solana
   settlement to a third-party facilitator for visibility.** Listing is additive,
   Solana stays self-hosted, and an EVM-only directory is a footnote, not a goal.

## Verify

```sh
curl -s https://three.ws/api/x402-facilitator/discovery/resources \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('items', d.get('resources', []))), 'resources')"
npm run gate
```

## Definition of done

- [ ] PR #1032 state re-read and reported (merged, stale, or awaiting the comment).
- [ ] The verification comment is either posted or handed to the owner as
      copy-paste-ready text with every link resolved.
- [ ] Origin registration done or blocked with the exact blocker named.
- [ ] The discovery endpoint's live output matches what the PR registers.
- [ ] Solana settlement unchanged and still self-hosted. State this explicitly.
- [ ] [PROGRESS.md](backlog-PROGRESS.md) updated.
