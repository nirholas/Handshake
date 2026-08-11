// Real, safe task library for the on-demand caster pool.
//
// Each task is a genuinely real end-to-end web job the caster runs in a real
// Chromium page: it navigates to a real public page, reads it, fills a real
// form, submits, waits for real results, and reads them back. No fabricated
// success screens, no fake form targets, no token discovery — every step lands
// against a live, stable, headless-friendly public site.
//
// A task is a declarative ordered list of steps. The pool's task-runner executes
// them with raw Playwright and narrates each one a beat before it happens. The
// declarative shape keeps the sequence pure and unit-testable (see
// tests/agent-screen-task-sequencer.test.js) — the side effects live entirely in
// the executor the pool injects.
//
// Step kinds:
//   goto       { url }                          — navigate
//   type       { selector, value }              — type into a field, char by char
//   submit     { selector, key }                — press a key (Enter) to submit
//   waitResult { selector, fallbackUrl? }       — wait for results to appear
//   read       { selector, multi?, limit? }     — read text back from the page
//
// $THREE is the only coin. These tasks never browse to, name, or transact any
// token. They research neutral public topics — that is the whole point of the
// "watch an agent do real web work" moment.

export const TASKS = [
	{
		id: 'wiki-research',
		title: 'Research a topic on Wikipedia',
		// The topic the agent researches. Neutral, on-brand (the 3D library this
		// platform is built on), and a real, stable Wikipedia article.
		topic: 'Three.js',
		startUrl: 'https://en.wikipedia.org/wiki/Main_Page',
		steps: [
			{ id: 'open', kind: 'goto', url: 'https://en.wikipedia.org/wiki/Main_Page', narration: 'Opening Wikipedia' },
			{ id: 'type', kind: 'type', selector: 'input[name="search"]', value: 'Three.js', narration: 'Typing the topic into the search box' },
			{ id: 'submit', kind: 'submit', selector: 'input[name="search"]', key: 'Enter', narration: 'Submitting the search' },
			{
				id: 'wait',
				kind: 'waitResult',
				selector: '#firstHeading',
				// If the typeahead swallowed Enter, fall back to the canonical article
				// URL so the run still completes against real content (no fake screen).
				fallbackUrl: 'https://en.wikipedia.org/wiki/Three.js',
				narration: 'Waiting for the article to load',
			},
			// Descendant, not a direct child of .mw-parser-output: Wikipedia now wraps
			// article prose in an inner content div, so the old `> p` matched nothing
			// and the agent narrated its way to an empty read. The executor takes the
			// first paragraph that carries text, which is the lead summary.
			{ id: 'read', kind: 'read', selector: '#mw-content-text p', narration: 'Reading the opening summary' },
		],
	},
	{
		id: 'hn-scan',
		title: 'Scan the Hacker News front page',
		topic: 'top technology stories',
		startUrl: 'https://news.ycombinator.com/',
		steps: [
			{ id: 'open', kind: 'goto', url: 'https://news.ycombinator.com/', narration: 'Opening the Hacker News front page' },
			{ id: 'wait', kind: 'waitResult', selector: '.titleline', narration: 'Waiting for the stories to load' },
			{ id: 'read', kind: 'read', selector: '.titleline > a', multi: true, limit: 5, narration: 'Reading the top stories' },
		],
	},
	{
		id: 'mdn-lookup',
		title: 'Look something up in the MDN docs',
		topic: 'the Fetch API',
		startUrl: 'https://developer.mozilla.org/en-US/',
		steps: [
			{ id: 'open', kind: 'goto', url: 'https://developer.mozilla.org/en-US/', narration: 'Opening the MDN web docs' },
			{ id: 'type', kind: 'type', selector: 'input[type="search"]', value: 'Fetch API', narration: 'Typing the API name into search' },
			{ id: 'submit', kind: 'submit', selector: 'input[type="search"]', key: 'Enter', narration: 'Submitting the lookup' },
			{
				id: 'wait',
				kind: 'waitResult',
				selector: 'main',
				fallbackUrl: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
				narration: 'Waiting for the documentation to load',
			},
			{ id: 'read', kind: 'read', selector: 'main p', narration: 'Reading the reference summary' },
		],
	},
];

// Deterministic task assignment: a given agent always shows the same task (so a
// reconnect resumes a coherent run), but different agents spread across the
// library — variety on the wall without any randomness (which the workflow
// runtime forbids anyway). Plain char-sum hash, stable across processes.
export function pickTask(agentId) {
	const id = String(agentId || '');
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return TASKS[h % TASKS.length];
}

export function getTask(taskId) {
	return TASKS.find((t) => t.id === taskId) || null;
}
