#!/usr/bin/env node
/**
 * gcp-logs: the `vercel logs` equivalent for our Cloud Run production.
 *
 * Reads Cloud Logging for any Cloud Run service in the project and renders
 * entries the way `vercel logs` did: one line per entry, chronological,
 * severity-colored, with app logs (textPayload/jsonPayload) and request logs
 * (httpRequest) both handled. `--follow` streams live via
 * `gcloud beta run services logs tail`.
 *
 *   npm run logs                                # last hour, three-ws-api
 *   npm run logs:tail                           # live tail (like `vercel logs --follow`)
 *   npm run logs:errors                         # ERROR+ across ALL services, last 6h
 *   npm run logs -- -s model-rig --since 2d     # another service, wider window
 *   npm run logs -- --grep forge --warnings     # search payloads
 *   npm run logs -- --http 500                  # request logs with status >= 500
 *   npm run logs -- --services                  # list Cloud Run services
 *
 * Requires an authenticated gcloud (this workspace already is).
 */

import { spawnSync, spawn } from 'node:child_process';

const DEFAULT_PROJECT = process.env.GCP_PROJECT || 'aerial-vehicle-466722-p5';
const DEFAULT_REGION = process.env.GCP_REGION || 'us-central1';
const DEFAULT_SERVICE = 'three-ws-api';

function parseArgs(argv) {
	const opts = {
		service: DEFAULT_SERVICE,
		all: false,
		follow: false,
		severity: null,
		http: null,
		appOnly: false,
		since: '1h',
		limit: 100,
		grep: null,
		json: false,
		listServices: false,
		project: DEFAULT_PROJECT,
		region: DEFAULT_REGION,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case '-s': case '--service': opts.service = next(); break;
			case '--all': opts.all = true; break;
			case '-f': case '--follow': opts.follow = true; break;
			case '-e': case '--errors': opts.severity = 'ERROR'; break;
			case '-w': case '--warnings': opts.severity = 'WARNING'; break;
			case '--http': {
				const peek = argv[i + 1];
				opts.http = peek && /^\d{3}$/.test(peek) ? Number(next()) : 400;
				break;
			}
			case '--app': opts.appOnly = true; break;
			case '--since': opts.since = next(); break;
			case '-n': case '--limit': opts.limit = Number(next()); break;
			case '-g': case '--grep': opts.grep = next(); break;
			case '--json': opts.json = true; break;
			case '--services': opts.listServices = true; break;
			case '--project': opts.project = next(); break;
			case '--region': opts.region = next(); break;
			case '-h': case '--help': printHelp(); process.exit(0); break;
			default:
				console.error(`Unknown option: ${a} (see --help)`);
				process.exit(2);
		}
	}
	if (!/^\d+[smhdw]$/.test(opts.since)) {
		console.error(`--since must look like 30m, 2h, 1d (got "${opts.since}")`);
		process.exit(2);
	}
	if (!Number.isFinite(opts.limit) || opts.limit < 1) {
		console.error('--limit must be a positive number');
		process.exit(2);
	}
	return opts;
}

function printHelp() {
	console.log(`gcp-logs: a vercel-logs-style reader for Cloud Run production

Usage: node scripts/gcp-logs.mjs [options]

  -s, --service <name>   Cloud Run service (default ${DEFAULT_SERVICE})
      --all              every Cloud Run service in the project
  -f, --follow           live tail (single service only)
  -e, --errors           severity >= ERROR
  -w, --warnings         severity >= WARNING
      --http [status]    request logs only, status >= given code (default 400)
      --app              app logs only (hide request logs)
      --since <window>   how far back: 30m, 2h, 1d, 1w (default 1h)
  -n, --limit <n>        max entries (default 100)
  -g, --grep <term>      search all payload fields for a term
      --json             raw JSON entries (for scripts/agents)
      --services         list Cloud Run services and exit
      --project <id>     GCP project (default ${DEFAULT_PROJECT})
      --region <region>  region (default ${DEFAULT_REGION})`);
}

function gcloud(args, { inherit = false } = {}) {
	const res = spawnSync('gcloud', args, {
		encoding: 'utf8',
		stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.error) {
		console.error(`Failed to run gcloud: ${res.error.message}`);
		process.exit(1);
	}
	if (res.status !== 0 && !inherit) {
		console.error((res.stderr || '').trim() || `gcloud exited ${res.status}`);
		process.exit(res.status ?? 1);
	}
	return res.stdout ?? '';
}

function buildQuery(opts) {
	const parts = ['resource.type="cloud_run_revision"'];
	if (!opts.all) parts.push(`resource.labels.service_name="${opts.service}"`);
	if (opts.http != null) {
		parts.push('logName:"run.googleapis.com%2Frequests"');
		parts.push(`httpRequest.status>=${opts.http}`);
	} else if (opts.appOnly) {
		parts.push('NOT logName:"run.googleapis.com%2Frequests"');
	}
	if (opts.severity) parts.push(`severity>=${opts.severity}`);
	if (opts.grep) parts.push(JSON.stringify(opts.grep));
	return parts.join(' ');
}

const COLORS = {
	DEFAULT: '\x1b[2m', DEBUG: '\x1b[2m', INFO: '\x1b[36m', NOTICE: '\x1b[36m',
	WARNING: '\x1b[33m', ERROR: '\x1b[31m', CRITICAL: '\x1b[41m\x1b[97m',
	ALERT: '\x1b[41m\x1b[97m', EMERGENCY: '\x1b[41m\x1b[97m',
};
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY;

function paint(sev, text) {
	if (!useColor) return text;
	return `${COLORS[sev] || ''}${text}${RESET}`;
}

export function renderEntry(entry) {
	const ts = (entry.timestamp || '').replace('T', ' ').replace(/\.\d+Z$/, 'Z');
	const sev = entry.severity || 'DEFAULT';
	const service = entry.resource?.labels?.service_name || '?';
	let msg;
	if (entry.httpRequest) {
		const r = entry.httpRequest;
		const latency = r.latency ? ` ${String(r.latency).replace(/(\.\d{2})\d+s/, '$1s')}` : '';
		msg = `${r.status || '-'} ${r.requestMethod || '-'} ${r.requestUrl || ''}${latency}`;
		if (entry.textPayload) msg += ` :: ${entry.textPayload}`;
	} else if (entry.textPayload != null) {
		msg = entry.textPayload;
	} else if (entry.jsonPayload != null) {
		const p = entry.jsonPayload;
		msg = typeof p.message === 'string' && Object.keys(p).length === 1
			? p.message
			: JSON.stringify(p);
	} else if (entry.protoPayload != null) {
		msg = `${entry.protoPayload.methodName || 'audit'} ${entry.protoPayload.status?.message || ''}`.trim();
	} else {
		msg = '(empty entry)';
	}
	return `${ts} ${paint(sev, sev.padEnd(7))} [${service}] ${msg}`;
}

export function fetchEntries(opts) {
	const query = buildQuery(opts);
	const out = gcloud([
		'logging', 'read', query,
		`--project=${opts.project}`,
		`--freshness=${opts.since}`,
		`--limit=${opts.limit}`,
		'--order=desc',
		'--format=json',
	]);
	const entries = JSON.parse(out || '[]');
	entries.reverse(); // chronological, like vercel logs
	return entries;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.listServices) {
		gcloud([
			'run', 'services', 'list',
			`--project=${opts.project}`, `--region=${opts.region}`,
			'--format=table(metadata.name,status.url,status.latestReadyRevisionName)',
		], { inherit: true });
		return;
	}

	if (opts.follow) {
		if (opts.all) {
			console.error('--follow tails one service at a time; drop --all or pass -s <service>.');
			process.exit(2);
		}
		console.error(`Tailing ${opts.service} (${opts.project}/${opts.region}); Ctrl-C to stop`);
		const child = spawn('gcloud', [
			'beta', 'run', 'services', 'logs', 'tail', opts.service,
			`--project=${opts.project}`, `--region=${opts.region}`,
		], { stdio: 'inherit' });
		child.on('exit', (code) => process.exit(code ?? 0));
		return;
	}

	const entries = fetchEntries(opts);
	if (opts.json) {
		process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
		return;
	}
	if (!entries.length) {
		const scope = opts.all ? 'all services' : opts.service;
		console.log(`No matching entries for ${scope} in the last ${opts.since}. Widen with --since or drop filters.`);
		return;
	}
	for (const e of entries) console.log(renderEntry(e));
	console.error(`\n${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${opts.all ? 'all services' : opts.service}, last ${opts.since})${entries.length >= opts.limit ? '; hit --limit, raise -n for more' : ''}`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) main();
