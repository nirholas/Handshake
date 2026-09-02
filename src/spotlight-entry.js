/**
 * /spotlight/:id — one Agent Spotlight entry.
 *
 * The reason this page exists: an entry's write-up runs to 4,000 characters and
 * the index could only ever show three clamped lines of it. A showcase whose
 * write-ups cannot be read is a directory with extra steps.
 *
 * It is also the only place an entry is WRITTEN after it is created. The index
 * creates; this page edits and removes, using the same field module
 * (src/spotlight-form.js), so there is exactly one implementation of the form
 * and one place a builder has to find to fix a typo.
 *
 * The page title, meta description and canonical are set from the entry once it
 * loads. Social crawlers never execute this: vercel.json rewrites them to
 * api/spotlight-og.js, which renders the same facts server-side.
 */

import { apiFetch } from './api.js';
import {
	buildFields,
	fillCategories,
	fillEntry,
	readValues,
	removeEntry,
	saveEntry,
	validate,
} from './spotlight-form.js';
import { el, entryPath, errorMessage, monogram, relativeTime, stageFor, voteButton } from './spotlight-shared.js';

const root = document.getElementById('sp-entry');
const live = document.getElementById('sp-live');

let entry = null;
let categories = [];

function announce(message) {
	if (live) live.textContent = message;
}

function plural(n, one, many) {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function entryIdFromPath() {
	const m = location.pathname.match(/^\/spotlight\/([0-9a-f-]{36})\/?$/i);
	return m ? m[1] : null;
}

function categoryLabel(slug) {
	return categories.find((c) => c.slug === slug)?.label || slug;
}

/* ── head ─────────────────────────────────────────────────────────────── */

// A client-rendered page still owes a correct title and canonical: the browser
// tab, a bookmark, and the history entry all read them, and so does any crawler
// that does execute JS.
function applyHead(e) {
	const title = `${e.title} · Agent Spotlight · three.ws`;
	document.title = title;
	setMeta('name', 'description', e.tagline);
	setLink('canonical', `https://three.ws/spotlight/${e.id}`);
}

function setMeta(attr, key, value) {
	let node = document.head.querySelector(`meta[${attr}="${key}"]`);
	if (!node) {
		node = document.createElement('meta');
		node.setAttribute(attr, key);
		document.head.appendChild(node);
	}
	node.setAttribute('content', value);
}

function setLink(rel, href) {
	let node = document.head.querySelector(`link[rel="${rel}"]`);
	if (!node) {
		node = document.createElement('link');
		node.rel = rel;
		document.head.appendChild(node);
	}
	node.href = href;
}

/* ── render ───────────────────────────────────────────────────────────── */

function breadcrumb(e) {
	return el('nav', { class: 'sp-crumbs', 'aria-label': 'Breadcrumb' }, [
		el('a', { href: '/spotlight', text: 'Agent Spotlight' }),
		el('span', { 'aria-hidden': 'true', text: '/' }),
		el('a', {
			href: `/spotlight?category=${encodeURIComponent(e.category)}`,
			text: categoryLabel(e.category),
		}),
	]);
}

function badges(e) {
	return el('div', { class: 'sp-detail-badges' }, [
		el('span', { class: 'sp-badge', text: categoryLabel(e.category) }),
		e.agent.is_registered ? el('span', { class: 'sp-badge sp-badge-onchain', text: 'On-chain' }) : null,
		e.featured ? el('span', { class: 'sp-badge', text: "Editor's pick" }) : null,
		e.source === 'curated' ? el('span', { class: 'sp-badge sp-badge-curated', text: 'Curated' }) : null,
	]);
}

// A curated entry says so in words, not just a badge. The badge tells you the
// category of thing you are reading; this tells you who wrote it, which is the
// part that would otherwise put words in a builder's mouth.
function provenance(e) {
	if (e.source !== 'curated') return null;
	return el('p', { class: 'sp-provenance' }, [
		el('strong', { text: 'Written by three.ws. ' }),
		document.createTextNode(
			`${e.agent.name} is ${e.builder?.name ? `${e.builder.name}'s` : 'a community'} agent; this write-up is ours, not theirs. `,
		),
		e.editable_by_me
			? el('span', { text: 'It is your agent, so you can replace this with your own words below.' })
			: document.createTextNode('Its builder can replace it with their own write-up at any time.'),
	]);
}

function storyBlock(e) {
	if (!e.story) return null;
	// Stored as plain text with blank-line paragraph breaks. Rendered as real
	// paragraphs via textContent, never innerHTML: this is user-submitted copy on
	// a public page.
	const paragraphs = e.story
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	return el(
		'div',
		{ class: 'sp-story' },
		paragraphs.map((p) => el('p', { text: p })),
	);
}

function skillChips(e) {
	const skills = e.agent.skills || [];
	if (!skills.length) return null;
	return el('div', { class: 'sp-facts-block' }, [
		el('h3', { class: 'sp-facts-head', text: 'Skills' }),
		el(
			'div',
			{ class: 'sp-tags' },
			skills.slice(0, 14).map((s) => el('span', { class: 'sp-tag sp-tag-static', text: s })),
		),
	]);
}

// Everything in this panel is read live off the agent on each request, which is
// exactly why it belongs beside the write-up: the prose is a claim from a
// moment in time, these are facts as of now.
function factsPanel(e) {
	const rows = [
		['Agent', e.agent.name],
		['Builder', e.builder?.name || 'Not public'],
		['Published', relativeTime(e.created_at)],
		['Upvotes', String(e.vote_count)],
	];
	if (e.agent.chat_count > 0) rows.push(['Conversations', e.agent.chat_count.toLocaleString()]);
	if (e.agent.action_count > 0) rows.push(['On-chain actions', e.agent.action_count.toLocaleString()]);
	if (e.view_count > 0) rows.push(['Views', e.view_count.toLocaleString()]);
	if (e.agent.onchain?.network) rows.push(['Network', e.agent.onchain.network]);

	return el('aside', { class: 'sp-facts', 'aria-label': 'Agent facts' }, [
		el(
			'dl',
			{ class: 'sp-facts-list' },
			rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]),
		),
		skillChips(e),
		el('div', { class: 'sp-facts-block' }, [
			el('h3', { class: 'sp-facts-head', text: 'Go to the agent' }),
			el('div', { class: 'sp-facts-links' }, [
				el('a', { class: 'sp-btn sp-btn-sm', href: `/agents/${e.agent.id}`, text: 'Open in 3D' }),
				el('a', { class: 'sp-btn sp-btn-sm', href: `/agents/${e.agent.id}/profile`, text: 'Full profile' }),
				el('a', { class: 'sp-btn sp-btn-sm', href: `/agents/${e.agent.id}/ar`, text: 'View in AR' }),
			]),
		]),
	]);
}

function shareRow(e) {
	const url = `https://three.ws/spotlight/${e.id}`;
	const shareText = `${e.title} — ${e.agent.name} on three.ws`;

	const copy = el('button', { type: 'button', class: 'sp-btn sp-btn-sm', text: 'Copy link' });
	copy.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(url);
			copy.textContent = 'Copied';
			announce('Link copied.');
			setTimeout(() => {
				copy.textContent = 'Copy link';
			}, 1600);
		} catch {
			// Clipboard is permission-gated and can simply refuse. Select the URL
			// so the visitor can copy it themselves rather than getting nothing.
			const field = el('input', { class: 'sp-input', value: url, readonly: true });
			copy.replaceWith(field);
			field.select();
		}
	});

	return el('div', { class: 'sp-share' }, [
		copy,
		el('a', {
			class: 'sp-btn sp-btn-sm',
			href: `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(url)}`,
			target: '_blank',
			rel: 'noopener',
			text: 'Share on X',
		}),
		e.demo_url
			? el('a', {
					class: 'sp-btn sp-btn-sm',
					href: e.demo_url,
					target: '_blank',
					rel: 'noopener nofollow ugc',
					text: 'See it live',
				})
			: null,
	]);
}

function ownerControls(e) {
	if (!e.editable_by_me) return null;
	const edit = el('button', { type: 'button', class: 'sp-btn sp-btn-sm', text: 'Edit entry' });
	const remove = el('button', { type: 'button', class: 'sp-btn sp-btn-sm sp-btn-danger', text: 'Remove' });
	edit.addEventListener('click', () => openEditor(true));
	remove.addEventListener('click', () => confirmRemove(remove));
	return el('div', { class: 'sp-owner-bar' }, [
		el('span', { class: 'sp-owner-label', text: 'You can edit this entry' }),
		edit,
		remove,
	]);
}

// Two-step, in place: a destructive action gets a real confirmation, and the
// second click is a different button than the first so a double click cannot
// delete an entry by accident.
function confirmRemove(button) {
	const bar = button.parentElement;
	const cancel = el('button', { type: 'button', class: 'sp-btn sp-btn-sm', text: 'Keep it' });
	const confirm = el('button', {
		type: 'button',
		class: 'sp-btn sp-btn-sm sp-btn-danger',
		text: 'Yes, remove it',
	});
	const prompt = el('span', { class: 'sp-owner-label', text: 'Remove this entry from the showcase?' });
	const original = Array.from(bar.childNodes);
	bar.replaceChildren(prompt, confirm, cancel);
	cancel.addEventListener('click', () => bar.replaceChildren(...original));
	confirm.addEventListener('click', async () => {
		confirm.disabled = true;
		confirm.textContent = 'Removing…';
		try {
			await removeEntry(entry.id);
			announce('Entry removed.');
			location.href = '/spotlight';
		} catch (err) {
			bar.replaceChildren(...original);
			renderNote(err?.message || 'the entry could not be removed', 'error');
		}
	});
}

function renderNote(message, tone) {
	const note = document.getElementById('sp-detail-note');
	if (!note) return;
	note.textContent = message;
	if (tone) note.dataset.tone = tone;
	else delete note.dataset.tone;
}

/* ── edit ─────────────────────────────────────────────────────────────── */

let editRefs = null;

function editorPanel() {
	const fields = el('div', { id: 'sp-edit-fields' });
	const note = el('p', { class: 'sp-form-note', id: 'sp-edit-note', role: 'status', 'aria-live': 'polite' });
	const save = el('button', { type: 'submit', class: 'sp-btn sp-btn-primary', text: 'Save changes' });
	const cancel = el('button', { type: 'button', class: 'sp-btn', text: 'Cancel' });
	cancel.addEventListener('click', () => openEditor(false));

	const form = el('form', { class: 'sp-panel', id: 'sp-edit-panel', hidden: true }, [
		el('div', { class: 'sp-panel-head' }, [
			el('h2', { class: 'sp-h2', text: 'Edit this entry' }),
			el('p', {
				class: 'sp-panel-note',
				text: `You are editing the write-up, not ${entry.agent.name} itself. The agent's name, avatar, skills and identity always come from the agent record.`,
			}),
		]),
		fields,
		el('div', { class: 'sp-ctas' }, [save, cancel]),
		note,
	]);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const payload = readValues(editRefs, entry.agent.id);
		const problem = validate(payload);
		if (problem) {
			note.textContent = problem;
			note.dataset.tone = 'error';
			return;
		}
		save.disabled = true;
		note.textContent = 'Saving…';
		delete note.dataset.tone;
		try {
			entry = await saveEntry(payload);
			announce('Entry updated.');
			render();
		} catch (err) {
			note.textContent = err.unauthorized
				? 'your session expired; sign in and try again'
				: err?.message || 'the change did not save';
			note.dataset.tone = 'error';
		} finally {
			save.disabled = false;
		}
	});

	return form;
}

function openEditor(open) {
	const panel = document.getElementById('sp-edit-panel');
	if (!panel) return;
	panel.hidden = !open;
	if (!open) return;
	if (!editRefs) {
		editRefs = buildFields(document.getElementById('sp-edit-fields'), {
			prefix: 'spe',
			withAgentPicker: false,
		});
	}
	fillCategories(editRefs, categories, entry.category);
	fillEntry(editRefs, entry);
	panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
	editRefs.title.focus();
}

/* ── related ──────────────────────────────────────────────────────────── */

async function loadRelated(e) {
	const rail = document.getElementById('sp-related');
	if (!rail) return;
	try {
		const res = await apiFetch(
			`/api/spotlight/list?category=${encodeURIComponent(e.category)}&limit=4&sort=trending`,
			{ allowAnonymous: true },
		);
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		const others = (data?.entries || []).filter((x) => x.id !== e.id).slice(0, 3);
		if (!others.length) return;

		rail.replaceChildren(
			el('h2', { class: 'sp-h2', text: `More in ${categoryLabel(e.category)}` }),
			el(
				'div',
				{ class: 'sp-related-grid' },
				others.map((o) =>
					el('a', { class: 'sp-related-card', href: entryPath(o) }, [
						o.agent.thumbnail
							? el('img', { src: o.agent.thumbnail, alt: '', loading: 'lazy', decoding: 'async' })
							: monogram(o.agent),
						el('div', { class: 'sp-related-copy' }, [
							el('strong', { text: o.title }),
							el('span', { text: o.agent.name }),
						]),
					]),
				),
			),
		);
		rail.hidden = false;
	} catch {
		// A missing related rail is not worth an error state on a page whose
		// content has already rendered.
	}
}

/* ── page ─────────────────────────────────────────────────────────────── */

function render() {
	applyHead(entry);

	const header = el('div', { class: 'sp-detail-copy' }, [
		breadcrumb(entry),
		badges(entry),
		el('h1', { class: 'sp-detail-title', text: entry.title }),
		el('p', { class: 'sp-detail-tagline', text: entry.tagline }),
		el('div', { class: 'sp-card-meta' }, [
			el('span', {}, [el('strong', { text: entry.agent.name })]),
			entry.builder?.name
				? el('span', { 'aria-hidden': 'true', text: '·' })
				: null,
			entry.builder?.name
				? entry.builder.profile_url
					? el('a', { href: entry.builder.profile_url, text: `built by ${entry.builder.name}` })
					: el('span', { text: `built by ${entry.builder.name}` })
				: null,
			el('span', { 'aria-hidden': 'true', text: '·' }),
			el('span', { text: relativeTime(entry.created_at) }),
		]),
		el('div', { class: 'sp-detail-actions' }, [
			voteButton(entry, { announce, large: true }),
			el('a', {
				class: 'sp-btn sp-btn-primary',
				href: `/agents/${entry.agent.id}`,
				text: `Talk to ${entry.agent.name}`,
			}),
		]),
		shareRow(entry),
	]);

	const main = el('div', { class: 'sp-detail-main' }, [
		provenance(entry),
		storyBlock(entry) ||
			el('p', { class: 'sp-detail-nostory', text: 'No write-up yet, just the one-liner above.' }),
	]);

	root.replaceChildren(
		el('div', { class: 'sp-detail-hero' }, [stageFor(entry, { eager: true }), header]),
		ownerControls(entry),
		editorPanel(),
		el('p', { class: 'sp-form-note', id: 'sp-detail-note', role: 'status', 'aria-live': 'polite' }),
		el('div', { class: 'sp-detail-body' }, [main, factsPanel(entry)]),
		el('section', { class: 'sp-related', id: 'sp-related', hidden: true }),
		el('div', { class: 'sp-detail-foot' }, [
			el('a', { class: 'sp-btn', href: '/spotlight', text: 'Back to the showcase' }),
			el('a', { class: 'sp-btn', href: '/spotlight?submit=1', text: 'Showcase your own agent' }),
		]),
	);
	root.setAttribute('aria-busy', 'false');
	editRefs = null;
}

function renderMissing(message, { notFound = false } = {}) {
	root.setAttribute('aria-busy', 'false');
	root.replaceChildren(
		el('div', { class: notFound ? 'sp-empty' : 'sp-error' }, [
			el('h3', { text: notFound ? 'That entry is not here' : 'This entry did not load' }),
			el('p', { text: message }),
			el('a', { class: 'sp-btn sp-btn-primary', href: '/spotlight', text: 'Open the showcase' }),
		]),
	);
	document.title = notFound ? 'Entry not found · Agent Spotlight · three.ws' : document.title;
}

async function loadCategories() {
	try {
		const res = await apiFetch('/api/spotlight/categories', { allowAnonymous: true });
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		categories = Array.isArray(data?.categories) ? data.categories : [];
	} catch {
		categories = [];
	}
}

async function boot() {
	const id = entryIdFromPath();
	if (!id) {
		renderMissing('That link does not point at a showcase entry.', { notFound: true });
		return;
	}

	// Categories only supply human labels, so the entry never waits on them.
	loadCategories();

	try {
		const res = await apiFetch(`/api/spotlight/get?id=${encodeURIComponent(id)}`, { allowAnonymous: true });
		const data = await res.json().catch(() => null);
		if (res.status === 404) {
			renderMissing(
				'This entry was removed, or the agent behind it is no longer public. The rest of the showcase is still here.',
				{ notFound: true },
			);
			return;
		}
		if (!res.ok) throw new Error(errorMessage(data, `the entry returned ${res.status}`));
		entry = data.entry;
		render();
		loadRelated(entry);
		announce(`${entry.title}. ${plural(entry.vote_count, 'upvote', 'upvotes')}.`);
		if (new URLSearchParams(location.search).get('edit') === '1' && entry.editable_by_me) {
			openEditor(true);
		}
	} catch (err) {
		renderMissing(err?.message || 'could not reach the showcase');
	}
}

boot();
