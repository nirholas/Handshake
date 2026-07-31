// Regression lock for the silent-expression defect on /api/avatar/render
// (ISSUES.md item 9, second defect): a model with zero morph targets, or with
// morphs named differently from the request, rendered a clean 200 with none of
// the requested expression applied and gave the caller no way to tell.
// applyExpression now returns { requested, missing }, the page publishes it as
// window.__expressionReport, and the HTTP layer maps it to
// x-render-expression / x-render-expression-missing headers.

import { describe, it, expect } from 'vitest';
import { applyExpression, sceneViewerHtml, SCENE_PRESETS } from '../../api/_lib/avatar-render.js';

// Minimal stand-in for a loaded glTF scene graph: traverse() visits every node.
function fakeRoot(nodes) {
	return { traverse(fn) { nodes.forEach(fn); } };
}

function morphMesh(dictionary) {
	return {
		isMesh: true,
		morphTargetDictionary: dictionary,
		morphTargetInfluences: new Array(Object.keys(dictionary).length).fill(0),
	};
}

describe('applyExpression report', () => {
	it('returns null when no expression is requested', () => {
		expect(applyExpression(fakeRoot([morphMesh({ mouthSmile: 0 })]), null)).toBeNull();
		expect(applyExpression(fakeRoot([morphMesh({ mouthSmile: 0 })]), {})).toBeNull();
	});

	it('applies matching morphs and reports zero missing', () => {
		const mesh = morphMesh({ mouthSmile: 0, eyeBlinkLeft: 1 });
		const report = applyExpression(fakeRoot([mesh]), { mouthSmile: 0.6 });
		expect(mesh.morphTargetInfluences[0]).toBe(0.6);
		expect(report).toEqual({ requested: ['mouthSmile'], missing: [] });
	});

	it('reports every requested name missing on a morph-less model', () => {
		// The live defect: avatar 13f259c7-… has no morph targets at all.
		const bareMesh = { isMesh: true };
		const report = applyExpression(fakeRoot([bareMesh]), { mouthSmile: 0.6, jawOpen: 0.3 });
		expect(report).toEqual({ requested: ['mouthSmile', 'jawOpen'], missing: ['mouthSmile', 'jawOpen'] });
	});

	it('reports a partial match when only some morphs exist', () => {
		const mesh = morphMesh({ mouthSmile: 0 });
		const report = applyExpression(fakeRoot([mesh]), { mouthSmile: 1, browInnerUp: 0.4 });
		expect(mesh.morphTargetInfluences[0]).toBe(1);
		expect(report.missing).toEqual(['browInnerUp']);
	});

	it('matches case-insensitively via the lowercase fallback', () => {
		const mesh = morphMesh({ mouthsmile: 0 });
		const report = applyExpression(fakeRoot([mesh]), { mouthSmile: 0.5 });
		expect(mesh.morphTargetInfluences[0]).toBe(0.5);
		expect(report.missing).toEqual([]);
	});

	it('a name matched on ANY mesh counts as applied', () => {
		const bare = { isMesh: true };
		const face = morphMesh({ jawOpen: 0 });
		const report = applyExpression(fakeRoot([bare, face]), { jawOpen: 0.2 });
		expect(report.missing).toEqual([]);
	});
});

describe('render page wiring', () => {
	it('injects applyExpression verbatim and publishes __expressionReport', () => {
		const html = sceneViewerHtml({
			glbUrl: 'https://cdn.three.ws/a.glb',
			width: 64,
			height: 64,
			background: 'transparent',
			pose: null,
			cameraOrbit: null,
			expression: { mouthSmile: 0.6 },
			scenePreset: SCENE_PRESETS.portrait,
		});
		expect(html).toContain('function applyExpression');
		expect(html).toContain('window.__expressionReport = null');
		expect(html).toContain('window.__expressionReport = applyExpression(root, expression)');
	});

	it('keeps the injected function self-contained (no outer-scope references)', () => {
		// The page evals this source standalone; a captured import or module
		// variable would throw only at render time in headless chromium.
		const src = applyExpression.toString();
		expect(src).not.toMatch(/\brequire\b|\bimport\b|\bTHREE\b/);
	});
});
