# Triage

How incoming issues and pull requests get sorted, who does it, and what you can expect back. Written for contributors, so you know where your work stands without having to ask.

## Response targets

These are commitments, not aspirations. If we miss one, ping the thread and we will own it.

| Event | Target | What "handled" means |
|---|---|---|
| New issue | 2 business days | Labeled, and either a question back, a reproduction confirmation, or a "not planned" with the reason |
| New pull request from a first-time contributor | 2 business days | A human has read the diff and left a real comment |
| Pull request follow-up round | 2 business days | Re-review after you push changes |
| Security advisory | 24 hours | Acknowledged privately, with a fix window |
| Discussions question | Best effort | Community-first; maintainers answer what stays unanswered |

Nothing gets closed for staleness by a bot. If an issue is real and open, it stays open.

## The triage pass

A maintainer runs the untriaged queue at least twice a week. Every new issue gets:

1. **A type label.** `bug`, `enhancement`, `documentation`, or `question`.
2. **A verdict.** Reproduced, needs more information, or not planned. Rig and rendering bugs need the GLB; the first response on those is usually a request for the file.
3. **A contributor signal, where it applies.** `good first issue` if it is genuinely self-contained with a named file and a verification command. `help wanted` if we want outside help but it is not beginner-shaped.
4. **A home.** Anything touching a path in [CODEOWNERS](../.github/CODEOWNERS) is routed to that owner automatically on the PR.

## Labels and what they actually mean

| Label | Meaning |
|---|---|
| `good first issue` | Self-contained, one or two files, the issue names the file to change and the command that proves it worked. No architecture knowledge needed. |
| `help wanted` | We want an outside contributor on this. Larger than a first issue, still well-scoped. |
| `bug` | Reproduced, or has enough detail to reproduce. |
| `enhancement` | Accepted as a direction. An enhancement issue that is still open has not been rejected. |
| `documentation` | Docs defect or gap. `npm run audit:docs` findings land here. |
| `question` | Usually gets converted to a Discussion so the answer is searchable. |
| `duplicate` / `invalid` / `wontfix` | Closed, always with the reason written in the thread. Never closed silently. |

## Claiming work

Comment on the issue before you start. One line is enough. We assign it to you and nobody else picks it up.

If you claim something and life happens, say so and we will unassign it with zero drama. An unclaimed issue helps the next person; a silently abandoned one blocks them.

## Pull request expectations

- Branch from `main`, one topic per PR.
- `npm test` passes locally before you push.
- `npx prettier --write` on the files you touched.
- Commit subject in the form `type(scope): what changed and why a reader would care`. Subjects that describe the act of committing (`wip`, `sync`, `update`, `changes`) are rejected mechanically.
- Touched a feature whose docs are now wrong? Fix the docs in the same PR. Stale docs are worse than none.
- User-visible change? It needs an entry in `data/changelog.json`. A maintainer will help you word it if you are unsure; the changelog is written for users, not for engineers.

## Maintainers

Day-to-day triage, review, and releases are handled by [@nirholas](https://github.com/nirholas), with [CODEOWNERS](../.github/CODEOWNERS) routing high-blast-radius paths (contracts, payment rails, published SDKs, security policy) to a required review.

We are actively looking to grow this. The path is the normal one: land a few good PRs, help answer things in [Discussions](https://github.com/nirholas/three.ws/discussions), and we will hand you triage rights. There is no interview.

## Related

- [Your first contribution](first-contribution.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [Community](community.md)
- [Security policy](../.github/SECURITY.md)
