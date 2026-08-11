/**
 * js-comment-ranges.mjs: locate the comment spans of a JavaScript source file.
 *
 * Source-scanning guards match patterns with a regular expression, and a bare
 * regex cannot tell code from prose. A security comment that quotes the very
 * markup it defends against (`<img onerror=…>` in an XSS note) reads to a
 * pattern matcher exactly like a shipped tag, so a guard reports it and the
 * matching codemod rewrites it, corrupting the explanation. Comments describe
 * code, they never render, so every such scanner wants the same primitive:
 * where do the comments start and end.
 *
 * The scanner walks the source character by character and tracks the four
 * contexts where a `/` is not a comment: quoted strings, template literals
 * (including the code inside `${}`, arbitrarily nested), and regular-expression
 * literals. Regex-versus-division is decided from the previous significant
 * token, the same heuristic every JS tokenizer uses.
 */

// Tokens after which a `/` opens a regular expression rather than dividing.
const REGEX_PRECEDING_CHARS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

function skipQuoted(src, start) {
	const quote = src[start];
	let i = start + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\') { i += 2; continue; }
		if (c === quote || c === '\n') return i + 1;
		i++;
	}
	return i;
}

function skipRegex(src, start) {
	let i = start + 1;
	let inClass = false;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\') { i += 2; continue; }
		if (c === '\n') return i;
		if (c === '[') inClass = true;
		else if (c === ']') inClass = false;
		else if (c === '/' && !inClass) { i++; break; }
		i++;
	}
	while (i < src.length && IDENT_PART.test(src[i])) i++;
	return i;
}

/**
 * Every comment in `src`, as `{ start, end }` half-open index ranges, in order.
 */
export function commentRanges(src) {
	const ranges = [];
	const templateBraces = [];
	let braceDepth = 0;
	let inTemplate = false;
	let prevChar = '';
	let prevWord = '';
	let i = 0;

	while (i < src.length) {
		const c = src[i];
		const d = src[i + 1];

		if (inTemplate) {
			if (c === '\\') { i += 2; continue; }
			if (c === '`') { inTemplate = false; prevChar = '`'; prevWord = ''; i++; continue; }
			if (c === '$' && d === '{') {
				templateBraces.push(braceDepth);
				braceDepth++;
				inTemplate = false;
				prevChar = '{';
				prevWord = '';
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		if (c === '/' && d === '/') {
			const start = i;
			i += 2;
			while (i < src.length && src[i] !== '\n') i++;
			ranges.push({ start, end: i });
			continue;
		}
		if (c === '/' && d === '*') {
			const start = i;
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
			i = Math.min(i + 2, src.length);
			ranges.push({ start, end: i });
			continue;
		}
		if (c === '"' || c === "'") {
			i = skipQuoted(src, i);
			prevChar = c;
			prevWord = '';
			continue;
		}
		if (c === '`') {
			inTemplate = true;
			i++;
			continue;
		}
		if (c === '/') {
			if (REGEX_PRECEDING_CHARS.has(prevChar) || REGEX_PRECEDING_WORDS.has(prevWord)) {
				i = skipRegex(src, i);
				prevChar = '/';
				prevWord = '';
				continue;
			}
			prevChar = '/';
			prevWord = '';
			i++;
			continue;
		}
		if (IDENT_START.test(c)) {
			const start = i;
			while (i < src.length && IDENT_PART.test(src[i])) i++;
			prevWord = src.slice(start, i);
			prevChar = src[i - 1];
			continue;
		}
		if (c === '{') { braceDepth++; prevChar = '{'; prevWord = ''; i++; continue; }
		if (c === '}') {
			if (templateBraces.length > 0 && braceDepth === templateBraces[templateBraces.length - 1] + 1) {
				templateBraces.pop();
				braceDepth--;
				inTemplate = true;
				i++;
				continue;
			}
			braceDepth--;
			prevChar = '}';
			prevWord = '';
			i++;
			continue;
		}
		if (!/\s/.test(c)) { prevChar = c; prevWord = ''; }
		i++;
	}

	return ranges;
}

/** True when `index` falls inside one of the ranges from `commentRanges`. */
export function isInsideComment(ranges, index) {
	for (const { start, end } of ranges) {
		if (index < start) return false;
		if (index < end) return true;
	}
	return false;
}

/**
 * `src` with every comment character replaced by a space, newlines kept. Index
 * and line numbers stay identical to the original, so a scanner can match
 * against the masked text and report positions against the real file.
 */
export function maskComments(src) {
	const ranges = commentRanges(src);
	if (ranges.length === 0) return src;
	// Sliced by UTF-16 code unit, never by code point: an emoji in a comment is
	// two units, and blanking it as one character would shift every index after
	// it, silently masking real code in any file that contains one.
	let out = '';
	let cursor = 0;
	for (const { start, end } of ranges) {
		out += src.slice(cursor, start) + src.slice(start, end).replace(/[^\n]/g, ' ');
		cursor = end;
	}
	return out + src.slice(cursor);
}
