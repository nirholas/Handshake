/**
 * Everything the home lane's e2e journeys need, before the first browser opens.
 *
 * The journeys drive the REAL product against a REAL Home Assistant, so the
 * stack is three processes and no stubs anywhere in it:
 *
 *   Home Assistant   a container from scripts/home-test-instance.mjs, seeded
 *   the API          node server/index.mjs, the same handlers Cloud Run runs
 *   the frontend     vite, with DEV_API_PROXY pointed at that API
 *
 * The house lives on 127.0.0.1, which both the browser and the server treat as
 * reachable: `normalizeBaseUrl` exempts loopback from the private-host refusal
 * precisely so a developer running Home Assistant on this machine still works.
 * That exemption is what makes an honest end-to-end run possible here, and
 * journey 10 proves the refusal still fires for every other private host.
 *
 * Two accounts are provisioned, an owner and a guest, because journey 7 is
 * about one member being refused something the other is allowed. They are
 * created through the real signup page ONCE and then reused for every later
 * run: account creation is rate limited to five per hour per IP, so a setup
 * that registered on every run would work twice and then start reporting the
 * rate limiter as a product failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireHomeInstance } from '../_helpers/home-instance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the stack's details land. Gitignored: it holds a real access token. */
export const STACK_FILE = path.join(ROOT, '.ha-config-e2e-stack.json');
/** The reusable QA accounts. Gitignored: real credentials for a real account. */
const ACCOUNTS_FILE = path.join(ROOT, '.ha-config-e2e-accounts.json');

export default async function globalSetup(config) {
	process.env.HOME_LIVE = process.env.HOME_LIVE || '1';
	process.env.HOME_LIVE_NAME = process.env.HOME_LIVE_NAME || 'e2e';

	const origin = config?.projects?.[0]?.use?.baseURL || 'http://localhost:3020';

	const home = await acquireHomeInstance({ timeout: 900_000 });
	console.log(`[home-e2e] Home Assistant ${home.version || 'unknown'} at ${home.baseUrl}`);

	const accounts = await ensureAccounts(origin);
	fs.writeFileSync(
		STACK_FILE,
		`${JSON.stringify({ home, accounts, origin, startedAt: new Date().toISOString() }, null, '\t')}\n`,
	);
	console.log(`[home-e2e] accounts ready: ${accounts.owner.username}, ${accounts.guest.username}`);
}

/**
 * Real three.ws accounts, created through the real signup page and kept.
 *
 * A stored account is verified by actually logging in with it rather than
 * assumed to still exist, so a database that was reset since the last run
 * re-provisions instead of failing every journey with a confusing 401.
 */
async function ensureAccounts(origin) {
	const stored = readJson(ACCOUNTS_FILE) || {};
	const accounts = { ...stored };

	for (const role of ['owner', 'guest']) {
		if (accounts[role] && (await loginWorks(origin, accounts[role]))) continue;
		accounts[role] = await register(origin, role);
		// Write after EVERY account, not once at the end. Registration is limited
		// to five per hour per IP, and a run that created the owner and then died
		// on the guest used to throw the owner away and burn one of the five for
		// nothing.
		fs.writeFileSync(ACCOUNTS_FILE, `${JSON.stringify(accounts, null, '\t')}\n`, { mode: 0o600 });
	}
	return accounts;
}

async function loginWorks(origin, account) {
	const res = await fetch(`${origin}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ email: account.email, password: account.password }),
		signal: AbortSignal.timeout(30_000),
	}).catch(() => null);
	return Boolean(res?.ok);
}

/**
 * Create one account against the real registration endpoint.
 *
 * This is the same request the register page makes, with the same terms
 * acceptance, and it is made directly rather than by driving the page: a
 * headless Chromium loading the full signup bundle is the heaviest thing in
 * this setup, and on a busy machine it crashes the page before the form is
 * filled. What is under test in this lane is the home surface; the signup page
 * has its own specs.
 */
async function register(origin, role) {
	const suffix = `${role}-${Date.now().toString(36)}`;
	const account = {
		username: `home-e2e-${suffix}`,
		email: `home-e2e-${suffix}@qa.three.ws`,
		password: `Home-e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
	};

	const res = await fetch(`${origin}/api/auth/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin },
		body: JSON.stringify({ email: account.email, password: account.password, tosAccepted: true }),
		signal: AbortSignal.timeout(90_000),
	}).catch((cause) => {
		throw new Error(`could not reach ${origin}/api/auth/register. The API server died during this run; check the [WebServer] output for a SIGTERM.`, { cause });
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		if (res.status === 429) {
			throw new Error(
				`registration is rate limited (five per hour per IP). The accounts in ${path.basename(ACCOUNTS_FILE)} are reused whenever they still log in; delete that file only when you have budget to spare.`,
			);
		}
		throw new Error(`registering the ${role} account returned ${res.status}: ${body.slice(0, 200)}`);
	}
	return account;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}
