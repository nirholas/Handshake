#!/usr/bin/env node
/**
 * gpu-capacity: where our Cloud Run GPUs are, which ones are idle, and how to
 * get more.
 *
 * Every 3D engine runs on a Cloud Run GPU, and each region has its OWN grant.
 * The recurring failure is not "we are out of GPUs" — it is that one region is
 * pinned to zero headroom while another region's grant sits untouched, so
 * min-0 services there cannot cold-start and 503 every request (the
 * `gpu-quota-starved` signature). This turns the manual audit in
 * docs/ops/gcp-credits-plan.md into one command, and the manual cross-region
 * port pattern into another.
 *
 *   npm run gpu                                    # audit every GPU region
 *   npm run gpu -- --json                           # machine-readable
 *   npm run gpu -- --port model-triposr --to us-east4          # show the plan
 *   npm run gpu -- --port model-triposr --to us-east4 --apply  # execute it
 *   npm run gpu -- --request 16 --region us-west1              # show the plan
 *   npm run gpu -- --request 16 --region us-west1 --apply      # file it
 *
 * Mutating modes are DRY RUN unless --apply is passed. Config-only Cloud Run
 * updates and quota requests are pre-approved (CLAUDE.md); nothing here builds
 * or deploys an image.
 *
 * Requires an authenticated gcloud. If `gcloud auth print-access-token` fails,
 * that is the sperax.io Workspace reauth policy — the owner runs
 * `gcloud auth login` once; there is no on-machine fallback.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = process.env.GCP_PROJECT || 'aerial-vehicle-466722-p5';

// Cloud Run regions that offer GPUs. Override with --regions a,b,c when Google
// lights up a new one — this list is a convenience, not a contract.
const GPU_REGIONS = ['us-central1', 'us-east4', 'us-west1', 'europe-west1', 'europe-west4', 'asia-southeast1'];

// Quota ids are per accelerator type AND per zonal-redundancy mode. The
// no-zonal-redundancy bucket is the one Cloud Run GPU services draw from by
// default; the redundant bucket is a SEPARATE grant, which is why a region can
// look full and still have capacity under the other mode.
const GPU_QUOTA_LABEL = {
	NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion: 'L4',
	NvidiaL4GpuAllocPerProjectRegion: 'L4 (zonal-redundant)',
	NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion: 'RTX PRO 6000',
	NvidiaRtxPro6000GpuAllocPerProjectRegion: 'RTX PRO 6000 (zonal-redundant)',
};

// An accelerator draws from a DIFFERENT grant per redundancy mode, so a service
// must be counted against the exact bucket it consumes. Getting this wrong is
// not cosmetic: charging an RTX instance to the L4 pool made us-central1 read
// "3/3 pinned, 0 free" when it actually had a spare L4.
const QUOTA_ID = {
	'nvidia-l4': { noRedundancy: 'NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion', redundant: 'NvidiaL4GpuAllocPerProjectRegion' },
	'nvidia-rtx-pro-6000': { noRedundancy: 'NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion', redundant: 'NvidiaRtxPro6000GpuAllocPerProjectRegion' },
};

/** The quota bucket a service consumes, from its accelerator + redundancy mode. */
function quotaIdFor(gpuType, zonalRedundancyDisabled) {
	const pair = QUOTA_ID[gpuType];
	if (!pair) return null;
	return zonalRedundancyDisabled ? pair.noRedundancy : pair.redundant;
}

const C = {
	dim: (s) => `\x1b[2m${s}\x1b[0m`,
	bold: (s) => `\x1b[1m${s}\x1b[0m`,
	red: (s) => `\x1b[31m${s}\x1b[0m`,
	green: (s) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s) => `\x1b[33m${s}\x1b[0m`,
	cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function parseArgs(argv) {
	const opts = {
		json: false,
		regions: GPU_REGIONS,
		port: null,
		to: null,
		request: null,
		region: null,
		apply: false,
		project: PROJECT,
	};
	for (let i = 0; i < argv.length; i++) {
		const next = () => argv[++i];
		switch (argv[i]) {
			case '--json': opts.json = true; break;
			case '--regions': opts.regions = next().split(',').map((s) => s.trim()).filter(Boolean); break;
			case '--port': opts.port = next(); break;
			case '--to': opts.to = next(); break;
			case '--request': opts.request = Number(next()); break;
			case '--region': opts.region = next(); break;
			case '--apply': opts.apply = true; break;
			case '--email': opts.email = next(); break;
			case '--project': opts.project = next(); break;
			case '-h': case '--help': opts.help = true; break;
			default:
				console.error(`unknown flag: ${argv[i]}`);
				process.exit(2);
		}
	}
	return opts;
}

/** Run gcloud, returning { ok, stdout, stderr }. Never throws. */
function gcloud(args, { input } = {}) {
	const r = spawnSync('gcloud', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
	const stderr = r.stderr || '';
	if (/Reauthentication failed|gcloud auth login|invalid_rapt/i.test(stderr)) {
		console.error(C.red('\ngcloud auth has expired (sperax.io Workspace reauth policy).'));
		console.error('There is no on-machine fallback. Run this once, then re-run:\n');
		console.error(C.bold('  gcloud auth login\n'));
		process.exit(3);
	}
	return { ok: r.status === 0, stdout: r.stdout || '', stderr };
}

function gcloudJson(args) {
	const r = gcloud([...args, '--format=json']);
	if (!r.ok) return null;
	try {
		return JSON.parse(r.stdout);
	} catch {
		return null;
	}
}

// ── Audit ────────────────────────────────────────────────────────────────────

const annot = (obj, key) => obj?.metadata?.annotations?.[key];
const scale = (svc, which) => {
	const v = annot(svc.spec?.template, `autoscaling.knative.dev/${which}Scale`);
	const n = Number(v);
	return Number.isFinite(n) ? n : which === 'min' ? 0 : 1;
};

/** GPU services in a region, with the GPU count each instance holds. */
function gpuServices(region, project) {
	const list = gcloudJson(['run', 'services', 'list', '--region', region, '--project', project]) || [];
	const out = [];
	for (const svc of list) {
		const container = svc.spec?.template?.spec?.containers?.[0];
		const gpu = Number(container?.resources?.limits?.['nvidia.com/gpu'] || 0);
		if (!gpu) continue;
		// The accelerator lives in the revision's nodeSelector, NOT in its
		// annotations — the annotation of that name does not exist, so reading
		// there silently defaulted every service to L4.
		const gpuType = svc.spec?.template?.spec?.nodeSelector?.['run.googleapis.com/accelerator'] || 'nvidia-l4';
		const noRedundancy = annot(svc.spec?.template, 'run.googleapis.com/gpu-zonal-redundancy-disabled') === 'true';
		out.push({
			name: svc.metadata?.name,
			gpu,
			gpuType,
			quotaId: quotaIdFor(gpuType, noRedundancy),
			min: scale(svc, 'min'),
			max: scale(svc, 'max'),
			// Pinned GPUs are what actually consume the grant around the clock;
			// burst demand is what the region would need under full load.
			pinned: scale(svc, 'min') * gpu,
			ceiling: scale(svc, 'max') * gpu,
			ready: svc.status?.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
		});
	}
	return out.sort((a, b) => b.pinned - a.pinned || a.name.localeCompare(b.name));
}

/**
 * Quota grants per region, from the preferences we have filed. A region with no
 * preference is reported as unknown rather than zero: it may still carry a
 * default grant, and the fix (file a preference) is the same either way.
 */
function quotaGrants(project) {
	const prefs = gcloudJson(['alpha', 'quotas', 'preferences', 'list', '--project', project]) || [];
	const byRegion = new Map();
	for (const p of prefs) {
		if (!GPU_QUOTA_LABEL[p.quotaId]) continue;
		const region = p.dimensions?.region;
		if (!region) continue;
		if (!byRegion.has(region)) byRegion.set(region, []);
		byRegion.get(region).push({
			quotaId: p.quotaId,
			label: GPU_QUOTA_LABEL[p.quotaId],
			granted: Number(p.quotaConfig?.grantedValue ?? 0),
			preferred: Number(p.quotaConfig?.preferredValue ?? 0),
			reconciling: Boolean(p.reconciling),
			name: (p.name || '').split('/').pop(),
			updated: p.updateTime || p.createTime || null,
		});
	}
	return byRegion;
}

/** The signed-in gcloud account, used as the quota contact address. */
function activeAccount() {
	const r = gcloud(['config', 'get-value', 'account']);
	const v = (r.stdout || '').trim();
	return r.ok && v && v !== '(unset)' ? v : null;
}

const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : null);

const L4_BUCKET = 'NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion';

/** Per-quota-bucket usage, so an RTX instance never charges the L4 pool. */
export function bucketUsage(services, quotas) {
	const buckets = new Map();
	const touch = (quotaId) => {
		if (!buckets.has(quotaId)) {
			const q = quotas.find((x) => x.quotaId === quotaId);
			buckets.set(quotaId, {
				quotaId,
				label: GPU_QUOTA_LABEL[quotaId] || quotaId,
				granted: q ? q.granted : null,
				pinned: 0,
				ceiling: 0,
				services: [],
			});
		}
		return buckets.get(quotaId);
	};
	// Every filed grant is a bucket even with nothing running in it — an unused
	// grant is exactly the capacity this tool exists to surface.
	for (const q of quotas) touch(q.quotaId);
	for (const s of services) {
		if (!s.quotaId) continue;
		const b = touch(s.quotaId);
		b.pinned += s.pinned;
		b.ceiling += s.ceiling;
		b.services.push(s);
	}
	for (const b of buckets.values()) b.headroom = b.granted == null ? null : b.granted - b.pinned;
	return [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function auditCapacity(opts) {
	const project = opts.project || PROJECT;
	const grants = quotaGrants(project);
	const regions = (opts.regions?.length ? opts.regions : GPU_REGIONS).map((region) => {
		const services = gpuServices(region, project);
		const quotas = grants.get(region) || [];
		const buckets = bucketUsage(services, quotas);
		// The L4 no-redundancy pool is what every 3D engine shares; it is the
		// headroom number that drives the recommendations.
		const l4 = buckets.find((b) => b.quotaId === L4_BUCKET);
		return {
			region,
			quotas,
			services,
			buckets,
			pinned: l4 ? l4.pinned : 0,
			ceiling: l4 ? l4.ceiling : 0,
			granted: l4 ? l4.granted : null,
			headroom: l4 ? l4.headroom : null,
			// Only L4 lanes compete for the shared pool; an RTX lane is not starved
			// by it, so it must not be reported as such.
			starved: services.filter((s) => s.min === 0 && s.quotaId === L4_BUCKET),
		};
	});
	return { project, checkedAt: new Date().toISOString(), regions };
}

/** Where to put work, and how to get more capacity. Ordered by time-to-effect. */
export function recommend(report) {
	const out = [];
	const withHeadroom = report.regions.filter((r) => r.headroom != null && r.headroom > 0);
	const saturated = report.regions.filter((r) => r.headroom != null && r.headroom <= 0 && r.services.length);

	for (const r of withHeadroom) {
		const idle = r.granted - r.pinned;
		out.push({
			priority: 1,
			kind: 'use-existing-grant',
			region: r.region,
			detail: `${idle} of ${r.granted} granted GPU(s) unpinned in ${r.region} — capacity we already own.`,
			command: saturated.length
				? `npm run gpu -- --port <service-from-${saturated[0].region}> --to ${r.region} --apply`
				: `gcloud run services update <service> --region ${r.region} --min-instances=1`,
		});
	}

	for (const r of saturated) {
		for (const s of r.starved) {
			out.push({
				priority: 2,
				kind: 'starved-service',
				region: r.region,
				service: s.name,
				detail: `${s.name} is min-0 in a region with no headroom: every cold start races for a GPU that is already pinned, so it 503s.`,
				command: withHeadroom.length
					? `npm run gpu -- --port ${s.name} --to ${withHeadroom[0].region} --apply`
					: `npm run gpu -- --request ${(r.granted || 0) + 8} --region ${r.region} --apply`,
			});
		}
	}

	for (const r of report.regions) {
		const l4 = r.quotas.find((q) => q.quotaId === 'NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion');
		if (!l4) {
			out.push({
				priority: 3,
				kind: 'no-preference-filed',
				region: r.region,
				detail: `No L4 quota preference filed for ${r.region}. Each region is a separate grant; filing one is free and asynchronous.`,
				command: `npm run gpu -- --request 8 --region ${r.region} --apply`,
			});
		} else if (l4.reconciling) {
			const age = daysSince(l4.updated);
			out.push({
				priority: 3,
				kind: 'pending-grant',
				region: r.region,
				detail: `${r.region} L4 raise ${l4.granted} → ${l4.preferred} still reconciling${age != null ? ` after ${age} day(s)` : ''}. Google reviews asynchronously; do not park work on it.`,
				command: `gcloud alpha quotas preferences describe ${l4.name} --project ${report.project}`,
			});
		}
		if (r.ceiling > (r.granted ?? 0) && r.granted != null) {
			out.push({
				priority: 4,
				kind: 'burst-exceeds-grant',
				region: r.region,
				detail: `${r.region} maxScale sums to ${r.ceiling} GPU(s) against a grant of ${r.granted} — under full load the excess fails over instead of scaling.`,
				command: `npm run gpu -- --request ${r.ceiling} --region ${r.region} --apply`,
			});
		}
	}
	return out.sort((a, b) => a.priority - b.priority);
}

function printAudit(report) {
	console.log(`\n${C.bold('Cloud Run GPU capacity')} ${C.dim(`· ${report.project}`)}\n`);
	for (const r of report.regions) {
		if (!r.services.length && !r.quotas.length) {
			console.log(`${C.dim(r.region.padEnd(18))} ${C.dim('no GPU services, no quota preference filed')}`);
			continue;
		}
		const head = r.granted == null
			? C.dim('grant unknown (no preference filed)')
			: r.headroom > 0
				? C.green(`${r.pinned}/${r.granted} pinned · ${r.headroom} free`)
				: C.red(`${r.pinned}/${r.granted} pinned · 0 free`);
		console.log(`${C.bold(r.region.padEnd(18))} ${head}   ${C.dim(`L4 burst ceiling ${r.ceiling}`)}`);
		for (const b of r.buckets) {
			const q = r.quotas.find((x) => x.quotaId === b.quotaId);
			const state = q?.reconciling ? C.yellow(`→ ${q.preferred} pending (${daysSince(q.updated)}d)`) : C.dim('settled');
			const use = b.granted == null
				? C.dim('no grant filed')
				: b.headroom > 0
					? C.green(`${b.pinned}/${b.granted} pinned`)
					: C.red(`${b.pinned}/${b.granted} pinned`);
			console.log(`  ${C.dim('pool')} ${b.label.padEnd(26)} ${use.padEnd(24)} ${state}`);
			for (const s of b.services) {
				const warm = s.min > 0 ? C.cyan(`warm ${s.min}`) : C.dim('scale-to-zero');
				const health = s.ready ? '' : C.red(' NOT READY');
				console.log(`    ${s.name.padEnd(26)} ${warm.padEnd(22)} ${C.dim(`max ${s.max}`)}${health}`);
			}
		}
		console.log('');
	}

	const recs = recommend(report);
	if (!recs.length) {
		console.log(C.green('No capacity action available: every region is either saturated with a pending raise or fully used.\n'));
		return;
	}
	console.log(C.bold('What to do, fastest first:\n'));
	for (const rec of recs) {
		console.log(`  ${C.bold(rec.kind)} ${C.dim(`· ${rec.region}`)}`);
		console.log(`    ${rec.detail}`);
		console.log(`    ${C.cyan(rec.command)}\n`);
	}
}

// ── Cross-region port ────────────────────────────────────────────────────────
// The documented no-rebuild pattern (docs/ops/gcp-credits-plan.md §us-east4):
// export the service, retarget its location, replace it in the new region, and
// mirror the invoker IAM. Images pull cross-region from the us-central1
// Artifact Registry and weights mount from GCS either way, so nothing rebuilds.

/** Find which region currently hosts a service. */
function locateService(name, regions, project) {
	for (const region of regions) {
		const svc = gcloudJson(['run', 'services', 'describe', name, '--region', region, '--project', project]);
		if (svc) return { region, svc };
	}
	return null;
}

export function retargetExport(yaml, from, to) {
	return yaml
		.split('\n')
		// Read-only, region-scoped URLs; carrying them into a new region is rejected.
		.filter((line) => !/^\s*run\.googleapis\.com\/urls:/.test(line))
		// The revision name is region-unique; letting Cloud Run mint a fresh one
		// avoids a collision with the source region's revision history.
		.filter((line) => !/^\s*name:\s*\S+-\d{5}-\w{3}\s*$/.test(line))
		.map((line) => line.replace(
			new RegExp(`(cloud\\.googleapis\\.com/location:\\s*)${from}\\s*$`),
			`$1${to}`,
		))
		.join('\n');
}

function portService(opts) {
	const { port: name, to, apply, project } = opts;
	if (!to) {
		console.error('--port requires --to <region>');
		process.exit(2);
	}
	const found = locateService(name, opts.regions, project);
	if (!found) {
		console.error(`service ${name} not found in any of: ${opts.regions.join(', ')}`);
		process.exit(1);
	}
	if (found.region === to) {
		console.error(`${name} already lives in ${to}`);
		process.exit(1);
	}

	const exported = gcloud(['run', 'services', 'describe', name, '--region', found.region, '--project', project, '--format=export']);
	if (!exported.ok) {
		console.error(`could not export ${name}: ${exported.stderr.trim()}`);
		process.exit(1);
	}
	const retargeted = retargetExport(exported.stdout, found.region, to);
	const dir = mkdtempSync(join(tmpdir(), 'gpu-port-'));
	const file = join(dir, `${name}.yaml`);
	writeFileSync(file, retargeted);

	const policy = gcloudJson(['run', 'services', 'get-iam-policy', name, '--region', found.region, '--project', project]);

	console.log(`\n${C.bold(`Port ${name}: ${found.region} → ${to}`)}\n`);
	console.log(`  spec written to ${C.dim(file)}`);
	console.log(`  ${C.cyan(`gcloud run services replace ${file} --region ${to} --project ${project}`)}`);
	if (policy?.bindings?.length) {
		console.log(`  ${C.cyan(`gcloud run services set-iam-policy ${name} <policy.json> --region ${to} --project ${project}`)}`);
		console.log(`  ${C.dim(`mirrors ${policy.bindings.length} binding(s): ${policy.bindings.map((b) => b.role).join(', ')}`)}`);
	}
	console.log(`\n  ${C.dim('The image pulls cross-region from the us-central1 Artifact Registry and')}`);
	console.log(`  ${C.dim('weights mount from the three-ws-model-weights GCS bucket, so nothing rebuilds.')}`);
	console.log(`  ${C.yellow('After this lands, point the caller at the new URL (config-only):')}`);
	console.log(`  ${C.dim(`gcloud run services update three-ws-api --region us-central1 --update-env-vars <VAR>=<new-url>`)}\n`);

	if (!apply) {
		console.log(C.yellow('DRY RUN — re-run with --apply to execute.\n'));
		return;
	}

	const replaced = gcloud(['run', 'services', 'replace', file, '--region', to, '--project', project]);
	process.stdout.write(replaced.stdout);
	if (!replaced.ok) {
		console.error(C.red(`replace failed:\n${replaced.stderr}`));
		process.exit(1);
	}
	if (policy?.bindings?.length) {
		const pfile = join(dir, 'policy.json');
		writeFileSync(pfile, JSON.stringify({ bindings: policy.bindings }, null, 2));
		const iam = gcloud(['run', 'services', 'set-iam-policy', name, pfile, '--region', to, '--project', project, '--quiet']);
		if (!iam.ok) console.error(C.yellow(`IAM mirror failed (bind manually):\n${iam.stderr}`));
	}
	const url = gcloudJson(['run', 'services', 'describe', name, '--region', to, '--project', project])?.status?.url;
	console.log(C.green(`\n${name} is live in ${to}${url ? `: ${url}` : ''}\n`));
}

// ── Quota request ────────────────────────────────────────────────────────────

function requestQuota(opts) {
	const { request: value, region, apply, project } = opts;
	if (!region) {
		console.error('--request requires --region <region>');
		process.exit(2);
	}
	if (!Number.isInteger(value) || value < 1) {
		console.error('--request takes a positive integer GPU count');
		process.exit(2);
	}
	const quotaId = 'NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion';
	const existing = (quotaGrants(project).get(region) || []).find((q) => q.quotaId === quotaId);
	const prefName = existing?.name || `l4-no-zonal-${region}-${value}`;
	// Any INCREASE is rejected without a contact address Google can reach for
	// follow-up questions. Default to the active gcloud account rather than
	// making the caller remember the flag.
	const email = opts.email || activeAccount();
	// `update` takes the preference id POSITIONALLY; only `create` uses the
	// --preference-id flag. Passing the flag to update fails with "unrecognized
	// arguments", which reads like a quota rejection but is pure CLI shape.
	const args = [
		'alpha', 'quotas', 'preferences', existing ? 'update' : 'create',
		...(existing ? [prefName] : ['--preference-id', prefName]),
		'--project', project,
		'--service', 'run.googleapis.com',
		'--quota-id', quotaId,
		'--preferred-value', String(value),
		'--dimensions', `region=${region}`,
		...(email ? ['--email', email] : []),
		...(existing ? ['--allow-missing'] : []),
	];

	console.log(`\n${C.bold(`L4 quota request · ${region}`)}\n`);
	console.log(`  current grant: ${existing ? existing.granted : C.dim('none filed')}`);
	console.log(`  requesting:    ${value}`);
	console.log(`  contact:       ${email || C.red('none — Google rejects an increase without one (--email)')}`);
	console.log(`  ${C.cyan(`gcloud ${args.join(' ')}`)}\n`);
	if (!apply) {
		console.log(C.yellow('DRY RUN — re-run with --apply to file it.\n'));
		return;
	}
	const r = gcloud(args);
	process.stdout.write(r.stdout);
	if (!r.ok) {
		console.error(C.red(`request failed:\n${r.stderr}`));
		process.exit(1);
	}
	console.log(C.green('\nFiled. Google reviews asynchronously — route around the shortage meanwhile.\n'));
}

// ── Entry ────────────────────────────────────────────────────────────────────
// Guarded so the pure helpers above (retargetExport, recommend) can be unit
// tested without the CLI running on import.

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (!invokedDirectly) { /* imported for tests */ } else {

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
	console.log(`
  npm run gpu                                            audit every GPU region
  npm run gpu -- --json                                  machine-readable audit
  npm run gpu -- --regions us-central1,us-east4          limit the sweep
  npm run gpu -- --port <service> --to <region> [--apply] move a service to a region with headroom
  npm run gpu -- --request <n> --region <region> [--apply] raise that region's L4 grant
`);
	process.exit(0);
}

if (opts.port) {
	portService(opts);
} else if (opts.request != null) {
	requestQuota(opts);
} else {
	const report = auditCapacity(opts);
	if (opts.json) {
		console.log(JSON.stringify({ ...report, recommendations: recommend(report) }, null, 2));
	} else {
		printAudit(report);
	}
	const actionable = recommend(report).filter((r) => r.priority <= 2).length;
	process.exit(actionable ? 1 : 0);
}

}
