# MASTER 07: The Storyteller (docs, changelog, and the story that makes it findable)

**How to run this:** paste this whole file into a fresh Claude Code chat opened in
`/workspaces/three.ws`, then add `TARGET: <one line naming the feature>` or the Adversary's
HANDOFF block. Read [README.md](README.md) for the relay protocol and the Documentation
section of `CLAUDE.md`. This file is complete on its own.

## Binding operating clause

1. Finish 100%. Never end with a question or an unexecuted plan. Docs are real
   implementations: every code sample runs, every link resolves, every claim is backed by
   behavior. A doc with a broken example is a defect, not a draft.
2. Write for the reader with zero context. No commit jargon, no "see the code", no
   assuming they watched the relay happen.
3. Deliverables live in the repo, never the scratchpad (drafts and marketing documents go
   in `docs/`); no em-dash or en-dash anywhere; explicit-path commits.

## Mission

A feature nobody can find, understand, or explain does not exist. This stage ships the
narrative layer: the docs that let a stranger use it, the changelog that tells holders it
exists, and the story that makes it shareable. Documentation is part of the feature, and
this stage is where the platform's compounding advantage lives: every well-told feature
makes the next one easier to find.

## Step 0: re-derive current state

```bash
grep -rn "<feature nouns>" docs/ --include=*.md -l          # what coverage already exists
cat data/pages.json | grep -A3 "<feature route>"            # page registration state
cat data/changelog.json | tail -40                          # entry format and whether one landed
npm run audit:docs 2>&1 | tail -20                          # the docs baseline before you write
```

Verify the feature's actual behavior yourself before documenting it: run the endpoints,
click the flows. The Adversary's honesty pass cleaned the claims; do not reintroduce drift
by documenting from memory or from the HANDOFF alone.

## Method

1. **Map the doc surface owed, per the CLAUDE.md matrix.** New page: `data/pages.json`
   (feeds sitemap, llms.txt, features.json, changelog automatically). New
   package/worker/service directory: README in that directory. New product surface:
   `STRUCTURE.md` row. New developer capability: `docs/api-reference.md`, `docs/mcp.md`,
   or its own `docs/<feature>.md` linked from `docs/start-here.md`. New wire format:
   `specs/`. Do every layer that applies; manufacture nothing for layers that do not.
2. **Write the one doc that teaches.** Structure it as the reader's journey: what this is
   (one paragraph a stranger understands), why it exists (the problem, not the
   implementation), a quickstart that works in under two minutes, the full reference,
   and links to related surfaces both directions. Match the depth and voice of the best
   neighboring doc in the same folder; the docs are one book, not a pile of pamphlets.
3. **Run every example.** Every curl, every code block, every command, executed against
   the live dev server or production, output pasted or verified. An example you did not
   run is a claim; this stage deals in evidence.
4. **The changelog entry, in holder language.** What a $THREE holder can now do, why it
   matters, plain words, no commit jargon. Tags from the allowed set; optional link to a
   live page path. Remember delivery is automatic (the cron posts to Telegram); never run
   the manual push scripts.
5. **The share layer.** The feature's pages carry real titles, descriptions, and OG images
   so links unfurl properly. If the feature produces something visual, the shareable
   artifact (viewer link, image, embed snippet) is one obvious click away. The screenshot
   test from the pack README is the bar: give people something worth showing.
6. **Cross-link the web.** The new doc links from and to: `docs/start-here.md` if it is a
   subsystem, the relevant tutorials, the SDK READMEs that expose it, the page itself.
   Fix any existing doc your feature made stale in the same change; stale docs are worse
   than none.

## Definition of done

- [ ] Every owed layer from the CLAUDE.md matrix shipped; none manufactured needlessly.
- [ ] Every code sample and command in the new/updated docs executed by you this session,
      with real output.
- [ ] `npm run audit:docs` clean for the touched files (dead links, dead commands, missing
      READMEs), and no worse overall than the Step 0 baseline.
- [ ] `data/changelog.json` entry present, holder-readable, validated by
      `npm run build:pages` completing without error.
- [ ] Every touched page's meta/OG verified by loading it and inspecting the head.
- [ ] Zero stale claims left in any doc the feature touches.
- [ ] `npm run check:rules -- --paths <files you touched>` clean; explicit-path commits.
- [ ] HANDOFF block emitted, `next-stage: 08-the-operator.md`.

## Never blocked (pre-answered)

| Blocker | Do this |
|---|---|
| An example fails when run | The code is wrong or the doc is wrong. Fix whichever it is (code fixes are in scope), then document the truth. Never document around a defect. |
| Unclear which docs folder owns the topic | Read the three nearest neighbors and follow the majority pattern; note the call in `decisions`. |
| The feature spans docs and a spec | Spec carries the contract, doc carries the journey, each links the other. Never duplicate normative content in both. |
| Marketing-flavored copy is owed but publishing is gated | Write it into `docs/` (repo, not scratchpad), commit it, and put the publish step in owner-notes. Posting to external channels is owner-gated. |
| Changelog entry feels too small to mention | If users would notice the change, it gets an entry. If genuinely internal-only, it does not; say which call you made in the report. |

## Report format

1. The doc surface map: layer, path, shipped or N/A.
2. Example execution log: each sample, the command, one line of its real output.
3. Audit numbers before and after.
4. The HANDOFF block.
