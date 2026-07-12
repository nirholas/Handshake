# M7 — Medium: `postversion` git push is not pinned to `threews`

**Severity:** Medium-Low · **Area:** Repo / release scripts · **Commit-gate:** no

## Context
CLAUDE.md rule: push **only** to the `threews` remote. `threeD` is a retired mirror
that must never receive pushes. No `origin` remote exists in this repo.

## The defect
[package.json:215](../../package.json):

```json
"postversion": "git push && git push --tags"
```

Bare `git push` uses the current branch's upstream. With no `origin` configured it
either fails, or — if `origin` is later reconfigured — pushes to the wrong target,
violating the push-to-threews-only rule and potentially hitting the forbidden mirror.

## The fix
Pin the push target explicitly:

```json
"postversion": "git push threews HEAD && git push threews --tags"
```

Using `HEAD` avoids assuming a branch name. If `npm version` isn't part of the
actual release flow here, consider whether the `postversion` hook should exist at
all — but if it stays, it must be pinned.

## Verification
1. `git config --get-regexp '^remote\.'` → confirm `threews` is the intended target
   and `origin` is absent.
2. Dry-run the hook logic: `git push threews HEAD --dry-run` targets the right repo.

## Done checklist
- [ ] `postversion` pinned to `threews HEAD` + tags.
- [ ] No bare `git push` remains in package scripts.
