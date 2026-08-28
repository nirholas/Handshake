// Stable selector synthesis: the part that decides whether a generated test
// actually replays a year later.
//
// A recorder that writes `div > div:nth-child(3) > button` produces tests that
// pass review and break on the next refactor. So every element is described by
// the strongest handle it actually has, verified unique against the live
// document before it is accepted, and demoted one rung at a time until
// something holds. The ladder, strongest first:
//
//   testid      [data-testid] / [data-test] / [data-qa]   the author's own contract
//   id          #id, unless it looks framework-generated
//   label       [aria-label]
//   role        role + accessible name (Playwright getByRole)
//   text        visible text, for buttons and links
//   name        [name], for form controls
//   placeholder [placeholder], for inputs
//   class       one stable-looking class token
//   path        :nth-of-type chain, the honest last resort
//
// Each candidate carries a numeric confidence so the compiler can annotate a
// weak locator in the generated test instead of pretending it is solid. The
// caller sees exactly how fragile its own selector is.

export const STRATEGY_SCORE = {
	testid: 100,
	id: 95,
	label: 85,
	role: 80,
	text: 70,
	name: 65,
	placeholder: 60,
	class: 40,
	path: 10,
};

const TESTID_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy'];

// Ids and classes that a bundler or a CSS-in-JS runtime invented. Matching one
// means the handle will not survive the next build, so it is worth less than a
// structural path that at least describes the page.
const GENERATED = [
	/^[a-z]?[0-9a-f]{6,}$/i, // hash-like: a1b2c3d4
	/^(css|sc|jsx|emotion|mui|chakra|tw)-[a-z0-9]{4,}$/i, // styled-components and friends
	/^:r[0-9a-z]+:$/i, // React useId
	/^radix-[a-z0-9]+$/i,
	/^headlessui-/i,
	/^[0-9]/, // a leading digit is never a hand-written id
	/^(ember|ext-gen|yui)[0-9]+$/i,
	/[0-9]{4,}$/, // long numeric tails are almost always generated
];

// Utility-first class names (Tailwind and friends) describe appearance, not
// identity. A test hung off `.px-4` is a test hung off a design decision, and
// it breaks the first time somebody adjusts the padding. Matched as
// `[variant:]*root-`, which is the actual shape of the convention, so `px-4`,
// `sm:px-4`, `-mt-2`, and `hover:bg-blue-500` are all refused while a real
// class like `price-tag` is kept.
const UTILITY_ROOT = [
	'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe',
	'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me',
	'w', 'h', 'min', 'max', 'size', 'top', 'left', 'right', 'bottom', 'inset', 'z',
	'gap', 'flex', 'grid', 'col', 'row', 'basis', 'grow', 'shrink', 'order', 'place',
	'text', 'bg', 'border', 'rounded', 'shadow', 'opacity', 'ring', 'outline', 'divide',
	'translate', 'scale', 'rotate', 'skew', 'origin', 'transform',
	'space', 'leading', 'tracking', 'font', 'align', 'whitespace', 'break', 'indent',
	'items', 'justify', 'self', 'content', 'overflow', 'overscroll', 'cursor', 'select',
	'transition', 'duration', 'ease', 'delay', 'animate', 'aspect', 'object', 'float',
	'clear', 'list', 'placeholder', 'fill', 'stroke', 'filter', 'blur', 'backdrop', 'sr',
].join('|');
const UTILITY_CLASS = new RegExp(`^-?(?:[a-z0-9-]{1,12}:)*(?:${UTILITY_ROOT})-`, 'i');
// Single-word utilities carry no hyphen, so they need their own list.
const UTILITY_STANDALONE =
	/^(?:flex|grid|block|inline|inline-block|inline-flex|hidden|absolute|relative|fixed|sticky|static|truncate|italic|underline|uppercase|lowercase|capitalize|container|antialiased|isolate|contents|visible|invisible)$/i;

function looksUtility(token) {
	return UTILITY_STANDALONE.test(token) || UTILITY_CLASS.test(token) || token.includes('[');
}

const INTERACTIVE_ROLE = {
	A: 'link',
	BUTTON: 'button',
	SELECT: 'combobox',
	TEXTAREA: 'textbox',
	SUMMARY: 'button',
};

const INPUT_ROLE = {
	button: 'button',
	submit: 'button',
	reset: 'button',
	checkbox: 'checkbox',
	radio: 'radio',
	range: 'slider',
	search: 'searchbox',
	email: 'textbox',
	tel: 'textbox',
	text: 'textbox',
	url: 'textbox',
	number: 'spinbutton',
};

function looksGenerated(value) {
	const token = String(value || '');
	if (!token) return true;
	return GENERATED.some((re) => re.test(token));
}

function cssEscape(value) {
	const text = String(value);
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text);
	return text.replace(/["\\\]]/g, '\\$&');
}

function quote(value) {
	return `"${String(value).replace(/["\\]/g, '\\$&')}"`;
}

/** Trim and collapse the way a screen reader would before comparing names. */
export function normalizeName(text) {
	return String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The accessible name, computed over the subset of the spec that real pages
 * actually use: aria-label, aria-labelledby, a wrapping or associated <label>,
 * alt text, value on buttons, title, then the visible text.
 */
export function accessibleName(el) {
	if (!el || el.nodeType !== 1) return '';
	const aria = normalizeName(el.getAttribute?.('aria-label'));
	if (aria) return aria;

	const labelledBy = el.getAttribute?.('aria-labelledby');
	if (labelledBy) {
		const names = labelledBy
			.split(/\s+/)
			.map((id) => el.ownerDocument?.getElementById(id)?.textContent || '')
			.map(normalizeName)
			.filter(Boolean);
		if (names.length) return normalizeName(names.join(' '));
	}

	const tag = el.tagName;
	if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
		const id = el.getAttribute('id');
		if (id) {
			const label = el.ownerDocument?.querySelector(`label[for="${cssEscape(id)}"]`);
			const text = normalizeName(label?.textContent);
			if (text) return text;
		}
		const wrapping = el.closest?.('label');
		if (wrapping) {
			const text = normalizeName(wrapping.textContent);
			if (text) return text;
		}
		if (tag === 'INPUT') {
			const type = (el.getAttribute('type') || 'text').toLowerCase();
			if (type === 'button' || type === 'submit' || type === 'reset') {
				const value = normalizeName(el.getAttribute('value'));
				if (value) return value;
			}
		}
	}

	if (tag === 'IMG') {
		const alt = normalizeName(el.getAttribute('alt'));
		if (alt) return alt;
	}

	const title = normalizeName(el.getAttribute?.('title'));
	const text = normalizeName(el.textContent);
	// Text wins over title when both exist: it is what the person actually read.
	return text || title;
}

/** The ARIA role, explicit first, then the implicit role of the tag. */
export function roleOf(el) {
	if (!el || el.nodeType !== 1) return null;
	const explicit = normalizeName(el.getAttribute?.('role'));
	if (explicit) return explicit.split(/\s+/)[0];
	const tag = el.tagName;
	if (tag === 'INPUT') {
		const type = (el.getAttribute('type') || 'text').toLowerCase();
		return INPUT_ROLE[type] || null;
	}
	if (INTERACTIVE_ROLE[tag]) {
		// A bare anchor with no href is not a link to anyone, screen readers
		// included, so it does not get the link role here either.
		if (tag === 'A' && !el.getAttribute('href')) return null;
		return INTERACTIVE_ROLE[tag];
	}
	if (/^H[1-6]$/.test(tag)) return 'heading';
	return null;
}

function unique(doc, css) {
	try {
		return doc.querySelectorAll(css).length === 1;
	} catch {
		return false;
	}
}

/** Every element with this role whose accessible name matches, exactly as Playwright's getByRole resolves it. */
function roleMatchCount(doc, role, name) {
	let count = 0;
	const all = doc.querySelectorAll('*');
	for (const node of all) {
		if (roleOf(node) !== role) continue;
		if (normalizeName(accessibleName(node)) === name) count += 1;
		if (count > 1) return count;
	}
	return count;
}

function textMatchCount(doc, tag, text) {
	let count = 0;
	for (const node of doc.querySelectorAll(tag)) {
		if (normalizeName(node.textContent) === text) count += 1;
		if (count > 1) return count;
	}
	return count;
}

/** The :nth-of-type chain, capped so it stays readable, used only when nothing better exists. */
export function structuralPath(el, { maxDepth = 5 } = {}) {
	const parts = [];
	let node = el;
	let depth = 0;
	while (node && node.nodeType === 1 && node.tagName !== 'HTML' && depth < maxDepth) {
		const tag = node.tagName.toLowerCase();
		const parent = node.parentElement;
		if (!parent) {
			parts.unshift(tag);
			break;
		}
		const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
		parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
		if (parent.tagName === 'BODY') break;
		node = parent;
		depth += 1;
	}
	return parts.join(' > ');
}

/**
 * Describe an element as the strongest handle that uniquely identifies it.
 *
 * @param {Element} el
 * @returns {{strategy:string, value:string, css:string|null, role?:string, name?:string, confidence:number, tag:string}|null}
 */
export function describeElement(el) {
	if (!el || el.nodeType !== 1) return null;
	const doc = el.ownerDocument;
	const tag = el.tagName.toLowerCase();
	const base = { tag };

	for (const attr of TESTID_ATTRS) {
		const value = el.getAttribute(attr);
		if (value) {
			const css = `[${attr}="${cssEscape(value)}"]`;
			if (unique(doc, css)) {
				return { ...base, strategy: 'testid', value, css, attr, confidence: STRATEGY_SCORE.testid };
			}
		}
	}

	const id = el.getAttribute('id');
	if (id && !looksGenerated(id)) {
		const css = `#${cssEscape(id)}`;
		if (unique(doc, css)) return { ...base, strategy: 'id', value: id, css, confidence: STRATEGY_SCORE.id };
	}

	const label = normalizeName(el.getAttribute('aria-label'));
	if (label) {
		const css = `[aria-label="${cssEscape(label)}"]`;
		if (unique(doc, css)) return { ...base, strategy: 'label', value: label, css, confidence: STRATEGY_SCORE.label };
	}

	const role = roleOf(el);
	const name = normalizeName(accessibleName(el));
	// A name longer than this is a paragraph that happens to be clickable, and
	// matching on it is brittle for a different reason than a weak selector is.
	if (role && name && name.length <= 80 && roleMatchCount(doc, role, name) === 1) {
		return { ...base, strategy: 'role', value: name, role, name, css: null, confidence: STRATEGY_SCORE.role };
	}

	if (name && name.length <= 80 && (tag === 'button' || tag === 'a' || tag === 'summary')) {
		if (textMatchCount(doc, tag, name) === 1) {
			return { ...base, strategy: 'text', value: name, css: null, confidence: STRATEGY_SCORE.text };
		}
	}

	const nameAttr = el.getAttribute('name');
	if (nameAttr) {
		const css = `${tag}[name="${cssEscape(nameAttr)}"]`;
		if (unique(doc, css)) return { ...base, strategy: 'name', value: nameAttr, css, confidence: STRATEGY_SCORE.name };
	}

	const placeholder = el.getAttribute('placeholder');
	if (placeholder) {
		const css = `[placeholder="${cssEscape(placeholder)}"]`;
		if (unique(doc, css)) {
			return { ...base, strategy: 'placeholder', value: placeholder, css, confidence: STRATEGY_SCORE.placeholder };
		}
	}

	const classes = (el.getAttribute('class') || '')
		.split(/\s+/)
		.filter((c) => c && !looksGenerated(c) && !looksUtility(c));
	for (const cls of classes) {
		const css = `${tag}.${cssEscape(cls)}`;
		if (unique(doc, css)) return { ...base, strategy: 'class', value: cls, css, confidence: STRATEGY_SCORE.class };
	}

	const path = structuralPath(el);
	return { ...base, strategy: 'path', value: path, css: path, confidence: STRATEGY_SCORE.path };
}

/**
 * Render a description as Playwright locator source. Semantic strategies emit
 * the semantic locator (which is what a human would have written); everything
 * else emits a CSS locator.
 */
export function toPlaywrightLocator(desc) {
	if (!desc) return 'page.locator("body")';
	switch (desc.strategy) {
		case 'testid':
			// getByTestId only reads the configured attribute, so the default
			// data-testid uses it and the other spellings stay explicit CSS.
			return desc.attr === 'data-testid'
				? `page.getByTestId(${quote(desc.value)})`
				: `page.locator(${quote(desc.css)})`;
		case 'label':
			return `page.getByLabel(${quote(desc.value)})`;
		case 'role':
			return `page.getByRole(${quote(desc.role)}, { name: ${quote(desc.name)} })`;
		case 'text':
			return `page.getByText(${quote(desc.value)}, { exact: true })`;
		case 'placeholder':
			return `page.getByPlaceholder(${quote(desc.value)})`;
		default:
			return `page.locator(${quote(desc.css || desc.value)})`;
	}
}

/** One short phrase naming the element for a human reading the steps. */
export function describeForHuman(desc) {
	if (!desc) return 'the page';
	const noun = desc.role || desc.tag || 'element';
	if (desc.strategy === 'role') return `the ${desc.role} "${desc.name}"`;
	if (desc.strategy === 'text') return `"${desc.value}"`;
	if (desc.strategy === 'label') return `the ${noun} labelled "${desc.value}"`;
	if (desc.strategy === 'placeholder') return `the field "${desc.value}"`;
	if (desc.strategy === 'testid') return `the ${noun} [${desc.value}]`;
	if (desc.strategy === 'id') return `the ${noun} #${desc.value}`;
	return `the ${noun} (${desc.value})`;
}
