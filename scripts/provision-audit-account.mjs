#!/usr/bin/env node
/**
 * provision-audit-account.mjs — create the QA account the authed sweeps need.
 *
 * `npm run audit:web:login` (and the other authed harnesses: likeness-eval,
 * reconstruct-load-test, capture-bundles-media) sign in with AUDIT_EMAIL /
 * AUDIT_PASSWORD. When those are absent from `.env` every one of them dies at
 * the first step. This script provisions a fresh, real account through the
 * production signup flow and writes the credentials back into `.env`.
 *
 * It drives the real /register page in a real browser: same form, same
 * clickwrap checkbox, same POST /api/auth/register the page makes. Nothing is
 * stubbed, so a successful run also proves the signup surface works.
 *
 * Usage:
 *   node scripts/provision-audit-account.mjs                 # provision + write .env
 *   node scripts/provision-audit-account.mjs --username qa-x  # pick the username
 *   node scripts/provision-audit-account.mjs --print-only      # don't touch .env
 *   BASE_URL=http://localhost:3000 node scripts/provision-audit-account.mjs
 *
 * The account is a normal free-plan member. Print the credentials into the
 * Cloud Run service env yourself when a server-side harness needs them:
 *   gcloud run services update three-ws-api --region us-central1 \
 *     --update-env-vars AUDIT_EMAIL=...,AUDIT_PASSWORD=...
 * (`--update-env-vars` merges; `--set-env-vars` would wipe every other var.)
 */
import { chromium } from 'playwright';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const BASE_URL = (process.env.BASE_URL || 'https://three.ws').replace(/\/$/, '');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PRINT_ONLY = flag('print-only');

// The register form takes a username, not an email: the server derives
// `<username>@users.three.ws.local` as the account email. That derived address
// is what AUDIT_EMAIL has to carry, because /api/auth/login treats a value
// containing '@' as an email lookup.
const USERNAME = opt('username', `qa-audit-${randomBytes(4).toString('hex')}`);
const DERIVED_EMAIL = `${USERNAME.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}@users.three.ws.local`;
// registerBody requires >= 10 characters; 32 base64url chars is well past any
// strength floor and is generated per run, never reused.
const PASSWORD = randomBytes(24).toString('base64url');

if (!/^[a-zA-Z0-9_-]{3,30}$/.test(USERNAME)) {
	console.error(`✗ --username must be 3-30 chars of [a-zA-Z0-9_-]; got ${USERNAME}`);
	process.exit(2);
}

/** Upsert KEY=value in .env, leaving every other line untouched. */
function writeEnvVars(vars) {
	let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
	for (const [key, value] of Object.entries(vars)) {
		const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
		if (idx === -1) lines.push(`${key}=${value}`);
		else lines[idx] = `${key}=${value}`;
	}
	// Keep exactly one trailing newline.
	while (lines.length && lines[lines.length - 1] === '') lines.pop();
	writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const browser = await chromium.launch();
try {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const pageErrors = [];
	page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));

	console.log(`Registering ${USERNAME} at ${BASE_URL}/register …`);
	await page.goto(`${BASE_URL}/register`, { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.fill('#username', USERNAME);
	await page.fill('#password', PASSWORD);
	await page.check('#tos-accept');
	await Promise.all([
		page.waitForURL((u) => !/\/register/.test(u.pathname), { timeout: 45000 }),
		page.click('#submit'),
	]);
	console.log(`✓ signup landed on ${new URL(page.url()).pathname}`);

	// Prove the credentials the sweeps will use actually authenticate, through
	// the same endpoint page-audit.mjs posts to.
	const res = await ctx.request.post(`${BASE_URL}/api/auth/login`, {
		data: { email: DERIVED_EMAIL, password: PASSWORD },
		headers: { 'content-type': 'application/json' },
		timeout: 20000,
	});
	if (!res.ok()) {
		const text = await res.text().catch(() => '');
		throw new Error(`login verification failed: HTTP ${res.status()} ${text.slice(0, 300)}`);
	}
	const { user } = await res.json();
	console.log(`✓ login verified as user ${user.id} (${user.display_name}, plan ${user.plan})`);
	if (pageErrors.length) console.log(`note: ${pageErrors.length} page error(s) on /register: ${pageErrors[0]}`);

	if (PRINT_ONLY) {
		console.log('\nAdd these to .env:');
	} else {
		writeEnvVars({ AUDIT_EMAIL: DERIVED_EMAIL, AUDIT_PASSWORD: PASSWORD });
		console.log(`✓ wrote AUDIT_EMAIL / AUDIT_PASSWORD to .env`);
		console.log('\nFor the Cloud Run service env:');
	}
	console.log(`AUDIT_EMAIL=${DERIVED_EMAIL}`);
	console.log(`AUDIT_PASSWORD=${PASSWORD}`);
} finally {
	await browser.close();
}
