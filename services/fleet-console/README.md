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

Each repository is graded on ten weighted checks. The weights are deliberate:
a broken deployment is worth more than a missing description, because a dead
link costs a visitor their trust and a missing description costs them a second.

| Check | Weight | Passes when |
| --- | ---: | --- |
| Claimed deployments respond | 20 | Every URL the repo presents as live actually answers |
| Advertised packages exist on npm | 15 | Every package name the repo advertises resolves on the registry |
| README links resolve | 12 | External links in the README are not dead |
| Has a real README | 8 | Present, and at least 600 bytes (under that is a stub, which warns) |
| Ships documentation beyond the README | 8 | A `docs/`, `doc/`, `documentation/`, `website/` or `site/` directory |
| Recently touched | 8 | Pushed within 120 days (within 400 days warns) |
| Declares a license | 6 | GitHub can classify it, so `NOASSERTION` does not count |
| npm matches the committed version | 6 | The registry `latest` tag equals the manifest version |
| Has a description | 4 | The GitHub description field is set |
| Discoverable by topic | 3 | Three or more topics are set (one or two warns) |

`/docs` on the running console renders this same table from the code, so it can
never drift from what the scorer does.

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
GET  /                          dashboard, or the scanning state before the first snapshot
GET  /r/:repo                   one repository, every measurement behind its score
GET  /docs                      how the score is computed, and how to embed a badge
GET  /healthz                   liveness, plus whether a snapshot exists yet
GET  /api/fleet                 the snapshot, slimmed; add ?full=1 for every measurement
GET  /api/repo/:repo            one repository, with its score history
GET  /api/status                scan progress, safe to poll
GET  /api/attention             only what is broken, ranked, for automation
POST /api/scan                  trigger a scan (requires FLEET_SCAN_TOKEN)
GET  /badge/fleet.svg           fleet median badge
GET  /badge/:repo.svg           one repository's health badge
GET  /badge/:repo/deployment.svg  how many of that repository's claimed URLs respond
```

`/api/attention` is the one to automate against: it returns only failing checks,
worst first, already carrying the fix strings.

Before the first scan finishes, `/api/fleet` and `/api/attention` answer `503`
with the current progress rather than an empty fleet, because an empty fleet
reads as "everything is fine" instead of "there is nothing to read yet".

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
| `GITHUB_TOKEN` | none | Read-only token, or `GH_TOKEN`. Without one, GitHub allows 60 requests/hour |
| `FLEET_DATA_DIR` | `/tmp/fleet-console` | Where snapshots are written. Ephemeral unless the path is a mounted volume |
| `PORT` | `8080` | HTTP port |
| `FLEET_MAX_REPOS` | `400` | Repositories per scan, highest star count first |
| `FLEET_INCLUDE_FORKS` | `false` | Forks are someone else's code and score meaninglessly |
| `FLEET_INCLUDE_ARCHIVED` | `false` | Archived repositories are deliberately frozen |
| `FLEET_GITHUB_CONCURRENCY` | `6` | Concurrent GitHub requests, kept low to avoid secondary rate limits |
| `FLEET_PROBE_CONCURRENCY` | `12` | Concurrent outbound probes against third-party hosts |
| `FLEET_PROBE_TIMEOUT_MS` | `10000` | Per-probe timeout |
| `FLEET_MAX_LINKS_PER_REPO` | `12` | READMEs occasionally carry hundreds of links |
| `FLEET_SCAN_INTERVAL_MS` | `21600000` (6h) | Automatic rescan cadence. `0` disables it and leaves scans to `POST /api/scan` |
| `FLEET_SCAN_ON_BOOT` | `true` | Scan as soon as the server starts, when no snapshot was restored from disk |
| `FLEET_HISTORY_LIMIT` | `60` | Past snapshots retained for the trend lines |
| `FLEET_SCAN_TOKEN` | none | Required as a bearer token to `POST /api/scan`. Unset means the endpoint answers `403` |

A scan that covers less than the whole fleet is flagged `partial`, and
`partialReason` says which of the two causes applied: `repo_cap` (the scan hit
`FLEET_MAX_REPOS`) or `rate_limit` (the GitHub request budget ran out). They
look identical in the data and need opposite fixes, so the dashboard and the
CLI always name the one that actually happened.

---

## Layout

| File | Role |
| --- | --- |
| `src/config.js` | Every tunable, read from the environment at import time |
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

## Where it runs

Nothing about this service is deployed. It has no `Dockerfile` and no Cloud Run
service, by design: it reads public GitHub and npm data and writes a JSON file,
so the useful shapes are a terminal, a cron job, and an MCP server next to an
agent. A snapshot survives a restart because `FLEET_DATA_DIR` is written
atomically, and `FLEET_SCAN_INTERVAL_MS` keeps a long-lived process current.

The gate that matters for cron use is `scan --attention`, which exits `1` when
anything in the fleet is measurably broken:

```bash
GITHUB_TOKEN=ghp_... node services/fleet-console/src/cli.js scan --attention
```

---

## Tests

```bash
npx vitest run tests/fleet-console.test.js tests/fleet-console-server.test.js
```

[tests/fleet-console.test.js](../../tests/fleet-console.test.js) covers the pure
engine (URL extraction, probe classification, the scoring model, registry
parsing, badges, the attention ranking).
[tests/fleet-console-server.test.js](../../tests/fleet-console-server.test.js)
is the core-path smoke test: it boots the real HTTP handler on a real socket
over a real on-disk snapshot and walks every route, in both the
before-first-scan and the populated state.

---

## Related

- [STRUCTURE.md](../../STRUCTURE.md) maps every surface in this repository
- [services/README.md](../README.md) covers the other long-running services
- [docs/mcp.md](../../docs/mcp.md) covers the wider three.ws MCP surface
