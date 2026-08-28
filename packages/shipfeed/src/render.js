// Renderers. One feed, four audiences: a Telegram channel, a README, a reader,
// and a terminal. Each renderer is pure; nothing here talks to a network.

const escapeHtml = (s) =>
	String(s == null ? '' : s).replace(
		/[<>&]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c],
	);

const escapeXml = (s) =>
	String(s == null ? '' : s).replace(
		/[<>&"']/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
	);

/**
 * One commit as a Telegram HTML message: bold headline, plain description, and
 * a provenance line. Matches the format three.ws posts to its holder channel.
 */
export function renderCommitTelegram(commit, { repo = '', linkText = '' } = {}) {
	const url = commit.url || (repo ? `https://github.com/${repo}/commit/${commit.sha}` : '');
	const shown =
		linkText || (repo ? `github.com/${repo}/commit/${commit.shortSha}` : commit.shortSha);
	const date = String(commit.date || '').slice(0, 10);
	return [
		`<b>${escapeHtml(commit.headline)}</b>`,
		'',
		escapeHtml(commit.summary),
		'',
		`${url ? `<a href="${url}">${escapeHtml(shown)}</a> · ` : ''}${escapeHtml(date)} · ${escapeHtml(commit.author)}`,
	].join('\n');
}

/**
 * One release as a Telegram HTML message, with the provenance footer that the
 * raw commit feed can never carry: how much code this note actually covers.
 */
export function renderReleaseTelegram(release, { repo = '', siteUrl = '' } = {}) {
	const lines = [`<b>${escapeHtml(release.title)}</b>`, '', escapeHtml(release.summary)];
	if (release.commits.length) {
		const range = release.stats.range;
		const url =
			repo && range ? `https://github.com/${repo}/compare/${range.replace('..', '...')}` : '';
		const label = `${release.commits.length} commit${release.commits.length === 1 ? '' : 's'}`;
		lines.push('', url ? `shipped in <a href="${url}">${label}</a>` : `shipped in ${label}`);
	}
	const tags = release.tags.map((t) => `#${t}`).join(' ');
	const link = release.url || (siteUrl ? `${siteUrl}/changelog` : '');
	lines.push(
		'',
		`${link ? `${escapeHtml(link)} · ` : ''}${escapeHtml(release.date)}${tags ? ` · ${escapeHtml(tags)}` : ''}`,
	);
	return lines.join('\n');
}

/** The whole feed as Markdown, suitable for a RELEASES.md or a PR body. */
export function renderMarkdown(feed, { includeShips = true } = {}) {
	const out = [
		'# Ship log',
		'',
		`_${feed.stats.commits} commits · ${feed.stats.releases} releases · ${Math.round(feed.stats.coverage * 100)}% of visible commits accounted for_`,
		'',
	];
	for (const r of feed.releases) {
		out.push(`## ${r.date} · ${r.title}`, '');
		if (r.summary) out.push(r.summary, '');
		if (r.tags.length) out.push(r.tags.map((t) => `\`${t}\``).join(' '), '');
		for (const c of r.commits) {
			out.push(
				`- \`${c.shortSha}\` **${c.headline}** ${c.summary}${c.url ? ` ([diff](${c.url}))` : ''}`,
			);
		}
		if (r.commits.length) out.push('');
	}
	if (includeShips && feed.ships.length) {
		out.push('## Unannounced work', '');
		for (const ship of feed.ships) {
			out.push(`### ${String(ship.start).slice(0, 10)} · ${ship.title}`, '');
			for (const c of ship.commits) {
				out.push(
					`- \`${c.shortSha}\` **${c.headline}** ${c.summary}${c.url ? ` ([diff](${c.url}))` : ''}`,
				);
			}
			out.push('');
		}
	}
	return out.join('\n').trimEnd() + '\n';
}

/** RSS 2.0 over the releases, with the commit list inline in each item. */
export function renderRss(feed, { title = 'Ship log', siteUrl = '', description = '' } = {}) {
	const items = feed.releases.slice(0, 50).map((r) => {
		const body = [
			`<p>${escapeXml(r.summary)}</p>`,
			r.commits.length
				? `<ul>${r.commits
						.map(
							(c) =>
								`<li><code>${escapeXml(c.shortSha)}</code> ${escapeXml(c.headline)}: ${escapeXml(c.summary)}</li>`,
						)
						.join('')}</ul>`
				: '',
		].join('');
		const link = r.url || siteUrl;
		return [
			'    <item>',
			`      <title>${escapeXml(r.title)}</title>`,
			link ? `      <link>${escapeXml(link)}</link>` : '',
			`      <guid isPermaLink="false">${escapeXml(r.key)}</guid>`,
			`      <pubDate>${new Date(`${r.date}T12:00:00Z`).toUTCString()}</pubDate>`,
			`      <description>${escapeXml(body)}</description>`,
			'    </item>',
		]
			.filter(Boolean)
			.join('\n');
	});
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0">',
		'  <channel>',
		`    <title>${escapeXml(title)}</title>`,
		siteUrl ? `    <link>${escapeXml(siteUrl)}</link>` : '',
		`    <description>${escapeXml(description || 'Releases and the commits behind them.')}</description>`,
		`    <lastBuildDate>${new Date(feed.generatedAt).toUTCString()}</lastBuildDate>`,
		...items,
		'  </channel>',
		'</rss>',
	]
		.filter(Boolean)
		.join('\n');
}

const ESC = String.fromCharCode(27);
const ANSI = {
	reset: `${ESC}[0m`,
	dim: `${ESC}[2m`,
	bold: `${ESC}[1m`,
	green: `${ESC}[32m`,
	cyan: `${ESC}[36m`,
	yellow: `${ESC}[33m`,
	grey: `${ESC}[90m`,
};

const AUDIENCE_COLOR = { holder: ANSI.green, developer: ANSI.cyan, internal: ANSI.grey };

/** The feed as a terminal report. Set `color: false` for pipes and CI logs. */
export function renderTerminal(feed, { color = true, maxCommits = 6, maxReleases = 20 } = {}) {
	const c = (code, s) => (color ? `${code}${s}${ANSI.reset}` : String(s));
	const out = [];
	out.push(
		c(ANSI.bold, `ship log · ${feed.repo || 'repository'}`),
		c(
			ANSI.dim,
			`${feed.stats.commits} commits · ${feed.stats.releases} releases · ${feed.stats.linked} linked · ${Math.round(feed.stats.coverage * 100)}% coverage`,
		),
		'',
	);
	for (const r of feed.releases.slice(0, maxReleases)) {
		out.push(`${c(ANSI.yellow, r.date)}  ${c(ANSI.bold, r.title)}`);
		for (const commit of r.commits.slice(0, maxCommits)) {
			out.push(
				`    ${c(ANSI.grey, commit.shortSha)} ${c(AUDIENCE_COLOR[commit.audience] || '', commit.headline)} ${c(ANSI.dim, commit.summary)}`,
			);
		}
		if (r.commits.length > maxCommits) {
			out.push(c(ANSI.dim, `    +${r.commits.length - maxCommits} more`));
		}
		out.push('');
	}
	if (feed.ships.length) {
		out.push(c(ANSI.bold, 'unannounced'), '');
		for (const ship of feed.ships.slice(0, 10)) {
			out.push(
				`${c(ANSI.yellow, String(ship.start).slice(0, 10))}  ${c(ANSI.bold, ship.title)} ${c(ANSI.dim, ship.summary)}`,
			);
			for (const commit of ship.commits.slice(0, maxCommits)) {
				out.push(`    ${c(ANSI.grey, commit.shortSha)} ${c(ANSI.dim, commit.summary)}`);
			}
			out.push('');
		}
	}
	return out.join('\n');
}
