const commonjs = require('@rollup/plugin-commonjs')

export default {
  input: 'src/utils/exports.js',
  output: {
    dir: 'lib',
    format: 'cjs',
  },
  plugins: [commonjs()],
}
