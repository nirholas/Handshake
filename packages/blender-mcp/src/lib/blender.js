// Locate and drive a local Blender install in background mode.
//
// Every tool call is one `blender -b --factory-startup --python runner.py`
// process. That is deliberate: a crashed job cannot corrupt the next one, and
// nothing has to stay resident between calls. --factory-startup keeps a user's
// saved preferences and third-party add-ons out of the result, so a conversion
// is reproducible on any machine.
//
// The runner writes its payload to a result FILE, never to stdout, because
// Blender prints progress, add-on chatter, and render statistics on stdout and
// picking a payload out of that stream is guesswork. A missing result file is
// therefore an unambiguous signal that Blender died, and the log tail says why.

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLENDER_PATH, JOB_TIMEOUT_MS, MAX_CONCURRENCY, WORKDIR } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER_PATH = path.join(HERE, '..', 'py', 'runner.py');

// Blender 3.0 is the floor: it is the first release with the operator surface
// the runner relies on, and matches what the glTF add-on supports.
const MIN_VERSION = [3, 0];

const LOG_TAIL_BYTES = 4000;

let cached = null;
let inFlight = null;

function candidatePaths() {
	const found = [];
	if (BLENDER_PATH) found.push(BLENDER_PATH);

	const exe = process.platform === 'win32' ? 'blender.exe' : 'blender';
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		if (dir) found.push(path.join(dir, exe));
	}

	if (process.platform === 'darwin') {
		found.push('/Applications/Blender.app/Contents/MacOS/Blender');
		found.push(path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'));
	} else if (process.platform === 'win32') {
		for (const root of ['C:\\Program Files\\Blender Foundation', 'C:\\Program Files (x86)\\Blender Foundation']) {
			for (const version of ['4.5', '4.4', '4.3', '4.2', '4.1', '4.0', '3.6']) {
				found.push(path.join(root, `Blender ${version}`, 'blender.exe'));
			}
		}
	} else {
		found.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/opt/blender/blender');
	}
	return found;
}

/**
 * Probe one candidate with `--version`.
 *
 * Returns `{ version, tuple }` on success, or `{ error }` naming what went
 * wrong. The distinction matters: a spawn that fails because the host is out of
 * memory is transient and worth retrying, while a binary that is not Blender
 * never will be. Collapsing both into "not found" is what turns a busy machine
 * into a message telling the user to install software they already have.
 */
function runVersion(binary) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (err) {
			resolve({ error: `spawn failed: ${err.message}`, transient: true });
			return;
		}
		let out = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, 20000);
		child.stdout.on('data', (chunk) => {
			out += chunk;
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ error: `spawn failed: ${err.message}`, transient: true });
		});
		child.on('close', () => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({ error: '--version did not answer within 20s', transient: true });
				return;
			}
			const match = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(out);
			if (!match) {
				resolve({ error: 'ran, but did not identify itself as Blender', transient: false });
				return;
			}
			resolve({
				version: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
				tuple: [Number(match[1]), Number(match[2]), Number(match[3] || 0)],
			});
		});
	});
}

/**
 * Find a usable Blender executable, once per process.
 *
 * @returns {Promise<{path: string, version: string, tuple: number[]}>}
 * @throws {Error} code 'blender_not_found' or 'blender_too_old', with an actionable message.
 */
export async function resolveBlender() {
	if (cached) return cached;
	// Parallel tool calls must share one discovery pass. Without this, several
	// calls each spawn their own `--version` probes at the same moment, which is
	// exactly the memory pressure that makes probing fail.
	if (inFlight) return inFlight;
	inFlight = discoverBlender().finally(() => {
		inFlight = null;
	});
	return inFlight;
}

async function probeCandidates(candidates) {
	const diagnostics = [];
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
		} catch {
			continue; // Nothing there: not worth reporting, the list is speculative.
		}
		const info = await runVersion(candidate);
		if (info.error) {
			diagnostics.push({ path: candidate, problem: info.error, transient: info.transient });
			continue;
		}
		if (info.tuple[0] < MIN_VERSION[0] || (info.tuple[0] === MIN_VERSION[0] && info.tuple[1] < MIN_VERSION[1])) {
			throw Object.assign(
				new Error(
					`Blender ${info.version} at ${candidate} is too old. This server needs ${MIN_VERSION.join('.')} or newer.`,
				),
				{ code: 'blender_too_old' },
			);
		}
		return { found: { path: candidate, version: info.version, tuple: info.tuple }, diagnostics };
	}
	return { found: null, diagnostics };
}

async function discoverBlender() {
	const candidates = [...new Set(candidatePaths())];
	let { found, diagnostics } = await probeCandidates(candidates);

	// A Blender that exists but would not answer is a transient condition on a
	// loaded machine, not a missing install. Give it one more chance before
	// telling anyone their setup is wrong.
	if (!found && diagnostics.some((entry) => entry.transient)) {
		await new Promise((resolve) => setTimeout(resolve, 750));
		const retry = await probeCandidates(diagnostics.filter((entry) => entry.transient).map((entry) => entry.path));
		if (retry.found) found = retry.found;
		else diagnostics = [...diagnostics, ...retry.diagnostics];
	}

	if (found) {
		cached = found;
		return cached;
	}

	if (diagnostics.length > 0) {
		throw Object.assign(
			new Error(
				`Blender is installed at ${diagnostics[0].path} but could not be run: ${diagnostics[0].problem}. ` +
					'On a loaded machine this is usually transient (retry the call); otherwise check that the executable ' +
					'works by running it yourself, or point BLENDER_PATH at a different one.',
			),
			{ code: 'blender_unusable', diagnostics },
		);
	}

	throw Object.assign(
		new Error(
			'No Blender executable found. Install Blender 3.0 or newer from https://www.blender.org/download/ ' +
				'and either put it on PATH or set BLENDER_PATH to the executable ' +
				'(macOS: /Applications/Blender.app/Contents/MacOS/Blender).',
		),
		{ code: 'blender_not_found', tried: candidates.slice(0, 12) },
	);
}

/** Reset the cached executable. Tests use this; nothing else needs it. */
export function resetBlenderCache() {
	cached = null;
	inFlight = null;
}

function tail(text) {
	const trimmed = String(text || '');
	return trimmed.length > LOG_TAIL_BYTES ? trimmed.slice(-LOG_TAIL_BYTES) : trimmed;
}

/** Create the shared workdir on demand and return it. */
export async function ensureWorkdir() {
	await mkdir(WORKDIR, { recursive: true });
	return WORKDIR;
}

// Blender costs a few hundred MB per process, so unbounded parallelism on a
// small machine turns into spawn failures rather than throughput. Calls queue
// instead of competing.
let running = 0;
const waiting = [];

async function acquireSlot() {
	if (running < MAX_CONCURRENCY) {
		running += 1;
		return;
	}
	await new Promise((resolve) => waiting.push(resolve));
	running += 1;
}

function releaseSlot() {
	running -= 1;
	const next = waiting.shift();
	if (next) next();
}

/**
 * Run one job through the in-Blender runner and return its payload.
 *
 * @param {object} job              `{ op, ... }`, matching src/py/runner.py.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>} The runner payload (always `ok: true` on return).
 * @throws {Error} with `.code` ('timeout' | 'blender_crashed' | the runner's own code)
 *   and, when Blender produced diagnostics, `.log`.
 */
export async function runJob(job, { timeoutMs } = {}) {
	const blender = await resolveBlender();
	await ensureWorkdir();
	await acquireSlot();
	const dir = await mkdtemp(path.join(WORKDIR, 'job-'));
	const jobPath = path.join(dir, 'job.json');
	const resultPath = path.join(dir, 'result.json');
	const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : JOB_TIMEOUT_MS;

	try {
		await writeFile(jobPath, JSON.stringify(job), 'utf8');

		const args = ['-b', '--factory-startup', '-noaudio', '--python', RUNNER_PATH, '--', jobPath, resultPath];
		const outcome = await new Promise((resolve, reject) => {
			const child = spawn(blender.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill('SIGKILL');
			}, limit);

			child.stdout.on('data', (chunk) => {
				stdout = tail(stdout + chunk);
			});
			child.stderr.on('data', (chunk) => {
				stderr = tail(stderr + chunk);
			});
			child.on('error', (err) => {
				clearTimeout(timer);
				reject(Object.assign(new Error(`Could not start Blender: ${err.message}`), { code: 'blender_spawn_failed' }));
			});
			child.on('close', (code, signal) => {
				clearTimeout(timer);
				if (timedOut) {
					reject(
						Object.assign(new Error(`Blender job "${job.op}" exceeded ${limit}ms and was killed.`), {
							code: 'timeout',
							log: tail(`${stdout}\n${stderr}`),
						}),
					);
					return;
				}
				resolve({ code, signal, log: tail(`${stdout}\n${stderr}`) });
			});
		});

		let payload;
		try {
			payload = JSON.parse(await readFile(resultPath, 'utf8'));
		} catch {
			throw Object.assign(
				new Error(
					`Blender exited ${outcome.signal ? `on ${outcome.signal}` : `with code ${outcome.code}`} without writing a result. ` +
						'The log tail below is what it printed before dying.',
				),
				{ code: 'blender_crashed', log: outcome.log },
			);
		}

		if (payload.ok === false) {
			throw Object.assign(new Error(payload.message || 'The Blender job failed.'), {
				code: payload.error || 'blender_error',
				...(payload.traceback ? { traceback: payload.traceback } : {}),
				log: outcome.log,
			});
		}
		return { ...payload, blender_path: blender.path };
	} finally {
		releaseSlot();
		await rm(dir, { recursive: true, force: true });
	}
}
