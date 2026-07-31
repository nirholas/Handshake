/**
 * Live SVG health badges.
 *
 * The point of the badge is that it is not self-reported. A build badge says
 * the tests passed on some commit; this one says the URLs that repository
 * advertises answered a request a few hours ago. Drop it in a README and the
 * README stops being able to lie about being deployed.
 */

const COLORS = { good: '#3fb950', warn: '#d29922', bad: '#e5534b', mute: '#6e7681' };

/** Approximate advance width for the 11px sans stack shields use. */
const textWidth = (text) => {
	let width = 0;
	for (const char of String(text)) {
		if ('ilj|!.,:;\'`'.includes(char)) width += 3.2;
		else if ('Iftr()[]{}/\\ '.includes(char)) width += 4.4;
		else if ('mwMW@'.includes(char)) width += 9.6;
		else if (char >= 'A' && char <= 'Z') width += 7.6;
		else width += 6.6;
	}
	return Math.ceil(width);
};

const escapeXml = (value) =>
	String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

/**
 * Render a two-part badge.
 * @param {{label:string, message:string, tone:'good'|'warn'|'bad'|'mute'}} input
 */
export function badgeSvg({ label, message, tone = 'mute' }) {
	const color = COLORS[tone] || COLORS.mute;
	const leftWidth = textWidth(label) + 20;
	const rightWidth = textWidth(message) + 20;
	const total = leftWidth + rightWidth;
	const title = `${label}: ${message}`;

	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${total}" height="20" role="img" aria-label="${escapeXml(title)}">
<title>${escapeXml(title)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
  <rect width="${leftWidth}" height="20" fill="#33383d"/>
  <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${color}"/>
  <rect width="${total}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
  <text x="${leftWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
  <text x="${leftWidth / 2}" y="14">${escapeXml(label)}</text>
  <text x="${leftWidth + rightWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>
  <text x="${leftWidth + rightWidth / 2}" y="14">${escapeXml(message)}</text>
</g>
</svg>`;
}

/** Badge for one repository. */
export function repoBadge(repo) {
	if (!repo || typeof repo.score !== 'number') return badgeSvg({ label: 'fleet health', message: 'unknown', tone: 'mute' });
	return badgeSvg({ label: 'fleet health', message: `${repo.score}/100 ${repo.grade?.grade || ''}`.trim(), tone: repo.grade?.tone || 'mute' });
}

/** Badge for a repository's advertised deployments only. */
export function deploymentBadge(repo) {
	const deployments = repo?.deployments || [];
	if (!deployments.length) return badgeSvg({ label: 'deployment', message: 'none advertised', tone: 'mute' });
	const healthy = deployments.filter((entry) => entry.state === 'live' || entry.state === 'redirected').length;
	const tone = healthy === deployments.length ? 'good' : healthy > 0 ? 'warn' : 'bad';
	return badgeSvg({ label: 'deployment', message: `${healthy}/${deployments.length} live`, tone });
}

/** Fleet-wide badge. */
export function fleetBadge(snapshot) {
	if (!snapshot) return badgeSvg({ label: 'fleet', message: 'not scanned', tone: 'mute' });
	const median = snapshot.summary.medianScore;
	const tone = median >= 75 ? 'good' : median >= 55 ? 'warn' : 'bad';
	return badgeSvg({ label: `fleet (${snapshot.summary.repos} repos)`, message: `median ${median}/100`, tone });
}
