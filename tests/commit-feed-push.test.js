import { describe, it, expect } from 'vitest';
import {
	splitSubject,
	prettyHeadline,
	commitPreviewUrl,
	formatTelegramMessage,
} from '../api/_lib/commit-feed-push.js';
import commitOg from '../api/commit-og.js';

const commit = (over = {}) => ({
	sha: 'abcdef1234567890abcdef1234567890abcdef12',
	html_url: 'https://github.com/nirholas/three.ws/commit/abcdef1234567890abcdef1234567890abcdef12',
	commit: {
		message: 'feat: add a thing\n\nlonger body ignored',
		author: { name: 'nirholas', date: '2026-07-22T12:00:00Z' },
	},
	author: { login: 'nirholas' },
	...over,
});

describe('splitSubject', () => {
	it('splits scope: description on an early colon', () => {
		expect(splitSubject('feat: add a thing')).toEqual({ headline: 'feat', body: 'add a thing' });
		expect(splitSubject('Avatar Studio: 122 sliders')).toEqual({
			headline: 'Avatar Studio',
			body: '122 sliders',
		});
	});
	it('falls back to New commit when there is no early colon', () => {
		expect(splitSubject('Escape a raw NUL byte in the test')).toEqual({
			headline: 'New commit',
			body: 'Escape a raw NUL byte in the test',
		});
	});
	it('does not split on a late colon', () => {
		const s = 'this is a very long subject line that carries its only colon well past sixty: nope';
		expect(splitSubject(s).headline).toBe('New commit');
	});
});

describe('prettyHeadline', () => {
	it('maps conventional-commit types to friendly labels', () => {
		expect(prettyHeadline('feat')).toBe('Feature');
		expect(prettyHeadline('fix')).toBe('Fix');
		expect(prettyHeadline('PERF')).toBe('Performance');
	});
	it('passes real scopes through untouched', () => {
		expect(prettyHeadline('Avatar Studio')).toBe('Avatar Studio');
		expect(prettyHeadline('/cookbook')).toBe('/cookbook');
		expect(prettyHeadline('New commit')).toBe('New commit');
	});
});

describe('formatTelegramMessage', () => {
	it('uses the prettified headline as the bold title', () => {
		const msg = formatTelegramMessage(commit());
		expect(msg).toContain('<b>Feature</b>');
		expect(msg).toContain('add a thing');
		expect(msg).toContain('github.com/nirholas/three.ws/commit/abcdef1');
	});
	it('escapes HTML in the subject body', () => {
		const msg = formatTelegramMessage(commit({ commit: { message: 'fix: guard <script> & co', author: {} } }));
		expect(msg).toContain('guard &lt;script&gt; &amp; co');
		expect(msg).not.toContain('<script>');
	});
});

describe('commitPreviewUrl', () => {
	it('points at the branded commit-og landing with the sha and pretty headline', () => {
		const u = new URL(commitPreviewUrl(commit()));
		expect(u.origin + u.pathname).toBe('https://three.ws/api/commit-og');
		expect(u.searchParams.get('sha')).toBe('abcdef1234567890abcdef1234567890abcdef12');
		expect(u.searchParams.get('t')).toBe('Feature');
		expect(u.searchParams.get('d')).toBe('add a thing');
		expect(u.searchParams.get('author')).toBe('nirholas');
	});
});

// Minimal ServerResponse stub for the HTML handler.
function capture() {
	const res = {
		statusCode: 0,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		end(s) {
			this.body = s || '';
		},
	};
	return res;
}

describe('commit-og handler', () => {
	it('emits OG tags and a validated GitHub redirect', () => {
		const res = capture();
		commitOg(
			{ url: '/api/commit-og?sha=abcdef1234567&t=Feature&d=add%20a%20thing&date=2026-07-22&author=nirholas' },
			res,
		);
		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.body).toContain('<meta property="og:title" content="Feature">');
		expect(res.body).toContain('property="og:image" content="https://three.ws/api/page-og?s=commit');
		expect(res.body).toContain('github.com/nirholas/three.ws/commit/abcdef1234567');
		// redirect target is the commit, not a caller-supplied url
		expect(res.body).toContain('url=https://github.com/nirholas/three.ws/commit/abcdef1234567');
	});

	it('rejects a non-hex sha and falls back to the commits page (no open redirect)', () => {
		const res = capture();
		commitOg({ url: '/api/commit-og?sha=https://evil.example/pwn&t=x' }, res);
		expect(res.body).not.toContain('evil.example');
		expect(res.body).toContain('github.com/nirholas/three.ws/commits/main');
	});

	it('escapes HTML in OG attribute values', () => {
		const res = capture();
		commitOg({ url: '/api/commit-og?sha=abcdef1&t=' + encodeURIComponent('a" onload="x') }, res);
		expect(res.body).not.toContain('onload="x"');
		expect(res.body).toContain('&quot;');
	});
});
