// Build an RSS 2.0 feed for HackerNoon's "Auto Import" ingester (also valid
// for any standard reader). Two sources:
//   - curated: data/rss/items.json (default — hand-edited, full editorial control)
//   - archive: data/archives/*.json (scraped X posts — fallback / mirror mode)

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'data');
const ARCHIVES_DIR = path.join(DATA_ROOT, 'archives');
const CURATED_FILE = path.join(DATA_ROOT, 'rss', 'items.json');
const MIN_LENGTH = 140;

export const SITE_ORIGIN = 'https://three.ws';
export const NEWS_PATH_PREFIX = '/news';

// Derive a URL-safe slug from a curated item. Honors an explicit `slug` if
// the editor set one; otherwise falls back to the id (with a leading `t-`
// from tweet-derived seeds stripped). Output is lowercase, only [a-z0-9-].
export function deriveSlug(item) {
	const explicit = typeof item?.slug === 'string' ? item.slug : '';
	const raw = explicit || String(item?.id || '').replace(/^t-/, '');
	return raw
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80) || 'item';
}

// Treat any non-three.ws URL as the external/original source link.
function isExternalLink(url) {
	if (typeof url !== 'string' || !url) return false;
	try {
		const u = new URL(url);
		return u.hostname !== 'three.ws' && u.hostname !== 'www.three.ws';
	} catch {
		return false;
	}
}

const ACCOUNTS = {
	trythreews: { handle: '@trythreews', display: 'three.ws', url: 'https://x.com/trythreews' },
	nichxbt: { handle: '@nichxbt', display: 'Nicholas (three.ws)', url: 'https://x.com/nichxbt' },
};

export async function loadCuratedItems({ includeDrafts = false } = {}) {
	const raw = await readFile(CURATED_FILE, 'utf8');
	const data = JSON.parse(raw);
	const entries = Array.isArray(data?.items) ? data.items : [];
	const items = [];
	for (const e of entries) {
		if (!e || typeof e !== 'object') continue;
		if (!e.id || !e.title || !e.date || !e.body_html) continue;
		if (!includeDrafts && e.published === false) continue;
		const ts = new Date(e.date);
		if (Number.isNaN(ts.getTime())) continue;
		const slug = deriveSlug(e);
		const rawLink = typeof e.link === 'string' && e.link ? e.link : '';
		const explicitExternal = typeof e.external_link === 'string' && e.external_link ? e.external_link : '';
		const externalLink = explicitExternal || (isExternalLink(rawLink) ? rawLink : '');
		items.push({
			id: String(e.id),
			slug,
			permalink: `${SITE_ORIGIN}${NEWS_PATH_PREFIX}/${slug}`,
			externalLink,
			// Where the item was first published. Most curated items are X posts, so
			// that stays the default; articles published at a named venue (the AWS
			// Builder Center, a partner blog) set external_source to be attributed
			// correctly instead of being labelled as an X post.
			externalSource: typeof e.external_source === 'string' && e.external_source ? e.external_source : 'X',
			title: String(e.title),
			author: typeof e.author === 'string' && e.author ? e.author : 'three.ws',
			summary: typeof e.summary === 'string' ? e.summary : deriveSummary(e.body_html),
			bodyHtml: String(e.body_html),
			image: typeof e.image === 'string' && e.image ? e.image : '',
			imageAlt: typeof e.image_alt === 'string' && e.image_alt ? e.image_alt : '',
			imageWidth: Number.isFinite(e.image_width) ? Math.trunc(e.image_width) : 0,
			imageHeight: Number.isFinite(e.image_height) ? Math.trunc(e.image_height) : 0,
			ogTitle: typeof e.og_title === 'string' && e.og_title ? e.og_title : '',
			ogDescription: typeof e.og_description === 'string' && e.og_description ? e.og_description : '',
			tags: Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string') : [],
			timestamp: ts,
			published: e.published !== false,
		});
	}
	items.sort((a, b) => b.timestamp - a.timestamp);
	return items;
}

function deriveSummary(html) {
	const text = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
	return text.length > 280 ? text.slice(0, 277) + '…' : text;
}

function absoluteUrl(url) {
	if (typeof url !== 'string' || !url) return '';
	if (/^https?:\/\//i.test(url)) return url;
	return `${SITE_ORIGIN}${url.startsWith('/') ? '' : '/'}${url}`;
}

function guessMime(url) {
	const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'png') return 'image/png';
	if (ext === 'webp') return 'image/webp';
	if (ext === 'gif') return 'image/gif';
	if (ext === 'svg') return 'image/svg+xml';
	return 'application/octet-stream';
}

export async function loadAnnouncementItems({ source = 'all' } = {}) {
	const files = (await readdir(ARCHIVES_DIR)).filter((f) => f.endsWith('.json') && f.includes('tweets'));
	const items = [];
	for (const file of files) {
		const archive = JSON.parse(await readFile(path.join(ARCHIVES_DIR, file), 'utf8'));
		const account = archive.profile;
		if (source !== 'all' && source !== account) continue;
		for (const t of archive.tweets || []) {
			if (t?.type?.isRetweet || t?.type?.isReply) continue;
			const text = cleanText(t.text || '');
			if (text.length < MIN_LENGTH) continue;
			const ts = new Date(t.timestamp);
			if (Number.isNaN(ts.getTime())) continue;
			items.push({
				id: t.id,
				account,
				url: t.url,
				text,
				timestamp: ts,
				hasImage: !!t?.media?.hasImage,
				hasVideo: !!t?.media?.hasVideo,
			});
		}
	}
	items.sort((a, b) => b.timestamp - a.timestamp);
	const seen = new Set();
	const deduped = [];
	for (const it of items) {
		if (seen.has(it.id)) continue;
		seen.add(it.id);
		deduped.push(it);
	}
	return deduped;
}

// The scraper emits bare "http://" tokens (sometimes on their own line) as
// placeholders for t.co-shortened URLs; the displayed URL text follows.
// Strip these so the prose reads cleanly.
function cleanText(s) {
	return s
		.replace(/\r\n/g, '\n')
		.replace(/^\s*https?:\/\/\s*\n?/u, '')
		.replace(/\bhttps?:\/\/\s*\n\s*/g, '')
		.replace(/\n[ \t]*https?:\/\/[ \t]*\n/g, '\n')
		.replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Characters XML 1.0 forbids outright (§2.2): the C0 controls other than tab,
// LF and CR, the two non-characters at the top of the BMP, and any unpaired
// surrogate. Escaping cannot rescue them (`&#7;` is just as illegal as a raw
// bell), so they are dropped. One of these anywhere in a title or body makes
// the WHOLE feed unparseable for every reader downstream, which is how a
// single stray byte in one scraped post takes the syndication feed offline.
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FIRST_PRINTABLE = 0x20;
const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;
const BMP_NONCHARS = new Set([0xfffe, 0xffff]);

function isValidXmlCodePoint(cp) {
	if (cp === TAB || cp === LINE_FEED || cp === CARRIAGE_RETURN) return true;
	if (cp < FIRST_PRINTABLE) return false;
	// Iterating by code point pairs real astral characters up already, so any
	// surrogate that reaches here is by definition unpaired.
	if (cp >= SURROGATE_START && cp <= SURROGATE_END) return false;
	return !BMP_NONCHARS.has(cp);
}

function stripInvalidXmlChars(s) {
	let out = '';
	for (const ch of String(s)) {
		if (isValidXmlCodePoint(ch.codePointAt(0))) out += ch;
	}
	return out;
}

function escapeXml(s) {
	return stripInvalidXmlChars(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function escapeAttr(s) {
	return escapeXml(s);
}

// CDATA carries markup verbatim, so the one sequence it cannot contain is its
// own terminator. Curated items ship hand-authored HTML, and a code sample
// that happens to close two brackets before a `>` would otherwise end the
// section early and corrupt every item after it. The canonical fix: close,
// emit the `]]>` as escaped text in a fresh section, and continue.
function cdata(s) {
	return stripInvalidXmlChars(s).split(']]>').join(']]]]><![CDATA[>');
}

function rfc822(date) {
	return date.toUTCString();
}

function deriveTitle(text) {
	const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) || text;
	const firstSentence = firstLine.split(/(?<=[.!?])\s+/)[0] || firstLine;
	const candidate = firstSentence.length > 90 ? firstLine : firstSentence;
	if (candidate.length <= 90) return candidate;
	const cut = candidate.slice(0, 87);
	const lastSpace = cut.lastIndexOf(' ');
	return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
}

// Linkify URLs and @handles in a single pass that swaps URLs out for
// placeholders so the handle pass can't accidentally match @-segments inside
// the URLs we just wrapped (e.g. https://x.com/Handle).
//
// The placeholder must be a sequence the post itself cannot contain, or a post
// that merely writes the placeholder's own text restores a URL that was never
// there (and, past the end of the array, throws and takes the whole feed down
// with it). Callers hand us XML-escaped text, so a raw `<` is impossible by
// construction: `<0>` is therefore collision-proof, and the restore pass can
// trust every index it finds.
const URL_SLOT = (i) => `<${i}>`;
const URL_SLOT_RE = /<(\d+)>/g;

function linkify(escapedHtml) {
	const urls = [];
	let buf = escapedHtml.replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
		const trimmed = url.replace(/[.,!?)]+$/, '');
		const tail = url.slice(trimmed.length);
		urls.push({ trimmed, tail });
		return URL_SLOT(urls.length - 1);
	});
	buf = buf.replace(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})/g, (_m, pre, handle) =>
		`${pre}<a href="https://x.com/${handle}" rel="noopener">@${handle}</a>`,
	);
	return buf.replace(URL_SLOT_RE, (_m, i) => {
		const { trimmed, tail } = urls[Number(i)];
		return `<a href="${trimmed}" rel="noopener">${trimmed}</a>${tail}`;
	});
}

function renderBodyHtml(item) {
	const account = ACCOUNTS[item.account] || { handle: '@' + item.account, display: item.account, url: `https://x.com/${item.account}` };
	const paragraphs = item.text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => '<p>' + linkify(escapeXml(p)).replace(/\n/g, '<br>') + '</p>')
		.join('\n');
	const footer =
		`<p><em>Originally posted by <a href="${account.url}" rel="noopener">${escapeXml(account.handle)}</a> on ` +
		`<a href="${item.url}" rel="noopener">${escapeXml(item.timestamp.toISOString().slice(0, 10))}</a>. ` +
		`Follow more updates at <a href="https://three.ws" rel="noopener">three.ws</a>.</em></p>`;
	return paragraphs + '\n' + footer;
}

function renderDescription(item) {
	const oneLine = item.text.replace(/\s+/g, ' ').trim();
	return oneLine.length > 280 ? oneLine.slice(0, 277) + '…' : oneLine;
}

export function buildRssXml({ items, selfUrl, source = 'curated' }) {
	const account = ACCOUNTS[source];
	const channelTitle = account
		? `three.ws: ${account.display} updates`
		: 'three.ws News & Announcements';
	const channelDescription = account
		? `Latest announcements from ${account.handle}, the team behind three.ws.`
		: 'Product launches, integrations, and announcements from three.ws, 3D AI agent avatars on-chain.';
	const lastBuildDate = items[0]?.timestamp || new Date();
	const itemsXml = items.map((item) => renderItemXml(item)).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
\txmlns:content="http://purl.org/rss/1.0/modules/content/"
\txmlns:dc="http://purl.org/dc/elements/1.1/"
\txmlns:atom="http://www.w3.org/2005/Atom"
\txmlns:media="http://search.yahoo.com/mrss/">
\t<channel>
\t\t<title>${escapeXml(channelTitle)}</title>
\t\t<link>https://three.ws</link>
\t\t<atom:link href="${escapeAttr(selfUrl)}" rel="self" type="application/rss+xml"/>
\t\t<atom:link href="https://pubsubhubbub.appspot.com" rel="hub"/>
\t\t<description>${escapeXml(channelDescription)}</description>
\t\t<language>en-us</language>
\t\t<lastBuildDate>${rfc822(lastBuildDate)}</lastBuildDate>
\t\t<generator>three.ws RSS feed</generator>
${itemsXml}
\t</channel>
</rss>
`;
}

function renderItemXml(item) {
	if (item.bodyHtml) {
		const tagsXml = (item.tags || [])
			.map((t) => `\n\t\t\t<category>${escapeXml(t)}</category>`)
			.join('');
		const sourceXml = item.externalLink
			? `\n\t\t\t<source url="${escapeAttr(item.externalLink)}">original post</source>`
			: '';
		let enclosureXml = '';
		let mediaXml = '';
		if (item.image) {
			const imgUrl = absoluteUrl(item.image);
			const mime = guessMime(item.image);
			enclosureXml = `\n\t\t\t<enclosure url="${escapeAttr(imgUrl)}" type="${escapeAttr(mime)}" length="0"/>`;
			const dimAttrs = item.imageWidth && item.imageHeight
				? ` width="${item.imageWidth}" height="${item.imageHeight}"`
				: '';
			const mediaTitle = item.imageAlt ? `\n\t\t\t\t<media:title type="plain">${escapeXml(item.imageAlt)}</media:title>` : '';
			mediaXml = `\n\t\t\t<media:content url="${escapeAttr(imgUrl)}" type="${escapeAttr(mime)}" medium="image"${dimAttrs}>${mediaTitle}
\t\t\t</media:content>`;
		}
		const bodyWithAttribution = item.externalLink
			? `${item.bodyHtml}\n<p><em>Originally published on <a href="${escapeAttr(item.externalLink)}" rel="noopener">${escapeXml(item.externalSource)}</a>. Follow more updates at <a href="https://three.ws" rel="noopener">three.ws</a>.</em></p>`
			: item.bodyHtml;
		return `\t\t<item>
\t\t\t<title>${escapeXml(item.title)}</title>
\t\t\t<link>${escapeXml(item.permalink)}</link>
\t\t\t<guid isPermaLink="true">${escapeXml(item.permalink)}</guid>
\t\t\t<pubDate>${rfc822(item.timestamp)}</pubDate>
\t\t\t<dc:creator>${escapeXml(item.author)}</dc:creator>${tagsXml}${sourceXml}${enclosureXml}${mediaXml}
\t\t\t<description>${escapeXml(item.summary)}</description>
\t\t\t<content:encoded><![CDATA[${cdata(bodyWithAttribution)}]]></content:encoded>
\t\t</item>`;
	}
	const account = ACCOUNTS[item.account] || { handle: '@' + item.account };
	const title = deriveTitle(item.text);
	return `\t\t<item>
\t\t\t<title>${escapeXml(title)}</title>
\t\t\t<link>${escapeXml(item.url)}</link>
\t\t\t<guid isPermaLink="false">three-ws:${escapeXml(item.id)}</guid>
\t\t\t<pubDate>${rfc822(item.timestamp)}</pubDate>
\t\t\t<dc:creator>${escapeXml(account.handle)}</dc:creator>
\t\t\t<description>${escapeXml(renderDescription(item))}</description>
\t\t\t<content:encoded><![CDATA[${cdata(renderBodyHtml(item))}]]></content:encoded>
\t\t</item>`;
}
