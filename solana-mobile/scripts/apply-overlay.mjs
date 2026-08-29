#!/usr/bin/env node
// Apply solana-mobile/android-overlay/ to the Bubblewrap-generated project.
//
// `bubblewrap update` regenerates the whole Android project from
// twa/twa-manifest.json on every build, so anything native (the glance home
// screen widget) has to be laid on top AFTER update and BEFORE build. This
// script is that step, and build-apk.sh runs it in exactly that slot.
//
//   node scripts/apply-overlay.mjs --project build [--overlay android-overlay]
//
// What it does:
//   1. copies every file under <overlay>/app/ into <project>/app/ (sources,
//      layouts, drawables, values, xml), refusing to clobber a generated file
//      it does not own;
//   2. splices AndroidManifest.permissions.xml after the <manifest> opening
//      tag and AndroidManifest.application.xml before </application>;
//   3. appends build.gradle.fragment to app/build.gradle.
//
// It is idempotent (a marker comment guards each splice) and it fails loudly
// on a missing overlay or a manifest it cannot parse: the listing says the app
// has a widget, so a build that silently dropped it would ship a lie.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const projectDir = path.resolve(root, opt('--project', 'build'));
const overlayDir = path.resolve(root, opt('--overlay', 'android-overlay'));

const log = (msg) => console.log(`[apply-overlay] ${msg}`);
const fail = (msg) => {
	console.error(`[apply-overlay] ERROR: ${msg}`);
	process.exit(1);
};

const REQUIRED = [
	'AndroidManifest.permissions.xml',
	'AndroidManifest.application.xml',
	'build.gradle.fragment',
	'app/src/main/java/ws/three/app/glance/GlanceWidget.java',
	'app/src/main/res/xml/glance_widget_info.xml',
];
for (const rel of REQUIRED) {
	if (!fs.existsSync(path.join(overlayDir, rel))) fail(`overlay is missing ${rel} (${overlayDir})`);
}

const manifestPath = path.join(projectDir, 'app/src/main/AndroidManifest.xml');
const gradlePath = path.join(projectDir, 'app/build.gradle');
if (!fs.existsSync(manifestPath)) fail(`no generated manifest at ${manifestPath}; run bubblewrap update first`);
if (!fs.existsSync(gradlePath)) fail(`no generated build.gradle at ${gradlePath}; run bubblewrap update first`);

// 1. Sources and resources. Every overlay file is namespaced "glance", so a
// collision with a generated file means the generator changed under us.
let copied = 0;
function copyTree(from, to) {
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) {
			fs.mkdirSync(dst, { recursive: true });
			copyTree(src, dst);
			continue;
		}
		if (fs.existsSync(dst) && fs.readFileSync(dst).equals(fs.readFileSync(src)) === false && !entry.name.includes('glance')) {
			fail(`refusing to overwrite generated file ${dst}`);
		}
		fs.copyFileSync(src, dst);
		copied++;
	}
}
copyTree(path.join(overlayDir, 'app'), path.join(projectDir, 'app'));
log(`copied ${copied} files into ${path.relative(root, projectDir)}/app`);

// 2. Manifest.
const MARK_PERMS = '<!-- glance widget (solana-mobile/android-overlay): fetched';
const MARK_APP = '<!-- glance widget (solana-mobile/android-overlay) -->';
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes(MARK_PERMS)) {
	const open = manifest.match(/<manifest\b[^>]*>/);
	if (!open) fail('cannot find the <manifest> opening tag');
	const at = open.index + open[0].length;
	manifest = `${manifest.slice(0, at)}\n\n${fs.readFileSync(path.join(overlayDir, 'AndroidManifest.permissions.xml'), 'utf8')}${manifest.slice(at)}`;
}
if (!manifest.includes(MARK_APP)) {
	const at = manifest.lastIndexOf('</application>');
	if (at < 0) fail('cannot find </application>');
	manifest = `${manifest.slice(0, at)}${fs.readFileSync(path.join(overlayDir, 'AndroidManifest.application.xml'), 'utf8')}\n    ${manifest.slice(at)}`;
}
fs.writeFileSync(manifestPath, manifest);
for (const needle of ['.glance.GlanceWidget', '.glance.GlanceLinkActivity', 'android.permission.INTERNET']) {
	if (!manifest.includes(needle)) fail(`manifest merge lost ${needle}`);
}
log('merged the widget receiver, link activity, and permissions into AndroidManifest.xml');

// 3. Gradle.
const fragment = fs.readFileSync(path.join(overlayDir, 'build.gradle.fragment'), 'utf8');
let gradle = fs.readFileSync(gradlePath, 'utf8');
const fragmentMark = fragment.split('\n')[0];
if (!gradle.includes(fragmentMark)) {
	gradle = `${gradle.trimEnd()}\n\n${fragment}`;
	fs.writeFileSync(gradlePath, gradle);
}
if (!gradle.includes('androidx.work:work-runtime')) fail('build.gradle merge lost the WorkManager dependency');
log('appended the WorkManager dependency to app/build.gradle');

log('overlay applied');
