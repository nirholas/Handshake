# @three-ws/fleet-console

Live health console for an open-source fleet.

A prolific GitHub account accumulates repositories faster than anyone can keep
them honest. READMEs promise demos at URLs that stopped resolving months ago,
badges point at npm packages that were never published, and nobody notices
because nobody re-reads a repository they finished.

Fleet Console re-reads them, continuously. It enumerates every repository an
owner has, extracts the URLs and package names each one *claims*, probes those
claims against the live internet, and scores the result. The output answers one
question: **which of my repositories is currently lying to a visitor?**

It runs three ways: an HTTP dashboard, a CLI you can put in a cron job, and an
MCP server so an agent can be told to go fix the worst of it.

---

## Quick start

```bash
cd services/fleet-console

# One scan, printed. No server, no token needed for a small fleet.
node src/cli.js scan

# Only what is broken. Exits 1 if anything is, so cron and CI can gate on it.
node src/cli.js scan --attention
```

Unauthenticated GitHub allows 60 requests/hour, enough for a handful of
repositories. Export a token to scan a real fleet:

```bash
export GITHUB_TOKEN=ghp_...      # any read-only token; public repo metadata only
node src/cli.js scan --json > snapshot.json
```

Then the dashboard:

```bash
npm start --prefix services/fleet-console      # http://localhost:8080
```

---

## What it measures

Each repository is graded on eight weighted checks. The weights are deliberate:
a broken deployment is worth more than a missing description, because a dead
link costs a visitor their trust and a missing description costs them a second.

| Check | Weight | Passes when |
| --- | ---: | --- |
| Claimed deployments respond | 20 | Every URL the repo presents as live actually answers |
| Advertised packages exist on npm | 15 | Every package name the repo advertises resolves on the registry |
| README links resolve | 12 | External links in the README are not dead |
| Has a real README | 8 | Present, and more than a title |
| Ships documentation beyond the README | 8 | A `docs/` directory, a site, or equivalent |
| Declares a license | 6 | A license file or SPDX declaration |
| Has a description | 4 | The GitHub description field is set |
| Recent activity | varies | Pushed within a recency window |

Every check returns `pass`, `warn`, `fail`, or `skip`. A `skip` is dropped from
both the numerator and the denominator, so a repository is never punished for a
check that does not apply to it. The score is the weighted percentage earned,
and the grade follows from it:

| Score | Grade | |
| --- | --- | --- |
| 90+ | A | Healthy |
| 75+ | B | Solid |
| 60+ | C | Needs work |
| 40+ | D | Degraded |
| below 40 | F | Broken |

Every check carries its **evidence** (the URL probed, the status returned) and a
**fix** string, so the console tells you what to do rather than only that
something is wrong.

---

## HTTP surface

```
GET  /                    dashboard, or the scanning state before the first snapshot
GET  /r/:repo             one repository, every measurement behind its score
GET  /docs                how the score is computed, and how to embed a badge
GET  /api/fleet           the whole snapshot
GET  /api/repo/:repo      one repository
GET  /api/status          scan progress, safe to poll
GET  /api/attention       only what is broken, ranked, for automation
POST /api/scan            trigger a scan (requires FLEET_SCAN_TOKEN)
GET  /badge/fleet.svg     fleet median badge
```

`/api/attention` is the one to automate against: it returns only failing checks,
worst first, already carrying the fix strings.

---

## As an MCP server

The dashboard answers "what is broken?" for a person. The MCP server answers it
for an agent, which is the more useful half: an agent that can read the fleet's
measured state can be sent to fix the worst of it without anyone first pasting a
list of URLs into a prompt.

```json
{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["services/fleet-console/src/mcp.js"],
      "env": { "FLEET_CONSOLE_URL": "http://localhost:8080" }
    }
  }
}
```

It reads the same snapshot the HTTP service writes, either from a running
console (`FLEET_CONSOLE_URL`) or straight from disk (`FLEET_DATA_DIR`), so it
never duplicates the scanning logic.

---

## Configuration

Every option is an environment variable with a working default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEET_OWNER` | `nirholas` | GitHub user or organisation to scan |
| `GITHUB_TOKEN` | none | Read-only token. Without one, GitHub allows 60 requests/hour |
| `FLEET_DATA_DIR` | `/tmp/fleet-console` | Where snapshots are written. Ephemeral on Cloud Run unless a volume is mounted |
| `PORT` | `8080` | HTTP port |
| `FLEET_MAX_REPOS` | `400` | Repositories per scan, highest star count first |
| `FLEET_INCLUDE_FORKS` | `false` | Forks are someone else's code and score meaninglessly |
| `FLEET_INCLUDE_ARCHIVED` | `false` | Archived repositories are deliberately frozen |
| `FLEET_GITHUB_CONCURRENCY` | `6` | Concurrent GitHub requests, kept low to avoid secondary rate limits |
| `FLEET_PROBE_CONCURRENCY` | `12` | Concurrent outbound probes against third-party hosts |
| `FLEET_PROBE_TIMEOUT_MS` | `10000` | Per-probe timeout |
| `FLEET_MAX_LINKS_PER_REPO` | `12` | READMEs occasionally carry hundreds of links |
| `FLEET_SCAN_TOKEN` | none | Required as a bearer token to `POST /api/scan` |

---

## Layout

| File | Role |
| --- | --- |
| `src/scan.js` | The engine: orchestrates a full fleet scan |
| `src/github.js` | GitHub API client (repository list, README, metadata) |
| `src/extract-urls.js` | Pulls claimed URLs and package names out of a README |
| `src/probe.js` | Probes a URL and classifies the response |
| `src/registry.js` | Checks an advertised package actually exists on npm |
| `src/score.js` | The weighted checks, the grade ladder |
| `src/store.js` | Snapshot persistence |
| `src/pool.js` | Bounded concurrency |
| `src/badge.js` | SVG badge rendering |
| `src/server.js` | HTTP server and routes |
| `src/cli.js` | Terminal entry point |
| `src/mcp.js` | MCP server over stdio |
| `src/views/` | Server-rendered dashboard, repo page, docs page |

---

## Related

- [STRUCTURE.md](../../STRUCTURE.md) maps every surface in this repository
- [docs/mcp.md](../../docs/mcp.md) covers the wider three.ws MCP surface
