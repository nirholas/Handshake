#!/usr/bin/env node
// Seed the OKX chat bot's GCS state object from a machine that already holds a
// live wallet session, so the first Cloud Run boot comes up authenticated
// instead of paging a human for an email OTP it did not need to ask for.
//
// workers/okx-chat-bot/state.js writes the same archive on the deployed host,
// but it authenticates through ADC and a developer codespace has none. This
// script builds a byte-compatible archive from the SAME exported contract
// (STATE_ROOTS / STATE_EXCLUDES, so the two can never drift) and uploads it with
// gcloud, which is authenticated here.
//
//   node scripts/okx-bot-seed-state.mjs            # plan only, writes nothing remote
//   node scripts/okx-bot-seed-state.mjs --apply    # build and upload
//   node scripts/okx-bot-seed-state.mjs --apply --force   # upload with the daemon running
//
// The archive carries the wallet keyring and the XMTP identity. It belongs in
// the private state bucket and nowhere else: never copy it elsewhere, never
// attach it to a report, never commit it.

import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { STATE_ROOTS, STATE_EXCLUDES } from '../workers/okx-chat-bot/state.js';

const run = promisify(execFile);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const HOME = process.env.OKX_BOT_HOME || homedir();
const BUCKET = process.env.OKX_BOT_STATE_BUCKET || 'three-ws-okx-bot-state';
const OBJECT = process.env.OKX_BOT_STATE_OBJECT || 'okx-chat-bot/state.tar.gz';
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'aerial-vehicle-466722-p5';
const ARCHIVE = join(tmpdir(), 'okx-bot-seed.tar.gz');

const say = (...m) => console.log(...m);
const die = (msg, code = 1) => {
	console.error(`\n  FAILED: ${msg}\n`);
	process.exit(code);
};

const exists = (p) => stat(p).then(() => true).catch(() => false);

/**
 * A snapshot taken while the daemon is writing can tear: the XMTP sqlite files
 * are copied mid-write and the restored identity is corrupt, which costs a human
 * OTP to recover. The deployed host avoids this by stopping the daemon before
 * its shutdown snapshot; here the operator has to.
 */
async function daemonIsRunning() {
	const r = await run('okx-a2a', ['daemon', 'status'], { timeout: 20_000 }).catch((err) => ({
		stdout: String(err?.stdout || ''),
	}));
	return (r.stdout || '').trim().startsWith('running');
}

function gcloud(argv) {
	return run('gcloud', [...argv, '--project', PROJECT], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
}

async function main() {
	const roots = [];
	for (const root of STATE_ROOTS) {
		if (await exists(join(HOME, root))) roots.push(root);
		else say(`  note: ${root} is missing under ${HOME}, skipping it`);
	}
	if (!roots.length) die(`no state to seed: neither ${STATE_ROOTS.join(' nor ')} exists under ${HOME}`);

	if (await daemonIsRunning()) {
		if (!FORCE) {
			die(
				'the okx-a2a daemon is running, so its sqlite files are being written and the archive could tear.\n' +
					'  Stop it first (the worker does this on SIGTERM), or pass --force if you accept a live copy.',
			);
		}
		say('  WARNING: --force with a running daemon: this is a live copy and may tear');
	}

	await rm(ARCHIVE, { force: true });
	await run('tar', ['-czf', ARCHIVE, '-C', HOME, ...STATE_EXCLUDES.flatMap((p) => ['--exclude', p]), ...roots]);
	const bytes = (await stat(ARCHIVE)).size;

	say(`\n  home     ${HOME}`);
	say(`  roots    ${roots.join(', ')}`);
	say(`  archive  ${ARCHIVE} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
	say(`  target   gs://${BUCKET}/${OBJECT}`);

	if (!APPLY) {
		await rm(ARCHIVE, { force: true });
		say('\n  plan only: nothing was uploaded. Re-run with --apply to seed the bucket.\n');
		return;
	}

	try {
		await gcloud(['storage', 'cp', ARCHIVE, `gs://${BUCKET}/${OBJECT}`]);
		const { stdout } = await gcloud([
			'storage',
			'objects',
			'describe',
			`gs://${BUCKET}/${OBJECT}`,
			'--format=value(size,generation,updated)',
		]);
		say(`\n  seeded: ${stdout.trim()}`);
		say('\n  The next okx-chat-bot boot restores this session instead of asking for an OTP.');
		say('  Exactly one host may write this object, so stop the seeding host before the');
		say('  Cloud Run service starts, or the two interleave snapshots.\n');
	} finally {
		await rm(ARCHIVE, { force: true });
	}
}

main().catch((err) => die(err?.message || String(err)));
