#!/usr/bin/env node
/**
 * Command line entry point. Runs one scan and prints the result, so the engine
 * can be used in a terminal or a cron job without the HTTP server.
 *
 *   node src/cli.js scan              human-readable report
 *   node src/cli.js scan --json       the raw snapshot
 *   node src/cli.js scan --attention  only what is broken, exit 1 if anything is
 */

import { config } from './config.js';
import { runScan, partialReasons } from './scan.js';
import * as store from './store.js';
import { attention } from './server.js';

const args = process.argv.slice(2);
const command = args[0] || 'scan';
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index > -1 && args[index + 1] ? args[index + 1] : fallback;
};

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code) => (tty ? `\u001b[${code}m` : '');
const BOLD = ansi(1);
const DIM = ansi(2);
const RESET = ansi(0);
const RED = ansi(31);
const YELLOW = ansi(33);
const GREEN = ansi(32);

const colorFor = (score) => (score >= 75 ? GREEN : score >= 55 ? YELLOW : RED);

function printReport(snapshot) {
	const { summary } = snapshot;
	process.stdout.write(`\n${BOLD}${snapshot.owner}${RESET}  ${summary.repos} repositories, ${summary.stars.toLocaleString()} stars\n`);
	process.stdout.write(`${DIM}scanned in ${(snapshot.durationMs / 1000).toFixed(1)}s${snapshot.partial ? ', partial' : ''}${RESET}\n`);
	for (const reason of partialReasons(snapshot)) process.stdout.write(`${YELLOW}  ${reason}${RESET}\n`);
	process.stdout.write('\n');
	process.stdout.write(`  median health      ${colorFor(summary.medianScore)}${summary.medianScore}/100${RESET}\n`);
	process.stdout.write(`  live deployments   ${summary.deployments.healthy}/${summary.deployments.total}\n`);
	process.stdout.write(`  dead README links  ${summary.links.dead}/${summary.links.total}\n`);
	process.stdout.write(`  unpublished pkgs   ${summary.missingPackages.length}\n\n`);

	const worst = snapshot.repos.filter((repo) => typeof repo.score === 'number').sort((a, b) => a.score - b.score).slice(0, Number(value('top', 20)));
	const width = Math.max(...worst.map((repo) => repo.name.length), 4);
	process.stdout.write(`${BOLD}Lowest scoring${RESET}\n`);
	for (const repo of worst) {
		const failed = (repo.checks || []).filter((check) => check.status === 'fail').map((check) => check.id);
		process.stdout.write(`  ${colorFor(repo.score)}${String(repo.score).padStart(3)}${RESET}  ${repo.name.padEnd(width)}  ${DIM}${failed.join(', ') || 'no failing checks'}${RESET}\n`);
	}
	process.stdout.write('\n');
}

async function main() {
	if (command !== 'scan') {
		process.stderr.write('usage: fleet-console scan [--json] [--attention] [--top N] [--owner NAME]\n');
		process.exit(2);
	}

	const owner = value('owner', config.owner);
	await store.load();
	const snapshot = await runScan({ owner });
	await store.save(snapshot);

	if (flag('json')) {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return;
	}
	if (flag('attention')) {
		const report = attention(snapshot);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exit(report.count > 0 ? 1 : 0);
	}
	printReport(snapshot);
}

main().catch((error) => {
	process.stderr.write(`fleet-console: ${error?.message || error}\n`);
	process.exit(1);
});
