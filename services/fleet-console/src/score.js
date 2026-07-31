/**
 * The scoring model.
 *
 * Every check carries a weight and returns one of pass / warn / fail / skip,
 * together with the evidence that produced it. Skipped checks leave the
 * denominator, so a library with nothing deployed is not punished for having
 * nothing deployed, and a repository that publishes no package is not punished
 * for that either. The score answers one question: "of the promises this
 * repository makes, how many does it keep?"
 */

import { isHealthyState } from './probe.js';

export const GRADES = [
	{ min: 90, grade: 'A', tone: 'good', label: 'Healthy' },
	{ min: 75, grade: 'B', tone: 'good', label: 'Solid' },
	{ min: 60, grade: 'C', tone: 'warn', label: 'Needs work' },
	{ min: 40, grade: 'D', tone: 'warn', label: 'Degraded' },
	{ min: 0, grade: 'F', tone: 'bad', label: 'Broken' }
];

export const gradeFor = (score) => GRADES.find((entry) => score >= entry.min) || GRADES[GRADES.length - 1];

const VALUE = { pass: 1, warn: 0.5, fail: 0, skip: null };

const DAY = 24 * 60 * 60 * 1000;

const check = (id, title, weight, status, evidence, fix = '') => ({ id, title, weight, status, evidence, fix });

/**
 * @param {object} repo repository facts gathered by the scanner
 * @returns {{score:number, grade:object, checks:object[]}}
 */
export function scoreRepo(repo) {
	const checks = [];

	checks.push(
		repo.description
			? check('description', 'Has a description', 4, 'pass', repo.description)
			: check('description', 'Has a description', 4, 'fail', 'The repository has no description', 'Set the About description on GitHub.')
	);

	const readmeBytes = repo.readmeBytes || 0;
	checks.push(
		readmeBytes >= 600
			? check('readme', 'Has a real README', 8, 'pass', `${readmeBytes.toLocaleString()} bytes`)
			: readmeBytes > 0
				? check('readme', 'Has a real README', 8, 'warn', `Only ${readmeBytes} bytes, which is a stub`, 'Explain what it does, how to install it, and one runnable example.')
				: check('readme', 'Has a real README', 8, 'fail', 'No README found', 'Add a README.md.')
	);

	checks.push(
		repo.license
			? check('license', 'Declares a license', 6, 'pass', repo.license)
			: check('license', 'Declares a license', 6, 'fail', 'GitHub detects no license', 'Add a LICENSE file GitHub can classify.')
	);

	checks.push(
		repo.hasDocsDir
			? check('docs', 'Ships documentation beyond the README', 8, 'pass', 'A docs/ directory is present')
			: readmeBytes >= 3000
				? check('docs', 'Ships documentation beyond the README', 8, 'warn', 'No docs/ directory, but the README is substantial')
				: check('docs', 'Ships documentation beyond the README', 8, 'fail', 'No docs/ directory and a thin README', 'Add docs/ with a getting-started page and examples.')
	);

	// Deployment. Skipped entirely when the repository never claims to be running.
	const deployments = repo.deployments || [];
	if (deployments.length === 0) {
		checks.push(check('deployment', 'Claimed deployments respond', 20, 'skip', 'This repository does not advertise a deployment'));
	} else {
		const healthy = deployments.filter((entry) => isHealthyState(entry.state));
		const ratio = healthy.length / deployments.length;
		const summary = `${healthy.length}/${deployments.length} responding`;
		const broken = deployments.filter((entry) => !isHealthyState(entry.state));
		const detail = broken.length ? `${summary}. Failing: ${broken.map((entry) => `${entry.url} (${entry.state})`).join(', ')}` : summary;
		checks.push(
			ratio === 1
				? check('deployment', 'Claimed deployments respond', 20, 'pass', detail)
				: ratio > 0
					? check('deployment', 'Claimed deployments respond', 20, 'warn', detail, 'Repoint or remove the URLs that no longer serve.')
					: check('deployment', 'Claimed deployments respond', 20, 'fail', detail, 'Every advertised URL is down. Redeploy or delete the claim.')
		);
	}

	// README link rot.
	const links = repo.links || [];
	if (links.length === 0) {
		checks.push(check('links', 'README links resolve', 12, 'skip', 'No external links to check'));
	} else {
		const dead = links.filter((entry) => !isHealthyState(entry.state) && entry.state !== 'auth_required' && entry.state !== 'rate_limited');
		const detail = dead.length ? `${dead.length}/${links.length} dead: ${dead.slice(0, 4).map((entry) => entry.url).join(', ')}` : `${links.length} checked, all resolve`;
		checks.push(
			dead.length === 0
				? check('links', 'README links resolve', 12, 'pass', detail)
				: dead.length / links.length <= 0.25
					? check('links', 'README links resolve', 12, 'warn', detail, 'Fix or drop the dead links.')
					: check('links', 'README links resolve', 12, 'fail', detail, 'Most external links are dead. The README needs a pass.')
		);
	}

	// Advertised packages actually exist.
	const packages = repo.packages || { checked: [], missing: [] };
	if (!packages.checked.length) {
		checks.push(check('packages', 'Advertised packages exist on npm', 15, 'skip', 'This repository advertises no npm package'));
	} else if (packages.missing.length) {
		checks.push(
			check(
				'packages',
				'Advertised packages exist on npm',
				15,
				'fail',
				`${packages.missing.length} of ${packages.checked.length} were never published: ${packages.missing.join(', ')}`,
				'Publish them or correct the install instructions. Readers currently hit a 404.'
			)
		);
	} else {
		const deprecated = packages.checked.filter((entry) => entry.deprecated);
		checks.push(
			deprecated.length
				? check('packages', 'Advertised packages exist on npm', 15, 'warn', `Published, but deprecated: ${deprecated.map((entry) => entry.name).join(', ')}`)
				: check('packages', 'Advertised packages exist on npm', 15, 'pass', `${packages.checked.length} verified against the registry`)
		);
	}

	// Published version matches the manifest.
	if (packages.ownPackage?.published && repo.packageVersion) {
		const same = packages.ownPackage.latest === repo.packageVersion;
		checks.push(
			same
				? check('release-sync', 'npm matches the committed version', 6, 'pass', `both at ${repo.packageVersion}`)
				: check('release-sync', 'npm matches the committed version', 6, 'warn', `manifest ${repo.packageVersion}, registry ${packages.ownPackage.latest}`, 'Publish the current version or bump the manifest.')
		);
	} else {
		checks.push(check('release-sync', 'npm matches the committed version', 6, 'skip', 'Nothing published to compare against'));
	}

	checks.push(
		repo.topics?.length >= 3
			? check('topics', 'Discoverable by topic', 3, 'pass', repo.topics.slice(0, 8).join(', '))
			: repo.topics?.length
				? check('topics', 'Discoverable by topic', 3, 'warn', `only ${repo.topics.length} topic(s)`)
				: check('topics', 'Discoverable by topic', 3, 'fail', 'No topics set', 'Add topics so the repository is findable.')
	);

	const pushedAt = repo.pushedAt ? Date.parse(repo.pushedAt) : NaN;
	const ageDays = Number.isFinite(pushedAt) ? Math.floor((Date.now() - pushedAt) / DAY) : null;
	checks.push(
		ageDays === null
			? check('activity', 'Recently touched', 8, 'skip', 'No push timestamp')
			: ageDays <= 120
				? check('activity', 'Recently touched', 8, 'pass', `last push ${ageDays} day(s) ago`)
				: ageDays <= 400
					? check('activity', 'Recently touched', 8, 'warn', `last push ${ageDays} day(s) ago`)
					: check('activity', 'Recently touched', 8, 'fail', `last push ${ageDays} day(s) ago`, 'Archive it, or ship the fix it has been waiting for.')
	);

	const graded = checks.filter((entry) => VALUE[entry.status] !== null);
	const total = graded.reduce((sum, entry) => sum + entry.weight, 0);
	const earned = graded.reduce((sum, entry) => sum + entry.weight * VALUE[entry.status], 0);
	const score = total === 0 ? 0 : Math.round((earned / total) * 100);

	return { score, grade: gradeFor(score), checks };
}

/** Fleet-level rollup used by the dashboard header and /api/fleet. */
export function summarise(repos) {
	const scored = repos.filter((repo) => typeof repo.score === 'number');
	const scores = scored.map((repo) => repo.score).sort((a, b) => a - b);
	const median = scores.length ? (scores.length % 2 ? scores[(scores.length - 1) / 2] : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2)) : 0;

	const deployments = repos.flatMap((repo) => repo.deployments || []);
	const links = repos.flatMap((repo) => repo.links || []);
	const missingPackages = repos.flatMap((repo) => (repo.packages?.missing || []).map((name) => ({ repo: repo.name, name })));

	const byGrade = {};
	for (const entry of GRADES) byGrade[entry.grade] = 0;
	for (const repo of scored) byGrade[repo.grade.grade] = (byGrade[repo.grade.grade] || 0) + 1;

	return {
		repos: repos.length,
		stars: repos.reduce((sum, repo) => sum + (repo.stars || 0), 0),
		medianScore: median,
		averageScore: scored.length ? Math.round(scored.reduce((sum, repo) => sum + repo.score, 0) / scored.length) : 0,
		byGrade,
		deployments: {
			total: deployments.length,
			healthy: deployments.filter((entry) => isHealthyState(entry.state)).length,
			byState: deployments.reduce((acc, entry) => ({ ...acc, [entry.state]: (acc[entry.state] || 0) + 1 }), {})
		},
		links: {
			total: links.length,
			dead: links.filter((entry) => !isHealthyState(entry.state) && entry.state !== 'auth_required' && entry.state !== 'rate_limited').length
		},
		missingPackages
	};
}
