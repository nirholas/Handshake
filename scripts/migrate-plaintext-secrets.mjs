#!/usr/bin/env node
// Move plaintext secret-bearing env vars off a Cloud Run service and into
// Secret Manager, then point the service at the secrets instead.
//
// WHY THIS EXISTS
//   A literal `value:` entry in a Cloud Run service config is readable by any
//   principal holding run.services.get on the project. A credential stored that
//   way (a wallet secret key, an API token, a database URL) is therefore only as
//   private as the broadest viewer role on the project. A `valueFrom.secretKeyRef`
//   is not: reading it needs secretmanager.versions.access on that one secret,
//   which this tool grants to the runtime service account and to nobody else.
//
// WHAT IT DOES
//   1. Reads the live service config and splits every env var into three groups:
//      already a secretKeyRef, a plaintext literal that looks like a credential,
//      and a plaintext literal that is public config (an address, a mint, a key
//      id, anything containing PUBLIC).
//   2. For each credential: reuses the Secret Manager secret that already holds
//      that exact value when one exists, otherwise creates the secret and adds
//      the live value as a version.
//   3. Grants the service's own runtime service account
//      roles/secretmanager.secretAccessor on that one secret. Never project-wide.
//   4. Flips every migrated var in ONE `gcloud run services update
//      --update-secrets` call, which both attaches the secret and drops the
//      plaintext literal.
//   5. Re-reads the service and asserts the new revision holds no plaintext
//      literal for any migrated var and carries 100% of traffic.
//
// SAFETY
//   * Dry run by default. Nothing is written without --apply.
//   * Secret values are never printed, never passed as a CLI argument, and never
//     written to disk. Versions are added over stdin; comparisons are done on a
//     SHA-256 digest held in memory.
//   * An existing secret whose latest version differs from the live value is
//     REFUSED, not overwritten (another var may depend on it). Pass
//     --force-new-version to add the live value as a new version anyway.
//   * The classifier's "leave as config" decisions are printed with reasons on
//     every run, so a wrong call is visible before --apply, and --include
//     overrides it per var.
//
// USAGE
//   node scripts/migrate-plaintext-secrets.mjs                       # plan, writes nothing
//   node scripts/migrate-plaintext-secrets.mjs --only ECONOMY_MASTER_SECRET_BASE58 --apply
//   node scripts/migrate-plaintext-secrets.mjs --apply               # migrate every credential found
//   node scripts/migrate-plaintext-secrets.mjs --verify              # assert the end state only
//
//   --only A,B            restrict to these env vars
//   --include A,B         also migrate these, overriding the "public config" call
//   --exclude A,B         never migrate these
//   --map ENV=secret-name pin a var to a specific Secret Manager secret
//   --force-new-version   add a version to an existing secret whose value differs
//   --service/--region/--project  target something other than three-ws-api
//
// Verify the service still works after --apply: compare /api/healthz against the
// reading you took before, and confirm a signing path that uses the migrated key
// (for the economy master that is the treasury-topup cron, visible in
// /api/ops/payment-outcomes and the healthz subsystem block).

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import './lib/gcloud-path.mjs';

const execFileP = promisify(execFile);

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const VERIFY_ONLY = argv.includes('--verify');
const FORCE_NEW_VERSION = argv.includes('--force-new-version');

function optValue(flag, fallback) {
	const i = argv.indexOf(flag);
	return i === -1 ? fallback : argv[i + 1];
}
function optList(flag) {
	const raw = optValue(flag, '');
	return String(raw || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

const SERVICE = optValue('--service', 'three-ws-api');
const REGION = optValue('--region', 'us-central1');
const PROJECT = optValue('--project', 'aerial-vehicle-466722-p5');
const ONLY = optList('--only');
const INCLUDE = optList('--include');
const EXCLUDE = optList('--exclude');

const NAME_MAP = new Map();
for (let i = 0; i < argv.length; i++) {
	if (argv[i] !== '--map') continue;
	const [env, ...rest] = String(argv[i + 1] || '').split('=');
	if (!env || !rest.length) fail(`--map expects ENV=secret-name, got "${argv[i + 1]}"`);
	NAME_MAP.set(env, rest.join('='));
}

// A name segment from this set means the value is a credential.
const SECRET_SEGMENTS = new Set([
	'SECRET',
	'SECRETS',
	'KEY',
	'KEYS',
	'KEYPAIR',
	'TOKEN',
	'TOKENS',
	'PRIVATE',
	'PASSWORD',
	'PASSWD',
	'MNEMONIC',
	'CREDENTIAL',
	'CREDENTIALS',
	'APIKEY',
	'DSN',
	'JWT',
]);

// A name segment from this set means the value is a public identifier, even when
// another segment matched above. In a crypto codebase TOKEN and KEY are heavily
// overloaded: THREE_TOKEN_MINT is an address, not a credential.
const PUBLIC_SEGMENTS = new Set(['PUBLIC', 'PUBKEY', 'ADDRESS', 'MINT', 'ISSUER', 'AUDIENCE']);

// Suffixes that name a credential's handle rather than the credential itself.
const PUBLIC_SUFFIXES = [
	'_KEY_ID',
	'_KEY_NAME',
	'_KEY_RING',
	'_KEY_PATH',
	'_KEY_FILE',
	'_KEYFILE',
	'_SECRET_NAME',
	'_SECRET_ID',
	'_TOKEN_NAME',
	'_TOKEN_SYMBOL',
	'_TOKEN_DECIMALS',
	'_TOKEN_URI',
];

// Credentials whose names carry no telltale segment.
const EXTRA_SECRETS = new Set([
	'DATABASE_URL',
	'DATABASE_URL_UNPOOLED',
	'POSTGRES_URL',
	'POSTGRES_URL_NON_POOLING',
	'REDIS_URL',
	'A2A_PAYER_SOLANA_SECRET',
]);

function fail(msg) {
	console.error(`\n  FAILED: ${msg}\n`);
	process.exit(1);
}

export function classify(name) {
	if (EXCLUDE.includes(name)) return { secret: false, reason: 'excluded by --exclude' };
	if (INCLUDE.includes(name)) return { secret: true, reason: 'forced by --include' };
	if (EXTRA_SECRETS.has(name)) return { secret: true, reason: 'known credential' };
	const suffix = PUBLIC_SUFFIXES.find((s) => name.endsWith(s));
	if (suffix) return { secret: false, reason: `names a handle, not a value (${suffix})` };
	const segments = name.split('_');
	const publicSegment = segments.find((s) => PUBLIC_SEGMENTS.has(s));
	if (publicSegment) return { secret: false, reason: `public identifier (${publicSegment})` };
	const secretSegment = segments.find((s) => SECRET_SEGMENTS.has(s));
	if (secretSegment) return { secret: true, reason: `credential-bearing name (${secretSegment})` };
	// A provider URL routinely carries its key in the query string (Helius, Alchemy,
	// QuickNode all do). The name cannot say whether this one does, so it is
	// surfaced for a human call instead of being silently filed as public config.
	if (/_(URL|URI|ENDPOINT)$/.test(name)) {
		return { secret: false, review: true, reason: 'URL: may embed a key in its query string' };
	}
	// A JWK is a public key half the time and a signing key the other half. The
	// name cannot tell them apart, so an operator decides.
	if (/_JWKS?$/.test(name)) {
		return { secret: false, review: true, reason: 'JWK: private signing keys and public verification keys share this name' };
	}
	return { secret: false, reason: 'no credential marker in the name' };
}

// x402-fee-payer-secret-base58 and upstash-redis-rest-token are the shape the
// existing secrets on this project already use: the env var name, lowercased,
// underscores to hyphens.
export function defaultSecretName(env) {
	return env.toLowerCase().replace(/_/g, '-');
}

function digest(value) {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function gcloud(args, { input } = {}) {
	return execFileP('gcloud', [...args, `--project=${PROJECT}`], {
		maxBuffer: 16 * 1024 * 1024,
		...(input === undefined ? {} : { input }),
	});
}

// execFile cannot feed stdin, so version writes go through execFileSync, which
// keeps the value off the argument list and out of the process table.
function gcloudWithStdin(args, input) {
	return execFileSync('gcloud', [...args, `--project=${PROJECT}`], {
		input,
		encoding: 'utf8',
		maxBuffer: 4 * 1024 * 1024,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

async function describeService() {
	let out;
	try {
		({ stdout: out } = await gcloud([
			'run',
			'services',
			'describe',
			SERVICE,
			`--region=${REGION}`,
			'--format=json',
		]));
	} catch (e) {
		const detail = (e?.stderr || e?.message || '').trim().split('\n').slice(0, 4).join(' ');
		fail(`could not read ${SERVICE} in ${REGION}: ${detail}`);
	}
	const svc = JSON.parse(out);
	const container = svc?.spec?.template?.spec?.containers?.[0] || {};
	return {
		raw: svc,
		env: container.env || [],
		serviceAccount: svc?.spec?.template?.spec?.serviceAccountName || null,
		latestReady: svc?.status?.latestReadyRevisionName || null,
		traffic: svc?.status?.traffic || [],
	};
}

function partition(env) {
	const alreadySecret = [];
	const credentials = [];
	const config = [];
	const review = [];
	for (const entry of env) {
		const name = entry.name;
		if (ONLY.length && !ONLY.includes(name)) continue;
		if (entry.valueFrom?.secretKeyRef) {
			alreadySecret.push({ name, secret: entry.valueFrom.secretKeyRef.name, key: entry.valueFrom.secretKeyRef.key });
			continue;
		}
		const value = entry.value ?? '';
		const verdict = classify(name);
		if (!verdict.secret) {
			(verdict.review ? review : config).push({ name, reason: verdict.reason });
			continue;
		}
		if (!value) {
			config.push({ name, reason: 'credential-bearing name but the value is empty' });
			continue;
		}
		credentials.push({ name, value, reason: verdict.reason, secretName: NAME_MAP.get(name) || defaultSecretName(name) });
	}
	return { alreadySecret, credentials, config, review };
}

async function secretExists(name) {
	try {
		await gcloud(['secrets', 'describe', name, '--format=value(name)']);
		return true;
	} catch {
		return false;
	}
}

async function latestVersionDigest(name) {
	try {
		const { stdout } = await gcloud(['secrets', 'versions', 'access', 'latest', `--secret=${name}`]);
		return digest(stdout);
	} catch {
		return null;
	}
}

async function prepareSecret(item) {
	const exists = await secretExists(item.secretName);
	const liveDigest = digest(item.value);
	if (!exists) {
		if (!APPLY) return { action: 'create secret + add version 1' };
		await gcloud(['secrets', 'create', item.secretName, '--replication-policy=automatic']);
		gcloudWithStdin(['secrets', 'versions', 'add', item.secretName, '--data-file=-'], item.value);
		return { action: 'created secret, added version 1' };
	}
	const existingDigest = await latestVersionDigest(item.secretName);
	if (existingDigest === liveDigest) {
		return { action: 'reused existing secret (latest version already holds this value)' };
	}
	if (!FORCE_NEW_VERSION) {
		return {
			action: null,
			error:
				existingDigest === null
					? `secret ${item.secretName} exists but its latest version is unreadable; resolve by hand or pass --force-new-version`
					: `secret ${item.secretName} exists with a DIFFERENT value; another var may depend on it. Pass --force-new-version to add the live value as a new version, or --map ${item.name}=<other-name>`,
		};
	}
	if (!APPLY) return { action: 'add a new version (value differs from latest)' };
	gcloudWithStdin(['secrets', 'versions', 'add', item.secretName, '--data-file=-'], item.value);
	return { action: 'added a new version (value differed from latest)' };
}

async function grantAccessor(secretName, serviceAccount) {
	if (!APPLY) return 'would grant secretAccessor to the runtime service account';
	await gcloud([
		'secrets',
		'add-iam-policy-binding',
		secretName,
		`--member=serviceAccount:${serviceAccount}`,
		'--role=roles/secretmanager.secretAccessor',
		'--condition=None',
	]);
	return 'granted secretAccessor on this one secret';
}

function reportEndState(after, migratedNames) {
	const byName = new Map(after.env.map((e) => [e.name, e]));
	const problems = [];
	for (const name of migratedNames) {
		const entry = byName.get(name);
		if (!entry) {
			problems.push(`${name}: no longer present on the service`);
			continue;
		}
		if (entry.value) problems.push(`${name}: STILL a plaintext literal`);
		else if (!entry.valueFrom?.secretKeyRef) problems.push(`${name}: neither a literal nor a secretKeyRef`);
	}
	const leftoverLiterals = after.env
		.filter((e) => e.value && classify(e.name).secret)
		.map((e) => e.name);
	const servingRevision = after.traffic.find((t) => Number(t.percent) === 100);
	const trafficOk = Boolean(servingRevision) && (servingRevision.latestRevision || servingRevision.revisionName === after.latestReady);

	console.log('\nEnd state');
	console.log(`  serving revision: ${after.latestReady || 'unknown'}`);
	console.log(
		`  traffic:          ${
			trafficOk
				? '100% on the newest ready revision'
				: after.traffic.map((t) => `${t.percent}% ${t.revisionName || 'latest'}`).join(', ') || 'unknown'
		}`,
	);
	for (const name of migratedNames) {
		const entry = byName.get(name);
		const ref = entry?.valueFrom?.secretKeyRef;
		console.log(`  ${name}  ->  ${ref ? `${ref.name}:${ref.key}` : 'NOT a secretKeyRef'}`);
	}
	if (leftoverLiterals.length) {
		console.log(`  plaintext credentials still on the service: ${leftoverLiterals.join(', ')}`);
	} else {
		console.log('  plaintext credentials still on the service: none');
	}
	if (problems.length) {
		for (const p of problems) console.log(`  PROBLEM: ${p}`);
		process.exitCode = 1;
	}
	if (!trafficOk) {
		console.log('  PROBLEM: the newest ready revision is not serving 100% of traffic');
		process.exitCode = 1;
	}
	return problems.length === 0 && trafficOk;
}

async function main() {
	const before = await describeService();
	if (!before.serviceAccount) {
		fail(`${SERVICE} has no explicit runtime service account; refusing to guess who to grant access to`);
	}
	const { alreadySecret, credentials, config, review } = partition(before.env);

	console.log(`\nService: ${SERVICE} (${REGION}, ${PROJECT})`);
	console.log(`Runtime service account: ${before.serviceAccount}`);
	console.log(`Serving revision: ${before.latestReady || 'unknown'}`);
	console.log(`Mode: ${VERIFY_ONLY ? 'VERIFY' : APPLY ? 'APPLY' : 'DRY RUN (nothing will change)'}`);

	console.log(`\nAlready in Secret Manager (${alreadySecret.length}):`);
	for (const e of alreadySecret) console.log(`  ${e.name}  ->  ${e.secret}:${e.key}`);

	console.log(`\nPlaintext, left as config (${config.length}):`);
	for (const e of config) console.log(`  ${e.name}  (${e.reason})`);

	if (review.length) {
		console.log(`\nPlaintext, needs a human call (${review.length}):`);
		for (const e of review) console.log(`  ${e.name}  (${e.reason}; --include ${e.name} to migrate it)`);
	}

	console.log(`\nPlaintext credentials to migrate (${credentials.length}):`);
	for (const e of credentials) console.log(`  ${e.name}  ->  ${e.secretName}  (${e.reason})`);

	if (VERIFY_ONLY) {
		const migrated = alreadySecret.map((e) => e.name);
		const ok = reportEndState(before, migrated);
		console.log(`\nVerify: ${ok && !credentials.length ? 'clean' : 'work remains'}`);
		if (credentials.length) process.exitCode = 1;
		return;
	}

	if (!credentials.length) {
		console.log('\nNothing to migrate. Every credential-bearing env var is already a secretKeyRef.');
		return;
	}

	const updates = [];
	for (const item of credentials) {
		const result = await prepareSecret(item);
		if (result.error) {
			console.log(`\n  SKIPPED ${item.name}: ${result.error}`);
			continue;
		}
		const grant = await grantAccessor(item.secretName, before.serviceAccount);
		console.log(`\n  ${item.name}`);
		console.log(`    secret: ${item.secretName}`);
		console.log(`    ${result.action}`);
		console.log(`    ${grant}`);
		updates.push(item);
	}

	if (!updates.length) fail('no var could be prepared; nothing was flipped on the service');

	const pairs = updates.map((u) => `${u.name}=${u.secretName}:latest`).join(',');
	if (!APPLY) {
		const echoFlags = [
			ONLY.length ? ` --only ${ONLY.join(',')}` : '',
			INCLUDE.length ? ` --include ${INCLUDE.join(',')}` : '',
			EXCLUDE.length ? ` --exclude ${EXCLUDE.join(',')}` : '',
			...[...NAME_MAP].map(([env, secret]) => ` --map ${env}=${secret}`),
			FORCE_NEW_VERSION ? ' --force-new-version' : '',
		].join('');
		console.log(`\nDry run. To apply:\n  node scripts/migrate-plaintext-secrets.mjs${echoFlags} --apply`);
		console.log(`\nThe single service update it would run:\n  gcloud run services update ${SERVICE} --region ${REGION} --project ${PROJECT} \\\n    --update-secrets ${pairs}`);
		return;
	}

	console.log(`\nFlipping ${updates.length} var(s) on ${SERVICE} in one update...`);
	await gcloud([
		'run',
		'services',
		'update',
		SERVICE,
		`--region=${REGION}`,
		`--update-secrets=${pairs}`,
		'--quiet',
	]);

	const after = await describeService();
	const ok = reportEndState(after, updates.map((u) => u.name));
	console.log(
		ok
			? '\nMigration complete. Now compare /api/healthz against the reading you took first, and confirm a signing path that uses a migrated key still works.'
			: '\nMigration finished with problems above. Roll traffic back to the prior revision before diagnosing:\n  gcloud run services update-traffic ' +
					`${SERVICE} --region ${REGION} --project ${PROJECT} --to-revisions <prior>=100`,
	);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main().catch((e) => fail(e?.stderr?.trim() || e?.message || String(e)));
}
