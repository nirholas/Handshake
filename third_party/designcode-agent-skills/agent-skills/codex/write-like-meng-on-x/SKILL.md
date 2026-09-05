---
name: write-like-meng-on-x
description: Write, rewrite, review, or continuously refine X/Twitter posts in Meng To's current voice using his deduplicated authored-post corpus, personal and product context, shared resources, and Content repo evidence. Use when asked to improve a tweet in Meng's tone, draft an original post, reply, thread, resource share, or quote post as Meng, check whether an angle repeats an earlier post, study Meng's writing style, ingest another 20-50 authored posts, or hone the reusable Meng X voice profile.
---

# Write Like Meng on X

## Start

Work from the user's Content repo unless the user names another checkout. If no Content repo is active, locate it from the available workspace roots or ask for the target before writing files.

1. Read `AGENTS.md` and run `git status --short --branch` before changing files.
2. Read [references/voice-profile.md](references/voice-profile.md) before drafting.
3. Read only the relevant rows in [references/content-source-map.md](references/content-source-map.md) for factual and personal context.
4. Search [references/tweet-corpus.jsonl](references/tweet-corpus.jsonl) for the subject, hook, resource, product, and repeated phrases before writing. Do not load or restate the entire corpus when a focused `rg` search is enough.
5. Treat authored X posts as voice evidence, not as copy to splice together.

Use this evidence order:

1. Current user instructions and raw wording
2. Recent authored posts of the same format
3. Trusted personal, product, and resource context in the Content repo
4. Older authored posts
5. Prior generated drafts, only for continuity

## Draft

Identify the format first: reply, original post, quote post, resource share, thread, or product post. Match examples from the same format because Meng's replies are looser than his standalone posts.

Keep the user's strongest original line when it already sounds natural. Improve clarity, sequence, and specificity without replacing the thought with a generic copywriting framework.

Ground the post in something real when useful:

- a product Meng has built or actively uses
- a workflow, constraint, failure, proof point, or result recorded in Content
- a resource Meng has actually shared
- a personal detail already supported by the corpus or trusted project context

Never invent usage, metrics, customers, team behavior, travel, family details, product capabilities, or results. Do not turn a resource share into a hidden product pitch.

For every rewrite or drafting request, return exactly five finished options unless the user explicitly requests another count. Put the strongest option first. Make the five options materially different in angle, structure, rhythm, or intent instead of producing five surface-level paraphrases.

Adapt the remix mix to the post, using distinct types such as:

1. Closest polish that preserves the user's original thought and phrasing
2. Punchier hook or tighter structure
3. Conversational, personal, or more casually spoken
4. Proof-led, mechanism-led, or practical
5. Playful, contrarian, unexpected, or use-case-driven

Label each option by its remix type when useful. Keep all five grounded in the same verified facts. Do not bury the copy under analysis.

Default to casual, spoken language unless the user asks for a more formal tone. Prefer the words Meng would naturally say out loud over polished brand-copy phrasing.

Make every sentence advance the thought. Do not let the second sentence or paragraph merely restate the hook or describe the same feature again. Use it to add a reason, mechanism, use case, proof point, constraint, contrast, question, or conclusion. If it adds nothing new, cut it.

## Prevent Repetition

Check two kinds of duplication before finalizing:

### Corpus duplication

- Match by post ID, canonical status URL, and normalized text hash.
- Store only Meng's authored text as voice evidence. Keep quoted-source text out of the voice field.
- Never append the same authored post twice.
- Replace a truncated record only when a verified full version is available.

### Editorial duplication

- Search for the same hook, claim, resource bundle, anecdote, proof point, and ending.
- Do not reuse a distinctive line merely by changing a few words.
- A recurring belief is allowed when the new post adds new proof, a different mechanism, a useful update, or a new personal angle.
- Prefer a fresh observation over another version of `taste is the moat`, `context matters`, `AI slop`, or `the prompt is not the point` unless the source genuinely advances it.

## Refresh The Voice Corpus

Use the Codex in-app browser only. Never use Chrome. Keep X read-only: do not post, reply, quote, like, repost, bookmark, follow, DM, or change account state.

Open the signed-in profile and the Latest search:

```text
https://x.com/MengTo
https://x.com/search?q=from%3AMengTo&src=typed_query&f=live
```

On each refresh:

1. Collect 20-50 unseen authored posts when X exposes enough history. Start with posts newer than the newest ledger entry, then continue older than the oldest ledger entry to backfill when the new batch is smaller than 20.
2. Include original posts, replies, and quote posts. Exclude pure reposts written by someone else.
3. Record post ID, canonical URL, UTC timestamp, authored text, and format.
4. Expand every truncated authored post on its status page. Report any post that remains incomplete.
5. Keep quoted-source text separate during collection and exclude it from the voice corpus.
6. Save the collected batch as JSON or JSONL and ingest it with the script bundled beside this skill:

```bash
node <skill-dir>/scripts/update-tweet-corpus.mjs --input <batch-path>
```

7. Read the script receipt. A healthy run reports zero duplicate IDs, URLs, and text hashes in the final corpus.
8. Update [references/voice-profile.md](references/voice-profile.md) only when the new evidence confirms a repeated pattern, changes an earlier conclusion, adds useful lived context, or reveals a format-specific move.
9. Update [references/content-source-map.md](references/content-source-map.md) when new Content work adds a durable product fact, resource, story, or teaching theme. Link to the source instead of copying whole passages.

If X is logged out, CAPTCHA-blocked, or the Codex browser cannot attach, stop and report the exact blocker. Do not use public search, Chrome, or guessed posts as a fallback.

## Hone The Profile

Measure the batch before editing the profile:

- sample count and date range
- original, reply, and quote-post mix
- first-person usage
- paragraph and list patterns
- recurring openings, transitions, and endings
- concrete nouns, tools, resources, products, and proof
- rough edges that are natural versus artifacts that should not become rules

Use replies for conversational vocabulary, capitalization, curiosity, gratitude, and disagreement. Use original posts for hooks, story, pacing, lists, proof, and endings. Use quote posts and resource shares for how Meng adds a reason, mechanism, or related resource.

Do not manufacture typos to imitate authenticity. Preserve natural directness, contractions, occasional fragments, and lower-case phrasing when the format supports it.

## Validate And Commit

After changing the skill or corpus:

```bash
node <skill-dir>/scripts/update-tweet-corpus.mjs --check
python3 <skill-creator-dir>/scripts/quick_validate.py <skill-dir>
git diff --check -- <skill-dir>
```

Stage only the source-controlled `write-like-meng-on-x/` skill folder and commit the narrow change. Leave unrelated modified and untracked files alone.

Report the sampled and added counts, date range, profile changes, duplicate checks, browser status, validation result, and commit hash. If no new post or durable voice insight was found, report a no-op instead of creating churn.
