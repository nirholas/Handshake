#!/usr/bin/env node
// Generate the square AWS Marketplace product logo from the brand mark.
//
// AMMP requires a square PNG, 120–640px per side. The repo's og-image.png is
// 1200×630 (wrong aspect), so we render public/pwa-icon.svg centered on a black
// canvas (matching the brand / EULA background) at 512×512.
//
// Usage: node scripts/gen-aws-logo.mjs

import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'public/pwa-icon.svg');
const OUT = join(root, 'public/aws-logo-512.png');
const SIZE = 512;
const INNER = 384; // mark inset, leaving even padding inside the square

const mark = await sharp(readFileSync(SRC), { density: 300 })
	.resize(INNER, INNER, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
	.png()
	.toBuffer();

await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
	.composite([{ input: mark, gravity: 'center' }])
	.png()
	.toFile(OUT);

const meta = await sharp(OUT).metadata();
console.log(`Wrote ${OUT} (${meta.width}x${meta.height} ${meta.format})`);
