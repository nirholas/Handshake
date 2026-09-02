# MASTER 02: The Scout (open-source leverage before a line of new code)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, then add `TARGET: <one line>` or the Architect's HANDOFF block.
Read [README.md](README.md) for the relay protocol. This file is complete on its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Every verdict in this
   stage is "adopt X", "wrap X", or "build it, and here is why nothing qualifies", each
   with evidence. "There might be a package" is not a verdict.
2. This stage may install and commit dependencies it adopts (with the lockfile), and may
   write thin proof-of-life scripts under `scripts/` (or delete them after use). It does
   not build the feature.
3. All CLAUDE.md hard rules apply, including: never add a dependency that duplicates one
   already in `package.json`, pin semver ranges (`^x.y.0`), no em-dash or en-dash anywhere.

## Mission

For every non-trivial capability in the build plan, find what already exists before the
Builder writes it from scratch. The open-source ecosystem has solved most of what any plan
needs; using it is engineering judgment, reinventing it is waste. The output is a
reuse map: capability by capability, what to adopt, what to wrap, what to genuinely build.

## Step 0: re-derive current state

```bash
cat package.json | node -e "const p=JSON.parse(require('fs').readFileSync(0));console.log(Object.keys({...p.dependencies,...p.devDependencies}).join('\n'))"
ls packages/                                # in-house packages that may already cover a capability
cat prompts/finish/roadmap-REUSE-MAP.md 2>/dev/null | head -50   # license-vetted OSS already evaluated
grep -rn "<key nouns>" api/_lib/ src/ --include=*.js -l | head   # in-repo prior art
```

The first dependency to check is always the one already installed. The second is the one
already vetted in `prompts/finish/roadmap-REUSE-MAP.md`. Only then go external.

## Method

1. **Decompose the build plan into capabilities.** From the Architect's plan (or your own
   read of the target), list every capability that is not trivially inline code: parsers,
   codecs, protocol clients, algorithms, UI primitives, file-format handling, validation.
2. **Sweep, in order:** existing `package.json` deps, in-house `packages/*`, the vetted
   reuse map, then npm (`npm view <pkg>`, search scoped to npmjs.com), then GitHub (topic +
   language + stars, but read the README and the issue tracker, not the star count).
   Web search is allowed and encouraged for "best library for X 2026" sweeps.
3. **Evaluate every candidate on the record:** weekly downloads, last publish date, open
   issue trend, maintainer activity, bundle size if it ships to the browser, license.
   GPL-family in shipped product code disqualifies; note it and move on. Known CVEs or 2+
   years unmaintained disqualifies unless wrapping isolates the risk and you say how.
4. **Prove life before adopting.** For each adoption: install it, write a five-line real
   invocation against real data (in `scripts/` or a REPL), confirm it does the job, then
   commit the dependency change. An adoption without a proof run is a guess.
5. **Verdict the remainder honestly.** A capability with no qualifying package gets
   "build", one line on why nothing qualifies, and (if a package solves 90%) a note on
   whether contributing the missing 10% upstream beats building in-house. Upstream-first
   is this repo's stated posture; a filed issue or PR link is a first-class deliverable.
6. **One-liners stay inline.** Never adopt a dependency for three statements. Say so in
   the map where you made that call.

## Definition of done

- [ ] Every capability in the plan has a verdict: adopt (package, version, license,
      evidence), wrap (same, plus what the wrapper isolates), or build (why).
- [ ] Every adopted package proven live against real data, installed, lockfile committed.
- [ ] Zero adopted packages duplicating an existing dependency; zero disqualified licenses.
- [ ] The reuse map appended to `prompts/finish/roadmap-REUSE-MAP.md` if it adds a vetted entry
      (extend the existing file's format; do not fork a second map).
- [ ] `npm test` still green after installs (piped through nothing; read the real exit code).
- [ ] `npm run check:rules -- --paths <files you touched>` clean.
- [ ] HANDOFF block emitted, `next-stage: 03-the-builder.md`, with the reuse map's verdicts
      summarized in `state`.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| Two candidate packages are close | Prefer the one already in the dependency tree's family (same author or ecosystem), then the smaller one. Record the loser. |
| The best package has a disqualifying license | Wrap-at-a-distance is not a license cure. Verdict "build", note the package as design reference only (read its docs, not its code). |
| npm registry or GitHub flaky | Retry, then use the npms.io mirror or `npm view` direct. Network flake never converts an "adopt" into an unverified guess; prove life before the HANDOFF. |
| A proof run needs a missing credential | Follow the CLAUDE.md credential playbook (.env, Cloud Run env, Secret Manager). If truly absent, prove life against the package's own test fixture and mark the verdict "adopt, live-proof pending env var X" in open-risks. |
| Capability is crypto-adjacent and candidates are token projects | Evaluate on engineering merit, but remember the commit gate: naming another crypto project in committed code needs owner approval first. Prefer neutral libraries; if none qualify, put the approval ask in owner-notes. |

## Report format

1. The reuse map: capability, verdict, evidence, one line each.
2. Proof-of-life results for every adoption (command run, what came back).
3. Upstream contributions filed, if any.
4. The HANDOFF block.
