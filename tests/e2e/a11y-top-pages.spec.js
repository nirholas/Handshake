// Task 07 — automated accessibility floor. Runs axe-core against the top 30
// pages by data/pages.json priority (the same ranking that drives the
// sitemap/llms.txt), catching contrast-below-AA, missing labels, and
// keyboard traps before they ship. `wcag2a`/`wcag2aa`/`wcag21aa` rule sets
// only — no experimental/best-practice rules, so this stays a hard gate and
// not a taste argument.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pagesData = JSON.parse(readFileSync(join(ROOT, 'data', 'pages.json'), 'utf8'));

const allPages = pagesData.sections.flatMap((s) => s.pages);
const top30 = [...allPages]
	.sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5))
	.slice(0, 30);

// Known, accepted contrast exceptions: third-party embeds we don't control
// the markup of, or pages that intentionally render user-generated content.
// Keep this list short and named — it is an exception ledger, not a bypass.
const KNOWN_EXCEPTIONS = new Set([]);

for (const { path } of top30) {
	test(`a11y floor: ${path}`, async ({ page }) => {
		if (KNOWN_EXCEPTIONS.has(path)) test.skip();
		await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await page.waitForTimeout(500); // let above-the-fold async content settle

		const results = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
			.analyze();

		if (results.violations.length > 0) {
			const summary = results.violations
				.map((v) => `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`)
				.join('\n\n');
			throw new Error(`axe found ${results.violations.length} violation(s) on ${path}:\n\n${summary}`);
		}

		expect(results.violations).toEqual([]);
	});
}
