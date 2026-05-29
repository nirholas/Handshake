# WOW Sprint — 20 parallel task prompts for three.ws

Goal: ship a wave of fixes + features that make $three holders proud again. Each
file in this folder is a **complete, self-contained prompt**. Open a fresh Claude
Code session at repo root, paste the contents of one file, and let it run. Twenty
files → twenty parallel chats.

CLAUDE.md auto-loads in every session, so each prompt assumes those rules
(no mocks, no stubs, real APIs, every state designed, push to both remotes).

## The 20 tasks

**Audit & quality (do these first — diagnosis feeds the rest)**
1. `01-bug-and-lazy-code-audit.md` — prioritized report of bugs + lazy code (no fixes)
2. `02-mock-and-stub-eradication.md` — enforce the no-mocks/no-stubs hard rules
3. `03-dead-path-and-broken-link-audit.md` — every button works, every link resolves
4. `04-console-errors-cleanup.md` — zero console errors/warnings across key pages
5. `05-performance-pass.md` — bundle split, lazy 3D, no jank
6. `06-accessibility-pass.md` — semantic HTML, keyboard nav, focus, contrast

**Design & polish**
7. `07-home-page-overhaul.md` — fix the broken `home.html`, ship a signature hero
8. `08-design-system-tokens.md` — consolidate CSS variables into one design system
9. `09-empty-loading-error-states.md` — design every state on key pages
10. `10-mobile-responsive-pass.md` — flawless at 320 / 768 / 1440
11. `11-microinteractions-motion.md` — hover/active/focus + intentional transitions

**$three holder "wow" features**
12. `12-reactive-3d-hero.md` — landing hero that reacts to live $three data
13. `13-onchain-activity-visualization.md` — real-time 3D scene of $three trades
14. `14-holder-dashboard.md` — real Solana/Helius holder dashboard
15. `15-holder-leaderboard-and-badges.md` — leaderboard + gated 3D badge/PFP
16. `16-token-page-upgrade.md` — real bonding curve + live trades on the coin page
17. `17-holder-rewards-surface.md` — real onchain rewards/staking surface

**Growth & integration**
18. `18-marketplace-crosslinking.md` — wire marketplace ↔ agent profiles + sorting
19. `19-shareable-og-cards.md` — screenshot-worthy share/OG image generation
20. `20-analytics-instrumentation.md` — real event tracking + conversion funnel

## Running them in parallel — avoid collisions

Some tasks touch the same files. Run conflicting ones **sequentially**, or assign
them to the same chat. Known overlaps:

- `home.html` / `src/home-v4-hero.js`: tasks **04, 07, 12** → run 07 first, then 12, then 04.
- Token data (`api/three-token`, `api/pump`, `src/pump`): tasks **13, 14, 16, 17** share data plumbing → have 14 build the shared data hook first.
- Global CSS tokens: task **08** should land before **09, 10, 11** so they consume the tokens.

Safe to run fully in parallel anytime: **01, 02, 03, 05, 06, 18, 19, 20**.

## After each task

Each prompt ends by asking the agent to run the **completionist** audit and to
report what it changed. Review the diff, then push to BOTH remotes (`threeD`,
`threews`) per CLAUDE.md — only when you approve.
