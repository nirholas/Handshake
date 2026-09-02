/**
 * The Agent Spotlight entry form, shared by /spotlight (create) and
 * /spotlight/:id (edit).
 *
 * Both surfaces write the same six fields through the same endpoint, so the
 * field spec, the client-side bounds, the tag parsing and the save call live
 * here once. The bounds mirror the server's (api/spotlight/[action].js) on
 * purpose: the server is the authority, and this copy exists only so a builder
 * learns about a too-long tagline while typing it rather than after a round
 * trip. When one moves, move both, and the bounds are named constants here so
 * the two can be diffed at a glance.
 */

import { apiFetch } from './api.js';

export const BOUNDS = {
	title: { min: 3, max: 90 },
	tagline: { min: 10, max: 160 },
	story: { max: 4000 },
	demoUrl: { max: 500 },
	tags: { max: 6, maxLength: 24 },
};

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else node.setAttribute(k, v === true ? '' : String(v));
	}
	for (const child of [].concat(children)) {
		if (child != null) node.append(child);
	}
	return node;
}

// A labelled field with a live character counter. The counter is the reason
// these are built rather than written as markup twice: it has to be wired to
// its own input, and a second hand-written copy is how the two forms drift.
function field({ id, label, optional, hint, control, counterFor }) {
	const labelNode = el('label', { for: id }, [
		document.createTextNode(label),
		optional ? el('span', { class: 'sp-hint', text: ` ${optional}` }) : null,
	]);
	const hintNode = counterFor
		? el('span', { class: 'sp-hint' }, [
				el('span', { 'data-count': id, text: '0' }),
				document.createTextNode(`/${counterFor}`),
			])
		: hint
			? el('span', { class: 'sp-hint', text: hint })
			: null;
	return el('div', { class: 'sp-field' }, [labelNode, control, hintNode]);
}

/**
 * Build the form body into `container`. `prefix` namespaces the element ids so
 * the create form and an edit form can coexist on one page without colliding.
 * Returns the refs the rest of the module reads.
 */
export function buildFields(container, { prefix = 'sp', withAgentPicker = true } = {}) {
	const id = (name) => `${prefix}-${name}`;

	const agentSelect = el('select', { class: 'sp-input', id: id('agent'), required: true });
	const agentHint = el('span', { class: 'sp-hint', id: id('agent-hint') });
	const titleInput = el('input', {
		class: 'sp-input',
		id: id('title'),
		required: true,
		minlength: BOUNDS.title.min,
		maxlength: BOUNDS.title.max,
		placeholder: 'The rug detector that reads the chain before you ape',
		autocomplete: 'off',
	});
	const categorySelect = el('select', { class: 'sp-input', id: id('category'), required: true });
	const taglineInput = el('input', {
		class: 'sp-input',
		id: id('tagline'),
		required: true,
		minlength: BOUNDS.tagline.min,
		maxlength: BOUNDS.tagline.max,
		placeholder: 'What it does, in the words you would use out loud.',
		autocomplete: 'off',
	});
	const storyArea = el('textarea', {
		class: 'sp-textarea',
		id: id('story'),
		maxlength: BOUNDS.story.max,
		placeholder:
			'How you built it, what it is for, what surprised you. This is the part people read.',
	});
	const demoInput = el('input', {
		class: 'sp-input',
		id: id('demo'),
		type: 'url',
		maxlength: BOUNDS.demoUrl.max,
		placeholder: 'https://your-site.com/where-it-lives',
		autocomplete: 'off',
	});
	const tagsInput = el('input', {
		class: 'sp-input',
		id: id('tags'),
		maxlength: 160,
		placeholder: 'solana, on-chain, research',
		autocomplete: 'off',
	});

	const nodes = [];
	if (withAgentPicker) {
		nodes.push(
			el('div', { class: 'sp-field' }, [
				el('label', { for: id('agent'), text: 'Agent' }),
				agentSelect,
				agentHint,
			]),
		);
	}
	nodes.push(
		el('div', { class: 'sp-row' }, [
			field({ id: id('title'), label: 'Headline', control: titleInput, counterFor: BOUNDS.title.max }),
			field({ id: id('category'), label: 'Category', control: categorySelect }),
		]),
		field({ id: id('tagline'), label: 'One-liner', control: taglineInput, counterFor: BOUNDS.tagline.max }),
		field({
			id: id('story'),
			label: 'The write-up',
			optional: '(optional)',
			control: storyArea,
			counterFor: BOUNDS.story.max,
		}),
		el('div', { class: 'sp-row' }, [
			field({
				id: id('demo'),
				label: 'Demo link',
				optional: '(optional)',
				control: demoInput,
				hint: 'Where it can be seen working. Rendered as a link, never fetched.',
			}),
			field({
				id: id('tags'),
				label: 'Tags',
				optional: `(optional, up to ${BOUNDS.tags.max})`,
				control: tagsInput,
				hint: 'Comma separated. Lowercase letters, digits and hyphens.',
			}),
		]),
	);
	container.replaceChildren(...nodes);

	const refs = {
		agentSelect,
		agentHint,
		title: titleInput,
		category: categorySelect,
		tagline: taglineInput,
		story: storyArea,
		demo: demoInput,
		tags: tagsInput,
	};
	wireCounters(container);
	return refs;
}

function wireCounters(container) {
	for (const counter of container.querySelectorAll('[data-count]')) {
		const input = container.querySelector(`#${CSS.escape(counter.dataset.count)}`);
		if (!input) continue;
		const update = () => {
			counter.textContent = String(input.value.length);
		};
		input.addEventListener('input', update);
		update();
	}
}

export function fillCategories(refs, categories, selected) {
	if (!categories?.length) return;
	refs.category.replaceChildren(
		...categories.map((c) => {
			const opt = el('option', { value: c.slug, text: c.label });
			if (c.slug === selected) opt.selected = true;
			return opt;
		}),
	);
}

export function fillEntry(refs, entry) {
	refs.title.value = entry.title || '';
	refs.tagline.value = entry.tagline || '';
	refs.story.value = entry.story || '';
	refs.demo.value = entry.demo_url || '';
	refs.tags.value = (entry.tags || []).join(', ');
	for (const input of [refs.title, refs.tagline, refs.story]) {
		input.dispatchEvent(new Event('input'));
	}
}

export function parseTags(raw) {
	const out = [];
	for (const piece of String(raw || '').split(',')) {
		const tag = piece.trim().toLowerCase().replace(/\s+/g, '-');
		if (tag && !out.includes(tag)) out.push(tag);
	}
	return out.slice(0, BOUNDS.tags.max);
}

export function readValues(refs, agentId) {
	return {
		agentId: agentId || refs.agentSelect?.value || '',
		title: refs.title.value.trim(),
		tagline: refs.tagline.value.trim(),
		story: refs.story.value.trim() || null,
		demoUrl: refs.demo.value.trim() || null,
		category: refs.category.value,
		tags: parseTags(refs.tags.value),
	};
}

// Returns an error message, or null when the payload is worth sending. Every
// rule here has a server-side twin; this only saves the round trip.
export function validate(payload) {
	if (!payload.agentId) return 'pick which agent you are showcasing';
	if (payload.title.length < BOUNDS.title.min) {
		return `the headline needs at least ${BOUNDS.title.min} characters`;
	}
	if (payload.tagline.length < BOUNDS.tagline.min) {
		return `the one-liner needs at least ${BOUNDS.tagline.min} characters`;
	}
	for (const tag of payload.tags) {
		if (tag.length > BOUNDS.tags.maxLength || !/^[a-z0-9][a-z0-9-]*$/.test(tag)) {
			return `"${tag}" is not a usable tag: lowercase letters, digits and hyphens only`;
		}
	}
	if (payload.demoUrl && !/^https?:\/\//i.test(payload.demoUrl)) {
		return 'the demo link has to start with http:// or https://';
	}
	return null;
}

/**
 * Save (create or edit, the server decides which) and return the entry.
 * Throws an Error carrying the server's message, or `{ unauthorized: true }`
 * on a 401 so the caller can show a sign-in prompt rather than a red error.
 */
export async function saveEntry(payload) {
	const res = await apiFetch('/api/spotlight/submit', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
		allowAnonymous: true,
	});
	if (res.status === 401) {
		const err = new Error('sign in to publish');
		err.unauthorized = true;
		throw err;
	}
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error_description || data?.error?.message || `the submission returned ${res.status}`);
	return data.entry;
}

export async function removeEntry(id) {
	const res = await apiFetch('/api/spotlight/remove', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id }),
		allowAnonymous: true,
	});
	if (res.status === 401) {
		const err = new Error('sign in to remove this entry');
		err.unauthorized = true;
		throw err;
	}
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error_description || data?.error?.message || `the removal returned ${res.status}`);
	return true;
}
