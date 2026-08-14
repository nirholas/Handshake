import { describe, it, expect } from 'vitest';
import {
	truncate,
	resolveGateway,
	normalizeDasAsset,
	agencStatusLabel,
	agencActive,
} from '../api/_lib/solana-agents-normalize.js';
import { remainingMs, withDeadline } from '../api/_lib/solana-agents-crawl.js';

describe('solana-agents-crawl helpers', () => {
	describe('truncate', () => {
		it('trims and caps length, nulling empties', () => {
			expect(truncate('  hi  ', 10)).toBe('hi');
			expect(truncate('abcdef', 3)).toBe('abc');
			expect(truncate('   ', 10)).toBe(null);
			expect(truncate(null, 10)).toBe(null);
			expect(truncate(undefined, 10)).toBe(null);
		});
	});

	describe('resolveGateway', () => {
		it('rewrites ipfs:// to a https gateway', () => {
			expect(resolveGateway('ipfs://bafyhash')).toBe('https://ipfs.io/ipfs/bafyhash');
			expect(resolveGateway('ipfs://ipfs/bafyhash')).toBe('https://ipfs.io/ipfs/bafyhash');
		});
		it('rewrites ar:// to arweave', () => {
			expect(resolveGateway('ar://txid123')).toBe('https://arweave.net/txid123');
		});
		it('treats a bare CID as ipfs', () => {
			const cid = 'QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR';
			expect(resolveGateway(cid)).toBe(`https://ipfs.io/ipfs/${cid}`);
		});
		it('leaves http(s) URLs untouched and nulls empties', () => {
			expect(resolveGateway('https://example.com/a.json')).toBe('https://example.com/a.json');
			expect(resolveGateway('')).toBe(null);
			expect(resolveGateway(null)).toBe(null);
		});
	});

	describe('normalizeDasAsset', () => {
		it('extracts image, glb, owner and metadata from a DAS result', () => {
			const out = normalizeDasAsset({
				content: {
					json_uri: 'https://meta.example/agent.json',
					metadata: { name: 'Astra', description: 'A trading agent' },
					links: { image: 'https://cdn.example/astra.png' },
					files: [
						{ mime: 'image/png', uri: 'https://cdn.example/astra.png' },
						{ mime: 'model/gltf-binary', uri: 'https://cdn.example/astra.glb' },
					],
				},
				ownership: { owner: 'OwnerPubkey1111' },
			});
			expect(out).toEqual({
				name: 'Astra',
				description: 'A trading agent',
				image: 'https://cdn.example/astra.png',
				glb_url: 'https://cdn.example/astra.glb',
				metadata_uri: 'https://meta.example/agent.json',
				owner: 'OwnerPubkey1111',
			});
		});

		it('falls back to a files[] image when links.image is absent', () => {
			const out = normalizeDasAsset({
				content: { metadata: {}, files: [{ mime: 'image/jpeg', uri: 'https://x/y.jpg' }] },
			});
			expect(out.image).toBe('https://x/y.jpg');
			expect(out.glb_url).toBe(null);
		});

		it('detects a GLB by file extension when mime is generic', () => {
			const out = normalizeDasAsset({
				content: { metadata: {}, files: [{ mime: 'application/octet-stream', uri: 'https://x/model.glb?v=2' }] },
			});
			expect(out.glb_url).toBe('https://x/model.glb?v=2');
		});

		it('returns null for a missing result', () => {
			expect(normalizeDasAsset(null)).toBe(null);
			expect(normalizeDasAsset(undefined)).toBe(null);
		});
	});

	describe('agencStatusLabel', () => {
		it('maps numeric status codes', () => {
			expect(agencStatusLabel(0)).toBe('pending');
			expect(agencStatusLabel(1)).toBe('active');
			expect(agencStatusLabel(2)).toBe('inactive');
			expect(agencStatusLabel(3)).toBe('suspended');
		});
		it('decodes an Anchor enum object', () => {
			// camelCase variant key falls through to the string passthrough
			expect(agencStatusLabel({ active: {} })).toBe('active');
			// numeric-keyed variant resolves via the code table
			expect(agencStatusLabel({ 1: {} })).toBe('active');
		});
		it('passes through unknown string codes and nulls junk', () => {
			expect(agencStatusLabel('weird')).toBe('weird');
			expect(agencStatusLabel(99)).toBe(null);
		});
	});

	// Registry enumeration (getProgramAccounts / Anchor .all()) takes no timeout of
	// its own, so the crawl budget is only real if these two enforce it. A 2026-08-14
	// audit run measured the cron at 272s against its declared 240s budget, inside
	// 48s of Cloud Scheduler's 320s attempt deadline.
	describe('remainingMs', () => {
		it('falls back to the scan budget when no deadline is set', () => {
			expect(remainingMs(undefined, 5_000)).toBe(5_000);
			expect(remainingMs(null, 5_000)).toBe(5_000);
		});
		it('reports the time left, going negative once the deadline has passed', () => {
			expect(remainingMs(Date.now() + 10_000)).toBeGreaterThan(9_000);
			expect(remainingMs(Date.now() - 1_000)).toBeLessThan(0);
		});
	});

	describe('withDeadline', () => {
		it('returns the value when the call finishes in time', async () => {
			await expect(withDeadline(Promise.resolve('scanned'), 1_000, 'gpa-v2')).resolves.toBe('scanned');
		});

		it('rejects with the budget label once the call overruns', async () => {
			const hang = new Promise(() => {});
			await expect(withDeadline(hang, 10, 'gpa-v2')).rejects.toThrow(/gpa-v2: exceeded its 0s budget/);
		});

		it('refuses to start a scan with no budget left', async () => {
			await expect(withDeadline(Promise.resolve('x'), 0, 'agenc account scan'))
				.rejects.toThrow(/no time left in the crawl budget/);
			await expect(withDeadline(Promise.resolve('x'), -5_000, 'agenc account scan'))
				.rejects.toThrow(/no time left in the crawl budget/);
		});

		it('surfaces the underlying failure unchanged when the call loses to nothing', async () => {
			await expect(withDeadline(Promise.reject(new Error('504 Gateway Timeout')), 1_000, 'gpa-v1'))
				.rejects.toThrow('504 Gateway Timeout');
		});

		// A scan that finishes after the timer fired must settle quietly. Left
		// unhandled it would take the whole instance down long after the cron
		// already returned its report.
		it('swallows a rejection that lands after the budget expired', async () => {
			const unhandled = [];
			const onUnhandled = (err) => unhandled.push(err);
			process.on('unhandledRejection', onUnhandled);
			try {
				const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late 504')), 30));
				await expect(withDeadline(late, 5, 'gpa-v2')).rejects.toThrow(/exceeded its/);
				await new Promise((r) => setTimeout(r, 80));
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
			expect(unhandled).toEqual([]);
		});
	});
});
