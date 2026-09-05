import { resolveApi, searchCatalog } from '../api.js';
import { style, symbols, failure, hint, heading } from '../style.js';

const KINDS = ['object', 'character', 'animation'];

function formatBytes(n) {
	if (!n) return '';
	const mb = n / 1024 / 1024;
	return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function describe(item) {
	if (item.kind === 'animation') {
		const secs = item.duration_seconds ? `${item.duration_seconds.toFixed(1)}s` : 'clip';
		return `${secs}${item.loop ? ' loop' : ''}`;
	}
	return [formatBytes(item.bytes), item.license].filter(Boolean).join(', ');
}

export async function search({ positional, flags }) {
	const query = positional.join(' ').trim();
	const kind = typeof flags.kind === 'string' ? flags.kind : null;
	if (kind && !KINDS.includes(kind)) {
		failure(`--kind must be one of: ${KINDS.join(', ')}`);
		return 1;
	}
	const limit = flags.limit ? Number(flags.limit) : 12;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		failure('--limit must be a whole number from 1 to 50');
		return 1;
	}

	const origin = resolveApi(flags);
	const result = await searchCatalog(origin, {
		q: query || undefined,
		kind: kind || undefined,
		category: typeof flags.category === 'string' ? flags.category : undefined,
		tag: typeof flags.tag === 'string' ? flags.tag : undefined,
		limit,
		offset: flags.offset ? Number(flags.offset) : undefined,
	});

	if (flags.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return result.items.length ? 0 : 1;
	}

	if (!result.items.length) {
		failure(`nothing in the catalog matches ${query ? `"${query}"` : 'that filter'}`);
		hint(`the catalog holds ${result.total} items; try a broader term or drop --kind`);
		return 1;
	}

	if (result.relaxed) {
		process.stderr.write(
			`${style.yellow(symbols.warn)} nothing matches every word of "${query}"; showing partial matches, best first\n`,
		);
	}

	const width = Math.max(...result.items.map((i) => i.id.length));
	process.stdout.write(`${heading(`${result.matched} match${result.matched === 1 ? '' : 'es'}`)}\n`);
	for (const item of result.items) {
		const meta = describe(item);
		process.stdout.write(
			`  ${style.cyan(item.id.padEnd(width))}  ${item.title}${meta ? style.dim(`  (${meta})`) : ''}\n`,
		);
	}

	const cats = (result.facets?.categories || []).slice(0, 6).map((c) => c.value);
	if (cats.length) process.stdout.write(`\n${style.dim(`categories: ${cats.join(', ')}`)}\n`);
	if (result.next_offset != null) {
		process.stdout.write(`${style.dim(`more: --offset ${result.next_offset}`)}\n`);
	}
	process.stdout.write(
		`${style.dim(`${symbols.arrow} add one: three-ws-assets add ${result.items[0].id}`)}\n`,
	);
	return 0;
}
