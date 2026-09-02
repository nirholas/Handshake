#!/usr/bin/env node
// Resolve environment variables off the live three-ws-api Cloud Run service,
// following Secret Manager references.
//
// Production's authoritative env lives on the Cloud Run service, and several
// runbooks tell an operator to read a value out of it with `gcloud run services
// describe`. That stopped working for credentials on 2026-09-02, when every
// credential-bearing var moved into Secret Manager
// (scripts/migrate-plaintext-secrets.mjs): `describe` now shows a
// `valueFrom.secretKeyRef` where the value used to be, and a snippet that reads
// `.value` silently gets an empty string. This resolves both shapes, so a runbook
// command keeps working whether a var is a literal or a reference.
//
// USAGE
//   node scripts/read-service-env.mjs '^S3_'          # export lines, safe for eval
//   node scripts/read-service-env.mjs JWT_SECRET --raw # just the value, no name
//   node scripts/read-service-env.mjs '_API_KEY$' --names   # names + where each lives
//
//   eval "$(node scripts/read-service-env.mjs '^S3_')"      # load them into a shell
//
// The pattern is a JavaScript regular expression matched against the variable
// name. With no pattern, every variable is listed in --names form.
//
// This prints credentials to your terminal, which is the point: it is how an
// operator gets a production value onto a machine that needs it. Do not pipe it
// into a file that lives in the repo, and do not paste its output into a commit.

import { accessSecretVersion, serviceEnvEntries, DEFAULT_SERVICE } from './lib/service-env.mjs';

const argv = process.argv.slice(2);
const RAW = argv.includes('--raw');
const NAMES_ONLY = argv.includes('--names');
const pattern = argv.find((a) => !a.startsWith('--'));

function fail(msg) {
	console.error(`\n  FAILED: ${msg}\n`);
	process.exit(1);
}

function main() {
	let regex;
	try {
		regex = pattern ? new RegExp(pattern) : /.*/;
	} catch (e) {
		fail(`"${pattern}" is not a valid regular expression: ${e.message}`);
	}

	let env;
	try {
		env = serviceEnvEntries().filter((e) => regex.test(e.name));
	} catch (e) {
		fail(`could not read ${DEFAULT_SERVICE}: ${(e?.stderr || e?.message || '').trim().split('\n')[0]}`);
	}
	if (!env.length) fail(`no variable on ${DEFAULT_SERVICE} matches ${regex}`);

	if (NAMES_ONLY) {
		for (const e of env) {
			const ref = e.valueFrom?.secretKeyRef;
			console.log(`${e.name}\t${ref ? `secret:${ref.name}:${ref.key}` : 'literal'}`);
		}
		return;
	}

	if (RAW && env.length > 1) {
		fail(`--raw prints one value; ${regex} matches ${env.length} variables (${env.map((e) => e.name).join(', ')})`);
	}

	for (const e of env) {
		let value = e.value;
		if (value === undefined) {
			const ref = e.valueFrom?.secretKeyRef;
			if (!ref?.name) {
				console.error(`  ${e.name}: neither a literal nor a readable secret reference, skipped`);
				continue;
			}
			try {
				value = accessSecretVersion(ref.name, ref.key || 'latest');
			} catch (err) {
				console.error(
					`  ${e.name}: cannot read ${ref.name}:${ref.key}. Needs roles/secretmanager.secretAccessor on that secret.`,
				);
				process.exitCode = 1;
				continue;
			}
		}
		// Single quotes with the embedded-quote escape, so the line survives eval
		// no matter what the value holds.
		if (RAW) process.stdout.write(value);
		else console.log(`export ${e.name}='${String(value).replace(/'/g, `'\\''`)}'`);
	}
}

try {
	main();
} catch (e) {
	fail(e?.message || String(e));
}
