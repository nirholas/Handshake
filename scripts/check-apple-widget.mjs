#!/usr/bin/env node
/**
 * Verifies the Apple Agent glance widget against the two things that can break
 * it from outside Xcode: the Xcode projects that build it, and the server
 * endpoint it reads.
 *
 *   node scripts/check-apple-widget.mjs
 *
 * Why this exists. Nothing on a Linux build machine can compile Swift or open
 * an .xcodeproj, so the failures this catches would otherwise be found on
 * somebody's Mac, days later: a Swift file added to apple/GlanceKit and never
 * added to a target, an object id in project.pbxproj that no longer resolves,
 * an entitlement that names a build setting the project never defines, or the
 * quieter one, a header or a state string renamed in api/glance/mine.js while
 * the widget kept parsing the old name and silently drew the wrong card.
 *
 * It is a structural check, not a build. A green run means the projects are
 * internally consistent and the client and the server still agree on the wire;
 * it does not mean the Swift compiles.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

const problems = [];
const fail = (msg) => problems.push(msg);
let checks = 0;
const pass = (msg) => {
	checks++;
	console.log(`[apple-widget] ok   ${msg}`);
};

// The Swift files each target has to compile. GlanceKit is shared; the host
// apps take only the part that has no WidgetKit view in it, because the iOS app
// deploys to iOS 16 and the widget's SwiftUI needs 17.
const KIT_APP_FILES = [
	'GlanceConfig.swift',
	'GlanceCard.swift',
	'GlanceTokenStore.swift',
	'GlanceCache.swift',
	'GlanceLink.swift',
];
const WIDGET_FILES = ['GlanceProvider.swift', 'AgentGlanceWidget.swift'];
const SETTINGS = ['GLANCE_ORIGIN', 'GLANCE_APP_GROUP', 'GLANCE_KEYCHAIN_GROUP'];

// ---------------------------------------------------------------- sources ---

const kitDir = join(REPO, 'apple/GlanceKit');
const kitFiles = readdirSync(kitDir).filter((f) => f.endsWith('.swift')).sort();
if (!kitFiles.length) fail('apple/GlanceKit holds no Swift sources');

for (const file of KIT_APP_FILES) {
	if (!kitFiles.includes(file)) fail(`apple/GlanceKit/${file} is missing but every host app compiles it`);
}
for (const file of WIDGET_FILES) {
	if (!existsSync(join(REPO, 'apple/GlanceWidget', file))) fail(`apple/GlanceWidget/${file} is missing`);
}
if (!problems.length) pass(`${kitFiles.length} shared sources and ${WIDGET_FILES.length} widget sources present`);

// -------------------------------------------------------------- iOS project ---

const pbx = read('ios/native/App/App.xcodeproj/project.pbxproj');

// Balanced object graph: every 24 character id used anywhere has a definition.
// A definition is an object at the top of a section; the project's own main
// group is the one that carries no trailing comment.
const defined = new Set([...pbx.matchAll(/^\t\t([0-9A-F]{24}) (?:\/\*|=)/gm)].map((m) => m[1]));
const referenced = new Set([...pbx.matchAll(/\b([0-9A-F]{24})\b/g)].map((m) => m[1]));
const dangling = [...referenced].filter((id) => !defined.has(id));
if (dangling.length) fail(`project.pbxproj references ${dangling.length} undefined object id(s): ${dangling.slice(0, 4).join(', ')}`);
else pass(`project.pbxproj resolves all ${referenced.size} object ids`);

const braces = (pbx.match(/{/g) || []).length - (pbx.match(/}/g) || []).length;
if (braces !== 0) fail(`project.pbxproj braces are unbalanced by ${braces}`);
else pass('project.pbxproj braces balance');

// Every file reference in the Glance groups points at a file that exists.
for (const [, path] of pbx.matchAll(/path = (\.\.\/\.\.\/\.\.\/apple\/[^;]+);/g)) {
	const clean = path.replace(/^"|"$/g, '');
	const onDisk = join(REPO, 'ios/native/App', clean);
	if (!existsSync(onDisk)) fail(`project.pbxproj points at ${clean}, which is not on disk`);
}
pass('every apple/ path in project.pbxproj resolves');

const requiredPbx = [
	['GlanceWidgetExtension', 'the widget extension target'],
	['com.apple.product-type.app-extension', 'the extension product type'],
	['dstSubfolderSpec = 13', 'the Embed Foundation Extensions phase'],
	['GlanceWidget.appex in Embed Foundation Extensions', 'the appex embedded in the app'],
	['PRODUCT_BUNDLE_IDENTIFIER = ws.three.app.glance', 'the extension bundle id'],
	['IPHONEOS_DEPLOYMENT_TARGET = 17.0', 'the extension deployment target'],
];
const missingPbx = requiredPbx.filter(([needle]) => !pbx.includes(needle));
for (const [needle, what] of missingPbx) fail(`project.pbxproj is missing ${what} (${needle})`);
if (!missingPbx.length) pass('the iOS widget target is wired and embedded');

// The app target compiles the shared half; the extension compiles all of it.
for (const file of [...KIT_APP_FILES, ...WIDGET_FILES, ...kitFiles]) {
	if (!pbx.includes(`/* ${file} in Sources */`)) fail(`${file} is in apple/ but no iOS target compiles it`);
}
for (const file of KIT_APP_FILES) {
	const count = (pbx.match(new RegExp(`/\\* ${file} in Sources \\*/ = `, 'g')) || []).length;
	if (count !== 2) fail(`${file} should be compiled by both iOS targets, found ${count} build files`);
}
pass('every shared source is a member of the iOS targets that need it');

for (const setting of SETTINGS) {
	// Once in each of the app's two configurations and the extension's two.
	const count = (pbx.match(new RegExp(`^\\s*${setting} = `, 'gm')) || []).length;
	if (count !== 4) fail(`${setting} is defined ${count} times in project.pbxproj, expected 4 (both targets, both configurations)`);
}
pass('the iOS project defines the three Glance build settings on both targets');

// ------------------------------------------------------------ macOS project ---

const mac = parseYaml(read('apple/macos/project.yml'));
const macTargets = Object.keys(mac.targets || {});
for (const target of ['ThreeWSGlance', 'GlanceWidget']) {
	if (!macTargets.includes(target)) fail(`apple/macos/project.yml has no ${target} target`);
}
for (const setting of SETTINGS) {
	if (!(setting in (mac.settings?.base || {}))) fail(`apple/macos/project.yml does not define ${setting}`);
}
const macSources = (mac.targets?.GlanceWidget?.sources || []).map((s) => s.path);
if (!macSources.includes('../GlanceWidget') || !macSources.includes('../GlanceKit')) {
	fail('the macOS widget target does not build both apple/GlanceWidget and apple/GlanceKit');
}
const embeds = (mac.targets?.ThreeWSGlance?.dependencies || []).some((d) => d.target === 'GlanceWidget' && d.embed);
if (!embeds) fail('the macOS app does not embed the widget extension');
pass('the macOS project builds and embeds the same sources');

// ---------------------------------------------------- plists and entitlements ---

const plists = [
	['apple/GlanceWidget/Info.plist', ['GlanceOrigin', 'GlanceAppGroup', 'GlanceKeychainGroup', 'com.apple.widgetkit-extension']],
	['apple/macos/ThreeWSGlance/Info.plist', ['GlanceOrigin', 'GlanceAppGroup', 'GlanceKeychainGroup', 'threews']],
	['ios/native/App/App/Info.plist', ['GlanceOrigin', 'GlanceAppGroup', 'GlanceKeychainGroup', 'threews']],
	['apple/GlanceWidget/GlanceWidget.entitlements', ['application-groups', 'keychain-access-groups']],
	['apple/macos/ThreeWSGlance/ThreeWSGlance.entitlements', ['application-groups', 'keychain-access-groups']],
	['ios/native/App/App/App.entitlements', ['application-groups', 'keychain-access-groups']],
];
for (const [file, keys] of plists) {
	const body = read(file);
	for (const key of keys) {
		if (!body.includes(key)) fail(`${file} is missing ${key}`);
	}
	// A plist that names a build setting nothing defines expands to an empty
	// string and the widget silently loses its container.
	for (const [, setting] of body.matchAll(/\$\((GLANCE_[A-Z_]+)\)/g)) {
		if (!SETTINGS.includes(setting)) fail(`${file} expands $(${setting}), which no project defines`);
	}
}
pass(`${plists.length} plists carry the keys the widget reads`);

// ------------------------------------------------------- the wire, both ends ---

const client = read('apple/GlanceKit/GlanceClient.swift');
const card = read('apple/GlanceKit/GlanceCard.swift');
const mine = read('api/glance/mine.js');
const png = read('api/_lib/glance-png.js');
const svg = read('api/_lib/glance-svg.js');
const token = read('api/glance/token.js');

if (!client.includes('api/glance/mine')) fail('the Swift client does not call /api/glance/mine');
for (const param of ['format', 'size', 'theme', 'scale']) {
	if (!client.includes(`name: "${param}"`)) fail(`the Swift client never sends ?${param}, which the server reads`);
}
pass('the Swift client calls the endpoint with the query the server reads');

// Header names, as the server sets them.
const headers = [...mine.matchAll(/setHeader\('(x-glance-[a-z]+)'/g)].map((m) => m[1]);
const usedByClient = headers.filter((h) => client.includes(`"${h}"`));
for (const needed of ['x-glance-state', 'x-glance-url', 'x-glance-name', 'x-glance-metric', 'x-glance-agent', 'x-glance-updated']) {
	if (!headers.includes(needed)) fail(`api/glance/mine.js no longer sets ${needed}, which the widget reads`);
	if (!usedByClient.includes(needed)) fail(`the Swift client no longer reads ${needed}`);
}
pass(`the client reads ${usedByClient.length} of the ${headers.length} headers the server sets`);

// State strings. Every state the server can answer has a Swift case.
const states = [...mine.matchAll(/^\t(\w+): '([a-z-]+)',$/gm)].map((m) => m[2]);
for (const state of states) {
	const cased = card.includes(`= "${state}"`) || card.includes(`case ${state}\n`) || new RegExp(`case ${state}\\b`).test(card);
	if (!cased) fail(`GlanceState has no case for the server state "${state}"`);
}
if (states.length !== 4) fail(`api/glance/mine.js declares ${states.length} states, expected 4`);
pass(`GlanceState covers all ${states.length} server states`);

// Sizes and scales.
const sizes = [...svg.matchAll(/^\t(small|medium|large):/gm)].map((m) => m[1]);
for (const size of sizes) {
	if (!new RegExp(`case ${size}\\b`).test(card)) fail(`GlanceSize has no case for the server size "${size}"`);
}
const scales = (png.match(/GLANCE_PNG_SCALES = \[([^\]]+)\]/) || [, ''])[1]
	.split(',')
	.map((n) => Number(n.trim()));
const swiftScales = [...card.matchAll(/\? (\d) : (\d)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
for (const scale of swiftScales) {
	if (!scales.includes(scale)) fail(`the widget asks for scale=${scale}, which the server refuses (accepts ${scales.join(', ')})`);
}
pass(`sizes and scales agree with the server (${sizes.join(', ')} at ${swiftScales.join(' and ')}x)`);

// The deep link, both ends.
const link = read('apple/GlanceKit/GlanceLink.swift');
const appleUrl = (token.match(/return `(threews:\/\/[^`]+)`/) || [, ''])[1];
if (!appleUrl.startsWith('threews://glance/link?token=')) {
	fail(`api/glance/token.js builds an apple link the widget does not recognise: ${appleUrl || 'none'}`);
}
if (!link.includes('static let host = "glance"') || !link.includes('static let path = "/link"')) {
	fail('GlanceLink no longer claims threews://glance/link');
}
const serverPattern = (read('api/_lib/glance-tokens.js').match(/TOKEN_RE = \/\^(.+?)\$\//) || [, ''])[1];
const swiftPattern = (read('apple/GlanceKit/GlanceTokenStore.swift').match(/pattern = "\^(.+?)\$"/) || [, ''])[1];
if (!serverPattern || serverPattern !== swiftPattern) {
	fail(`the token shape differs: server /${serverPattern}/ against Swift /${swiftPattern}/`);
}
pass('the deep link and the token shape match the server');

// ----------------------------------------------------------------- verdict ---

if (problems.length) {
	console.error('');
	for (const problem of problems) console.error(`[apple-widget] FAIL ${problem}`);
	console.error(`\n[apple-widget] ${problems.length} problem(s). See apple/README.md.`);
	process.exit(1);
}
console.log(`[apple-widget] ${checks} checks passed`);
