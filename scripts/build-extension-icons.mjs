// scripts/build-extension-icons.mjs — generate extension icons from the SVG source.
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgSrc = join(__dirname, '..', 'public', 'pwa-icon.svg');
const outDir = join(__dirname, '..', 'extensions', 'walk-avatar', 'icons');

mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 128];

const svgBuf = readFileSync(svgSrc);

await Promise.all(sizes.map((size) =>
	sharp(svgBuf)
		.resize(size, size)
		.png()
		.toFile(join(outDir, `icon-${size}.png`))
		.then(() => console.log(`✓ icon-${size}.png`))
));

console.log('Extension icons generated.');
