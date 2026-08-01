// okx-chat-bot: durable state across restarts.
//
// The bot's identity is on disk, not in a database: `~/.onchainos/keyring.enc`
// plus `session.json` and `machine-identity` are what make the wallet session
// survive, and `~/.okx-agent-task/` holds the XMTP client database the daemon
// receives marketplace chat through. Cloud Run's filesystem is in-memory and
// dies with the revision, so without this module every deploy would log the bot
// out and need a fresh human OTP: trading one uptime problem for another.
//
// The whole tree is tarred to one GCS object and restored on boot. Two things
// keep that safe:
//
//   * The service runs --min-instances=1 --max-instances=1, so there is exactly
//     one writer. Concurrent revisions would interleave snapshots.
//   * The SIGTERM path stops the daemon BEFORE snapshotting, so the sqlite files
//     are quiesced rather than copied mid-write. The periodic timer snapshot is
//     a live copy and is best-effort by design: it exists so an ungraceful kill
//     loses minutes, not the identity.
//
// Excluded from the archive: logs (unbounded), downloads (regenerable
// attachments), and the AI workspace (rebuilt from the image at every boot, so
// the briefing can never go stale behind a snapshot).

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getGcpAccessToken } from '../../api/_lib/gcp-auth.js';
import { log } from './log.js';

const run = promisify(execFile);

const TAR_ROOTS = ['.okx-agent-task', '.onchainos'];
const TAR_EXCLUDES = [
	'.okx-agent-task/logs',
	'.okx-agent-task/downloads',
	'.okx-agent-task/workspace',
	'.onchainos/audit.jsonl',
];

const API = 'https://storage.googleapis.com/storage/v1/b';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b';

function objectUrl(cfg) {
	return `${API}/${cfg.stateBucket}/o/${encodeURIComponent(cfg.stateObject)}`;
}

/**
 * Pull the last snapshot into cfg.home. Returns a short verdict string rather
 * than throwing: a missing or unreadable snapshot must not stop the bot from
 * booting, it just means the session starts logged out and a human is paged.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @returns {Promise<'restored'|'empty'|'skipped'|'failed'>}
 */
export async function restoreState(cfg) {
	if (!cfg.stateBucket) return 'skipped';
	const tmp = join('/tmp', 'okx-bot-restore.tar.gz');
	try {
		const token = await getGcpAccessToken();
		const resp = await fetch(`${objectUrl(cfg)}?alt=media`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(120_000),
		});
		if (resp.status === 404) {
			log.info('no state snapshot yet: first boot for this bucket', { object: cfg.stateObject });
			return 'empty';
		}
		if (!resp.ok || !resp.body) throw new Error(`GCS read ${resp.status}`);
		await rm(tmp, { force: true });
		await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmp));
		await mkdir(cfg.home, { recursive: true });
		await run('tar', ['-xzf', tmp, '-C', cfg.home]);
		const bytes = (await stat(tmp)).size;
		log.info('state restored', { object: cfg.stateObject, bytes });
		return 'restored';
	} catch (err) {
		log.warn('state restore failed: booting with empty state', { err: err?.message });
		return 'failed';
	} finally {
		await rm(tmp, { force: true }).catch(() => {});
	}
}

/**
 * Tar cfg.home's durable subtrees and overwrite the GCS object.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {{ reason?: string }} [opts]
 * @returns {Promise<'saved'|'skipped'|'failed'>}
 */
export async function snapshotState(cfg, { reason = 'timer' } = {}) {
	if (!cfg.stateBucket) return 'skipped';
	const tmp = join('/tmp', 'okx-bot-snapshot.tar.gz');
	try {
		const roots = [];
		for (const root of TAR_ROOTS) {
			if (await stat(join(cfg.home, root)).then(() => true).catch(() => false)) roots.push(root);
		}
		if (!roots.length) {
			log.warn('nothing to snapshot: state tree is missing', { home: cfg.home });
			return 'skipped';
		}
		await rm(tmp, { force: true });
		await run('tar', [
			'-czf',
			tmp,
			'-C',
			cfg.home,
			...TAR_EXCLUDES.flatMap((p) => ['--exclude', p]),
			...roots,
		]);
		const bytes = (await stat(tmp)).size;
		const token = await getGcpAccessToken();
		const { readFile } = await import('node:fs/promises');
		const body = await readFile(tmp);
		const resp = await fetch(
			`${UPLOAD}/${cfg.stateBucket}/o?uploadType=media&name=${encodeURIComponent(cfg.stateObject)}`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
				body,
				signal: AbortSignal.timeout(120_000),
			},
		);
		if (!resp.ok) throw new Error(`GCS write ${resp.status} ${(await resp.text()).slice(0, 200)}`);
		log.info('state snapshot saved', { object: cfg.stateObject, bytes, reason });
		return 'saved';
	} catch (err) {
		log.warn('state snapshot failed', { err: err?.message, reason });
		return 'failed';
	} finally {
		await rm(tmp, { force: true }).catch(() => {});
	}
}

// Exported for tests: the archive contract (what is carried, what is rebuilt).
export const STATE_ROOTS = TAR_ROOTS;
export const STATE_EXCLUDES = TAR_EXCLUDES;
