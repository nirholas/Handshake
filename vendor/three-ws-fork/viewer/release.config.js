module.exports = {
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'angular',
        releaseRules: [
          { type: 'feat', scope: 'anim', release: 'minor' },
          { type: 'fix', release: 'patch' },
          { type: 'BREAKING CHANGE', release: 'major' }
        ]
      }
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/npm',
    '@semantic-release/github'
  ]
};
