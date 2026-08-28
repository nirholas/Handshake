#!/usr/bin/env node
/**
 * agent-glance — a three.ws agent card, in your terminal or in your repo.
 *
 *   npx @three-ws/agent-glance <agent-id>              print the card
 *   npx @three-ws/agent-glance <agent-id> --json       the raw card model
 *   npx @three-ws/agent-glance <agent-id> --markdown   a README snippet
 *   npx @three-ws/agent-glance <agent-id> --html       an embed snippet
 *   npx @three-ws/agent-glance <agent-id> --svg card.svg
 *   npx @three-ws/agent-glance <agent-id> --watch 60   refresh every 60s
 *
 * Options: --size small|medium|large, --theme auto|light|dark, --no-color,
 *          --origin https://three.ws
 */

import { writeFile } from 'node:fs/promises';
import {
	fetchGlanceCard,
	glanceImageUrl,
	glanceMarkdown,
	glanceEmbedHtml,
	renderGlanceAnsi,
	GlanceError,
} from '../src/index.js';

const USAGE = `agent-glance <agent-id> [options]

  --json              print the card model as JSON
  --markdown          print a README snippet (image linked to the agent)
  --html              print an embed snippet for a web page
  --svg <file>        write the card image to a file
  --watch [seconds]   redraw on an interval (default 60)
  --size <s>          small | medium | large      (default medium)
  --theme <t>         auto | light | dark         (default auto)
  --origin <url>      API origin (default https://three.ws)
  --no-color          plain text, no ANSI
  -h, --help          this message
`;

function parseArgs(argv) {
	const opts = { color: true, size: 'medium', theme: 'auto', watch: 0 };
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') opts.json = true;
		else if (arg === '--markdown' || arg === '--md') opts.markdown = true;
		else if (arg === '--html' || arg === '--embed') opts.html = true;
		else if (arg === '--svg') opts.svg = argv[++i];
		else if (arg === '--size') opts.size = argv[++i];
		else if (arg === '--theme') opts.theme = argv[++i];
		else if (arg === '--origin') opts.origin = argv[++i];
		else if (arg === '--no-color') opts.color = false;
		else if (arg === '--watch') {
			const next = Number(argv[i + 1]);
			opts.watch = Number.isFinite(next) && next > 0 ? (i++, next) : 60;
		} else if (arg === '-h' || arg === '--help') opts.help = true;
		else rest.push(arg);
	}
	opts.agentId = rest[0];
	return opts;
}

async function printOnce(opts) {
	const card = await fetchGlanceCard(opts.agentId, { origin: opts.origin });
	if (opts.json) return console.log(JSON.stringify(card, null, 2));
	console.log(renderGlanceAnsi(card, { color: opts.color && process.stdout.isTTY !== false }));
	return card;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || !opts.agentId) {
		console.log(USAGE);
		process.exit(opts.agentId ? 0 : 1);
	}

	if (opts.markdown) return console.log(glanceMarkdown(opts.agentId, opts));
	if (opts.html) return console.log(glanceEmbedHtml(opts.agentId, opts));

	if (opts.svg) {
		const url = glanceImageUrl(opts.agentId, opts);
		const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new GlanceError(`three.ws answered ${res.status}`, { status: res.status });
		await writeFile(opts.svg, await res.text(), 'utf8');
		console.log(`wrote ${opts.svg}`);
		return;
	}

	await printOnce(opts);
	if (!opts.watch) return;

	// Watch mode redraws in place: one card that stays current, not a scroll of
	// stale copies.
	const tick = async () => {
		try {
			process.stdout.write('\u001b[2J\u001b[H');
			await printOnce(opts);
			console.log(`\nrefreshing every ${opts.watch}s, ctrl+c to stop`);
		} catch (err) {
			console.error(`glance: ${err.message}`);
		}
	};
	setInterval(tick, opts.watch * 1000);
}

main().catch((err) => {
	console.error(`glance: ${err instanceof GlanceError ? err.message : err?.message || err}`);
	process.exit(1);
});
