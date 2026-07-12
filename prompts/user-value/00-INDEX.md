# User-value prompt pack — execution index

Closes the gap identified 2026-07-12: three.ws has deep generation tech but little that makes a
user *return*. Every agent reads `_shared.md` first, then its prompt. Run order matters — later
waves consume earlier waves' output. Within a wave, prompts are independent and can run
concurrently.

> DO NOT DELETE PROMPT FILES — even after their work ships. Only the owner removes prompts.

## Wave 1 — foundation (run first, alone)
| Prompt | Feature | Touches |
|---|---|---|
| [01-creator-profile.md](01-creator-profile.md) | Human creator profile/portfolio | `pages/profile.html`, `pages/handle.html`, new `api/creations.js` |

## Wave 2 — activity layer (after wave 1; all concurrent)
| Prompt | Feature | Touches |
|---|---|---|
| [02-activity-feed.md](02-activity-feed.md) | Real activity feed | `pages/feed.html`, `pages/community.html`, `api/remix-feed.js` |
| [03-social-graph.md](03-social-graph.md) | Site-wide follow graph | `src/friends.js`, `src/social/`, new follow API |
| [04-notifications.md](04-notifications.md) | Notification center | new `pages/notifications.html`, new notify API |

## Wave 3 — surfacing (after wave 2; all concurrent)
| Prompt | Feature | Touches |
|---|---|---|
| [05-discovery-search.md](05-discovery-search.md) | Cross-entity discovery/search | new `pages/discover.html` or extend existing gallery/marketplace pages |
| [06-cross-surface-leaderboard.md](06-cross-surface-leaderboard.md) | Cross-surface leaderboard + streaks | `pages/leaderboard.html`, `pages/walk-leaderboard.html` |

## Wave 4 — synthesis (last, alone)
| Prompt | Feature | Touches |
|---|---|---|
| [07-onboarding-journey.md](07-onboarding-journey.md) | Guided onboarding chaining all silos | `tour-sdk/` applied to three.ws itself, `/start`, `/create*` |

## Non-negotiables recap
- Read `_shared.md` before starting. Ground truth there overrides assumptions.
- No mocks, no fake data, no placeholder copy — real data, designed empty states.
- Every new page → `data/pages.json`. Every user-visible feature → `data/changelog.json`.
- Concurrent agents share this worktree — stage explicit paths, never `git add -A`.
- Done = built + linked into real navigation + tested + verified in a browser + reported.
