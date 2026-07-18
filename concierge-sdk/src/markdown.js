/**
 * Markdown-lite renderer — @three-ws/concierge
 * ============================================
 *
 * Answers stream back as plain text with light markdown (bold, code, links,
 * lists). This renders that subset to safe HTML: every piece of source text is
 * escaped BEFORE markup is applied, links are restricted to http(s)/mailto and
 * always open in a new tab with rel hardening. No innerHTML of raw model
 * output, ever.
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

function safeHref(url) {
	const u = String(url || '').trim();
	if (/^(https?:\/\/|mailto:|\/)/i.test(u)) return u;
	return null;
}

function inline(md) {
	let out = escapeHtml(md);
	// `code`
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
	// **bold** then *italic*
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
	// [label](url) — href is validated; the label is already escaped
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
		const href = safeHref(url);
		return href
			? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
			: label;
	});
	return out;
}

/**
 * Render markdown-lite `text` to an HTML string (paragraphs, bullet/numbered
 * lists, fenced code blocks, inline marks). Safe against HTML injection.
 */
export function renderMarkdown(text) {
	const src = String(text ?? '').replace(/\r\n/g, '\n');
	const blocks = [];
	const lines = src.split('\n');
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (/^```/.test(line)) {
			const buf = [];
			i++;
			while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
			i++; // closing fence (or EOF)
			blocks.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
			continue;
		}

		if (/^\s*[-*]\s+/.test(line)) {
			const items = [];
			while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
				i++;
			}
			blocks.push(`<ul>${items.join('')}</ul>`);
			continue;
		}

		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items = [];
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
				items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
				i++;
			}
			blocks.push(`<ol>${items.join('')}</ol>`);
			continue;
		}

		if (!line.trim()) {
			i++;
			continue;
		}

		// Paragraph: consume until a blank line or a structural line.
		const buf = [];
		while (i < lines.length && lines[i].trim() && !/^```|^\s*[-*]\s+|^\s*\d+[.)]\s+/.test(lines[i])) {
			buf.push(lines[i++]);
		}
		blocks.push(`<p>${inline(buf.join(' '))}</p>`);
	}

	return blocks.join('');
}

/**
 * Strip markdown for the voice channel — what the narrator speaks should be
 * the words, not the syntax.
 */
export function stripMarkdown(text) {
	return String(text ?? '')
		.replace(/```[\s\S]*?```/g, ' code sample. ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*\n]+)\*/g, '$1')
		.replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
		.replace(/^[\s]*[-*]\s+/gm, '')
		.replace(/^[\s]*\d+[.)]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
}
