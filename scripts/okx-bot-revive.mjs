#!/usr/bin/env node
// Brings the OKX.AI marketplace chat bot for agent #2632 back online, end to end.
//
//   npm run okx:bot
//
// The bot is a LOCAL `okx-a2a` daemon plus an `onchainos` wallet session, both of
// which live outside this repo. A codespace rebuild (or an idle nap) wipes them,
// and OKX-side chat tests then time out with "no delivery in 30 min". This script
// is the whole recovery: install, daemon, AI workspace, catalog briefing, skills,
// permissions, health sweep. It is safe to run any number of times.
//
// The one step it cannot do for you is the browser login: OKX requires a human to
// complete an email OTP. When logged out, the script prints the login URL and
// exits non-zero so callers can tell "needs a human" from "ready".

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = join(homedir(), '.okx-agent-task', 'workspace');
const SKILLS_SRC = join(REPO, '.agents', 'skills');
const MIN_NODE_MAJOR = 22;

// Skills the chat subsession needs: the A2A task/chat lifecycle, our identity and
// payment surfaces, and the 3D skills a buyer question can land on.
const SKILLS = [
	'okx-agent-chat',
	'okx-agent-task',
	'okx-agent-identity',
	'okx-agent-payments-protocol',
	'okx-agentic-wallet',
	'okx-ai-guide',
	'okx-ai-support',
	'okx-task-watch',
	'create-3d-avatar',
	'generate-3d-model',
	'rig-a-model',
	'embed-three-ws-avatar',
];

const steps = [];
function step(name, detail) {
	steps.push({ name, detail });
	console.log(`  ${name}: ${detail}`);
}

function sh(cmd, { allowFail = false } = {}) {
	try {
		return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		if (allowFail) return '';
		throw err;
	}
}

function has(bin) {
	return sh(`command -v ${bin} || true`, { allowFail: true }).length > 0;
}

console.log('OKX chat bot revive\n');

// 1. Node version, the daemon refuses to run below 22.14.
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
	console.error(`Node ${process.versions.node} is too old; the okx-a2a daemon needs >= ${MIN_NODE_MAJOR}.14.0.`);
	process.exit(1);
}
step('node', process.versions.node);

// 2. The two CLIs. okx-a2a runs the daemon; onchainos holds the wallet session the
//    daemon reads agent identities through.
if (!has('okx-a2a')) {
	console.log('  installing @okxweb3/a2a-node ...');
	sh('npm install -g @okxweb3/a2a-node@latest');
}
step('okx-a2a', sh('okx-a2a --version', { allowFail: true }) || 'installed');

const onchainosBin = join(homedir(), '.local', 'bin', 'onchainos');
if (!has('onchainos') && !existsSync(onchainosBin)) {
	console.error(
		'onchainos is missing. Install it with the checksum-verified installer described in\n' +
			'.agents/skills/okx-agentic-wallet/_shared/preflight.md, then re-run this script.',
	);
	process.exit(1);
}
process.env.PATH = `${join(homedir(), '.local', 'bin')}:${process.env.PATH}`;
step('onchainos', sh('onchainos --version', { allowFail: true }) || 'present');

// 3. Daemon. `okx-a2a daemon start` delegates to an OS autostart unit, and this
//    container has no systemd ("systemd is not running in this container"), so on
//    a codespace that call installs the unit and silently leaves the daemon down.
//    A crashed daemon also leaves a lock behind that blocks the next start
//    ("stale pid=..." / "lockPid=..."). Clear the lock, try the supported path,
//    then fall back to running the daemon process directly.
function daemonState() {
	return sh('okx-a2a daemon status', { allowFail: true });
}

if (!daemonState().startsWith('running')) {
	const stale = daemonState();
	if (stale.includes('stale') || stale.includes('lockPid')) {
		rmSync(join(homedir(), '.okx-agent-task', 'run', 'daemon.lock'), { force: true, recursive: true });
	}
	sh('okx-a2a daemon start', { allowFail: true });
	if (!daemonState().startsWith('running')) {
		const log = join(homedir(), '.okx-agent-task', 'logs', 'run-nohup.log');
		sh(`nohup okx-a2a run > ${log} 2>&1 & disown`, { allowFail: true });
		// The daemon loads system config and XMTP state before it reports running.
		const until = Date.now() + 20000;
		while (Date.now() < until && !daemonState().startsWith('running')) {
			execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
		}
	}
}

const daemon = daemonState();
if (!daemon.startsWith('running')) {
	console.error(`\ndaemon would not start: ${daemon}`);
	console.error('Check ~/.okx-agent-task/logs/run-nohup.log and logs/listener.log.');
	process.exit(1);
}
step('daemon', daemon);

// 4. Runtime wiring (which AI CLI answers chats) and final plugin setup.
sh('okx-a2a switch-runtime --json', { allowFail: true });
const setup = sh('okx-a2a setup --json', { allowFail: true });
const setupState = (() => {
	try {
		return JSON.parse(setup.split('\n').pop()).state;
	} catch {
		return 'unknown';
	}
})();
step('runtime setup', setupState);

// 5. The AI workspace: this is the cwd the daemon spawns the AI CLI in, so its
//    briefing and .claude/skills are what the chat subsession actually sees.
//    Both filenames are written because the provider is chosen by whichever CLI
//    is credentialed: claude reads CLAUDE.md, codex reads AGENTS.md, and a
//    fallback to the other provider must not silently drop the briefing.
mkdirSync(join(WORKSPACE, '.claude', 'skills'), { recursive: true });

const briefing = execFileSync(process.execPath, [join(REPO, 'scripts', 'okx-listing-payload.mjs'), '--briefing'], {
	encoding: 'utf8',
});
writeFileSync(join(WORKSPACE, 'CLAUDE.md'), briefing);
writeFileSync(join(WORKSPACE, 'AGENTS.md'), briefing);
step('briefing', `${briefing.length} chars from the live catalog module`);

let linked = 0;
for (const name of SKILLS) {
	const src = join(SKILLS_SRC, name);
	if (!existsSync(src)) continue;
	const dest = join(WORKSPACE, '.claude', 'skills', name);
	rmSync(dest, { force: true, recursive: true });
	symlinkSync(src, dest);
	linked++;
}
step('skills', `${linked} linked into the chat subsession`);

// 6. Permissions: without bypass the subsession stalls on tool approval prompts
//    nobody is there to answer, which reads to the buyer as an unresponsive bot.
sh('okx-a2a agent bypass on --json', { allowFail: true });
step('permissions', 'bypass on');

// 7. Wallet session. Everything above is useless while logged out: the daemon
//    takes every XMTP client offline when `onchainos agent get` 401s.
const status = sh('onchainos wallet status', { allowFail: true });
let loggedIn = false;
try {
	loggedIn = JSON.parse(status).data.loggedIn === true;
} catch {
	loggedIn = false;
}

if (!loggedIn) {
	console.log('\nNOT ONLINE: the OKX wallet session is logged out.\n');
	const init = sh('onchainos wallet login --phase init', { allowFail: true });
	try {
		const { authSessionId, loginUrl } = JSON.parse(init).data;
		console.log('A human must finish this login (email OTP, account claude@three.ws):\n');
		console.log(`  ${loginUrl}\n`);
		console.log('Then run:');
		console.log(`  onchainos wallet login --phase poll --session-id ${authSessionId}`);
		console.log('  okx-a2a agent refresh --json     # expect agentCount >= 1, activeClients >= 1');
	} catch {
		console.log('Run `onchainos wallet login --phase init` and open the returned loginUrl.');
	}
	process.exit(2);
}

// 8. Logged in: pull the agent identities so the XMTP clients come online.
const refresh = sh('okx-a2a agent refresh --json', { allowFail: true });
let agentCount = 0;
let activeClients = 0;
try {
	const payload = JSON.parse(refresh).payload ?? {};
	agentCount = payload.agentCount ?? 0;
	activeClients = payload.activeClients ?? 0;
} catch {
	/* refresh may queue instead of completing; the doctor line below is the check */
}
step('agents', `agentCount=${agentCount} activeClients=${activeClients}`);

console.log(`\n${sh('okx-a2a doctor --non-interactive', { allowFail: true })}`);

if (agentCount < 1 || activeClients < 1) {
	console.log(
		'\nLogged in but no active XMTP client yet. The daemon retries every minute;\n' +
			're-run `okx-a2a agent refresh --json` in a moment, and check\n' +
			'~/.okx-agent-task/logs/listener.log if it stays at zero.',
	);
	process.exit(2);
}

console.log('\nONLINE: agent #2632 is reachable in OKX.AI marketplace chat.');
