#!/usr/bin/env node
// herald: make your avatar say something, from your terminal.
//
//   npx @three-ws/herald say "Deploy is green"
//   npx @three-ws/herald watch -- npm test
//
// `watch` is the one worth putting in your muscle memory: it runs any command,
// keeps its exit code and its output, and when it finishes your 3D agent walks
// onto whatever browser tab you have open and tells you how it went. Long test
// runs, builds, migrations, and training jobs stop needing a babysitter.
//
// Zero dependencies. Node 18+ (global fetch). Auth is one env var:
//   export THREE_WS_API_KEY=sk_live_...        # /dashboard/developers
//   export THREE_WS_ORIGIN=https://three.ws    # optional, for self-hosting

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_ORIGIN = process.env.THREE_WS_ORIGIN || 'https://three.ws';
const VERSION = '0.1.0';

const HELP = `herald ${VERSION}: deliver a message in person.

USAGE
  herald say <text> [options]
  herald watch [options] -- <command...>
  herald ping
  herald --help

COMMANDS
  say     Announce one line on your own avatar.
  watch   Run a command, then announce how it went (keeps its exit code).
  ping    Verify your key and the rail, without announcing anything.

OPTIONS
  --from <name>          Who it is from ("CI", "Stripe", "your build").
  --importance <0-100>   How hard it should interrupt. Default 70 (say),
                         60 on success and 95 on failure (watch).
  --url <url>            Where clicking through goes.
  --tone <t>             neutral | alert | celebrate | error
  --emote <name>         Gesture on arrival: wave, dance, punch, backflip.
  --key <dedupe-key>     Same key twice is said once.
  --quiet                Print nothing on success.
  --origin <url>         Rail origin. Default ${DEFAULT_ORIGIN}
  --api-key <key>        Overrides THREE_WS_API_KEY.
  --api-key-file <path>  Read the key from a file (CI secret mounts).

EXAMPLES
  herald say "Deploy is green" --url https://three.ws/dashboard
  herald watch --from CI -- npm test
  herald watch --from "db migrate" -- npm run db:migrate
  TESTS=$(herald watch -- npm test; echo $?)   # exit code is preserved

ENVIRONMENT
  THREE_WS_API_KEY   API key with the herald:announce scope.
  THREE_WS_ORIGIN    Rail origin (default ${DEFAULT_ORIGIN}).
`;

function parseArgs(argv) {
	const out = { _: [], flags: {}, command: null, rest: [] };
	const dashdash = argv.indexOf('--');
	const head = dashdash === -1 ? argv : argv.slice(0, dashdash);
	out.rest = dashdash === -1 ? [] : argv.slice(dashdash + 1);

	for (let i = 0; i < head.length; i++) {
		const token = head[i];
		if (token.startsWith('--')) {
			const name = token.slice(2);
			// Boolean flags take no value; everything else consumes the next token.
			if (name === 'quiet' || name === 'help' || name === 'version') {
				out.flags[name] = true;
			} else {
				out.flags[name] = head[++i];
			}
		} else if (!out.command) {
			out.command = token;
		} else {
			out._.push(token);
		}
	}
	return out;
}

function resolveKey(flags) {
	if (flags['api-key']) return flags['api-key'].trim();
	if (flags['api-key-file']) {
		try {
			return readFileSync(flags['api-key-file'], 'utf8').trim();
		} catch (err) {
			fail(`could not read --api-key-file: ${err.message}`);
		}
	}
	const env = (process.env.THREE_WS_API_KEY || '').trim();
	if (env) return env;
	fail(
		'no API key. Set THREE_WS_API_KEY (create one at ' +
			`${DEFAULT_ORIGIN}/dashboard/developers with the herald:announce scope), ` +
			'or pass --api-key / --api-key-file.',
	);
}

function fail(message, code = 2) {
	process.stderr.write(`herald: ${message}\n`);
	process.exit(code);
}

async function announce(body, { origin, apiKey, quiet }) {
	let res;
	try {
		res = await fetch(`${origin.replace(/\/$/, '')}/api/herald/announce`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		fail(`could not reach the rail at ${origin}: ${err.message}`, 3);
	}

	const payload = await res.json().catch(() => ({}));
	if (!res.ok) {
		const detail = payload.error_description || payload.error || `HTTP ${res.status}`;
		if (res.status === 401 || res.status === 403) {
			fail(`${detail} (check the key's herald:announce scope)`, 4);
		}
		fail(detail, 5);
	}
	if (!quiet) {
		process.stdout.write(`herald: queued "${body.text}"\n`);
	}
	return payload;
}

async function cmdSay(args) {
	const text = args._.join(' ').trim() || args.rest.join(' ').trim();
	if (!text) fail('nothing to say. Usage: herald say "your message"');
	await announce(
		{
			text,
			from: args.flags.from,
			importance: args.flags.importance != null ? Number(args.flags.importance) : undefined,
			url: args.flags.url,
			tone: args.flags.tone,
			emote: args.flags.emote,
			key: args.flags.key,
		},
		context(args),
	);
}

async function cmdWatch(args) {
	const command = args.rest;
	if (!command.length) fail('nothing to run. Usage: herald watch -- npm test');

	const label = args.flags.from || command.join(' ');
	const started = Date.now();
	const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: false });

	const code = await new Promise((resolve) => {
		child.on('error', (err) => {
			fail(`could not run "${command[0]}": ${err.message}`, 127);
		});
		child.on('close', (exitCode) => resolve(exitCode ?? 0));
	});

	const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
	const took = seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
	const ok = code === 0;

	await announce(
		{
			text: ok ? `${label} passed in ${took}` : `${label} failed (exit ${code}) after ${took}`,
			from: args.flags.from,
			importance:
				args.flags.importance != null ? Number(args.flags.importance) : ok ? 60 : 95,
			url: args.flags.url,
			tone: args.flags.tone || (ok ? 'celebrate' : 'error'),
			emote: args.flags.emote || (ok ? 'dance' : undefined),
			key: args.flags.key,
			meta: { exitCode: code, seconds, command: command.join(' ') },
		},
		context(args),
	);

	// The whole point of `watch` is being transparent in a pipeline: it must
	// exit with the command's status, not its own.
	process.exit(code);
}

async function cmdPing(args) {
	const { origin, apiKey } = context(args);
	const res = await fetch(`${origin.replace(/\/$/, '')}/api/herald/announce`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ text: 'herald ping', importance: 0, key: 'herald:cli:ping' }),
	}).catch((err) => fail(`could not reach the rail at ${origin}: ${err.message}`, 3));

	if (res.status === 401 || res.status === 403) fail('key rejected: check herald:announce scope', 4);
	if (!res.ok) fail(`rail returned HTTP ${res.status}`, 5);
	// importance 0 means the browser's own floor drops it: this proves the key
	// and the rail without interrupting anybody.
	process.stdout.write(`herald: rail reachable at ${origin}, key accepted\n`);
}

function context(args) {
	return {
		origin: args.flags.origin || DEFAULT_ORIGIN,
		apiKey: resolveKey(args.flags),
		quiet: !!args.flags.quiet,
	};
}

const args = parseArgs(process.argv.slice(2));

if (args.flags.help || (!args.command && !args.rest.length)) {
	process.stdout.write(HELP);
	process.exit(0);
}
if (args.flags.version) {
	process.stdout.write(`${VERSION}\n`);
	process.exit(0);
}

const commands = { say: cmdSay, watch: cmdWatch, ping: cmdPing };
const run = commands[args.command];
if (!run) fail(`unknown command "${args.command}". Try: herald --help`);

run(args).catch((err) => fail(err?.message || String(err), 1));
