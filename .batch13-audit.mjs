// Batch-13 docs audit: console errors, failed requests, link resolution.
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3000';
const PATHS = (process.env.PATHS || [
	'/docs/mcp-intel',
	'/docs/mcp-vanity',
	'/docs/mcp-naming',
	'/docs/mcp-marketplace',
	'/docs/skills',
	'/docs/widgets',
	'/docs/api-reference',
	'/docs/authentication',
].join(',')).split(',');

const browser = await chromium.launch();
const urlCache = new Map();

async function getStatus(url) {
	if (urlCache.has(url)) return urlCache.get(url);
	let status = -1;
	try {
		const r = await fetch(url, { redirect: 'follow' });
		await r.arrayBuffer();
		status = r.status;
	} catch {
		status = -1;
	}
	urlCache.set(url, status);
	return status;
}

const mdCache = new Map();
async function docHeadingIds(slug) {
	if (mdCache.has(slug)) return mdCache.get(slug);
	let ids = null;
	const r = await fetch(`${BASE}/docs/${slug}.md`);
	if (r.ok) {
		const text = await r.text();
		if (!/^\s*<!doctype html/i.test(text)) {
			ids = new Set();
			let fence = false;
			for (const line of text.split('\n')) {
				if (/^\s*```/.test(line)) fence = !fence;
				if (fence) continue;
				const m = /^(#{1,6})\s+(.*)$/.exec(line);
				if (m) {
					ids.add(
						m[2]
							.replace(/`/g, '')
							.replace(/\*\*/g, '')
							.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
							.toLowerCase()
							.replace(/[^\w\s-]/g, '')
							.trim()
							.replace(/\s+/g, '-'),
					);
				}
			}
		}
	}
	mdCache.set(slug, ids);
	return ids;
}

const report = [];
for (const p of PATHS) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const consoleErrors = [];
	const pageErrors = [];
	const failedReqs = [];
	page.on('console', (m) => {
		if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
	});
	page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
	page.on('requestfailed', (r) => failedReqs.push(`FAILED ${r.url()} :: ${r.failure()?.errorText}`));
	page.on('response', (r) => {
		if (r.status() >= 400) failedReqs.push(`${r.status()} ${r.url()}`);
	});

	const resp = await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => {
		pageErrors.push('goto failed: ' + e.message);
		return null;
	});
	await page.waitForTimeout(2500);

	const info = await page.evaluate(() => {
		const anchors = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
		const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
		return {
			title: document.title,
			desc: document.querySelector('meta[name="description"]')?.getAttribute('content') || null,
			h1: document.querySelector('h1')?.textContent?.trim() || null,
			bodyLen: document.body.innerText.length,
			anchors,
			ids,
		};
	});

	const dead = [];
	const seen = new Set();
	for (const href of info.anchors) {
		if (!href || seen.has(href)) continue;
		seen.add(href);
		if (/^(mailto:|javascript:|data:|tel:)/i.test(href)) continue;

		if (href.startsWith('#')) {
			const raw = decodeURIComponent(href.slice(1));
			if (!raw) continue;
			if (info.ids.includes(raw)) continue;
			const [slug, anchor] = raw.split('@');
			const ids = await docHeadingIds(slug);
			if (!ids) dead.push(`HASHROUTE ${href} (no /docs/${slug}.md)`);
			else if (anchor && !ids.has(anchor)) dead.push(`HASHANCHOR ${href}`);
			continue;
		}

		let url;
		if (/^https?:\/\//i.test(href)) {
			url = href;
			if (!/(^|\/\/)([a-z0-9-]+\.)?three\.ws/.test(url)) continue;
			url = url.replace(/^https?:\/\/three\.ws/, BASE);
		} else {
			url = new URL(href, BASE + p).toString();
		}
		const st = await getStatus(url.split('#')[0]);
		if (st >= 400 || st < 0) dead.push(`${st} ${href}`);
	}

	report.push({
		path: p,
		status: resp?.status() ?? 0,
		title: info.title,
		desc: info.desc,
		h1: info.h1,
		bodyLen: info.bodyLen,
		links: info.anchors.length,
		consoleErrors,
		pageErrors,
		failedReqs,
		dead,
	});
	await ctx.close();
}
await browser.close();

for (const r of report) {
	console.log('='.repeat(70));
	console.log(r.path, 'HTTP', r.status, '| bodyLen', r.bodyLen, '| links', r.links);
	console.log('  title:', r.title);
	console.log('  desc :', r.desc);
	console.log('  h1   :', r.h1);
	console.log('  counts: console=' + r.consoleErrors.length, 'pageErrors=' + r.pageErrors.length, 'netFail=' + new Set(r.failedReqs).size, 'dead=' + r.dead.length);
	if (r.consoleErrors.length) console.log('  CONSOLE:\n    ' + r.consoleErrors.slice(0, 15).join('\n    '));
	if (r.pageErrors.length) console.log('  PAGEERR:\n    ' + r.pageErrors.join('\n    '));
	if (r.failedReqs.length) console.log('  NETFAIL:\n    ' + [...new Set(r.failedReqs)].slice(0, 20).join('\n    '));
	if (r.dead.length) console.log('  DEADLINK:\n    ' + r.dead.join('\n    '));
}
