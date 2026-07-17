// src/forge-embed-snippets.js — the shared, pure snippet builders behind the
// Forge "Embed this model" panel and (roadmap prompt 10) the "Add to your
// agent/site" flow. Pure string/URL assembly, no DOM — safe to unit test and
// to import from a Node script (examples/agent-native-3d/run.mjs does exactly
// that, so these contracts are load-bearing for more than the browser panel).

import { describe, it, expect } from 'vitest';
import {
	buildIframeSnippet,
	buildWebComponentSnippet,
	buildAgentThreeDSnippet,
	buildPageAgentSnippet,
	buildWalkCompanionSnippet,
	embedPageUrl,
	absoluteGlb,
} from '../../src/forge-embed-snippets.js';

const GLB = 'https://cdn.test/robot.glb';
const TITLE = 'A friendly robot';

describe('embedPageUrl', () => {
	it('points at the lightweight /forge/embed viewer, not the full app', () => {
		const url = embedPageUrl(GLB, TITLE);
		// URLSearchParams (not encodeURIComponent) does the encoding — spaces become
		// "+", matching how api/_lib/embed.js's forgeEmbedTarget builds the same URL.
		expect(url).toBe(`https://three.ws/forge/embed?${new URLSearchParams({ src: GLB, title: TITLE })}`);
	});
});

describe('absoluteGlb', () => {
	it('resolves a relative path against the prod origin', () => {
		expect(absoluteGlb('/forge/abc.glb')).toBe('https://three.ws/forge/abc.glb');
	});
	it('passes an already-absolute URL through unchanged', () => {
		expect(absoluteGlb(GLB)).toBe(GLB);
	});
});

describe('buildIframeSnippet / buildWebComponentSnippet / buildAgentThreeDSnippet', () => {
	it('all embed the same GLB URL and a sane title fallback', () => {
		const iframe = buildIframeSnippet(GLB, '', 'wide');
		const component = buildWebComponentSnippet(GLB, '', 'wide');
		const agent3d = buildAgentThreeDSnippet(GLB, '', 'wide');
		expect(iframe).toContain('<iframe');
		expect(iframe).toContain(encodeURIComponent(GLB));
		expect(component).toContain(GLB);
		expect(component).toContain('<model-viewer');
		// The pasted snippet must render at studio quality, not model-viewer's
		// legacy-neutral defaults — same env HDR / tone mapping / exposure as
		// the Forge studio viewer (pages/forge.html) and /forge/embed.
		expect(component).toContain('tone-mapping="aces"');
		expect(component).toContain('environment-image="https://three.ws/environments/gallery/env.hdr"');
		expect(component).toContain('exposure="1.5"');
		expect(component).toContain('shadow-softness="0.9"');
		expect(agent3d).toContain(GLB);
		expect(agent3d).toContain('<agent-3d');
		expect(agent3d).toContain('viewer');
	});
});

describe('buildPageAgentSnippet — "add to your agent"', () => {
	it('uses the real @three-ws/page-agent AvatarStage/SpeechNarrator custom-avatar contract', () => {
		const snippet = buildPageAgentSnippet(GLB, TITLE);
		expect(snippet).toContain("import { AvatarStage, SpeechNarrator } from '@three-ws/page-agent'");
		expect(snippet).toContain(`stage.load('${GLB}'`);
		expect(snippet).toContain('new SpeechNarrator(stage)');
		expect(snippet).toContain(TITLE);
	});

	it('falls back to a sane default title when none is given', () => {
		const snippet = buildPageAgentSnippet(GLB, '');
		expect(snippet).toContain('Your agent');
	});

	it('escapes HTML-unsafe characters in the title', () => {
		const snippet = buildPageAgentSnippet(GLB, '<script>alert(1)</script>');
		expect(snippet).not.toContain('<script>alert(1)</script>');
		expect(snippet).toContain('&lt;script&gt;');
	});
});

describe('buildWalkCompanionSnippet — "add to your site"', () => {
	it('uses the real @three-ws/walk createWalkCompanion custom-roster contract', () => {
		const snippet = buildWalkCompanionSnippet(GLB, TITLE);
		expect(snippet).toContain("import { createWalkCompanion } from '@three-ws/walk'");
		expect(snippet).toContain(`asset: '${GLB}'`);
		// Absolute-URL roster entries use source:'static' (resolveAvatarUrl in
		// walk-sdk/src/roster.js passes an absolute asset URL through untouched) —
		// source:'api' would instead resolve against /api/avatars/<id>/glb, which
		// only works for a platform avatar id, not an arbitrary GLB URL.
		expect(snippet).toContain("source: 'static'");
		expect(snippet).toContain("rig: 'shared'");
		expect(snippet).toContain('walk.bootstrap()');
		expect(snippet).toContain(TITLE);
	});

	it('falls back to a sane default title when none is given', () => {
		const snippet = buildWalkCompanionSnippet(GLB, '');
		expect(snippet).toContain('Your avatar');
	});
});
