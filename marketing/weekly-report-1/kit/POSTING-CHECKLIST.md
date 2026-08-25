# Weekly Report #1: posting checklist

Everything in this folder is what you need. Rebuild it anytime with `node scripts/build-weekly-report-kit.mjs 1`.

## 1. The X Article

1. Open weekly-report-1.html in a browser. Select all, copy, paste into the X Article editor. Headings, bold, and lists carry over.
2. Title: `three.ws Weekly Report #1: Everything We Have Shipped So Far`
3. Cover image: cover-x-article.png (2400x1200).
4. Replace each grey `[ insert image NN: name ]` placeholder with the matching file from images/ (numbered 01 to 29, see IMAGE-ORDER.md). Delete the placeholder line after inserting.
5. Suggested captions are in ../README.md; keep them short or skip them.
6. Publish, copy the article URL.

## 2. The announcing post (@trythreews)

Attach announce-post-16x9.png, then paste the article URL at the end.

Long form (325 characters, needs Premium):

```
Weekly Report #1 is out, and because it is the first one it covers everything: 19 weeks, week by week, from the first commit to today.

9,508 commits. 21 contributors. 2,674 changelog entries. 725 pages. 101 npm packages. 72 MCP servers. 4,519 x402 endpoints. 110,416 on-chain settlements.

One token: $THREE.

Read it here:
```

Under 280 characters, if needed:

```
Weekly Report #1 is out. The first one covers all 19 weeks since the first commit.

9,508 commits. 2,674 changelog entries. 725 pages. 101 npm packages. 72 MCP servers. 4,519 x402 endpoints. 110,416 on-chain settlements.

One token: $THREE. Read it here:
```

Replies 1 to 3 are in ../../../docs/x-posts/weekly-report-1.md; post them under the main post in order.

## 3. Telegram (@three_ws)

Attach cover-x-article.png, then the article URL:

```
Weekly Report #1 is out. The first one covers all 19 weeks since the first commit: 9,508 commits, 2,674 changelog entries, 725 pages, 101 npm packages, 72 MCP servers, 4,519 x402 endpoints, every partnership, and where $THREE sits in all of it. Read it here:
```

## 4. The 100-stars post

Separate post, can go the same day or the day after. Copy and images: ../../../docs/x-posts/github-100-stars.md (images 28 and 29 in this kit are the same graphics).

## 5. Before you post

- `git push threews main` first, so /docs/weekly-report-1 and /docs/three-thesis resolve on the site (the article links to both).
- The live $THREE figures in the article (16,264 holders, about $2.3M cap, about $538K volume) were read on 2026-08-25. If you post on a later day, update that one bullet from three.ws/three-token.
- Nothing in the article names another crypto project; safe under the commit gate as-is.
