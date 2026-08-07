// gcloud is required by several scripts, but non-interactive shells in this
// workspace do not always carry the SDK on PATH (.bashrc only appends it for
// interactive shells). Importing this module resolves a known install and
// prepends it, so the importing script AND every child it spawns inherit a
// working gcloud. Safe to import unconditionally: it is a no-op when gcloud
// is already resolvable or when no install exists.

import { existsSync } from 'node:fs';

export function ensureGcloudOnPath() {
	const dirs = (process.env.PATH || '').split(':');
	if (dirs.some((d) => d && existsSync(`${d}/gcloud`))) return true;
	for (const dir of [
		`${process.env.HOME}/google-cloud-sdk/bin`,
		'/usr/lib/google-cloud-sdk/bin',
		'/usr/local/google-cloud-sdk/bin',
		'/opt/google-cloud-sdk/bin',
	]) {
		if (existsSync(`${dir}/gcloud`)) {
			process.env.PATH = `${dir}:${process.env.PATH}`;
			return true;
		}
	}
	return false;
}

ensureGcloudOnPath();
