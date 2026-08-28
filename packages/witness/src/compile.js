// Compile a trace into a Playwright spec that FAILS on the reported bug.
//
// This is the part that changes what a bug report is. A normal report is prose
// a maintainer has to translate into an experiment. A compiled report IS the
// experiment: check it out, run it, watch it go red, fix the code, watch it go
// green. The report becomes a regression test the moment it is filed, and the
// definition of "fixed" stops being a judgement call.
//
// The critical design decision is that the generated test asserts the ABSENCE
// of the failure the visitor hit, not the presence of whatever the page did.
// A recorder that emits `expect(status).toBe(500)` has written a test that
// passes while the site is broken and fails once it is fixed, which is worse
// than no test at all. So the failure in the trace is inverted into the
// assertion:
//
//   trace: POST /api/export -> 500     spec: expect(failures).toEqual([])
//   trace: TypeError: x is not a fn    spec: expect(pageErrors).toEqual([])
//
// Pure, DOM-free, and dependency-free so it runs identically in the browser,
// in the API, and in the CLI.

import { toPlaywrightLocator, describeForHuman } from './selector.js';

function quote(value) {
	return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function commentSafe(value) {
	return String(value ?? '')
		.replace(/\*\//g, '*\\/')
		.replace(/[\r\n]+/g, ' ')
		.slice(0, 200);
}

function slug(value, max = 48) {
	return (
		String(value || '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, max) || 'report'
	);
}

/** The events that describe intent, in order, with the noise dropped. */
function actionable(events) {
	return events.filter((e) => ['goto', 'navigate', 'click', 'fill', 'check', 'select', 'submit', 'key'].includes(e.type));
}

/** Every failure the session saw, split by kind so each gets the right assertion. */
export function failuresIn(trace) {
	const events = trace?.events || [];
	const network = [];
	const errors = [];
	const resources = [];
	for (const e of events) {
		if (e.type === 'xhr' && e.detail) network.push(e.detail);
		else if ((e.type === 'error' || e.type === 'rejection') && e.detail) errors.push(e.detail);
		else if (e.type === 'resource' && e.detail) resources.push(e.detail);
	}
	return { network, errors, resources, any: network.length + errors.length + resources.length > 0 };
}

/** The route the session started on, which is where the replay must start. */
export function entryRoute(trace) {
	const first = (trace?.events || []).find((e) => e.type === 'goto');
	return first?.detail || trace?.environment?.url || '/';
}

/**
 * One human-readable line per step. The same source of truth as the spec, so
 * the queue and the test can never describe different sequences.
 */
export function narrate(trace) {
	const steps = [];
	for (const e of actionable(trace?.events || [])) {
		const who = e.el ? describeForHuman(e.el) : null;
		const times = e.count > 1 ? ` (x${e.count})` : '';
		switch (e.type) {
			case 'goto':
				steps.push(`Open ${e.detail}`);
				break;
			case 'navigate':
				steps.push(`Go to ${e.detail}`);
				break;
			case 'click':
				steps.push(`Click ${who}${times}`);
				break;
			case 'fill': {
				const [shape, length] = String(e.detail || '').split(':');
				steps.push(
					shape === 'private'
						? `Type into ${who}`
						: `Type ${length} character${length === '1' ? '' : 's'} into ${who}`,
				);
				break;
			}
			case 'check':
				steps.push(`${e.detail === 'on' ? 'Check' : 'Uncheck'} ${who}`);
				break;
			case 'select':
				steps.push(`Choose "${e.detail}" in ${who}`);
				break;
			case 'submit':
				steps.push(`Submit ${who}`);
				break;
			case 'key':
				steps.push(`Press ${e.detail}`);
				break;
			default:
				break;
		}
	}
	const { network, errors } = failuresIn(trace);
	for (const line of errors) steps.push(`The page threw: ${line}`);
	for (const line of network) steps.push(`The request failed: ${line}`);
	return steps;
}

/**
 * The confidence that this replays: the weakest link in the chain of selectors,
 * because one fragile locator breaks the whole spec.
 */
export function replayConfidence(trace) {
	const described = actionable(trace?.events || []).filter((e) => e.el);
	if (!described.length) return { score: 0, weakest: null, note: 'No interactions were recorded.' };
	let weakest = described[0].el;
	for (const e of described) if ((e.el.confidence ?? 0) < (weakest.confidence ?? 0)) weakest = e.el;
	const score = weakest.confidence ?? 0;
	const note =
		score >= 80
			? 'Every step is anchored to a stable handle.'
			: score >= 60
				? 'One or more steps rely on visible text, which moves when copy changes.'
				: score >= 40
					? 'A step is anchored to a class name, which a restyle can break.'
					: 'A step falls back to a structural path and will not survive a refactor.';
	return { score, weakest, note };
}

function actionLine(event) {
	const locator = toPlaywrightLocator(event.el);
	switch (event.type) {
		case 'navigate':
			return `\tawait page.goto(${quote(event.detail)});`;
		case 'click':
			return `\tawait ${locator}.click();`;
		case 'submit':
			// Submitting through the form element is what actually happened, and it
			// exercises the same handler a click on the button would.
			return `\tawait ${locator}.evaluate((form) => form.requestSubmit());`;
		case 'check':
			return event.detail === 'on' ? `\tawait ${locator}.check();` : `\tawait ${locator}.uncheck();`;
		case 'select':
			return `\tawait ${locator}.selectOption({ label: ${quote(event.detail)} });`;
		case 'key':
			return `\tawait page.keyboard.press(${quote(event.detail)});`;
		case 'fill': {
			const [shape, length] = String(event.detail || '').split(':');
			if (shape === 'private') {
				return `\t// The visitor typed into this field. The value was never recorded\n\t// (see @three-ws/witness redact.js); supply a real one to replay.\n\tawait ${locator}.fill(process.env.WITNESS_INPUT || 'replace-me');`;
			}
			const sample =
				shape === 'digits'
					? '1'.repeat(Math.min(Number(length) || 1, 12))
					: shape === 'email'
						? 'someone@example.com'
						: shape === 'url'
							? 'https://example.com'
							: 'x'.repeat(Math.min(Number(length) || 1, 40));
			return `\tawait ${locator}.fill(${quote(sample)}); // visitor typed ${length} ${shape} character(s)`;
		}
		default:
			return null;
	}
}

/**
 * Emit a runnable Playwright spec.
 *
 * @param {object} trace         a trace from Recorder#trace()
 * @param {object} [options]
 * @param {string} [options.title]    what the visitor reported, used as the test name
 * @param {string} [options.baseUrl]  origin the replay runs against
 * @param {string} [options.reportId] the report this came from, linked in a comment
 * @returns {{ filename:string, source:string, confidence:object, steps:string[] }}
 */
export function compileToPlaywright(trace, options = {}) {
	const { title = 'reported issue', baseUrl = '', reportId = null } = options;
	const events = actionable(trace?.events || []);
	const failures = failuresIn(trace);
	const confidence = replayConfidence(trace);
	const steps = narrate(trace);
	const env = trace?.environment || {};
	const route = entryRoute(trace);
	const start = baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}${route}` : route;

	const header = [
		'// Generated by @three-ws/witness from a real user session.',
		`// Report:  ${commentSafe(title)}`,
		reportId ? `// Source:  feedback report ${commentSafe(reportId)}` : null,
		env.userAgent ? `// Browser: ${commentSafe(env.userAgent)}` : null,
		`// Replay confidence: ${confidence.score}/100. ${confidence.note}`,
		'//',
		'// This test asserts the FAILURE IS GONE, so it is red until the bug is fixed.',
		'// What the visitor did:',
		...steps.map((s) => `//   ${commentSafe(s)}`),
		'',
		"import { test, expect } from '@playwright/test';",
		'',
	]
		.filter((line) => line !== null)
		.join('\n');

	const viewport = env.viewport?.width
		? `\ttest.use({ viewport: { width: ${env.viewport.width}, height: ${env.viewport.height} }${
				env.locale ? `, locale: ${quote(env.locale)}` : ''
			}${env.touch ? ', hasTouch: true, isMobile: true' : ''} });\n`
		: '';

	const body = [];
	body.push('\t// Collect the same classes of failure the visitor hit, so the assertions');
	body.push('\t// below fail for the reported reason and not for an unrelated one.');
	body.push('\tconst pageErrors = [];');
	body.push('\tconst failedRequests = [];');
	body.push("\tpage.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));");
	body.push("\tpage.on('response', (res) => {");
	body.push('\t\tif (res.status() >= 400) failedRequests.push(`${res.request().method()} ${new URL(res.url()).pathname} -> ${res.status()}`);');
	body.push('\t});');
	body.push('');
	body.push(`\tawait page.goto(${quote(start)});`);

	for (const event of events) {
		if (event.type === 'goto') continue;
		const line = actionLine(event);
		if (line) body.push(line);
	}

	body.push('');
	if (failures.errors.length) {
		body.push('\t// The session threw. The reported failure was:');
		for (const e of failures.errors) body.push(`\t//   ${commentSafe(e)}`);
		body.push('\texpect(pageErrors, `the page threw during the reported flow`).toEqual([]);');
	}
	if (failures.network.length) {
		body.push('\t// The session saw these requests fail:');
		for (const n of failures.network) body.push(`\t//   ${commentSafe(n)}`);
		body.push('\texpect(failedRequests, `a request failed during the reported flow`).toEqual([]);');
	}
	if (failures.resources.length) {
		body.push('\t// Assets the page could not load:');
		for (const r of failures.resources) body.push(`\t//   ${commentSafe(r)}`);
		body.push('\texpect(failedRequests, `an asset failed to load`).toEqual([]);');
	}
	if (!failures.any) {
		// No machine-visible failure: the complaint is about behaviour a person
		// judged wrong. An assertion invented here would be fiction, so the spec
		// says plainly what a human must add, and does not pretend to be green.
		body.push('\t// The browser recorded no exception or failed request for this report:');
		body.push('\t// the visitor judged the RESULT wrong, which no recorder can see.');
		body.push('\t// Replace this with the assertion that states what should have happened.');
		body.push("\texpect(pageErrors, 'no page errors during the reported flow').toEqual([]);");
		body.push("\ttest.fail(true, 'Add the assertion this report is really about.');");
	}

	const source = `${header}test.describe('witness repro', () => {\n${viewport}\ttest(${quote(
		title.slice(0, 100),
	)}, async ({ page }) => {\n${body.join('\n')}\n\t});\n});\n`;

	return {
		filename: `${slug(reportId || title)}.spec.js`,
		source,
		confidence,
		steps,
	};
}
