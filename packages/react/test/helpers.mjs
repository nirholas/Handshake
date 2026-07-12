// Shared helpers for the @three-ws/react test suite.
//
// Tests run against the built bundles in dist/ (the artifact that actually
// ships) — `npm test` triggers a fresh build via the pretest hook. Rendering
// is done with react-dom/server so no DOM shim is needed: everything the
// component puts in markup (iframe src, wrapper styles, pass-through props)
// is asserted on the serialized HTML string.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Render a component to static HTML with the given props. */
export function render(Component, props = {}) {
	return renderToStaticMarkup(React.createElement(Component, props));
}

/** Undo React's attribute-value HTML escaping. */
export function unescapeHtml(value) {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/** Extract the iframe's src attribute from rendered markup as a URL object. */
export function iframeSrc(html) {
	const match = html.match(/<iframe[^>]*\ssrc="([^"]*)"/);
	if (!match) throw new Error(`no <iframe src> found in markup: ${html}`);
	return new URL(unescapeHtml(match[1]));
}

/** Extract an attribute value from the first tag matching `tag`. */
export function attrOf(html, tag, attr) {
	const tagMatch = html.match(new RegExp(`<${tag}[^>]*>`));
	if (!tagMatch) throw new Error(`no <${tag}> found in markup: ${html}`);
	const attrMatch = tagMatch[0].match(new RegExp(`\\s${attr}="([^"]*)"`));
	return attrMatch ? unescapeHtml(attrMatch[1]) : null;
}

/** Parse an inline style attribute string into a { prop: value } object. */
export function styleOf(html, tag) {
	const raw = attrOf(html, tag, 'style');
	if (raw == null) return {};
	const out = {};
	for (const decl of raw.split(';')) {
		const i = decl.indexOf(':');
		if (i === -1) continue;
		out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
	}
	return out;
}
