#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  convert,
  toMarkdown,
  checkMarkdownFile,
  GITHUB_MARKDOWN_LIMIT,
} from '../src/index.js';

const HELP = `readme-3d — put interactive 3D models in your GitHub README

Usage:
  readme-3d <model.(glb|gltf|stl|ast|obj)> [options]   convert a model
  readme-3d check <file.md>                            size-check a markdown file

Convert options:
  -o, --out <file>     write the markdown block to a file (default: stdout)
      --stl <file>     also write the raw ASCII STL to a file
      --facets <n>     max triangle count (default 1500)
      --budget <size>  max output size, e.g. 200kb (overrides --facets downward)
      --name <name>    solid name inside the STL (default: input filename)
      --precision <n>  coordinate decimals (default 2)
      --up <y|z>       source up-axis (default: y for glb/gltf/obj, z for stl)
      --details        wrap the block in a collapsed <details> section
      --no-normalize   keep original coordinates (skip rescale/grounding)
  -h, --help           show this help

Examples:
  npx readme-3d avatar.glb --budget 180kb >> README.md
  npx readme-3d part.stl --facets 800 -o part.md
  npx readme-3d check README.md
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    stl: { type: 'string' },
    facets: { type: 'string' },
    budget: { type: 'string' },
    name: { type: 'string' },
    precision: { type: 'string' },
    up: { type: 'string' },
    details: { type: 'boolean' },
    'no-normalize': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || positionals.length === 0) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 1);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

try {
  if (positionals[0] === 'check') {
    const file = positionals[1];
    if (!file) throw new Error('usage: readme-3d check <file.md>');
    const report = await checkMarkdownFile(file);
    console.log(`${file}: ${kb(report.bytes)} of ${kb(report.limit)} GitHub render limit`);
    report.stlBlocks.forEach((b, i) =>
      console.log(`  stl block ${i + 1}: ${b.facets} facets, ${kb(b.bytes)}`)
    );
    if (report.ok) {
      console.log(`OK — ${kb(report.headroom)} of headroom left.`);
    } else {
      console.error(
        `TOO BIG — GitHub will show this file as raw text. Trim ${kb(-report.headroom)} (lower --facets or --precision).`
      );
      process.exit(2);
    }
  } else {
    const input = positionals[0];
    const result = await convert(input, {
      facets: values.facets ? parseInt(values.facets, 10) : undefined,
      budget: values.budget,
      name: values.name ?? basename(input, extname(input)).replace(/[^\w-]/g, '_'),
      precision: values.precision ? parseInt(values.precision, 10) : undefined,
      up: values.up,
      normalize: !values['no-normalize'],
    });
    const markdown = toMarkdown(result.stl, { details: values.details });
    if (values.stl) await writeFile(values.stl, result.stl);
    if (values.out) {
      await writeFile(values.out, markdown);
    } else {
      process.stdout.write(markdown);
    }
    console.error(
      `${input}: ${result.sourceFacets} → ${result.facets} facets, ${kb(result.bytes)}` +
        (result.bytes > GITHUB_MARKDOWN_LIMIT / 2
          ? ` (large — run "readme-3d check" on the target file)`
          : '')
    );
    if (values.out) console.error(`wrote ${values.out}`);
    if (values.stl) console.error(`wrote ${values.stl}`);
  }
} catch (err) {
  console.error(`readme-3d: ${err.message}`);
  process.exit(1);
}
