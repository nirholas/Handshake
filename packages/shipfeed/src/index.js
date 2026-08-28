// @three-ws/shipfeed
//
// A repository's commit log and its changelog describe the same work twice and
// never point at each other. This package joins them: it parses commits, scores
// who each one is for, and works out which commits produced which release note,
// so one feed can carry both the human sentence and the code behind it.
//
// Zero dependencies, pure functions, and one network module you can replace.
// See README.md for the full reference.

export {
	parseCommit,
	parseCommitMessage,
	parseTrailers,
	splitMessage,
	headline,
	summaryLine,
	KNOWN_TYPES,
	TYPE_LABELS,
} from './parse.js';

export { classify, filterByAudience, AUDIENCE_RANK } from './classify.js';

export { linkCommits, tokenize, buildIdf, entryKey, entrySlug } from './link.js';

export { groupIntoShips } from './group.js';

export { buildShipFeed, FEED_VERSION } from './feed.js';

export {
	renderCommitTelegram,
	renderReleaseTelegram,
	renderMarkdown,
	renderRss,
	renderTerminal,
} from './render.js';

export {
	fetchGitHubCommits,
	fetchChangelog,
	commitsFromGitLog,
	normalizeChangelog,
	GIT_LOG_FORMAT,
} from './sources.js';

import { fetchGitHubCommits, fetchChangelog, normalizeChangelog } from './sources.js';
import { buildShipFeed } from './feed.js';

/**
 * The one-call path: read a repo (and optionally its changelog), return the
 * unified feed.
 *
 * ```js
 * const feed = await shipfeed({ repo: 'nirholas/three.ws', changelogUrl: 'https://three.ws/changelog.json' });
 * console.log(feed.releases[0].commits.map((c) => c.shortSha));
 * ```
 *
 * @param {{
 *   repo: string, branch?: string, limit?: number, token?: string,
 *   changelogUrl?: string, changelog?: object, siteUrl?: string,
 *   minAudience?: 'holder'|'developer'|'internal',
 *   productScopes?: string[], fetchImpl?: typeof fetch, signal?: AbortSignal, now?: number
 * }} options
 */
export async function shipfeed(options) {
	const { repo, branch, limit, token, changelogUrl, changelog, fetchImpl, signal } = options;
	const [commits, entries] = await Promise.all([
		fetchGitHubCommits({ repo, branch, limit, token, fetchImpl, signal }),
		changelog
			? Promise.resolve(normalizeChangelog(changelog))
			: changelogUrl
				? fetchChangelog(changelogUrl, { fetchImpl, signal })
				: Promise.resolve([]),
	]);
	return buildShipFeed({
		commits,
		entries,
		repo,
		siteUrl: options.siteUrl,
		now: options.now,
		minAudience: options.minAudience,
		classify: { productScopes: options.productScopes },
	});
}
