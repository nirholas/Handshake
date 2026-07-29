// Markdown for pump.fun bounty briefs/submissions and the agent copilot.
//
// This is a thin preset over the shared sanitized pipeline
// (src/shared/markdown.js): full CommonMark + GFM via `marked`, then a strict
// DOMPurify pass. Headings are demoted two levels so a brief's `#` sits under
// the page's section `<h2>`, and `<pre>` keeps the `md-pre` class the bounty
// stylesheet targets.
//
// It previously carried ~150 lines of hand-rolled regex parsing. That version
// could not render tables or nested lists and broke on adjacent emphasis;
// every fix had to be repeated across the seven other copies in this repo.

import { renderMarkdown } from './shared/markdown.js';

const PRESET = { demoteHeadings: 2, classes: { pre: 'md-pre' } };

/** Render Markdown to sanitized HTML, safe to assign via innerHTML. */
export function mdToHtml(src) {
	return renderMarkdown(src, PRESET);
}
