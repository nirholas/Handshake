/**
 * The scan orchestrator.
 *
 * One pass: enumerate the fleet, gather each repository's own claims, probe
 * those claims against the live internet, verify its packages against the npm
 * registry, and score the result. Progress is observable while it runs, because
 * a full fleet scan takes minutes and a spinner with no numbers is not a
 * loading state.
 */

import { config } from './config.js';
import { mapPool } from './pool.js';
import { listRepos, fetchReadme, fetchPackageJson, fetchPagesUrl, fetchRootEntries, rateLimit } from './github.js';
import { extractReadmeLinks, deploymentCandidates } from './extract-urls.js';
import { probeUrl } from './probe.js';
import { verifyPackages } from './registry.js';
import { scoreRepo, summarise } from './score.js';

/** Live progress for the dashboard's scanning state. */
export const progress = {
	running: false,
	startedAt: null,
	finishedAt: null,
	total: 0,
	done: 0,
	current: '',
	phase: 'idle',
	error: '',
	lastDurationMs: 0
};

const DOC_DIRS = new Set(['docs', 'doc', 'documentation', 'website', 'site']);

async function gatherRepo(repo) {
	const [readme, manifest, entries, pagesUrl] = await Promise.all([
		fetchReadme(repo.fullName),
		fetchPackageJson(repo.fullName, repo.defaultBranch),
		fetchRootEntries(repo.fullName, repo.defaultBranch),
		repo.hasPages ? fetchPagesUrl(repo.fullName) : Promise.resolve('')
	]);

	const links = extractReadmeLinks(readme);
	const candidates = deploymentCandidates({
		repoName: repo.name,
		homepage: repo.homepage,
		pagesUrl,
		manifestHomepage: typeof manifest?.homepage === 'string' ? manifest.homepage : '',
		links
	});

	const candidateUrls = new Set(candidates.map((entry) => entry.url));
	// Check links that are not already covered by a deployment probe.
	const linkTargets = links
		.map((link) => link.url)
		.filter((url) => !candidateUrls.has(url))
		.slice(0, config.maxLinksPerRepo);

	const [deployments, linkResults, packages] = await Promise.all([
		mapPool(candidates, 4, async (candidate) => ({ ...(await probeUrl(candidate.url)), why: candidate.why })),
		mapPool(linkTargets, 4, (url) => probeUrl(url)),
		verifyPackages({ manifest, readme })
	]);

	return {
		...repo,
		pagesUrl,
		readmeBytes: Buffer.byteLength(readme, 'utf8'),
		hasDocsDir: entries.some((entry) => entry.type === 'dir' && DOC_DIRS.has(entry.name.toLowerCase())),
		packageName: manifest?.name || '',
		packageVersion: manifest?.version ? String(manifest.version) : '',
		deployments,
		links: linkResults,
		packages
	};
}

/**
 * Run one full fleet scan.
 * @returns {Promise<object>} the snapshot
 */
export async function runScan({ owner = config.owner, limit = config.maxRepos } = {}) {
	if (progress.running) throw new Error('a scan is already running');

	const startedAt = Date.now();
	Object.assign(progress, {
		running: true,
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: null,
		total: 0,
		done: 0,
		current: '',
		phase: 'enumerating',
		error: ''
	});

	try {
		const all = await listRepos(owner);
		const selected = all.slice(0, limit);
		progress.total = selected.length;
		progress.phase = 'scanning';

		const scanned = await mapPool(selected, config.githubConcurrency, async (repo) => {
			progress.current = repo.name;
			try {
				const gathered = await gatherRepo(repo);
				const { score, grade, checks } = scoreRepo(gathered);
				return { ...gathered, score, grade, checks };
			} catch (error) {
				return { ...repo, score: null, grade: null, checks: [], scanError: String(error?.message || error).slice(0, 200) };
			} finally {
				progress.done += 1;
			}
		});

		const snapshot = {
			owner,
			generatedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAt,
			partial: Boolean(rateLimit.exhausted) || selected.length < all.length,
			totalOwned: all.length,
			authenticated: Boolean(config.githubToken),
			rateLimit: { limit: rateLimit.limit, remaining: rateLimit.remaining, resetAt: rateLimit.resetAt },
			summary: summarise(scanned),
			repos: scanned
		};

		progress.lastDurationMs = snapshot.durationMs;
		progress.phase = 'idle';
		return snapshot;
	} catch (error) {
		progress.error = String(error?.message || error);
		progress.phase = 'failed';
		throw error;
	} finally {
		progress.running = false;
		progress.finishedAt = new Date().toISOString();
		progress.current = '';
	}
}
