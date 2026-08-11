# Draft: HISTORY.md for nirholas/fresh-start

Copy this into `nirholas/fresh-start` as `HISTORY.md` and link it from the README. Notes on the
choices are at the bottom of this file, under "Drafting notes"; delete that section before publishing.

Every factual claim below was verified against a primary artifact (the archived original zip, git
commit metadata in a surviving fork, published npm tarballs, the DMCA filings). Verification commands
are included so nobody has to take the account on trust.

---

## What this repository is

On 31 March 2026, Anthropic accidentally published the TypeScript source of Claude Code: version
2.1.88 of the `@anthropic-ai/claude-code` npm package shipped with a source map pointing at a public
bucket containing roughly 512,000 lines across ~2,200 files. Chaofan Shou found it and posted the
link. Anthropic later called it "a release packaging issue caused by human error, not a security
breach."

I mirrored it to `nirholas/claude-code` about 40 minutes later, and then started building on top of
it. The repository grew to several thousand stars and thousands of forks before Anthropic filed a
DMCA notice against it. GitHub processed that notice against the entire fork network of 8,100
repositories. Anthropic retracted the network-wide portion the next day and everything else was
restored; the notice against my repository was not retracted. I removed the contents, and GitHub let
me keep the repository. That is what you are looking at.

This repository contains no Anthropic source code and will not.

## The correction that matters to everyone else

**Claude Code does not contain, and has never contained, a cryptocurrency wallet or an autonomous
payment system. The x402 payment code that circulated with copies of the leak was mine. I wrote it.
It was not Anthropic's, it was not a hidden feature, and it was not in the leak.**

Several widely-read writeups state that the leak revealed a built-in USDC wallet in
`src/commands/x402/`, listing `/x402 setup`, `/x402 enable`, `/x402 set-limit` and so on as
undocumented Anthropic features. Search engines now repeat this as fact. It is wrong, and the error
originates with my working copy.

Here is what actually happened. I was using the leaked tree as the base for a project of my own: a
web-terminal front end, an MCP server, build shims to get it compiling under Bun, and an x402
integration so an agent could pay for HTTP 402 responses. That is ordinary work on a fork, and I said
so publicly the same day. What I did not anticipate was that thousands of people would fork my working
copy while it was still a working copy, and that some of them would read my feature as Anthropic's.

Three independent ways to confirm Anthropic never shipped it:

1. **The original archive.** The Internet Archive holds four captures of the original `src.zip` from
   31 March 2026, all with identical content digests, the earliest predating my mirror. It contains
   2,203 entries. Filenames matching `x402|wallet|payment|usdc|signer`: zero. Full-text search for
   the string `x402`: zero hits.
2. **The shipped packages.** Versions 2.1.87 and 2.1.89, which bracket the pulled 2.1.88, contain zero
   occurrences of `x402`. The only `usdc` strings are the `.usdc` file extension inside the bundled
   ripgrep binary, which is a Pixar 3D format.
3. **The commit history.** In my repository the x402 files appear for the first time in a commit
   timestamped `2026-03-31T10:26:23Z`, roughly two minutes after the bulk import of the leaked files
   finished at `10:24:35Z`. That history is preserved in public forks.

The one false positive that probably fed the confusion: grepping the leak for `USDC` returns 11 hits.
All of them are the identifier `calculateUSDCost` in `src/utils/modelCost.ts` and its callers. That is
"USD Cost", the token-pricing function, not the stablecoin.

## Everything I changed, completely

Some copies of the leak have been described as possibly containing other unidentified modifications.
Here is the full accounting so that claim can be checked rather than repeated.

The x402 feature was **8 new files**:

```
src/services/x402/client.ts          src/commands/x402/index.ts
src/services/x402/config.ts          src/commands/x402/x402.ts
src/services/x402/index.ts
src/services/x402/paymentFetch.ts
src/services/x402/tracker.ts
src/services/x402/types.ts
```

It touched exactly **4 of Anthropic's files**, all to call into those new modules:

| File | Change | What it does |
|---|---|---|
| `src/services/api/client.ts` | +13/-1 | wraps `fetch` with the x402 handler, behind an `isX402Enabled()` check |
| `src/cost-tracker.ts` | +13/-1 | appends a payment total to the `Total cost:` display |
| `src/tools/WebFetchTool/utils.ts` | +43 | catches an HTTP 402 response and retries once with a payment header |
| `src/commands.ts` | small | registers the `/x402` command |

All four call sites are wrapped in `try { require(...) } catch {}` so they no-op when the module is
absent. That is why the integration reads as native rather than bolted on: it was written to match the
surrounding code, because I was building on the codebase, not disguising an addition to it.

Beyond that, and beyond my own new files (the `src/server/web/*` terminal, `src/shims/*` build shims,
type declarations, the MCP server, Docker and docs), **the only other edits to Anthropic's files were
48 single blank lines appended by a formatter pass.** No logic, no network destinations, no telemetry,
no credential handling anywhere in the tree was modified.

Scope limit, stated plainly: this accounting is complete through `2026-03-31T12:43Z`, which is where
the public fork history I can verify against ends. Work continued in my repository after that point
and before the takedown, and I am not asking anyone to take my word for that window. If you hold a
copy from later, diff it yourself against the archived original and publish what you find.

## Verify all of it yourself

```bash
# The archived original: no payment code of any kind
curl -sL "https://web.archive.org/web/20260331090815id_/https://pub-aea8527898604c1bbb12468b1581d95e.r2.dev/src.zip" -o orig.zip
unzip -Z1 orig.zip | grep -icE "x402|wallet|payment|signer"     # -> 0

# Anthropic's shipped bundles, either side of the pulled release
npm pack @anthropic-ai/claude-code@2.1.89
tar xzf claude-code-2.1.89.tgz -O | grep -c x402                # -> 0

# The DMCA notice and the next-day partial retraction
# github.com/github/dmca -> 2026/03/2026-03-31-anthropic.md
#                        -> 2026/04/2026-04-01-anthropic-retraction.md
```

## Why it looked planted

A careful forensic writeup of the mirror listed seven properties of the x402 code as evidence it was
covertly injected: no `tengu_` GrowthBook feature flag when all 58 other features have one; defensive
`try { require(...) } catch {}` at every integration point instead of static imports; absent from the
17 `prompts/` build-out documents; no tests; no telemetry, in a codebase that logs roughly 651 event
types; no new npm dependencies, rolling its own secp256k1 and EIP-712 signing on native Node crypto;
and self-contained enough to remove without a trace.

Every one of those observations is accurate. Here is the other explanation for them, which is the
actual one: I could not register a GrowthBook flag I have no access to. I used defensive requires
because a tree reconstructed from a source map does not compile cleanly and I did not want my feature
to be the thing that broke the build. I did not add my feature to the 17 documents describing how to
rebuild Anthropic's codebase, because it is not part of Anthropic's codebase. I did not wire it into
Anthropic's telemetry exporters, because sending events to their BigQuery pipeline would have been
worse in every direction. And I kept it dependency-free and self-contained because that is how you
build a feature on a base you may need to rebase or discard.

The properties of "a feature added quickly to a fork by someone outside the company" and "a covert
injection" overlap almost completely. That is a fair thing for an analyst to flag, and I am not
disputing the observations. What I can add is the intent, which the code cannot show you: I was
building a project, not disguising a payload. The clearest evidence is that eight hours after
committing it, when someone accused me publicly in the reply thread of secretly adding payment code, I
answered in the same thread that it was x402 and that it was not secret. I never claimed it was
Anthropic's, and I would have said so any time anyone asked.

Where I was wrong is narrower and I will name it plainly: I published my in-progress work on top of a
freshly leaked tree, under a repository name that read as a faithful mirror, at the exact moment
thousands of people were cloning it as a reference copy. Whatever I intended, that is how the confusion
was manufactured, and that part is mine.

## This repository was never the malware campaign

A separate thing happened in the same news cycle, and the two get conflated. Between 1 and 3 April
2026, threat actors published fake "Claude Code leak" repositories containing a `.7z` archive with a
Rust dropper, `ClaudeCode_x64.exe`, that installed Vidar v18.7 and GhostSocks. It was covered by The
Register, Help Net Security, TechRadar and others.

Zscaler ThreatLabz published the indicators of compromise. They name three things: the repositories
`leaked-claude-code/leaked-claude-code` and `my3jie/leaked-claude-code`, and the publisher account
`idbzoomh1`. This account is named in none of it. There were no binaries, no releases, and no
installers here, only TypeScript in a git tree.

## Where the x402 code went

The payment integration was the part of my work I actually wanted to build, and it outlived the
repository. It survives at its original paths in a number of downstream projects that forked before
the takedown, generally uncredited and sometimes still mistaken for Anthropic's.

The maintained version is [`nirholas/agenti`](https://github.com/nirholas/agenti): give any agent a
wallet, pay x402 APIs, receive USDC, on EVM and Solana, with MCP client support. That is the same idea
with none of anyone else's code in it, which is where it should have been from the start.

## Do not run copies of the leak

This is worth repeating regardless of where your copy came from. The leaked tree imports internal
packages that do not exist on the public npm registry, and squatters publish malicious packages under
exactly those names. Installing dependencies from any copy of this codebase can execute arbitrary code
on your machine. Use the official Claude Code CLI from Anthropic.

## Status

The DMCA notice against the original repository has not been retracted. This repository holds no
Anthropic code. If that situation changes, this file will say so.

---

## Drafting notes (delete before publishing)

**Why publish at all.** This repo has 6,254 stars and two files. People land here from the story and
find a placeholder README saying the original content will return, which is the opposite of an
accurate account and reads as "come back later for the leak." The vacuum is currently being filled by
articles claiming Anthropic ships a USDC wallet. A precise record is both more useful and better for
you than silence.

**Why the complete change accounting is the most important section.** The specific reputational damage
is not "he added a feature to his fork." It is the open-ended suggestion that unknown other things may
have been planted. An enumerated, independently checkable list is the only thing that closes that. A
general denial does not.

**Word choice.** The draft says "added" and "wrote," never "injected," because injected implies intent
to deceive and the timeline does not support that reading: you publicly identified the code as x402
and said "it's not secret" at 17:54 UTC on 31 March, within eight hours of committing it. Consider
citing that tweet in the record. It is the single strongest exculpatory artifact you have.

**The one post that cuts the other way** is 2026-04-01 05:52 UTC: "word is someone injected x402
payments. lemme know if you can find that version." Anyone researching this finds it next to the
commits. The draft does not mention it. If you would rather get ahead of it, one honest sentence
beats being quoted on it later; if you would rather not, leave it, but expect it to surface.

**Two adjacent moves worth making:**

1. The x402 code is your own authorship and carries none of Anthropic's IP. Publishing it as a
   standalone repo or npm package is clean, gives this record a live link to point at, and converts
   the whole episode into a shipped artifact.
2. The HackerNoon piece ("25 Things the Claude Code Leak Reveals") and its Medium reprint are the two
   sources actively spreading the false Anthropic claim, and neither has been corrected. A correction
   request to both, citing the archive and the npm bundles, fixes the record at the source. That helps
   Anthropic too, which is not a bad position to be in while a notice against you is outstanding.

**One caution, stated once.** The notice against `nirholas/claude-code` was never retracted, and this
document is a detailed, permanent, quotable account of modifying and redistributing that codebase.
Everything in it is already independently discoverable, which is the argument for publishing. It is
still worth a lawyer's read before it goes up, given the notice is outstanding.
