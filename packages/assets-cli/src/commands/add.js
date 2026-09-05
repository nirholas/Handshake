import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveApi, fetchItem, downloadAsset } from '../api.js';
import { style, symbols, success, failure, hint, warn, heading } from '../style.js';

/**
 * Where a downloaded asset lands when `--dir` is not given.
 *
 * A project with a `public/` directory is almost always serving it at the web
 * root, so an asset written under it is reachable at `/three-ws/<file>` with no
 * build config. Without one, we do not guess a serving convention: the files go
 * in a plainly named directory and the snippet uses the path relative to the
 * project, which the caller then wires up themselves.
 */
export function defaultDir(cwd) {
	return existsSync(join(cwd, 'public'))
		? join(cwd, 'public', 'three-ws')
		: join(cwd, 'three-ws-assets');
}

/**
 * The URL the snippet should reference for a file on disk.
 *
 * Returns `{ url, served }`. `served: false` means we could not prove the file
 * will be reachable at that path, and the caller warns instead of implying it
 * works.
 */
export function webPathFor(cwd, filePath) {
	const rel = relative(cwd, filePath);
	const segments = rel.split(sep);
	const publicIndex = segments.indexOf('public');
	if (publicIndex !== -1) {
		return { url: `/${segments.slice(publicIndex + 1).join('/')}`, served: true };
	}
	return { url: `./${segments.join('/')}`, served: false };
}

function extensionFor(item) {
	const fromUrl = extname(new URL(item.url).pathname);
	if (fromUrl) return fromUrl;
	return item.format === 'glb' ? '.glb' : '.json';
}

function sha256(buf) {
	return createHash('sha256').update(buf).digest('hex');
}

/**
 * Write `bytes` to `target`, refusing to clobber a file whose contents differ.
 *
 * A re-run that would write identical bytes is reported as unchanged rather
 * than as a write, so `add` is safe to put in a setup script. A file that was
 * edited after it was added is never silently replaced: that is someone's work.
 *
 * @returns {Promise<'written'|'unchanged'|'conflict'>}
 */
export async function writeAsset(target, bytes, { force = false } = {}) {
	if (existsSync(target)) {
		const existing = await readFile(target);
		if (sha256(existing) === sha256(bytes)) return 'unchanged';
		if (!force) return 'conflict';
	}
	await mkdir(resolve(target, '..'), { recursive: true });
	await writeFile(target, bytes);
	return 'written';
}

export async function add({ positional, flags }) {
	const id = positional[0];
	if (!id) {
		failure('add needs a catalog id');
		hint('find one with: three-ws-assets search <term>');
		return 1;
	}

	const cwd = process.cwd();
	const dirFlag = typeof flags.dir === 'string' ? flags.dir : null;
	const dir = dirFlag ? (isAbsolute(dirFlag) ? dirFlag : resolve(cwd, dirFlag)) : defaultDir(cwd);

	const origin = resolveApi(flags);
	let payload;
	try {
		payload = await fetchItem(origin, id);
	} catch (err) {
		failure(err.message);
		if (err.notFound) hint('search first: three-ws-assets search <term>');
		return 1;
	}

	const { item, snippets, frameworks, links } = payload;
	if (!item.url) {
		failure(`${item.id} has no downloadable file`);
		return 1;
	}

	const wanted = typeof flags.framework === 'string' ? flags.framework : null;
	if (wanted && !snippets[wanted]) {
		failure(`no "${wanted}" source for a ${item.kind}`);
		hint(`available: ${frameworks.join(', ')}`);
		return 1;
	}

	const targets = [{ label: 'asset', url: item.url, path: join(dir, `${item.name}${extensionFor(item)}`) }];
	if (flags.thumb && item.thumb) {
		targets.push({
			label: 'thumbnail',
			url: item.thumb,
			path: join(dir, basename(new URL(item.thumb).pathname)),
		});
	}

	const written = [];
	for (const target of targets) {
		const bytes = await downloadAsset(target.url);
		const outcome = await writeAsset(target.path, bytes, { force: Boolean(flags.force) });
		if (outcome === 'conflict') {
			failure(`${relative(cwd, target.path)} exists with different contents`);
			hint('pass --force to overwrite it');
			return 1;
		}
		written.push({ ...target, bytes: bytes.length, outcome });
	}

	// The snippet the API returned points at the CDN. Now that the bytes are on
	// disk, rewrite it to the local copy: that is the whole point of `add` as
	// opposed to `show`.
	const assetFile = written[0];
	const web = webPathFor(cwd, assetFile.path);
	const chosen = wanted || frameworks[0];
	const code = snippets[chosen].code.split(item.url).join(web.url);

	if (flags.json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					ok: true,
					id: item.id,
					files: written.map((w) => ({
						path: relative(cwd, w.path),
						bytes: w.bytes,
						outcome: w.outcome,
					})),
					url: web.url,
					served: web.served,
					framework: chosen,
					snippet: code,
					license: item.license,
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}

	for (const w of written) {
		const path = relative(cwd, w.path);
		if (w.outcome === 'unchanged') {
			process.stdout.write(`${style.dim(`${symbols.bullet} ${path} already up to date`)}\n`);
		} else {
			success(`${path} ${style.dim(`(${(w.bytes / 1024).toFixed(0)} KB ${w.label})`)}`);
		}
	}
	if (item.license) process.stdout.write(`${style.dim(`license: ${item.license}`)}\n`);
	if (!web.served) {
		warn(`${relative(cwd, dir)} is not under a public/ directory`);
		hint('the snippet uses a project-relative path; serve that directory or pass --dir');
	}

	process.stdout.write(`\n${heading(chosen)}\n${code}\n`);
	for (const note of snippets[chosen].notes || []) {
		process.stdout.write(`${style.dim(`  ${symbols.bullet} ${note}`)}\n`);
	}
	if (links?.preview) process.stdout.write(`\n${style.dim(`preview: ${links.preview}`)}\n`);
	return 0;
}
