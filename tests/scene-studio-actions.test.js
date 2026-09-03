/**
 * Scene Studio action bar: pure-logic unit tests.
 *
 * Two of these pin regressions that shipped silently, because both failure
 * modes produce a plausible-looking string rather than an error:
 *
 *   1. `sceneTitle` used to be `document.title.replace(/\s*·\s*Scene Studio.*$/i, '')`.
 *      The live title is "Scene Studio · Assemble 3D worlds · three.ws", which
 *      that pattern never matches (it looks for "· Scene Studio", and the page
 *      leads with it), so every scene shared from the studio was labelled with
 *      the studio's own marketing string instead of the scene's name.
 *   2. `describeImportFailure` turns a bare `HTTP 4xx` / `Failed to fetch` into
 *      copy that tells the user what to do next. Its 403 branch was written as
 *      `40[34]`, which swallowed 404 and left the "nothing is hosted there"
 *      branch unreachable.
 */

import { describe, it, expect } from 'vitest';
import { describeImportFailure, sceneTitle } from '../src/scene-studio/actions.js';

describe('sceneTitle', () => {
	it('uses the name the user gave the scene', () => {
		expect(sceneTitle({ scene: { name: 'Rooftop bar' } })).toBe('Rooftop bar');
	});

	it('falls back for the editor default name, which is not a title', () => {
		expect(sceneTitle({ scene: { name: 'Scene' } })).toBe('Scene composed on three.ws');
		expect(sceneTitle({ scene: { name: 'scene' } })).toBe('Scene composed on three.ws');
	});

	it('falls back for an unnamed or whitespace-only scene', () => {
		expect(sceneTitle({ scene: { name: '' } })).toBe('Scene composed on three.ws');
		expect(sceneTitle({ scene: { name: '   ' } })).toBe('Scene composed on three.ws');
		expect(sceneTitle({ scene: {} })).toBe('Scene composed on three.ws');
	});

	it('never reaches for the page title', () => {
		expect(sceneTitle({})).toBe('Scene composed on three.ws');
	});
});

describe('describeImportFailure', () => {
	it('separates "not yours" from "not there"', () => {
		expect(describeImportFailure(new Error('HTTP 401'))).toBe('that link is private or expired');
		expect(describeImportFailure(new Error('HTTP 403'))).toBe('that link is private or expired');
		expect(describeImportFailure(new Error('HTTP 404'))).toBe('nothing is hosted at that link');
	});

	it('names the host when the host is at fault', () => {
		expect(describeImportFailure(new Error('HTTP 500'))).toBe('the host that stores it is down');
		expect(describeImportFailure(new Error('HTTP 503'))).toBe('the host that stores it is down');
	});

	it('explains the opaque cross-origin failure every browser words differently', () => {
		const cors = 'the host blocked the request (no CORS header) or is unreachable';
		expect(describeImportFailure(new TypeError('Failed to fetch'))).toBe(cors);
		expect(describeImportFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(cors);
		expect(describeImportFailure(new TypeError('Load failed'))).toBe(cors);
	});

	it('passes an unrecognised message through rather than inventing one', () => {
		expect(describeImportFailure(new Error('Unsupported glTF version'))).toBe('Unsupported glTF version');
		expect(describeImportFailure('plain string')).toBe('plain string');
	});

	it('never renders undefined for a thrown non-error', () => {
		expect(describeImportFailure(undefined)).toBe('Unknown error');
		expect(describeImportFailure(null)).toBe('Unknown error');
		expect(describeImportFailure({})).toBe('Unknown error');
	});
});
