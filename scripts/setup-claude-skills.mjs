#!/usr/bin/env node
// Mirrors .agents/skills/<name> directories as symlinks under .claude/skills/
// so Claude Code's skill discovery (which looks under .claude/skills/) sees
// the canonical SKILL.md packs without duplicating them in git.
//
// These symlinks are NOT checked in — they're local-only. On Vercel the
// .claude/ tree is already excluded via .vercelignore, and we skip work
// there to avoid leaving symlinks for the archiver to resolve.

import { readdirSync, statSync, symlinkSync, existsSync, mkdirSync, unlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.VERCEL || process.env.CI === 'true' && process.env.VERCEL_ENV) {
	process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const srcRoot = resolve(root, '.agents/skills');
const dstRoot = resolve(root, '.claude/skills');

if (!existsSync(srcRoot)) process.exit(0);

mkdirSync(dstRoot, { recursive: true });

const wanted = readdirSync(srcRoot).filter((name) => {
	try {
		return statSync(join(srcRoot, name)).isDirectory();
	} catch {
		return false;
	}
});

for (const name of wanted) {
	const linkPath = join(dstRoot, name);
	const targetRel = join('..', '..', '.agents', 'skills', name);
	if (existsSync(linkPath) || lstatSyncSafe(linkPath)) {
		const lst = lstatSyncSafe(linkPath);
		if (lst && lst.isSymbolicLink() && readlinkSync(linkPath) === targetRel) continue;
		try {
			unlinkSync(linkPath);
		} catch {
			continue;
		}
	}
	try {
		symlinkSync(targetRel, linkPath, 'dir');
	} catch (err) {
		console.warn(`[setup-claude-skills] could not link ${name}: ${err.message}`);
	}
}

function lstatSyncSafe(p) {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}
