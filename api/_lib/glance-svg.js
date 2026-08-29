/**
 * Glance card, rendered as a self-contained SVG.
 *
 * One file of markup with no external CSS, no script and no font dependency
 * beyond the system stack, so the same bytes render in a README, a Slack
 * unfurl, an <img> on a third-party page and a widget host that only accepts
 * an image. Theme follows the reader: `auto` ships both palettes and lets
 * prefers-color-scheme pick, which is what GitHub and Slack actually honour.
 *
 * Sizes map to the slots the OS widget boards hand out:
 *   small  240x240  square tile   (Android 2x2, iOS small, Windows small)
 *   medium 480x200  the default   (Android 4x2, Windows medium, README badge)
 *   large  480x300  adds the stat row and the last action
 */

export const GLANCE_SIZES = {
	small: { w: 240, h: 240 },
	medium: { w: 480, h: 200 },
	large: { w: 480, h: 300 },
};

const LIGHT = {
	bg: '#ffffff',
	panel: '#f4f5f9',
	text: '#0b0b18',
	muted: '#5b5f73',
	line: '#e4e6ef',
};
const DARK = {
	bg: '#0b0b16',
	panel: '#15162a',
	text: '#f6f7fb',
	muted: '#a2a7bd',
	line: '#262842',
};

// Control characters are not representable in XML 1.0. One stray byte inside an
// agent name would otherwise make the whole document unparseable, which is the
// same class of failure that stalled the chain indexer: strip, keep serving.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeXml(value) {
	return String(value ?? '')
		.replace(CONTROL_CHARS, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export function truncate(value, max) {
	const chars = [...String(value ?? '')];
	if (chars.length <= max) return chars.join('');
	return `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
}

export function formatCount(n) {
	const value = Number(n) || 0;
	if (value < 1000) return String(value);
	if (value < 100_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

/**
 * @param {object} card a model from buildGlanceCard()
 * @param {{ theme?: 'auto'|'light'|'dark', size?: 'small'|'medium'|'large' }} [opts]
 * @returns {string} a complete SVG document
 */
export function renderGlanceSvg(card, { theme = 'auto', size = 'medium' } = {}) {
	const dim = GLANCE_SIZES[size] || GLANCE_SIZES.medium;
	const large = size === 'large';
	const small = size === 'small';
	// Ids and CSS selectors are namespaced per card. Two cards inlined into one
	// HTML document would otherwise share a `svg{}` rule and a gradient id, and
	// the last one on the page would repaint every other one.
	const ns = `g${String(card.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'card'}${size[0]}${theme[0]}`;
	const label = `${card.name}: ${card.metric.value} ${card.metric.label.toLowerCase()} on three.ws`;
	const pSize = small ? 56 : 64;
	const pAt = small ? 20 : 24;

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${dim.w}" height="${dim.h}" viewBox="0 0 ${dim.w} ${dim.h}" class="${ns}" role="img" aria-label="${escapeXml(label)}" font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif">
<title>${escapeXml(label)}</title>
<defs>
<linearGradient id="${ns}a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${escapeXml(card.accent.from)}"/><stop offset="1" stop-color="${escapeXml(card.accent.to)}"/></linearGradient>
<radialGradient id="${ns}g" cx="0.12" cy="0" r="0.9"><stop offset="0" stop-color="${escapeXml(card.accent.from)}" stop-opacity="0.20"/><stop offset="1" stop-color="${escapeXml(card.accent.from)}" stop-opacity="0"/></radialGradient>
<clipPath id="${ns}c"><rect x="0" y="0" width="${dim.w}" height="${dim.h}" rx="20"/></clipPath>
<clipPath id="${ns}p"><rect x="${pAt}" y="${pAt}" width="${pSize}" height="${pSize}" rx="18"/></clipPath>
</defs>
<style>${themeCss(theme, ns)}</style>
<g clip-path="url(#${ns}c)">
<rect width="${dim.w}" height="${dim.h}" class="bg"/>
<rect width="${dim.w}" height="${dim.h}" fill="url(#${ns}g)"/>
<rect width="${dim.w}" height="3" fill="url(#${ns}a)"/>
${small ? smallBody(card, ns) : wideBody(card, ns, dim, large)}
</g>
<rect x="0.5" y="0.5" width="${dim.w - 1}" height="${dim.h - 1}" rx="19.5" fill="none" class="line"/>
</svg>`;
}

function themeCss(theme, ns) {
	// A fixed theme writes literal colors into the rules. Browsers would accept
	// `var()` too, but librsvg (which rasterizes the PNG encoding through sharp)
	// silently paints an unresolved custom property black and ignores
	// `prefers-color-scheme`, so a fixed theme is the only shape every renderer
	// agrees on. `auto` keeps the variables and the media query because that is
	// the one case where the reader's browser has to pick the palette.
	const rules = (t) =>
		`.${ns} .bg{fill:${t.bg}}.${ns} .panel{fill:${t.panel}}.${ns} .t{fill:${t.text}}.${ns} .m{fill:${t.muted}}.${ns} .line{stroke:${t.line}}`;
	if (theme === 'light') return rules(LIGHT);
	if (theme === 'dark') return rules(DARK);
	const vars = (t) =>
		`--bg:${t.bg};--panel:${t.panel};--text:${t.text};--muted:${t.muted};--line:${t.line}`;
	const base = `.${ns} .bg{fill:var(--bg)}.${ns} .panel{fill:var(--panel)}.${ns} .t{fill:var(--text)}.${ns} .m{fill:var(--muted)}.${ns} .line{stroke:var(--line)}`;
	return `.${ns}{${vars(LIGHT)}}@media (prefers-color-scheme:dark){.${ns}{${vars(DARK)}}}${base}`;
}

function portrait(card, ns, x, y, s) {
	if (card.image) {
		// Both href forms: SVG 2 renderers read `href`, older sanitizers and
		// renderers (Slack, some feed readers) still only read the xlink form.
		return `<image href="${escapeXml(card.image)}" xlink:href="${escapeXml(card.image)}" x="${x}" y="${y}" width="${s}" height="${s}" clip-path="url(#${ns}p)" preserveAspectRatio="xMidYMid slice"/>`;
	}
	const fontSize = Math.round(s * 0.42);
	return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="18" fill="url(#${ns}a)"/><text x="${x + s / 2}" y="${y + s / 2 + fontSize * 0.36}" text-anchor="middle" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(card.monogram)}</text>`;
}

const STATUS_FILL = { active: '#22c55e', idle: '#f59e0b', new: '#64748b' };

function statusDot(card, x, y) {
	return `<circle cx="${x}" cy="${y}" r="4" fill="${STATUS_FILL[card.status] || STATUS_FILL.new}"/>`;
}

function wideBody(card, ns, dim, large) {
	const sub = card.description || card.headline;
	const metric = formatCount(card.metric.value);
	const metricY = large ? 140 : 148;
	const last = card.lastAction
		? `${truncate(card.lastAction.type, 22)} ${card.lastAction.relative}`
		: 'no activity yet';

	const chips = large
		? card.stats
				.map((s, i) => {
					const x = 24 + i * 112;
					return `<rect x="${x}" y="186" width="104" height="58" rx="14" class="panel"/>
<text x="${x + 16}" y="212" font-size="18" font-weight="700" class="t">${escapeXml(formatCount(s.value))}</text>
<text x="${x + 16}" y="230" font-size="11" class="m">${escapeXml(s.label)}</text>`;
				})
				.join('\n')
		: card.stats
				.map((s, i) => {
					const y = 112 + i * 22;
					return `<text x="${dim.w - 24}" y="${y}" text-anchor="end" font-size="12" class="m">${escapeXml(s.label)}  <tspan font-weight="700" class="t">${escapeXml(formatCount(s.value))}</tspan></text>`;
				})
				.join('\n');

	return `${portrait(card, ns, 24, 24, 64)}
<text x="104" y="50" font-size="21" font-weight="700" class="t">${escapeXml(truncate(card.name, 22))}</text>
<text x="104" y="72" font-size="12.5" class="m">${escapeXml(truncate(sub, 44))}</text>
${statusDot(card, dim.w - 90, 38)}
<text x="${dim.w - 24}" y="42" text-anchor="end" font-size="11" class="m">three.ws</text>
<text x="24" y="${metricY}" font-size="42" font-weight="800" class="t">${escapeXml(metric)}</text>
<text x="${30 + metric.length * 24}" y="${metricY}" font-size="13" class="m">${escapeXml(card.metric.label.toLowerCase())}</text>
<text x="24" y="${metricY + 24}" font-size="11.5" class="m">${escapeXml(truncate(`last: ${last}`, 46))}</text>
${chips}
${large ? `<text x="24" y="274" font-size="11.5" class="m">${escapeXml(truncate(card.headline, 60))}</text>` : ''}`;
}

function smallBody(card, ns) {
	const metric = formatCount(card.metric.value);
	return `${portrait(card, ns, 20, 20, 56)}
${statusDot(card, 214, 32)}
<text x="20" y="100" font-size="16" font-weight="700" class="t">${escapeXml(truncate(card.name, 16))}</text>
<text x="20" y="156" font-size="40" font-weight="800" class="t">${escapeXml(metric)}</text>
<text x="20" y="176" font-size="11.5" class="m">${escapeXml(card.metric.label.toLowerCase())}</text>
<text x="20" y="208" font-size="11" class="m">${escapeXml(truncate(card.lastAction ? `last ${card.lastAction.relative}` : 'no activity yet', 26))}</text>
<text x="220" y="222" text-anchor="end" font-size="10.5" class="m">three.ws</text>`;
}
