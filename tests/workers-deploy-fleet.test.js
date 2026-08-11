// Drift guard for the Cloud Run fleet runbooks in workers/deploy/.
//
// These three bash scripts carry three hand-maintained maps that nothing else
// validates: service key -> worker dir, service key -> Cloud Run service name,
// and service key -> weights bucket prefix. Every one of them has silently
// drifted from the workers it names, and each kind of drift fails in a way that
// looks like something else entirely:
//
//   wrong worker dir      -> "worker dir not found" halfway through a deploy
//   wrong service name    -> a teardown or scale-down silently skips a service
//   wrong bucket prefix   -> the service deploys fine and 503s on cold start,
//                            because from_pretrained() finds an empty mount
//
// So the maps are parsed straight out of the scripts and checked against the
// workers' own cloudbuild.yaml files, which are the source of truth for the
// service name and the weights paths.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_DIR = resolve(REPO, 'workers/deploy');
const SCRIPTS = ['deploy-all.sh', 'deploy-editing.sh', 'stage-weights.sh'];

const read = (rel) => readFileSync(resolve(REPO, rel), 'utf8');

/** Pull `key) echo value;;` pairs out of one of the scripts' case-statement maps. */
function parseCaseMap(source, fnName) {
	const line = source.split('\n').find((l) => l.trimStart().startsWith(`${fnName}()`));
	if (!line) throw new Error(`${fnName}() not found`);
	const map = {};
	for (const [, key, value] of line.matchAll(/(\w+)\)\s*echo\s+([\w.-]+);;/g)) map[key] = value;
	return map;
}

/** Pull `key) echo "repo|subdir ..." ;;` pairs out of stage-weights.sh. */
function parseWeightSources(source) {
	const map = {};
	for (const [, key, value] of source.matchAll(/^\s*(\w+)\)\s*echo\s+"([^"]+)"\s*;;/gm)) {
		map[key] = value.split(/\s+/).map((pair) => {
			const [repo, subdir] = pair.split('|');
			return { repo, subdir };
		});
	}
	return map;
}

/** A cloudbuild config's `substitutions:` block, as a plain object. */
function parseSubstitutions(yaml) {
	const subs = {};
	const block = yaml.match(/^substitutions:\n((?:[ \t]+.*\n)+)/m);
	if (!block) return subs;
	for (const [, key, value] of block[1].matchAll(/^\s+(_\w+):\s*"?([^"\n]*)"?\s*$/gm)) {
		subs[key] = value.trim();
	}
	return subs;
}

/** Every weights-bucket prefix a cloudbuild config actually reads. */
function weightsPrefixes(yaml) {
	const subs = parseSubstitutions(yaml);
	const resolved = yaml.replace(/\$\{(_\w+)\}/g, (whole, key) => subs[key] ?? whole);
	const prefixes = new Set();
	// FUSE mounts (WEIGHTS_DIR=/weights/x, DINO_DIR, MOTION_MODEL_DIR, ...)
	for (const [, p] of resolved.matchAll(/\/weights\/([A-Za-z0-9._-]+)/g)) prefixes.add(p);
	// Direct GCS staging (WEIGHTS_GCS_URI=gs://bucket/x)
	for (const [, p] of resolved.matchAll(/gs:\/\/[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+)/g)) prefixes.add(p);
	return prefixes;
}

const configFor = (workerDir, file = 'cloudbuild.yaml') => `workers/${workerDir}/${file}`;

describe('workers/deploy fleet scripts', () => {
	it('are valid bash', () => {
		for (const script of SCRIPTS) {
			expect(() => execFileSync('bash', ['-n', resolve(DEPLOY_DIR, script)])).not.toThrow();
		}
	});

	it('name only worker directories that exist and can be built', () => {
		for (const [script, fn] of [['deploy-all.sh', 'svc_dir'], ['deploy-editing.sh', 'svc_dir']]) {
			const map = parseCaseMap(read(`workers/deploy/${script}`), fn);
			expect(Object.keys(map).length).toBeGreaterThan(0);
			for (const [key, dir] of Object.entries(map)) {
				expect(existsSync(resolve(REPO, `workers/${dir}`)), `${script}: ${key} -> workers/${dir}`).toBe(true);
				expect(existsSync(resolve(REPO, configFor(dir))), `${script}: workers/${dir}/cloudbuild.yaml`).toBe(true);
			}
		}
	});

	it('map each service key to the Cloud Run service its cloudbuild deploys', () => {
		for (const [script, dirFn, nameFn] of [
			['deploy-all.sh', 'svc_dir', 'svc_runname'],
			['deploy-editing.sh', 'svc_dir', 'svc_run'],
		]) {
			const source = read(`workers/deploy/${script}`);
			const dirs = parseCaseMap(source, dirFn);
			const names = parseCaseMap(source, nameFn);
			expect(Object.keys(names).sort()).toEqual(Object.keys(dirs).sort());
			for (const [key, dir] of Object.entries(dirs)) {
				const subs = parseSubstitutions(read(configFor(dir)));
				expect(subs._SERVICE, `${script}: ${key} deploys ${configFor(dir)}`).toBe(names[key]);
			}
		}
	});

	it('stage weights into the exact bucket prefix each worker reads', () => {
		// stage-weights key -> the cloudbuild config that consumes those weights.
		// hunyuan3d (2.0) and hunyuan3d21 (2.1) are different models in different
		// prefixes deployed from different configs in the same worker dir.
		const consumers = {
			hunyuan3d: configFor('model-hunyuan3d'),
			hunyuan3d21: configFor('model-hunyuan3d', 'cloudbuild.hunyuan21.yaml'),
			trellis: configFor('model-trellis'),
			triposr: configFor('model-triposr'),
			triposg: configFor('model-triposg'),
		};
		const sources = parseWeightSources(read('workers/deploy/stage-weights.sh'));
		expect(Object.keys(sources).sort()).toEqual(Object.keys(consumers).sort());

		for (const [key, pairs] of Object.entries(sources)) {
			const prefixes = weightsPrefixes(read(consumers[key]));
			for (const { repo, subdir } of pairs) {
				expect(repo, `${key}: every entry is repo|subdir`).toMatch(/^[\w.-]+\/[\w.-]+$/);
				expect(
					prefixes.has(subdir),
					`stage-weights ${key} stages ${repo} into "${subdir}", which ${consumers[key]} never reads (it reads: ${[...prefixes].join(', ')})`,
				).toBe(true);
			}
		}
	});

	it('hand off to Cloud Run, not to the retired Vercel deployment', () => {
		// Production moved off Vercel on 2026-07-07. A `vercel env add` handoff
		// here sends an operator to a disabled project, and the site never picks
		// the new worker URLs up.
		for (const script of SCRIPTS) {
			const source = read(`workers/deploy/${script}`);
			expect(source, `${script}`).not.toMatch(/vercel env add|api\.vercel\.com|VERCEL_TOKEN/);
		}
		const wiring = read('workers/deploy/deploy-all.sh') + read('workers/deploy/deploy-editing.sh');
		expect(wiring).toMatch(/gcloud run services update .*--update-env-vars|--update-env-vars/s);
		// --set-env-vars REPLACES the whole env set and would drop every other
		// variable three-ws-api needs, so it must never appear in the wiring.
		expect(wiring).not.toMatch(/--set-env-vars\s+\$?\{?SITE_ENV/);
	});

	it('build every fleet worker under a pinned service account', () => {
		// This project has no default compute service account, so a config with no
		// serviceAccount pin fails the build outright.
		const dirs = new Set([
			...Object.values(parseCaseMap(read('workers/deploy/deploy-all.sh'), 'svc_dir')),
			...Object.values(parseCaseMap(read('workers/deploy/deploy-editing.sh'), 'svc_dir')),
			'avatar-pipeline-controller',
		]);
		for (const dir of dirs) {
			expect(read(configFor(dir)), `workers/${dir}/cloudbuild.yaml`).toMatch(
				/^serviceAccount: projects\/[\w-]+\/serviceAccounts\/[^\s]+$/m,
			);
		}
	});

	it('deploy the controller that deploy-all.sh wires its backends into', () => {
		const source = read('workers/deploy/deploy-all.sh');
		const controller = parseSubstitutions(read(configFor('avatar-pipeline-controller')))._SERVICE;
		expect(source).toContain(`workers/avatar-pipeline-controller/cloudbuild.yaml`);
		expect(source).toContain(`gcloud run services update ${controller}`);

		// Every backend the script wires must be an env var the controller reads.
		const controllerMain = read('workers/avatar-pipeline-controller/main.py');
		for (const envVar of Object.values(parseCaseMap(source, 'svc_ctrlenv'))) {
			expect(controllerMain, `controller reads ${envVar}`).toContain(envVar);
		}
	});
});
