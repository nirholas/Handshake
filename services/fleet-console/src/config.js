/**
 * Runtime configuration for the fleet console.
 *
 * Every value is read from the environment so the service is owner-agnostic:
 * point FLEET_OWNER at any GitHub user or organisation and the console
 * discovers that fleet at runtime. Nothing about a specific fleet is compiled
 * into this service.
 */

const int = (raw, fallback) => {
	const n = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (raw, fallback) => {
	if (raw === undefined || raw === '') return fallback;
	return raw === '1' || raw.toLowerCase() === 'true';
};

export const config = {
	/** GitHub user or organisation whose repositories make up the fleet. */
	owner: process.env.FLEET_OWNER || 'nirholas',
	/** Optional token. Without one GitHub allows 60 requests/hour, which limits a scan to a handful of repositories. */
	githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
	/** Where snapshots are written. Ephemeral on Cloud Run unless a volume is mounted. */
	dataDir: process.env.FLEET_DATA_DIR || '/tmp/fleet-console',
	port: int(process.env.PORT, 8080),

	/** Repositories per scan, highest star count first. */
	maxRepos: int(process.env.FLEET_MAX_REPOS, 400),
	/** Skip forks, which are somebody else's code and score meaninglessly. */
	includeForks: bool(process.env.FLEET_INCLUDE_FORKS, false),
	/** Skip archived repositories, which are deliberately frozen. */
	includeArchived: bool(process.env.FLEET_INCLUDE_ARCHIVED, false),

	/** Concurrent GitHub requests. GitHub tolerates far more, but this keeps secondary rate limits away. */
	githubConcurrency: int(process.env.FLEET_GITHUB_CONCURRENCY, 6),
	/** Concurrent outbound HTTP probes against third-party hosts. */
	probeConcurrency: int(process.env.FLEET_PROBE_CONCURRENCY, 12),
	probeTimeoutMs: int(process.env.FLEET_PROBE_TIMEOUT_MS, 10000),
	/** External links checked per repository. READMEs occasionally carry hundreds. */
	maxLinksPerRepo: int(process.env.FLEET_MAX_LINKS_PER_REPO, 12),

	/** Automatic rescan cadence. Set to 0 to disable and drive scans over the API. */
	scanIntervalMs: int(process.env.FLEET_SCAN_INTERVAL_MS, 6 * 60 * 60 * 1000),
	/** Run a scan as soon as the process boots. */
	scanOnBoot: bool(process.env.FLEET_SCAN_ON_BOOT, true),
	/** Shared secret required by POST /api/scan. Empty means the endpoint is disabled. */
	scanToken: process.env.FLEET_SCAN_TOKEN || '',
	/** Snapshots retained for trend lines. */
	historyLimit: int(process.env.FLEET_HISTORY_LIMIT, 60),

	userAgent: 'fleet-console (+https://github.com/nirholas/three.ws)'
};

export default config;
