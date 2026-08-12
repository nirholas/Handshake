// Shared image persistence (api/_lib/image-persist.js) unit tests. The module
// is the single home for the "every generated image becomes a durable R2 URL"
// rule the NIM FLUX lane, the Vertex reference-image lane, and the Livepeer
// federation provider all share.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { looksLikeImageBytes, sniffImageFormat, persistImageBase64, persistImageBytes } from '../api/_lib/image-persist.js';
import { putObject, publicUrl } from '../api/_lib/r2.js';

vi.mock('../api/_lib/r2.js', () => ({
	putObject: vi.fn(async () => ({})),
	publicUrl: vi.fn((key) => `https://cdn.example.com/${key}`),
}));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIG = [0xff, 0xd8, 0xff, 0xe0];

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.resetAllMocks();
});

describe('sniffImageFormat', () => {
	it('detects JPEG from the FF D8 FF magic header', () => {
		expect(sniffImageFormat(Buffer.from([...JPEG_SIG, 0, 1, 2]))).toBe('jpg');
	});

	it('labels everything else png (the legacy default)', () => {
		expect(sniffImageFormat(Buffer.from([...PNG_SIG]))).toBe('png');
		expect(sniffImageFormat(Buffer.from([0x00, 0x01]))).toBe('png');
	});
});

describe('looksLikeImageBytes', () => {
	it('accepts real JPEG and PNG signatures', () => {
		expect(looksLikeImageBytes(Buffer.from([...JPEG_SIG, 0, 1]))).toBe(true);
		expect(looksLikeImageBytes(Buffer.from([...PNG_SIG, 0, 1]))).toBe(true);
	});

	it('rejects text, tiny payloads, and empty buffers', () => {
		expect(looksLikeImageBytes(Buffer.from('<html>error</html>'))).toBe(false);
		expect(looksLikeImageBytes(Buffer.from([0xff]))).toBe(false);
		expect(looksLikeImageBytes(Buffer.alloc(0))).toBe(false);
		expect(looksLikeImageBytes(null)).toBe(false);
	});
});

describe('persistImageBytes', () => {
	it('writes under forge/refs/ with a sniffed extension and content type', async () => {
		const body = Buffer.from([...JPEG_SIG, 9, 9, 9]);
		const url = await persistImageBytes(body);
		const call = putObject.mock.calls[0][0];
		expect(call.key).toMatch(/^forge\/refs\/[0-9a-f-]+\.jpg$/);
		expect(call.contentType).toBe('image/jpeg');
		expect(Buffer.compare(call.body, body)).toBe(0);
		expect(url).toBe(`https://cdn.example.com/${call.key}`);
	});

	it('keeps png labeling for non-JPEG payloads', async () => {
		const body = Buffer.from([...PNG_SIG, 9, 9, 9]);
		await persistImageBytes(body);
		const call = putObject.mock.calls[0][0];
		expect(call.key).toMatch(/\.png$/);
		expect(call.contentType).toBe('image/png');
	});
});

describe('persistImageBase64', () => {
	it('decodes base64 and persists the decoded bytes', async () => {
		const body = Buffer.from([...PNG_SIG, 1, 2, 3, 4]);
		await persistImageBase64(body.toString('base64'));
		const call = putObject.mock.calls[0][0];
		expect(Buffer.compare(call.body, body)).toBe(0);
	});
});
