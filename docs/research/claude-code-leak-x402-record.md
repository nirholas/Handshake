# The Claude Code leak, the DMCA, and the x402 question: what the public record shows

Research compiled 2026-08-10. Every claim below is sourced to a primary artifact (DMCA filing, git
commit, npm tarball, Wayback capture) or to a named published article. Times are UTC.

## 1. Timeline

| Time (UTC) | Event | Source |
|---|---|---|
| 2026-03-31 ~08:00 | `@anthropic-ai/claude-code` 2.1.88 ships with a 59.8 MB source map pointing at Anthropic's public R2 bucket. Chaofan Shou (@shoucccc) posts the `src.zip` link. | X post; version 2.1.88 is now absent from npm (registry jumps 2.1.87 to 2.1.89) |
| 09:08:15 | Internet Archive captures `src.zip`, 9,917,836 bytes, 2,203 entries. | Wayback CDX |
| 09:23:58 | `Kuberwastaken/claude-code` created (mirror). | GitHub API |
| ~09:46 | `nichxbt` posts: "i added a mirror/backup of the Claude Code source code on my Github". 1.4K likes, 452K views. | x.com/nichxbt/status/2038915876616057058 |
| 10:22:43 to 10:24:35 | `nirholas/claude-code` imports the leak as ~2,100 single-file commits with emoji subjects (a `gitpretty-apply.sh` run). | commit metadata preserved in `ccsols/claude-code-nirholas` |
| **10:26:23** | Commit `8ba939ba` ("📝") adds `src/commands/x402/index.ts` and `src/services/x402/{client,config,index,paymentFetch,tracker}.ts`, and wires them into `src/cost-tracker.ts` and `src/services/api/client.ts`. | same |
| 10:38:23 | Commit `cf9b4053` ("✨ milady") adds `src/commands/x402/x402.ts` (+216) and registers the command in `src/commands.ts`. | same |
| 10:55 to 12:05 | MCP server `claude-code-explorer-mcp` published to npm and listed on Anthropic's MCP Registry. | x.com/nichxbt/status/2038933318289465601 |
| 17:54 | nichxbt replies to a "secretly added payment code" accusation: "it's x402 which enables micropayments to APIs from agents. And it's not secret." | x.com/nichxbt/status/2039038602857087450 |
| ~2026-03-31 late | Anthropic files the DMCA against `nirholas/claude-code` plus 96 named forks. GitHub processes it network-wide against 8,100 repos because the network exceeded 100 repos. | github/dmca 2026/03/2026-03-31-anthropic.md |
| 2026-04-01 03:49 | nichxbt: "Github took down 8,000+ Github repos ... All of which happened to be forked from my repository". 240 likes, 33K views. | x.com/nichxbt/status/2039188393528332578 |
| 2026-04-01 | Anthropic files a partial retraction: everything except `nirholas/claude-code` and the 96 listed forks is reinstated. | github/dmca 2026/04/2026-04-01-anthropic-retraction.md |
| 2026-04-01 05:52 | nichxbt: "its being passed around on the low. word is someone injected x402 payments. lemme know if you can find that version" | x.com/nichxbt/status/2039219238217601482 |
| 2026-04-01 | Business Insider covers the leak and names @nichxbt as the account whose GitHub copy "spawned thousands of copies". | businessinsider.com/claude-code-leak-what-happened-recreated-python-features-revealed-2026-4 |
| 2026-04-02 | Prabal Gupta replaces his analysis post with a correction stating the x402 files were injected into the nirholas copy and were not Anthropic's. | prabalgupta.com (correction post, same URL as the original) |
| 2026-04-16 17:15 | nichxbt posts about going "head-to-head with Anthropic and GitHub"; repo "live again" on a `clean-start` branch. | x.com/nichxbt/status/2044826931452108889 |
| 2026-07-14 / 07-28 | `nirholas/fresh-start` license switched to All Rights Reserved; README rewritten as a takedown-status placeholder. | GitHub commits |

`nirholas/fresh-start` today: created 2026-03-31, default branch `clean-start`, two files (LICENSE,
README.md), 6,254 stars, 13 forks.

## 2. Was x402 in Anthropic's leak? No.

Three independent lines of evidence, each reproducible.

### 2.1 The archived original zip

The Internet Archive holds four captures of the original `src.zip` from 2026-03-31, all with the same
content digest (`JIVFLG4CVETN7KRTTJTWM6JYOFP7DWBF`). The earliest, 09:08:15, predates the nirholas
mirror by roughly 40 minutes.

- SHA-256 of the retrieved archive: `8cd0e0b61ddc5755e2120876ece34f3b24613f1f5f0d97a659962a7282bc8921`
- 2,203 entries
- Filenames matching `x402|wallet|payment|usdc|signer`: **zero**
- `src/services/` contains 36 entries; none is `x402` (`src/commands/` contains 101; the nirholas tree
  has 102, the extra one being `x402`)
- Full-text grep of every file for the string `x402`: **zero hits**

The only `USDC` hits in the entire archive are the identifier `calculateUSDCost` / `tokensToUSDCost`
in `src/utils/modelCost.ts`, `src/cost-tracker.ts`, `src/services/vcr.ts`, and
`src/services/api/claude.ts`. That is "USD Cost", not the stablecoin. A naive `grep -i usdc` over the
leak returns 11 hits and none of them are crypto, which is a plausible way a reader talked themselves
into the payments story.

### 2.2 Set difference against the mirror

`ccsols/claude-code-nirholas` is a fork-of-a-fork of `nirholas/claude-code` that survived the takedown
with the original commit history and author metadata intact. Comparing its `src/commands/` directory
set against the archived zip:

- In the mirror but not the original: `x402` (one entry)
- In the original but not the mirror: nothing

The two trees are otherwise identical at that level. The single divergence is the payments code.

### 2.3 The shipped npm bundles

The published packages bracketing the pulled 2.1.88 release contain no payment system at all:

| Version | `x402` occurrences | `USDC` occurrences |
|---|---|---|
| 2.1.87 | 0 | 6, all of them the `.usdc` file extension inside the bundled ripgrep binary (Pixar USD format) |
| 2.1.89 | 0 | same 6 |

If Anthropic had shipped a USDC wallet in Claude Code, it would be in the bundle. It is not.

### 2.4 What the injected code actually is

`src/commands/x402/x402.ts` in the mirror implements a `/x402` slash command with `setup`, `status`,
`enable`, `disable`, `set-limit`, `set-session`, `network`, and `remove` subcommands, over networks
`base`, `base-sepolia`, `ethereum`, `ethereum-sepolia`. `src/services/x402/paymentFetch.ts` wraps
`globalThis.fetch` so HTTP 402 responses are answered with a signed USDC payment authorization;
`src/services/api/client.ts` was patched to install that wrapper, and `src/cost-tracker.ts` was patched
to append a payment total to the `Total cost:` display. Both patches are guarded with
`try { require(...) } catch {}` so they no-op when the module is absent, which is why the code reads as
native rather than bolted on.

A complete enumeration of every post-import edit to Anthropic's files in the surviving snapshot
(4 substantive files, 48 blank-line-only formatter edits, 8 new x402 files) is in
[fresh-start-history-draft.md](fresh-start-history-draft.md).

**Conclusion:** the x402 payment system was not part of Anthropic's leak. In the nirholas lineage it
appears for the first time in commit `8ba939ba`, authored `nirholas`, timestamped 2026-03-31T10:26:23Z,
about two minutes after the bulk import of the leaked files finished. That matches Prabal Gupta's
correction on the substance, and the commit timestamps are stronger evidence than his file count.

## 2.5 The source of the allegation

The piece alleging the injection is not a news outlet. It is a personal blog post.

- **Site:** `prabal.ca` (the older `prabalgupta.com` 302s to it). Author Prabal Gupta: X
  [@prabal_](https://x.com/prabal_), GitHub `prabal-rje`, LinkedIn `prabal1997`, a Buttondown
  newsletter, and a `/consulting/` page. Roughly a dozen posts total, mostly about his own projects
  (MonitorIntent, LatentScore, an X-algorithm visualizer, ClaudeDown).
- **URL:** `https://prabal.ca/posts/claude-code-x402-agent-payments/`. The slug is the *original*
  thesis: that Anthropic had built agent payments into Claude Code. He replaced that article in place
  with the correction, so the slug now serves a piece titled "Correction: Claude Code Leak Post".
  Page metadata gives `article:published_time` of 2026-04-02T04:51:23Z.
- **Distribution is thin.** The post does not appear on the site's `/posts/` index, in its RSS feed,
  or on its own `/tags/claude/` page. It is delisted from every human navigation path on the site
  while remaining live. It *is* listed in `sitemap-0.xml` with a canonical tag and no `noindex`, so
  it is crawlable, but no search query I ran surfaced it. The Internet Archive holds exactly one
  capture, 2026-05-12, reached via a `?ref=rosecurify.com` referral, and that capture is already the
  corrected version. No archive of the pre-correction article appears to exist anywhere.
- **Method he used:** "I cross-referenced against two other mirrors of the same leak." He did not use
  the archived original `src.zip`, which is the authoritative artifact and independently supports his
  conclusion.
- **Where he is precisely right:** "Eight files were planted." The mirror carries exactly eight:
  `src/services/x402/{client,config,index,paymentFetch,tracker,types}.ts` and
  `src/commands/x402/{index,x402}.ts`, plus in-place patches to two real files.
- **Where he goes past his evidence:** "Multiple people have since told me their copies don't match
  each other ... possibly other injections nobody has identified yet," and the instruction that any
  copy sourced from nirholas should be treated as compromised. No artifacts are offered for any
  variant other than the x402 one. That part is secondhand report, not verified finding.
- **The motive line** is the sharpest sentence in the piece: "The GitHub account that distributed the
  tampered source (nirholas) has the Twitter handle nichxbt. An account promoting this ecosystem
  distributing a leaked codebase that happens to contain fabricated payment integrations." The post
  embeds two screenshots of @nichxbt tweets at `/images/x402/nichxbt-mirror-tweet.png` and
  `/images/x402/nichxbt-dmca-tweet.jpg`.

Net: the allegation is one individual's blog post with near-zero search distribution and a single
archive capture. Its central technical claim happens to be correct. Its extension to "other
injections nobody has identified" is unsupported.

## 3. Where the false claim spread

The x402 story escaped the original post and is still being repeated as fact about Anthropic:

- **HackerNoon, "25 Things the Claude Code Leak Reveals About Anthropic's AI Agents"** states "Inside
  `src/commands/x402/` lives a fully implemented USDC wallet and autonomous payment system most users
  don't know exists", and lists the `/x402` subcommands verbatim. No correction published.
- **Medium, "25 Things Anthropic Never Told You About Claude Code"** (author `devlogs`) reproduces the
  same passage.
- **Search-engine answer panels** now synthesize the claim directly from those pages, so a query for
  "claude code x402" returns it as settled fact with no mention of the correction.
- **Prabal Gupta's post** was replaced in place with the correction, so its inbound links now serve
  the retraction. He also reports readers telling him their copies of the leak differ from each other.

Coverage that analyzed the leak without ever mentioning x402: VentureBeat, Zscaler, Straiker, SoCRadar,
Engineer's Codex, layer5, alternativeto, TechRadar, Sunil Khadka's writeup (which names three mirrors,
including nirholas, and documents KAIROS, AutoDream, and BUDDY but no payments code).

## 4. Statements on the record from @nichxbt

Relevant because they are quoted or quotable by anyone writing this up:

- 2026-03-31 17:54, replying to the accusation: "Secretly added payment code, huh? ... In all
  seriousness though, it's x402 which enables micropayments to APIs from agents. And it's not secret."
- 2026-03-31 13:16: "It was pushed to the public domain by the team ... I am following the guidance of
  Claude since Claude knows Anthropic best."
- 2026-04-01 05:52: "word is someone injected x402 payments. lemme know if you can find that version."
- 2026-04-16 17:15: "My repo (nirholas/claude-code) was the original target in the massive Claude Code
  DMCA that took down 8,100 repositories. Even after their partial retraction, they kept mine locked."

The 17:54 post on 03-31 and the 05:52 post on 04-01 point in different directions. Anyone doing
adversarial research will find both, and will find the commit history in a surviving fork within about
ten minutes.

## 5. What is still open

- **Nothing in the public DMCA record retracts the notice against `nirholas/claude-code` itself.** The
  2026-04-01 filing retracts only the network-wide overreach; the parent repo and the 96 named forks
  stay covered. No counter-notice appears in `github/dmca`.
- **The commit history is preserved in at least one public fork** (`ccsols/claude-code-nirholas`,
  created 2026-03-31T16:07:53Z, itself a fork of `RishabhK103/claude-code`). It carries the full
  ~2,100-commit import plus the three x402 commits with author name and timestamps.
- **Prabal's report of divergent copies is unverified.** Only one variant (the x402 one) is documented
  with artifacts. Whether other injected variants exist is an open claim.
- **The 6,254 stars on `fresh-start` are real inbound attention** on a two-file repo whose README
  promises the original content will return. Anything published there inherits that audience.

## 5.5 Second sweep: further findings

**The repo was renamed, not deleted.** `github.com/nirholas/claude-code` 301s to
`github.com/nirholas/fresh-start`. It is the same repository object, created 2026-03-31, carrying the
original 6,254 stars and 91 watchers. Every inbound link in every article that cited the original URL
lands on `fresh-start` today. That makes it the canonical destination for the whole story, not a
side page.

**A real malware campaign ran in parallel, and it was not this account.** Between 2026-04-01 and
04-03, The Register, Help Net Security, TechRadar and Zscaler ThreatLabz covered trojanized "Claude
Code leak" repositories delivering Vidar v18.7 and GhostSocks via a Rust dropper named
`ClaudeCode_x64.exe` inside a `.7z` archive. Zscaler's indicators of compromise name exactly three
things: `github.com/leaked-claude-code/leaked-claude-code`, `github.com/my3jie/leaked-claude-code`,
and the publisher account `idbzoomh1`. One of those repos reached 793 forks and 564 stars.
**`nirholas` appears in none of the malware reporting**, not in Zscaler's IOCs, not in The Register,
not in Help Net Security. This is worth stating explicitly because "treat any copy from nirholas as
compromised" was published into the same news cycle as a genuine compromise story about entirely
different accounts, and the two are easy to conflate.

**The x402 code outlived the takedown and seeded a small ecosystem.** GitHub code search for the
distinctive identifiers returns 260 to 323 indexed files across public repos still carrying
`src/services/x402/paymentFetch.ts` and friends at the original paths: `codeaashu/claude-code`,
`StanHus/claude-code-src`, `qDeizer/CloudeCodeSourcecode`, `Silin144/claude-code`,
`Git-Leon/claude-code-bootstrap`, `Tashima-Tarsh/Disha`, `kushalchalla981-tech/opencode-skills`,
`The-AI-Republic/workx`, `daydreamsai/lucid-agents`, `browser-use/sdk`,
`seren-agent-horizontal/Seren_agent_v1`, plus an org, `x402agent` ("ClawdBot", solanaclawd.com,
83 repos) shipping `solana-clawd`, `Solana-Clawd-SDK` and `openclawd-main` built on it. The x402
integration is now, de facto, an unattributed dependency of a cluster of Solana agent projects.

**Hacker News never discussed the account.** The leak itself drew huge HN threads (2,095 points and
1,376 points). A search of HN for `nirholas` returns nothing on topic. The highest-signal analyses
(alex000kim's post, `nblintao/awesome-claude-code-postleak-insights`) contain zero mentions of x402,
USDC, wallets, or payments. The false Anthropic-payments claim is confined to the HackerNoon piece,
its Medium reprint, and the search panels that synthesize from them.

**The biggest beneficiary was the clean-room rewrite.** `instructkr/claude-code` (created the same
day, now a Rust project) sits at 195,020 stars and 109,227 forks.

**One live loose end.** `claude-code-explorer-mcp` v1.1.0, published 2026-03-31T10:44:39Z, is still on
npm and still listed on Anthropic's official MCP Registry as `io.github.nirholas/claude-code-explorer-mcp`,
described as "Explore the Claude Code CLI source", with its repository field pointing at
`github.com/nirholas/claude-code` (which now 301s to `fresh-start`). The tarball is 28 KB, 17 files,
and contains **no** Anthropic source: it is an MCP server that reads a local checkout. So there is no
infringing content in the package, but the listing on Anthropic's own registry still advertises
exploring the leaked source and links to the repository named in an unretracted DMCA notice.

## 5.6 The second accusation: jennyqueenofswords.github.io/x402-forensics

A detailed forensic writeup, "The x402 That Wasn't There", authored in first person by a Claude Opus
4.6 instance ("dot") running in the repo owner's terminal. Unlike the Prabal Gupta piece, this is not
a retraction: it is a primary accusation with reproducible receipts, and it names @nichxbt directly.

**Provenance and reach.** Repo `jennyqueenofswords/x402-forensics`, owner "Jenny Nicholson" (account
2023, 4 followers, 30 repos). Created 2026-04-01, five commits all on that same day, nothing since.
**0 stars, 0 forks, 0 watchers.** It did not surface in any of the two dozen search queries run for
this research. As a piece of public pressure it is currently inert; as a piece of analysis it is the
best one written about this incident.

**What it gets right** (all independently confirmed here): the x402 files are absent from clean
extractions and present only in the nirholas tree; the exact file inventory (6 in `src/services/x402/`,
2 in `src/commands/x402/`); the exact modified files (`api/client.ts`, `WebFetchTool/utils.ts`,
`cost-tracker.ts`, `commands.ts`, plus `docs/subsystems.md` and `docs/commands.md`); the `try/require/catch`
integration pattern; and the directory counts (36 services / 101 commands clean, 37 / 102 in the
nirholas tree). Its "seven signs" are all real properties of the code: no `tengu_` GrowthBook flag,
defensive requires, absent from the 17 `prompts/` build-out docs, no tests, no telemetry, no new npm
dependencies, self-contained.

**Where the reading is contestable.** The seven signs are presented as evidence of covert injection.
Every one of them is equally the signature of someone adding a feature to a fork they imported twenty
minutes earlier: you cannot register a GrowthBook flag you have no access to, you use defensive
requires because the imported tree does not compile cleanly, and you do not wire your own feature into
someone else's BigQuery telemetry exporter. The technical observations are correct; the inference
about intent is the part that does not follow from them.

**Where it overreaches.** Three places worth naming:

1. It juxtaposes the x402 addition with the unrelated malicious-axios npm attack that ran the same
   day and says "whether the x402 injection and the axios attack are related is unknown." No evidence
   links them. Raising an unsupported link and then labelling it unknown is innuendo, and it is the
   most prejudicial sentence in the piece.
2. It cites ClawRouter (`BlockRunAI/ClawRouter`, 6,608 stars, "USDC payments on Base and Solana via
   x402") as a product whose premise is "load-bearing" on the false narrative. It is not. x402 is a
   real open Coinbase protocol; a router adopting it does not depend on Anthropic having shipped it.
3. Its own "How to verify" test has already decayed. `paoloanzn/free-code`, which the piece itself
   cites as a clean reference fork, today has 37 services and 102 commands, because it is maintained
   and has added its own directories. Anyone applying the count test to it now gets a false positive.
   The only durable test is `grep -r x402 src/`, which returns 0 there.

**Collateral finding: the clean mirrors it relies on have mostly evaporated.** `chauncygu/claude-code`
is 404. `sanbuphy/claude-code-source-code` was renamed to `sanbuphy/learn-coding-agent` and now holds
only READMEs and a `docs/` directory, no source. `paoloanzn/free-code` (8,674 stars, maintained through
July 2026) is the one live clean reference left. The archived `src.zip` is therefore the only stable
ground truth, which is what this document uses.

**The quoted contemporaneous accusation** is @SHAnonymousUser replying to the original mirror post:
"Don't download his code. He secretly added payment code" (1,721 views, 25 likes). That is the reply
being answered at 17:54 UTC on 31 March with "it's x402 ... and it's not secret."

## 6. Reproducing this

```bash
# 1. The archived original, filenames only
curl -sL "https://web.archive.org/web/20260331090815id_/https://pub-aea8527898604c1bbb12468b1581d95e.r2.dev/src.zip" -o orig-src.zip
unzip -Z1 orig-src.zip | grep -icE "x402|wallet|payment|signer"   # -> 0

# 2. The mirror's x402 provenance
gh api "repos/ccsols/claude-code-nirholas/commits?path=src/commands/x402" \
  --jq '.[] | "\(.commit.author.date) \(.commit.author.name) \(.sha[0:8])"'

# 3. The shipped bundles
npm pack @anthropic-ai/claude-code@2.1.89 && tar xzf claude-code-2.1.89.tgz -O | grep -c x402   # -> 0

# 4. The filings
gh api repos/github/dmca/contents/2026/03/2026-03-31-anthropic.md --jq .content | base64 -d
gh api repos/github/dmca/contents/2026/04/2026-04-01-anthropic-retraction.md --jq .content | base64 -d
```

## Sources

- [github/dmca 2026-03-31 Anthropic notice](https://github.com/github/dmca/blob/master/2026/03/2026-03-31-anthropic.md)
- [github/dmca 2026-04-01 Anthropic partial retraction](https://github.com/github/dmca/blob/master/2026/04/2026-04-01-anthropic-retraction.md)
- [github/dmca 2025-03-10 Anthropic notice (dnakov/claude-code)](https://github.com/github/dmca/blob/master/2025/03/2025-03-10-anthropic.md)
- [github/dmca 2025-04-28 Anthropic notice (dnakov/anon-kode)](https://github.com/github/dmca/blob/master/2025/04/2025-04-28-anthropic.md)
- [nirholas/fresh-start](https://github.com/nirholas/fresh-start)
- [Business Insider: A 4 a.m. scramble turned Anthropic's leak into a 'workflow revelation'](https://www.businessinsider.com/claude-code-leak-what-happened-recreated-python-features-revealed-2026-4)
- [The IPKat: The Claude Code leak that spurred 8,100 DMCA takedown notices](https://ipkitten.blogspot.com/2026/04/the-claude-code-leak-that-spurred-8100.html)
- [WinBuzzer: Anthropic DMCA blunder took down 8,100 GitHub repos](https://winbuzzer.com/2026/04/02/anthropic-dmca-blunder-took-down-8100-github-repos-xcxwbn/)
- [VentureBeat: 5 actions enterprise security leaders should take now](https://venturebeat.com/security/claude-code-512000-line-source-leak-attack-paths-audit-security-leaders)
- [Zscaler: Claude Code leak security analysis](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak)
- [Straiker: With great agency comes great responsibility](https://www.straiker.ai/blog/claude-code-source-leak-with-great-agency-comes-great-responsibility)
- [Sunil Khadka: How a debugging file accidentally open-sourced Anthropic's crown jewel](https://www.sunil001.com.np/blog/how-a-debugging-file-accidentally-open-sourced-anthropics-crown-jewel)
- [HackerNoon: 25 things the Claude Code leak reveals](https://hackernoon.com/25-things-the-claude-code-leak-reveals-about-anthropics-ai-agents) (repeats the x402 claim, uncorrected)
- [Medium: 25 things Anthropic never told you about Claude Code](https://medium.com/@thecuriousdev01/25-things-anthropic-never-told-you-about-claude-code-discovered-inside-a-briefly-leaked-source-c42cd017cb8d) (same claim)
