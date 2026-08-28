#!/usr/bin/env node
// x402-preflight — ask any x402 seller whether it can settle, from a terminal.
//
//   npx @three-ws/x402-preflight https://three.ws
//   npx @three-ws/x402-preflight https://three.ws --network solana:mainnet
//   npx @three-ws/x402-preflight https://three.ws --json
//   npx @three-ws/x402-preflight https://three.ws --issuer <pubkey>
//
// Exit codes are the point of the tool, so it composes in a shell and in CI:
//   0  payable (on the requested network, or on any network)
//   1  verified, and NOT payable
//   2  could not be verified (no attestation, bad signature, expired, timeout)
//
// That means `x402-preflight $URL && pay` is a correct one-liner, and a
// monitoring job can alert on exit 1 without parsing anything.

import { preflight, networkVerdict, payableNetworks, PreflightError } from '../src/index.js';

const argv = process.argv.slice(2);
// Flags that take a value, so the positional scan below cannot mistake a flag's
// argument for the origin.
const VALUED = new Set(['network', 'issuer', 'timeout']);
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

let origin;
for (let i = 0; i < argv.length; i += 1) {
	const a = argv[i];
	if (a.startsWith('--')) {
		if (VALUED.has(a.slice(2))) i += 1;
		continue;
	}
	origin = a;
	break;
}
const asJson = has('json');
const network = flag('network');
const issuer = flag('issuer');
const timeoutMs = Number(flag('timeout')) || 5000;

if (!origin || has('help') || has('h')) {
	process.stdout.write(
		`x402-preflight — can this seller actually settle?\n\n` +
			`  x402-preflight <origin> [--network <caip2>] [--issuer <pubkey>]\n` +
			`                          [--timeout <ms>] [--json]\n\n` +
			`Exit codes: 0 payable, 1 not payable, 2 unverifiable.\n\n` +
			`Examples:\n` +
			`  x402-preflight https://three.ws\n` +
			`  x402-preflight https://three.ws --network solana:mainnet && echo "safe to pay"\n`,
	);
	process.exit(origin ? 0 : 2);
}

// ANSI only when a human is looking. Piped output stays clean for grep and jq.
const tty = process.stdout.isTTY && !asJson;
const ESC = '\u001b[';
const c = (code, s) => (tty ? `${ESC}${code}m${s}${ESC}0m` : s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

function mark(payable) {
	if (payable === true) return green('PAYABLE');
	if (payable === false) return red('NOT PAYABLE');
	return yellow('UNKNOWN');
}

function describeSettle(s) {
	if (!s || s.rate == null) return dim('no settle sample in window');
	const pct = (s.rate * 100).toFixed(1);
	return `${pct}% of ${s.attempts} attempts over ${s.window_hours}h ` + dim(`(confidence ${s.confidence})`);
}

try {
	const { envelope, report } = await preflight(origin, { issuer, timeoutMs, cache: false });

	if (asJson) {
		process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
	} else {
		const secondsLeft = Math.max(0, Math.round((Date.parse(report.expires_at) - Date.now()) / 1000));
		process.stdout.write(`\n${report.subject}  ${dim(`signed by ${envelope.issuer}`)}\n`);
		process.stdout.write(dim(`  attestation verified, valid for another ${secondsLeft}s\n\n`));
		for (const [id, n] of Object.entries(report.networks)) {
			process.stdout.write(`  ${mark(n.payable).padEnd(tty ? 20 : 11)} ${id}\n`);
			process.stdout.write(`    reason   ${n.reason}\n`);
			process.stdout.write(`    settle   ${describeSettle(n.settle)}\n`);
			if (n.payable !== true && n.retry_after) {
				process.stdout.write(`    retry    after ${n.retry_after}s\n`);
			}
			if (n.payable !== true && n.alternates?.length) {
				process.stdout.write(`    instead  ${green(n.alternates.join(', '))}\n`);
			}
			process.stdout.write('\n');
		}
	}

	if (network) {
		const v = networkVerdict(envelope, network);
		process.exit(v.payable === true ? 0 : 1);
	}
	process.exit(payableNetworks(envelope).length > 0 ? 0 : 1);
} catch (err) {
	const info = err instanceof PreflightError ? { code: err.code, reason: err.reason } : { code: 'error' };
	if (asJson) {
		process.stdout.write(JSON.stringify({ error: info.code, reason: info.reason, message: err.message }, null, 2) + '\n');
	} else {
		process.stderr.write(`${red('unverifiable')}  ${origin}\n  ${err.message}\n`);
		if (info.code === 'not_supported') {
			process.stderr.write(dim(`  This origin does not publish /.well-known/x402-preflight.\n`));
		}
	}
	process.exit(2);
}
