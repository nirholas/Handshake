// Rendering a change set for humans.
//
// Two targets, one shape. The terminal report is what you read while iterating;
// the Markdown report is what a CI job posts on a pull request so the reviewer
// sees "this export dropped 3 joints" without downloading either file. Both are
// built from the same ordered walk of the change set so they never disagree.

import { formatBytes } from './diff.js';
import { SEVERITY_MEANING } from './severity.js';

// Written as a code point rather than a literal escape so the source stays
// copy-pasteable through editors and diff viewers that swallow control bytes.
const ESC = String.fromCharCode(27);

const ANSI = {
	reset: `${ESC}[0m`,
	bold: `${ESC}[1m`,
	dim: `${ESC}[2m`,
	red: `${ESC}[31m`,
	green: `${ESC}[32m`,
	yellow: `${ESC}[33m`,
	blue: `${ESC}[34m`,
	magenta: `${ESC}[35m`,
	cyan: `${ESC}[36m`,
};

const SEVERITY_COLOR = {
	none: 'dim',
	cosmetic: 'dim',
	minor: 'cyan',
	major: 'yellow',
	breaking: 'red',
};

const SECTION_ORDER = ['skins', 'animations', 'meshes', 'nodes', 'materials', 'textures'];

const SECTION_LABEL = {
	skins: 'Skeletons',
	animations: 'Animations',
	meshes: 'Meshes',
	nodes: 'Nodes',
	materials: 'Materials',
	textures: 'Textures',
};

const TOTAL_LABEL = {
	vertices: 'vertices',
	triangles: 'triangles',
	nodes: 'nodes',
	meshes: 'meshes',
	materials: 'materials',
	textures: 'textures',
	animations: 'animations',
	skins: 'skins',
	joints: 'joints',
	scenes: 'scenes',
	textureBytes: 'texture bytes',
	sizeBytes: 'file size',
};

function paint(enabled) {
	if (!enabled) return (text) => text;
	return (text, ...styles) => styles.map((s) => ANSI[s] || '').join('') + text + ANSI.reset;
}

function num(n) {
	return Number(n || 0).toLocaleString('en-US');
}

function signed(n) {
	if (n === 0) return '0';
	return n > 0 ? `+${num(n)}` : `-${num(Math.abs(n))}`;
}

function bytesSigned(n) {
	return n > 0 ? `+${formatBytes(n)}` : `-${formatBytes(-n)}`;
}

function valueText(v) {
	if (v === null || v === undefined) return 'none';
	if (Array.isArray(v)) return v.length > 6 ? `[${v.slice(0, 6).join(', ')}, ...+${v.length - 6}]` : `[${v.join(', ')}]`;
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
}

// A hash is 16 opaque characters; printing both sides in full says nothing a
// reader can act on, so hashes collapse to a verdict and the note carries the
// meaning.
const OPAQUE_FIELDS = new Set(['geometry', 'pixels', 'inverseBindMatrices']);

function changeLine(change) {
	if (OPAQUE_FIELDS.has(change.field)) return `${change.field}: changed${change.note ? ` (${change.note})` : ''}`;
	return `${change.field}: ${valueText(change.a)} -> ${valueText(change.b)}${change.note ? ` (${change.note})` : ''}`;
}

/**
 * Render a change set as a terminal report.
 * @param {object} changeset
 * @param {{ color?: boolean, verbose?: boolean }} [opts]
 */
export function formatText(changeset, opts = {}) {
	const c = paint(opts.color !== false);
	const lines = [];
	const nameA = changeset.a.name || 'A';
	const nameB = changeset.b.name || 'B';

	lines.push(`${c('glb-diff', 'bold')}  ${c(nameA, 'dim')} -> ${c(nameB, 'bold')}`);

	if (changeset.identical) {
		lines.push(c('  identical: every scene, mesh, material, texture, skeleton and clip matches.', 'green'));
		return lines.join('\n');
	}

	const sevColor = SEVERITY_COLOR[changeset.severity] || 'yellow';
	const s = changeset.summary;
	lines.push(
		`  ${c(changeset.severity.toUpperCase(), sevColor, 'bold')}  ${num(s.changed)} change(s): ` +
			`${c(`+${s.added}`, 'green')} ${c(`-${s.removed}`, 'red')} ${c(`~${s.modified}`, 'yellow')} ` +
			`${c(`renamed ${s.renamed}`, 'dim')} ${c(`moved ${s.moved}`, 'dim')}`,
	);
	lines.push(`  ${c(SEVERITY_MEANING[changeset.severity], 'dim')}`);
	lines.push('');

	for (const h of changeset.highlights) {
		const mark = h.severity === 'breaking' ? '!!' : h.severity === 'major' ? ' !' : '  ';
		lines.push(`  ${c(mark, SEVERITY_COLOR[h.severity] || 'dim')} ${h.text}`);
	}
	if (changeset.highlights.length) lines.push('');

	// Totals table. Only rows that moved, unless --verbose asks for the lot: a
	// wall of zeroes is what makes people stop reading diff output.
	const rows = Object.entries(changeset.totals).filter(([, v]) => opts.verbose || v.delta !== 0);
	if (rows.length) {
		lines.push(c('  totals', 'bold'));
		const width = Math.max(...rows.map(([k]) => (TOTAL_LABEL[k] || k).length));
		for (const [key, v] of rows) {
			const label = (TOTAL_LABEL[key] || key).padEnd(width);
			const isBytes = key.endsWith('Bytes');
			const fmt = isBytes ? formatBytes : num;
			const delta =
				v.delta === 0 ? c('same', 'dim') : c(isBytes ? bytesSigned(v.delta) : signed(v.delta), v.delta > 0 ? 'yellow' : 'cyan');
			lines.push(`    ${label}  ${String(fmt(v.a)).padStart(12)} -> ${String(fmt(v.b)).padStart(12)}  ${delta}`);
		}
		lines.push('');
	}

	for (const key of SECTION_ORDER) {
		const section = changeset.sections[key];
		if (!section || !section.changed) continue;
		lines.push(`${c(SECTION_LABEL[key], 'bold')} ${c(`(${section.changed} changed, ${section.unchanged} unchanged)`, 'dim')}`);
		for (const item of section.removed) lines.push(`  ${c('-', 'red')} ${item.name}  ${c(item.detail || '', 'dim')}`);
		for (const item of section.added) lines.push(`  ${c('+', 'green')} ${item.name}  ${c(item.detail || '', 'dim')}`);
		for (const item of section.renamed) lines.push(`  ${c('R', 'magenta')} ${item.from} ${c('->', 'dim')} ${item.to}`);
		for (const item of section.moved || []) lines.push(`  ${c('M', 'blue')} ${item.from} ${c('->', 'dim')} ${item.to}`);
		for (const item of section.modified) {
			lines.push(`  ${c('~', 'yellow')} ${item.name}${item.from && item.from !== item.name ? c(` (was ${item.from})`, 'dim') : ''}`);
			for (const change of item.changes) lines.push(`      ${c(changeLine(change), SEVERITY_COLOR[change.severity] || 'dim')}`);
		}
		if (section.similarityLimited) {
			lines.push(`  ${c('note: too many candidates to run rename detection here; unpaired items are listed as added/removed.', 'dim')}`);
		}
		lines.push('');
	}

	const ext = changeset.extensions;
	if (ext.used.added.length || ext.used.removed.length || ext.required.added.length || ext.required.removed.length) {
		lines.push(c('Extensions', 'bold'));
		for (const name of ext.required.added) lines.push(`  ${c('+', 'green')} ${name} ${c('(required)', 'yellow')}`);
		for (const name of ext.required.removed) lines.push(`  ${c('-', 'red')} ${name} ${c('(was required)', 'dim')}`);
		for (const name of ext.used.added.filter((n) => !ext.required.added.includes(n))) lines.push(`  ${c('+', 'green')} ${name}`);
		for (const name of ext.used.removed.filter((n) => !ext.required.removed.includes(n))) lines.push(`  ${c('-', 'red')} ${name}`);
		lines.push('');
	}

	if (changeset.asset.length) {
		lines.push(c('Asset metadata', 'bold'));
		for (const change of changeset.asset) lines.push(`  ${c('~', 'yellow')} ${changeLine(change)}`);
		lines.push('');
	}

	return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Render a change set as Markdown, sized for a pull-request comment.
 * @param {object} changeset
 */
export function formatMarkdown(changeset) {
	const nameA = changeset.a.name || 'A';
	const nameB = changeset.b.name || 'B';
	const out = [`### 3D diff: \`${nameA}\` to \`${nameB}\``, ''];

	if (changeset.identical) {
		out.push('The two models are structurally identical.');
		return out.join('\n');
	}

	out.push(`**${changeset.severity}**: ${SEVERITY_MEANING[changeset.severity]}`, '');
	for (const h of changeset.highlights) {
		out.push(`- ${h.severity === 'breaking' ? `**${h.text}**` : h.text}`);
	}
	out.push('');

	const rows = Object.entries(changeset.totals).filter(([, v]) => v.delta !== 0);
	if (rows.length) {
		out.push('| metric | before | after | delta |', '| --- | ---: | ---: | ---: |');
		for (const [key, v] of rows) {
			const isBytes = key.endsWith('Bytes');
			const fmt = isBytes ? formatBytes : num;
			out.push(`| ${TOTAL_LABEL[key] || key} | ${fmt(v.a)} | ${fmt(v.b)} | ${isBytes ? bytesSigned(v.delta) : signed(v.delta)} |`);
		}
		out.push('');
	}

	for (const key of SECTION_ORDER) {
		const section = changeset.sections[key];
		if (!section || !section.changed) continue;
		out.push(`<details><summary>${SECTION_LABEL[key]} (${section.changed} changed)</summary>`, '');
		for (const item of section.removed) out.push(`- \`-\` **${item.name}** ${item.detail || ''}`);
		for (const item of section.added) out.push(`- \`+\` **${item.name}** ${item.detail || ''}`);
		for (const item of section.renamed) out.push(`- \`R\` \`${item.from}\` to \`${item.to}\``);
		for (const item of section.moved || []) out.push(`- \`M\` \`${item.from}\` to \`${item.to}\``);
		for (const item of section.modified) {
			out.push(`- \`~\` **${item.name}**`);
			for (const change of item.changes) out.push(`  - ${changeLine(change)}`);
		}
		out.push('', '</details>', '');
	}

	return out.join('\n');
}
