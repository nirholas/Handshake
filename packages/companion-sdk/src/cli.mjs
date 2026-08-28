#!/usr/bin/env node
// companion - the command line for a person's 3D companion.
//
//   companion login --token cmp_...        store the bridge token on this machine
//   companion send "Build finished" --from CI --priority high
//   companion stream --say                 tail live deliveries, speak them on macOS
//   companion watch-imap --host imap.gmail.com --user you@gmail.com
//   companion mcp                          expose the companion to an agent over MCP
//   companion doctor                       check the token, the API, and the lanes
//
// Design notes worth knowing:
//
//   • `watch-imap` is the privacy mode. The mail password never leaves the
//     machine: this process connects to the inbox locally, scores each message
//     with the same rules the server uses (@three-ws/companion/triage), and
//     posts only what clears the bar, with the body redacted if you ask. It
//     needs `imapflow` installed alongside this package.
//   • `mcp` turns "interrupt a human" into a tool any agent can call. An agent
//     that finds something genuinely urgent can now walk on stage in a 3D body
//     and say it, rather than writing into a log nobody reads.

import { createCompanionClient } from './client.js';
import { decide, scoreByRules } from './triage-rules.js';
import { resolveCredentials, writeConfig, configPath } from './config.js';
import { spawn } from 'node:child_process';

const HELP = `companion - your 3D companion, from the command line

Usage
  companion login --token <cmp_...> [--api <url>]
  companion send <title> [--body <text>] [--from <name>] [--id <handle>]
                 [--app <name>] [--url <link>] [--priority high|normal|low]
  companion stream [--say] [--since <iso>] [--json]
  companion list [--limit 20] [--min <score>]
  companion check
  companion watch-imap --host <host> --user <address> [--pass <app password>]
                       [--port 993] [--folder INBOX] [--interval 60]
                       [--min <score>] [--redact]
  companion score <title> [--body <text>] [--from <name>] [--lane email]
  companion mcp
  companion doctor

Credentials
  Bridge token from https://three.ws/companion, in order of precedence:
  --token, $COMPANION_TOKEN, ${configPath()}

Every command exits non-zero on failure, so it composes in scripts and CI.`;

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) args[key] = true;
			else {
				args[key] = next;
				i += 1;
			}
		} else args._.push(arg);
	}
	return args;
}

function die(message, code = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function clientFrom(args) {
	const { token, apiBase } = resolveCredentials({ token: args.token, apiBase: args.api });
	if (!token) {
		die('No bridge token. Run `companion login --token cmp_...` (get one at https://three.ws/companion).');
	}
	return { client: createCompanionClient({ apiBase, token }), token, apiBase };
}

// macOS ships a real speech synthesiser; on other platforms the line is printed
// and nothing pretends to have spoken it.
function sayOnMac(text) {
	if (process.platform !== 'darwin') return false;
	try {
		spawn('say', [text], { stdio: 'ignore', detached: true }).unref();
		return true;
	} catch {
		return false;
	}
}

async function cmdLogin(args) {
	const token = args.token === true ? null : args.token;
	if (!token) die('Pass the token: companion login --token cmp_...');
	const apiBase = args.api && args.api !== true ? args.api : undefined;
	const client = createCompanionClient({ token, ...(apiBase ? { apiBase } : {}) });
	// Prove the token before storing it, so a typo fails here and not at 3am.
	const probe = await client.list({ limit: 1 }).catch((err) => {
		die(`That token was refused: ${err.message}`);
	});
	writeConfig({ token, ...(apiBase ? { apiBase } : {}), threshold: probe?.threshold ?? 60 });
	process.stdout.write(`Saved to ${configPath()}. Threshold is ${probe?.threshold ?? 60}.\n`);
}

async function cmdSend(args) {
	const title = args._[1];
	if (!title) die('What should it say? companion send "Build finished"');
	const { client } = clientFrom(args);
	const result = await client.send({
		title,
		...(args.body && args.body !== true ? { body: args.body } : {}),
		...(args.from && args.from !== true ? { sender: args.from } : {}),
		...(args.id && args.id !== true ? { sender_id: args.id } : {}),
		...(args.app && args.app !== true ? { app: args.app } : {}),
		...(args.url && args.url !== true ? { url: args.url } : {}),
		...(args.priority && args.priority !== true ? { priority: args.priority } : {}),
	});
	if (result.duplicate) {
		process.stdout.write('Already delivered that one.\n');
		return;
	}
	const event = result.event;
	process.stdout.write(
		`${event.delivered ? 'Delivered' : 'Stored (below your bar)'} · score ${event.importance}\n`
		+ `  ${event.line}\n  why: ${event.reason}\n`,
	);
}

async function cmdStream(args) {
	const { client } = clientFrom(args);
	const speak = Boolean(args.say);
	const asJson = Boolean(args.json);
	process.stderr.write('Listening for deliveries. Ctrl-C to stop.\n');
	const stop = client.stream({
		since: args.since && args.since !== true ? args.since : null,
		onOpen: (hello) => {
			if (!asJson) process.stderr.write(`Connected (threshold ${hello?.threshold ?? '?'}).\n`);
		},
		onDelivery: (delivery) => {
			if (asJson) {
				process.stdout.write(`${JSON.stringify(delivery)}\n`);
			} else {
				const when = new Date(delivery.created_at).toLocaleTimeString();
				process.stdout.write(`[${when}] ${delivery.speaker}: ${delivery.spoken_line}\n`);
			}
			if (speak) sayOnMac(delivery.spoken_line || delivery.title);
			client.markDelivered(delivery.id).catch(() => {});
		},
		onError: (err) => process.stderr.write(`stream: ${err.message}\n`),
	});
	process.on('SIGINT', () => {
		stop();
		process.exit(0);
	});
	// Hold the process open for the stream.
	await new Promise(() => {});
}

async function cmdList(args) {
	const { client } = clientFrom(args);
	const limit = Number(args.limit) || 20;
	const min = Number(args.min) || 0;
	const data = await client.list({ limit, minImportance: min });
	if (!data.events.length) {
		process.stdout.write('Nothing yet.\n');
		return;
	}
	for (const event of data.events) {
		const flag = event.delivered_at ? 'spoken' : 'held  ';
		process.stdout.write(
			`${String(event.importance).padStart(3)}  ${flag}  ${new Date(event.created_at).toLocaleString()}  `
			+ `${event.contact_name || event.sender || 'unknown'}: ${event.spoken_line || event.title}\n`,
		);
	}
}

async function cmdCheck(args) {
	const { client } = clientFrom(args);
	const result = await client.checkNow();
	if (!result.sources.length) {
		process.stdout.write('No sources connected. Connect one at https://three.ws/companion\n');
		return;
	}
	for (const source of result.sources) {
		process.stdout.write(`${source.ok ? 'ok  ' : 'FAIL'}  ${source.kind.padEnd(9)} ${source.label}  ${source.ok ? `${source.ingested} new` : source.error}\n`);
	}
}

async function cmdScore(args) {
	const title = args._[1];
	if (!title) die('companion score "Your verification code is 123456" --lane email');
	const verdict = scoreByRules({
		source_kind: args.lane && args.lane !== true ? args.lane : 'bridge',
		title,
		body: args.body && args.body !== true ? args.body : '',
		sender: args.from && args.from !== true ? args.from : undefined,
		sender_id: args.id && args.id !== true ? args.id : undefined,
	});
	process.stdout.write(`${verdict.importance}\n  ${verdict.line}\n  why: ${verdict.reason}\n  signals: ${verdict.signals.join(', ') || 'none'}\n`);
}

// ── Local IMAP watcher (privacy mode) ────────────────────────────────────────

async function cmdWatchImap(args) {
	let ImapFlow;
	try {
		({ ImapFlow } = await import('imapflow'));
	} catch {
		die('This command needs imapflow: npm install imapflow');
	}
	const host = args.host && args.host !== true ? args.host : null;
	const user = args.user && args.user !== true ? args.user : null;
	const pass = (args.pass && args.pass !== true ? args.pass : null) || process.env.COMPANION_IMAP_PASS;
	if (!host || !user || !pass) {
		die('Need --host, --user, and --pass (or $COMPANION_IMAP_PASS).');
	}
	const { client } = clientFrom(args);
	const { threshold } = resolveCredentials({ token: args.token, apiBase: args.api });
	const min = Number(args.min) || threshold || 60;
	const redact = Boolean(args.redact);
	const intervalMs = Math.max(15, Number(args.interval) || 60) * 1000;
	const folder = args.folder && args.folder !== true ? args.folder : 'INBOX';

	process.stderr.write(
		`Watching ${user} on ${host}${redact ? ' (bodies redacted)' : ''}.\n`
		+ `Scoring locally; only messages at ${min} or above leave this machine.\n`,
	);

	let lastUid = 0;
	let validity = '';

	const pass_ = pass;
	async function tick() {
		const imap = new ImapFlow({
			host,
			port: Number(args.port) || 993,
			secure: args.insecure ? false : true,
			auth: { user, pass: pass_ },
			logger: false,
		});
		try {
			await imap.connect();
			const lock = await imap.getMailboxLock(folder, { readOnly: true });
			try {
				const currentValidity = String(imap.mailbox.uidValidity || '');
				if (!lastUid || (validity && validity !== currentValidity)) {
					lastUid = Math.max(0, (imap.mailbox.uidNext || 1) - 1);
					validity = currentValidity;
					return;
				}
				validity = currentValidity;
				for await (const message of imap.fetch({ uid: `${lastUid + 1}:*` }, { uid: true, envelope: true }, { uid: true })) {
					if (message.uid <= lastUid) continue;
					lastUid = Math.max(lastUid, message.uid);
					const from = message.envelope?.from?.[0] || {};
					const event = {
						source_kind: 'email',
						title: message.envelope?.subject || '(no subject)',
						sender: from.name || from.address || 'Email',
						sender_id: from.address || null,
					};
					const verdict = decide(event, { threshold: min });
					const mark = verdict.speak ? 'send' : 'keep';
					process.stdout.write(`${String(verdict.importance).padStart(3)} ${mark}  ${event.sender}: ${event.title}\n`);
					if (!verdict.speak) continue;
					await client.send({
						title: event.title,
						sender: event.sender,
						sender_id: event.sender_id || undefined,
						app: 'Email',
						id: `local-imap:${validity}:${message.uid}`,
						body: redact ? undefined : verdict.line,
						priority: verdict.importance >= 80 ? 'high' : 'normal',
					}).catch((err) => process.stderr.write(`send failed: ${err.message}\n`));
				}
			} finally {
				lock.release();
			}
		} catch (err) {
			process.stderr.write(`imap: ${err.message}\n`);
		} finally {
			await imap.logout().catch(() => imap.close?.());
		}
	}

	await tick();
	setInterval(tick, intervalMs);
	await new Promise(() => {});
}

// ── MCP: let an agent interrupt a human, in person ───────────────────────────

async function cmdMcp(args) {
	let Server;
	let StdioServerTransport;
	let schemas;
	try {
		({ Server } = await import('@modelcontextprotocol/sdk/server/index.js'));
		({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
		schemas = await import('@modelcontextprotocol/sdk/types.js');
	} catch {
		die('This command needs the MCP SDK: npm install @modelcontextprotocol/sdk');
	}
	const { client } = clientFrom(args);

	const server = new Server(
		{ name: 'three-ws-companion', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	);

	const tools = [
		{
			name: 'deliver_message',
			description:
				'Interrupt the human in person: a 3D companion walks on screen and says this out loud, on whatever device they are at. '
				+ 'Use it only for something the person would genuinely want to be interrupted for; everything else is stored quietly. '
				+ 'Returns the triage score, the reason, and whether it was actually spoken.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'One line, what happened.' },
					body: { type: 'string', description: 'Optional detail.' },
					sender: { type: 'string', description: 'Who it is from, as the person would recognise them.' },
					url: { type: 'string', description: 'Optional link to open.' },
					priority: { type: 'string', enum: ['high', 'normal', 'low'] },
				},
				required: ['title'],
			},
		},
		{
			name: 'list_deliveries',
			description: 'What the companion has heard recently, with scores and whether each one was spoken.',
			inputSchema: {
				type: 'object',
				properties: {
					limit: { type: 'number', description: 'How many, 1 to 50.' },
					min_importance: { type: 'number', description: 'Only at or above this score.' },
				},
			},
		},
		{
			name: 'score_message',
			description: 'Ask, without sending anything, how urgent a message would be judged and what the companion would say.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					body: { type: 'string' },
					sender: { type: 'string' },
					lane: { type: 'string', description: 'telegram | email | calendar | bridge' },
				},
				required: ['title'],
			},
		},
	];

	server.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({ tools }));

	server.setRequestHandler(schemas.CallToolRequestSchema, async (request) => {
		const { name, arguments: input = {} } = request.params;
		try {
			if (name === 'deliver_message') {
				const result = await client.send({
					title: input.title,
					body: input.body,
					sender: input.sender || 'An agent',
					app: 'Agent',
					url: input.url,
					priority: input.priority || 'normal',
				});
				const event = result.event;
				return {
					content: [{
						type: 'text',
						text: result.duplicate
							? 'Already delivered that exact message.'
							: `${event.delivered ? 'Spoken out loud' : 'Stored quietly (below the human\'s bar)'} · score ${event.importance}. Line: "${event.line}". Why: ${event.reason}`,
					}],
				};
			}
			if (name === 'list_deliveries') {
				const data = await client.list({
					limit: Math.min(50, Math.max(1, Number(input.limit) || 10)),
					minImportance: Number(input.min_importance) || 0,
				});
				return {
					content: [{
						type: 'text',
						text: data.events.length
							? data.events.map((e) => `${e.importance} ${e.delivered_at ? '(spoken)' : '(held)'} ${e.contact_name || e.sender}: ${e.spoken_line || e.title}`).join('\n')
							: 'Nothing yet.',
					}],
				};
			}
			if (name === 'score_message') {
				const verdict = scoreByRules({
					source_kind: input.lane || 'bridge',
					title: input.title,
					body: input.body,
					sender: input.sender,
				});
				return {
					content: [{
						type: 'text',
						text: `score ${verdict.importance}\nline: ${verdict.line}\nwhy: ${verdict.reason}\nsignals: ${verdict.signals.join(', ') || 'none'}`,
					}],
				};
			}
			return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
		} catch (err) {
			return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
		}
	});

	await server.connect(new StdioServerTransport());
}

async function cmdDoctor(args) {
	const { token, apiBase } = resolveCredentials({ token: args.token, apiBase: args.api });
	process.stdout.write(`config     ${configPath()}\n`);
	process.stdout.write(`api        ${apiBase}\n`);
	process.stdout.write(`token      ${token ? `${token.slice(0, 8)}…${token.slice(-4)}` : 'MISSING'}\n`);
	if (!token) die('\nRun `companion login --token cmp_...` first. Get one at https://three.ws/companion');
	const client = createCompanionClient({ apiBase, token });
	try {
		const data = await client.list({ limit: 1 });
		process.stdout.write(`threshold  ${data.threshold}\nreachable  yes\n`);
	} catch (err) {
		die(`reachable  no (${err.message})`);
	}
	try {
		const sources = await client.checkNow();
		for (const source of sources.sources) {
			process.stdout.write(`source     ${source.kind.padEnd(9)} ${source.ok ? 'ok' : `error: ${source.error}`}\n`);
		}
		if (!sources.sources.length) process.stdout.write('source     none connected\n');
	} catch (err) {
		process.stdout.write(`source     could not check (${err.message})\n`);
	}
}

const COMMANDS = {
	login: cmdLogin,
	send: cmdSend,
	stream: cmdStream,
	list: cmdList,
	check: cmdCheck,
	score: cmdScore,
	'watch-imap': cmdWatchImap,
	mcp: cmdMcp,
	doctor: cmdDoctor,
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || args.help || command === 'help') {
	process.stdout.write(`${HELP}\n`);
	process.exit(command ? 0 : 1);
}

const handler = COMMANDS[command];
if (!handler) die(`Unknown command: ${command}\n\n${HELP}`);

handler(args).catch((err) => die(`${err?.message || err}`));
