import { resolveApi, fetchItem } from '../api.js';
import { style, symbols, failure, hint, heading } from '../style.js';

export async function show({ positional, flags }) {
	const id = positional[0];
	if (!id) {
		failure('show needs a catalog id');
		hint('find one with: three-ws-assets search <term>');
		return 1;
	}

	const origin = resolveApi(flags);
	let payload;
	try {
		payload = await fetchItem(origin, id);
	} catch (err) {
		failure(err.message);
		if (err.notFound) hint('search first: three-ws-assets search <term>');
		return 1;
	}

	if (flags.json) {
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return 0;
	}

	const { item, links, related, frameworks, snippets } = payload;
	process.stdout.write(`${style.bold(item.title)}  ${style.dim(item.id)}\n`);
	const facts = [
		item.kind === 'animation' ? 'motion clip' : item.kind === 'object' ? 'prop' : 'rigged character',
		item.license,
		item.kind === 'animation'
			? item.duration_seconds && `${item.duration_seconds.toFixed(2)}s ${item.loop ? 'loop' : 'one-shot'}`
			: item.bytes && `${(item.bytes / 1024 / 1024).toFixed(1)} MB`,
	].filter(Boolean);
	process.stdout.write(`${style.dim(facts.join(' · '))}\n`);
	if (item.tags?.length) process.stdout.write(`${style.dim(`tags: ${item.tags.join(', ')}`)}\n`);

	// A specific framework prints only its snippet, so the output pipes cleanly
	// into a file. With no --framework, the recommended one is shown and the rest
	// are named.
	const wanted = typeof flags.framework === 'string' ? flags.framework : null;
	if (wanted && !snippets[wanted]) {
		failure(`no "${wanted}" source for a ${item.kind}`);
		hint(`available: ${frameworks.join(', ')}`);
		return 1;
	}
	const chosen = wanted || frameworks[0];
	process.stdout.write(`\n${heading(chosen)}\n`);
	process.stdout.write(`${snippets[chosen].code}\n`);
	for (const note of snippets[chosen].notes || []) {
		process.stdout.write(`${style.dim(`  ${symbols.bullet} ${note}`)}\n`);
	}

	if (!wanted) {
		const others = frameworks.filter((f) => f !== chosen);
		if (others.length) {
			process.stdout.write(`\n${style.dim(`other frameworks: ${others.join(', ')}`)}\n`);
		}
		if (links?.preview) process.stdout.write(`${style.dim(`preview: ${links.preview}`)}\n`);
		if (related?.length) {
			process.stdout.write(
				`${style.dim(`related: ${related.slice(0, 4).map((r) => r.id).join(', ')}`)}\n`,
			);
		}
	}
	return 0;
}
