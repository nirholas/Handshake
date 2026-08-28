#!/usr/bin/env node
// shipfeed: read a repository's releases and the commits behind them.
//
//   npx @three-ws/shipfeed                      the current repo, from GitHub
//   npx @three-ws/shipfeed --local              the current repo, from git log
//   npx @three-ws/shipfeed --repo vercel/next.js --limit 300
//   npx @three-ws/shipfeed --changelog https://three.ws/changelog.json
//   npx @three-ws/shipfeed explain <sha>
//   npx @three-ws/shipfeed stats
//   npx @three-ws/shipfeed post --telegram --chat <id>
//
// No configuration file, no state, no network beyond GitHub (and Telegram when
// you explicitly ask it to post).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

import {
	buildShipFeed,
	classify,
	commitsFromGitLog,
	fetchChangelog,
	fetchGitHubCommits,
	GIT_LOG_FORMAT,
	linkCommits,
	normalizeChangelog,
	parseCommit,
	renderCommitTelegram,
	renderMarkdown,
	renderReleaseTelegram,
	renderRss,
	renderTerminal,
} from '../src/index.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

const HELP = `shipfeed ${VERSION}

  shipfeed [feed]            build the unified release feed (default)
  shipfeed explain <sha>     why one commit was classified and linked as it was
  shipfeed stats             velocity, audience mix, and changelog coverage
  shipfeed post              render what would go to a channel (add --send to deliver)

Options
  --repo <owner/name>        default: parsed from the git "origin" remote
  --branch <name>            default: main
  --limit <n>                commits to read (default 200)
  --local                    read commits from the local clone with git log
  --changelog <url|path>     changelog JSON to link commits against
  --site <url>               site base URL used for permalinks
  --scopes <a,b,c>           scopes that mean "product" when scoring signal
  --min-audience <a>         holder | developer | internal (default internal)
  --json | --markdown | --rss | --no-color
  --telegram --chat <id> --token <t> --send     post mode; dry run without --send
  --help | --version
`;

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const [name, inline] = arg.slice(2).split('=');
		const next = argv[i + 1];
		const wantsValue = [
			'repo',
			'branch',
			'limit',
			'changelog',
			'site',
			'scopes',
			'min-audience',
			'chat',
			'token',
		].includes(name);
		if (inline !== undefined) flags[name] = inline;
		else if (wantsValue && next && !next.startsWith('--')) flags[name] = argv[++i];
		else flags[name] = true;
	}
	return { flags, positional };
}

function detectRepo() {
	try {
		const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
		return m ? m[1] : '';
	} catch {
		return '';
	}
}

function readLocalCommits(limit, repo) {
	const out = execFileSync('git', ['log', `-n${limit}`, `--format=${GIT_LOG_FORMAT}`], {
		encoding: 'utf8',
		maxBuffer: 1 << 28,
	});
	return commitsFromGitLog(out, { repo });
}

async function loadChangelog(source) {
	if (!source || source === true) return [];
	if (/^https?:\/\//.test(source)) return fetchChangelog(source);
	return normalizeChangelog(JSON.parse(readFileSync(source, 'utf8')));
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(values) {
	if (values.length === 0) return '';
	const max = Math.max(...values, 1);
	return values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * 7))]).join('');
}

function fail(message) {
	process.stderr.write(`shipfeed: ${message}\n`);
	process.exitCode = 1;
}

async function collect(flags) {
	const repo = flags.repo || detectRepo();
	if (!repo && !flags.local) {
		throw new Error('no repository. Pass --repo owner/name, or run inside a GitHub clone.');
	}
	const limit = Math.max(1, Number(flags.limit) || 200);
	const commits = flags.local
		? readLocalCommits(limit, repo)
		: await fetchGitHubCommits({
				repo,
				branch: flags.branch || 'main',
				limit,
				token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
			});
	const entries = await loadChangelog(flags.changelog);
	const feed = buildShipFeed({
		commits,
		entries,
		repo,
		siteUrl: flags.site || '',
		minAudience: flags['min-audience'] || 'internal',
		classify: {
			productScopes: String(flags.scopes || '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		},
	});
	return { repo, commits, entries, feed };
}

async function cmdFeed(flags) {
	const { feed } = await collect(flags);
	if (flags.json) return process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
	if (flags.markdown) return process.stdout.write(renderMarkdown(feed));
	if (flags.rss) {
		return process.stdout.write(
			`${renderRss(feed, { title: `${feed.repo} ship log`, siteUrl: feed.siteUrl || '' })}\n`,
		);
	}
	return process.stdout.write(
		`${renderTerminal(feed, { color: !flags['no-color'] && process.stdout.isTTY })}\n`,
	);
}

async function cmdExplain(flags, sha) {
	if (!sha) throw new Error('explain needs a commit sha');
	const { commits, entries, feed } = await collect(flags);
	const parsed = commits.map((c) => parseCommit(c));
	const commit = parsed.find((c) => c.sha.startsWith(sha));
	if (!commit) throw new Error(`commit ${sha} is not in the last ${parsed.length} commits`);

	const cls = classify(commit, {
		productScopes: String(flags.scopes || '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	});
	const { byCommit } = linkCommits(entries, parsed);
	const link = byCommit.get(commit.sha);

	const lines = [
		`${commit.shortSha}  ${commit.subject}`,
		'',
		`  type        ${commit.type || '(none)'}${commit.scope ? ` (${commit.scope})` : ''}`,
		`  breaking    ${commit.breaking}`,
		`  audience    ${cls.audience}`,
		`  signal      ${cls.signal}`,
		'',
		'  scoring',
		...cls.reasons.map(
			(r) => `    ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}  ${r.rule.padEnd(22)} ${r.note}`,
		),
		'',
	];
	if (link) {
		const release = feed.releases.find((r) => r.key === link.entryKey);
		lines.push(
			`  linked to   ${release ? release.title : link.entryKey}`,
			`  confidence  ${link.score}`,
			'  because',
			...link.reasons.map((r) => `    ${r}`),
		);
	} else {
		lines.push('  linked to   nothing: no changelog entry claims this commit');
	}
	process.stdout.write(`${lines.join('\n')}\n`);
}

async function cmdStats(flags) {
	const { feed } = await collect(flags);
	const velocity = feed.stats.velocity;
	const lines = [
		`${feed.repo}`,
		'',
		`  commits        ${feed.stats.commits}`,
		`  releases       ${feed.stats.releases}`,
		`  linked         ${feed.stats.linked} (${Math.round(feed.stats.coverage * 100)}% of visible commits)`,
		`  unannounced    ${feed.stats.orphans}`,
		'',
		`  holder         ${feed.stats.byAudience.holder}`,
		`  developer      ${feed.stats.byAudience.developer}`,
		`  internal       ${feed.stats.byAudience.internal}`,
		'',
		`  velocity       ${sparkline(velocity.map((v) => v.count))}`,
		`                 ${velocity.length ? `${velocity[0].date} to ${velocity[velocity.length - 1].date}` : 'no dated commits'}`,
		'',
		'  types          ' +
			Object.entries(feed.stats.byType)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 8)
				.map(([t, n]) => `${t}:${n}`)
				.join('  '),
		'  authors        ' + feed.stats.topAuthors.map((a) => `${a.name}:${a.count}`).join('  '),
	];
	process.stdout.write(`${lines.join('\n')}\n`);
}

async function postTelegram(chatId, token, text) {
	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
		signal: AbortSignal.timeout(20_000),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.ok) {
		throw new Error(`Telegram sendMessage failed (${res.status}): ${body.description || 'unknown'}`);
	}
}

async function cmdPost(flags) {
	const { feed, repo } = await collect(flags);
	const messages = [];
	for (const release of feed.releases.slice(0, 3)) {
		messages.push(renderReleaseTelegram(release, { repo, siteUrl: feed.siteUrl || '' }));
	}
	for (const ship of feed.ships.slice(0, 3)) {
		for (const commit of ship.commits.slice(0, 3)) {
			messages.push(renderCommitTelegram(commit, { repo }));
		}
	}

	if (!flags.send) {
		process.stdout.write(
			`${messages.join('\n\n---\n\n')}\n\n(dry run: ${messages.length} messages. Add --send to deliver.)\n`,
		);
		return;
	}

	const token = flags.token || process.env.TELEGRAM_BOT_TOKEN || '';
	const chat = flags.chat || process.env.TELEGRAM_CHAT_ID || '';
	if (!token || !chat) throw new Error('post --send needs --token and --chat (or the env vars)');
	for (const [i, message] of messages.entries()) {
		await postTelegram(chat, token, message);
		process.stdout.write(`sent ${i + 1}/${messages.length}\n`);
		if (i < messages.length - 1) await new Promise((r) => setTimeout(r, 3500));
	}
}

const { flags, positional } = parseArgs(process.argv.slice(2));

if (flags.help || positional[0] === 'help') {
	process.stdout.write(HELP);
} else if (flags.version) {
	process.stdout.write(`${VERSION}\n`);
} else {
	const command = positional[0] && !positional[0].startsWith('-') ? positional[0] : 'feed';
	const run =
		command === 'explain'
			? () => cmdExplain(flags, positional[1])
			: command === 'stats'
				? () => cmdStats(flags)
				: command === 'post'
					? () => cmdPost(flags)
					: () => cmdFeed(flags);
	run().catch((err) => fail(err?.message || String(err)));
}
