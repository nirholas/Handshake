// Language support for <agent-3d> embeds. Pure: no vscode, so every rule is
// unit tested against strings and character offsets; extension.js maps the
// offsets to editor positions and wires the providers.
//
// Covers the two tags an embed is made of: the element itself, and the
// <script> that loads the library. The rules encode what docs/embedding.md says
// goes wrong in practice: an element with no source shows nothing, an element
// with no size collapses to zero, a "latest" script changes under a production
// page, and a pinned script whose integrity hash has drifted is refused by the
// browser outright.

/** Every attribute the element reads, with the docs a hover or completion shows. */
export const ATTRIBUTES = Object.freeze([
	attr('src', 'On-chain agent URI, the canonical source: `agent://base/42`. Also accepts a bare GLB URL.', { source: true }),
	attr('agent-id', 'Agent id: numeric token id (with `chain-id`), CAIP-10 (`eip155:8453:0xReg…:42`), or a backend id (`a_abc123`).', { source: true }),
	attr('chain-id', 'Chain id that a numeric `agent-id` lives on, e.g. `8453` for Base.'),
	attr('avatar-id', 'A three.ws avatar id. Loads the avatar without an agent persona.', { source: true }),
	attr('manifest', 'IPFS or HTTPS URL of an agent manifest.', { source: true }),
	attr('body', 'HTTPS URL of a bare GLB for an ad-hoc agent. Viewer-only unless `brain` is set.', { source: true }),
	attr('brain', '`free` gives an ad-hoc `body` embed a real conversation with no API key, routed through the host-paid free tier.', { values: ['free'] }),
	attr('instructions', 'System prompt for the `brain`: who the agent is and how it should behave.'),
	attr('mode', 'Layout: `inline` (default, flows with the document), `floating` (fixed bubble), `section` (fills its parent), `fullscreen`.', { values: ['inline', 'floating', 'section', 'fullscreen'] }),
	attr('position', 'Corner for `mode="floating"`.', { values: ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'bottom-center'] }),
	attr('offset', 'Distance from the edges for `mode="floating"`, e.g. `24px 24px`.'),
	attr('width', 'CSS width for `mode="floating"`, e.g. `320px`. Inline embeds size through CSS instead.'),
	attr('height', 'CSS height for `mode="floating"`, e.g. `420px`.'),
	attr('responsive', 'Scale the layout with the container width.'),
	attr('framing', 'Camera framing of the avatar: `full`, `bust`, or `face`.', { values: ['full', 'bust', 'face'] }),
	attr('clip', 'Animation clip to play on load, by name.'),
	attr('background', 'Background colour or `transparent`.'),
	attr('poster', 'Image shown while the model loads (also available as the `poster` slot).'),
	attr('name-plate', 'Show the agent name over the avatar.'),
	attr('voice', 'Enable voice: the agent speaks its replies and listens to the mic.'),
	attr('voice-server', 'URL of a self-hosted voice server.'),
	attr('chat', 'Show the built-in chat panel.'),
	attr('avatar-chat', 'Chat through the avatar (speech bubbles) instead of a panel.'),
	attr('avatar-walk', 'Let the avatar walk around the page.'),
	attr('sign-language', 'Sign replies in ASL alongside speech.'),
	attr('wallet', 'Enable the agent wallet affordance.'),
	attr('tracked-mint', 'Token mint the agent reacts to (price, holders).'),
	attr('skills', 'Comma-separated skill URIs to install on load.'),
	attr('skill-trust', 'Trust policy for installed skills.'),
	attr('memory', 'Enable persistent conversation memory.'),
	attr('memory-key', 'Storage key that scopes the memory, e.g. per user.'),
	attr('api-base', 'Origin of a self-hosted three.ws API, for private deployments.'),
	attr('api-key', 'API key for a self-hosted brain. Prefer `key-proxy` on public pages.'),
	attr('key-proxy', 'URL of your own proxy that adds the API key server-side so it never ships in HTML.'),
	attr('rpc-url', 'Custom RPC endpoint for on-chain lookups.'),
	attr('registry', 'Agent registry contract to resolve `agent-id` against.'),
	attr('name', 'Display name override.'),
	attr('eager', 'Boot immediately instead of waiting to scroll into view.', { flag: true }),
	attr('keep-alive', 'Keep the GL context running while off-screen.', { flag: true }),
	attr('kiosk', 'Hide all chrome for a public display.', { flag: true }),
	attr('viewer', 'Viewer-only: no chat, no voice, no brain.', { flag: true }),
]);

function attr(name, doc, extra = {}) {
	return Object.freeze({ name, doc, values: extra.values || null, flag: Boolean(extra.flag), source: Boolean(extra.source) });
}

export const SOURCE_ATTRIBUTES = Object.freeze(ATTRIBUTES.filter((a) => a.source).map((a) => a.name));

/** Attributes any HTML element takes, never flagged as unknown. */
const GLOBAL_ATTRIBUTE = /^(id|class|style|slot|title|hidden|lang|dir|tabindex|role|part|is|data-[\w-]+|aria-[\w-]+|on[a-z]+)$/i;

const ELEMENT_RE = /<agent-3d\b([^>]*?)(\/?)>/gi;
const SCRIPT_RE = /<script\b([^>]*)>/gi;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\{[^}]*\})|([^\s"'<>`]+)))?/g;
const LIBRARY_SRC_RE = /^(https?:)?\/\/([^/]+)\/agent-3d\/([^/]+)\/agent-3d(\.umd\.cjs|\.js)$/;
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

/**
 * @typedef {object} Attr
 * @property {string} name
 * @property {string|null} value null for a bare flag
 * @property {number} start offset of the name
 * @property {number} end offset after the whole attribute
 * @property {number} nameEnd
 * @property {boolean} expression true for a JSX `{…}` value
 */

/**
 * Every <agent-3d> tag in the text.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, tagEnd: number, attrsStart: number, attrs: Attr[] }>}
 */
export function findEmbeds(text) {
	const out = [];
	ELEMENT_RE.lastIndex = 0;
	let m;
	while ((m = ELEMENT_RE.exec(text))) {
		const start = m.index;
		const tagEnd = start + '<agent-3d'.length;
		const attrsStart = tagEnd;
		out.push({ start, end: start + m[0].length, tagEnd, attrsStart, attrs: parseAttrs(m[1], attrsStart) });
	}
	return out;
}

/**
 * Every <script> that loads the agent-3d library.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, src: Attr, channel: string, host: string, integrity: Attr|null, exact: boolean }>}
 */
export function findLibraryScripts(text) {
	const out = [];
	SCRIPT_RE.lastIndex = 0;
	let m;
	while ((m = SCRIPT_RE.exec(text))) {
		const attrs = parseAttrs(m[1], m.index + '<script'.length);
		const src = attrs.find((a) => a.name.toLowerCase() === 'src' && a.value);
		const lib = src && LIBRARY_SRC_RE.exec(src.value.trim());
		if (!lib) continue;
		const channel = lib[3];
		out.push({
			start: m.index,
			end: m.index + m[0].length,
			src,
			host: lib[2],
			channel,
			exact: EXACT_VERSION_RE.test(channel),
			integrity: attrs.find((a) => a.name.toLowerCase() === 'integrity') || null,
		});
	}
	return out;
}

/** @param {string} chunk @param {number} base offset of chunk[0] in the document */
export function parseAttrs(chunk, base) {
	const attrs = [];
	ATTR_RE.lastIndex = 0;
	let m;
	while ((m = ATTR_RE.exec(chunk))) {
		if (!m[0].trim()) continue;
		const name = m[1];
		const expression = m[4] !== undefined;
		const value = m[2] ?? m[3] ?? m[4] ?? m[5] ?? null;
		attrs.push({
			name,
			value,
			expression,
			start: base + m.index,
			nameEnd: base + m.index + name.length,
			end: base + m.index + m[0].length,
		});
	}
	return attrs;
}

/** Which attribute of an embed the cursor is on, if any. */
export function attributeAt(embed, offset) {
	return embed.attrs.find((a) => offset >= a.start && offset <= a.end) || null;
}

/**
 * Where in an embed the cursor sits: naming an attribute, inside an
 * attribute's value, or nowhere relevant. Works on a tag the user is still
 * typing (no closing `>` yet), which is when completion matters most.
 *
 * @returns {{ kind: 'name', embed: { attrs: Attr[] } } | { kind: 'value', attr: { name: string }, def: object|null } | null}
 */
export function completionContext(text, offset) {
	const open = text.lastIndexOf('<agent-3d', offset);
	if (open === -1) return null;
	const attrsStart = open + '<agent-3d'.length;
	if (offset < attrsStart) return null;
	// A `>` between the tag and the cursor means the cursor is past this tag.
	const close = text.indexOf('>', attrsStart);
	if (close !== -1 && close < offset) return null;
	const chunk = text.slice(attrsStart, offset);
	// Inside an open quote: `mode="fl` or `mode='`.
	const inValue = /([^\s"'<>\/=]+)\s*=\s*(["'])([^"']*)$/.exec(chunk);
	if (inValue) {
		const name = inValue[1].toLowerCase();
		return { kind: 'value', attr: { name }, def: ATTRIBUTES.find((d) => d.name === name) || null };
	}
	// After whitespace (or a partial attribute name after whitespace): naming.
	if (/\s$/.test(chunk) || /\s[^\s="'<>]*$/.test(chunk)) {
		return { kind: 'name', embed: { start: open, tagEnd: attrsStart, attrsStart, end: offset, attrs: parseAttrs(chunk, attrsStart) } };
	}
	return null;
}

/**
 * @typedef {object} Finding
 * @property {string} code
 * @property {'error'|'warning'|'information'|'hint'} severity
 * @property {string} message
 * @property {number} start
 * @property {number} end
 * @property {{ title: string, start: number, end: number, text: string }|null} fix a single text replacement
 */

/**
 * Run every rule.
 *
 * @param {string} text
 * @param {{ release?: { channel: string, integrity: string|null } | null, origin?: string }} [ctx]
 *   release is the current library release from /agent-3d/versions.json; when
 *   absent (offline) the pinning rules that need it are skipped.
 * @returns {Finding[]}
 */
export function diagnose(text, ctx = {}) {
	const findings = [];
	const release = ctx.release && EXACT_VERSION_RE.test(ctx.release.channel) ? ctx.release : null;

	for (const embed of findEmbeds(text)) {
		const names = embed.attrs.map((a) => a.name.toLowerCase());
		const hasSource = names.some((n) => SOURCE_ATTRIBUTES.includes(n));
		const hasSpread = embed.attrs.some((a) => a.expression && /^\{\s*\.\.\./.test(a.name) || /^\{\.\.\./.test(a.name));
		if (!hasSource && !hasSpread) {
			findings.push({
				code: 'no-source',
				severity: 'error',
				message: `<agent-3d> has nothing to show. Set one of ${SOURCE_ATTRIBUTES.map((n) => `\`${n}\``).join(', ')}.`,
				start: embed.start,
				end: embed.tagEnd,
				fix: null,
			});
		}

		const mode = valueOf(embed, 'mode');
		const style = valueOf(embed, 'style') || '';
		const sized =
			(/\bwidth\s*:/.test(style) && /\bheight\s*:/.test(style)) ||
			(names.includes('width') && names.includes('height')) ||
			names.includes('responsive') ||
			(mode && mode !== 'inline') ||
			hasSpread ||
			embed.attrs.some((a) => a.name.toLowerCase() === 'style' && a.expression) ||
			names.includes('class') || names.includes('classname');
		if (!sized) {
			findings.push({
				code: 'no-size',
				severity: 'warning',
				message: 'The element has no intrinsic size and will collapse to 0×0. Give it a width and height (inline style, a class, or the width/height attributes).',
				start: embed.start,
				end: embed.tagEnd,
				fix: {
					title: 'Add an inline size (400×500)',
					start: embed.tagEnd,
					end: embed.tagEnd,
					text: ' style="width: 400px; height: 500px; display: block;"',
				},
			});
		}

		for (const a of embed.attrs) {
			const lower = a.name.toLowerCase();
			if (a.expression && /^\{/.test(a.name)) continue;
			const def = ATTRIBUTES.find((d) => d.name === lower);
			if (!def) {
				if (GLOBAL_ATTRIBUTE.test(lower) || lower === 'classname' || lower === 'key' || lower === 'ref') continue;
				const guess = closest(lower);
				findings.push({
					code: 'unknown-attribute',
					severity: 'information',
					message: `\`${a.name}\` is not an attribute <agent-3d> reads.${guess ? ` Did you mean \`${guess}\`?` : ''}`,
					start: a.start,
					end: a.nameEnd,
					fix: guess ? { title: `Rename to ${guess}`, start: a.start, end: a.nameEnd, text: guess } : null,
				});
				continue;
			}
			if (def.values && a.value !== null && !a.expression && !def.values.includes(a.value.trim())) {
				findings.push({
					code: 'bad-value',
					severity: 'warning',
					message: `\`${a.name}\` takes ${def.values.map((v) => `\`${v}\``).join(', ')}; \`${a.value}\` will be ignored.`,
					start: a.nameEnd,
					end: a.end,
					fix: null,
				});
			}
			if (lower === 'api-key' && a.value && !a.expression) {
				findings.push({
					code: 'key-in-html',
					severity: 'warning',
					message: 'An API key in HTML ships to every visitor. Use `key-proxy` to add it server-side, or `brain="free"`.',
					start: a.start,
					end: a.end,
					fix: null,
				});
			}
		}
	}

	for (const script of findLibraryScripts(text)) {
		const target = release ? release.channel : null;
		if (!script.exact) {
			const moving = script.channel === 'latest';
			findings.push({
				code: 'unpinned-library',
				severity: moving ? 'warning' : 'hint',
				message: moving
					? 'The `latest` channel is for demos: a release can change this page under you. Pin an exact version for production.'
					: `Channel \`${script.channel}\` follows new releases automatically. Pin an exact version if this page must not change on its own.`,
				start: script.src.start,
				end: script.src.end,
				fix: target
					? pinFix(text, script, release)
					: null,
			});
			continue;
		}
		if (!script.integrity) {
			const known = release && release.channel === script.channel && release.integrity;
			findings.push({
				code: 'missing-integrity',
				severity: 'hint',
				message: 'Pinned, but without an `integrity` hash the browser cannot verify the bytes. Add the release hash.',
				start: script.src.start,
				end: script.src.end,
				fix: known
					? { title: `Add integrity for ${release.channel}`, start: script.src.end, end: script.src.end, text: `\n  integrity="${release.integrity}"\n  crossorigin="anonymous"` }
					: null,
			});
		} else if (release && release.channel === script.channel && release.integrity && script.integrity.value?.trim() !== release.integrity) {
			findings.push({
				code: 'stale-integrity',
				severity: 'error',
				message: `The integrity hash does not match release ${release.channel}. The browser will refuse to run the library.`,
				start: script.integrity.start,
				end: script.integrity.end,
				fix: { title: `Use the published hash for ${release.channel}`, start: script.integrity.start, end: script.integrity.end, text: `integrity="${release.integrity}"` },
			});
		} else if (release && release.channel !== script.channel && newer(release.channel, script.channel)) {
			findings.push({
				code: 'newer-release',
				severity: 'hint',
				message: `Release ${release.channel} is available (this page pins ${script.channel}).`,
				start: script.src.start,
				end: script.src.end,
				fix: pinFix(text, script, release),
			});
		}
	}

	return findings;
}

function pinFix(text, script, release) {
	if (!release?.integrity) return null;
	// Replace the whole tag so channel and hash change together.
	const tag = text.slice(script.start, script.end);
	const type = /\btype\s*=\s*["']module["']/i.test(tag) ? 'module' : null;
	const src = script.src.value.replace(/\/agent-3d\/[^/]+\/agent-3d/, `/agent-3d/${release.channel}/agent-3d`);
	const lines = ['<script', ...(type ? [`  type="${type}"`] : []), `  src="${src}"`, `  integrity="${release.integrity}"`, '  crossorigin="anonymous"', '>'];
	return { title: `Pin to ${release.channel} with its integrity hash`, start: script.start, end: script.end, text: lines.join('\n') };
}

function valueOf(embed, name) {
	const a = embed.attrs.find((x) => x.name.toLowerCase() === name);
	return a && a.value !== null && !a.expression ? a.value : null;
}

function newer(a, b) {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] > pb[i];
	}
	return false;
}

/** Nearest known attribute by edit distance, for "did you mean". */
export function closest(name) {
	let best = null;
	let bestScore = Infinity;
	for (const a of ATTRIBUTES) {
		const d = levenshtein(name, a.name);
		if (d < bestScore) {
			bestScore = d;
			best = a.name;
		}
	}
	return bestScore <= Math.max(2, Math.floor(name.length / 4)) ? best : null;
}

function levenshtein(a, b) {
	const m = a.length;
	const n = b.length;
	const row = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[n];
}

/** Hover text for the tag itself. */
export function tagHover(origin = 'https://three.ws') {
	return [
		'**`<agent-3d>`**: a live three.ws agent (3D avatar that can talk, gesture, and run skills).',
		'',
		`Point it at an agent with \`src\`, \`agent-id\`, \`avatar-id\`, \`manifest\`, or a bare GLB with \`body\`. Give it a width and height.`,
		'',
		`[Embedding guide](${origin}/docs/embedding) · [Widget Studio](${origin}/studio)`,
	].join('\n');
}
