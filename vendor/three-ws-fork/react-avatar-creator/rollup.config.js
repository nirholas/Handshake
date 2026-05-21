const typescript = require('@rollup/plugin-typescript');
const { default: dts } = require('rollup-plugin-dts');
const packageJson = require('./package.json');

// rollup.config.js
module.exports = [
  {
    input: 'src/index.tsx',
    output: [
      {
        file: packageJson.main,
        format: 'cjs',
        sourcemap: false,
      },
      {
        file: packageJson.module,
        format: 'esm',
        sourcemap: false,
      },
    ],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
      }),
    ],
    external: ['react'],
  },
  {
    input: 'src/index.tsx',
    output: [{ file: 'dist/index.d.ts' }],
    plugins: [dts()],
  },
];
