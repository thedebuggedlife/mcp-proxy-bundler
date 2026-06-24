// Per-image semantic-release config, parameterized by MCP_NAME (design Appendix B.1).
// One run per MCP: tagFormat gives each image an independent semver lineage, and
// commit-analyzer releaseRules route by conventional-commit scope so a shared
// proxy/node bump versions every image while an MCP bump versions only its own.
// Release rules live in a separate, unit-tested helper (test/unit/release-rules.test.ts).
import { releaseRulesFor } from './scripts/lib/release-rules.ts'

const name = process.env.MCP_NAME
if (!name) {
  throw new Error('MCP_NAME env var is required to select the per-image release config')
}

export default {
  branches: ['main'],
  tagFormat: `mcp-${name}-v\${version}`,
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'angular',
        releaseRules: releaseRulesFor(name),
      },
    ],
    [
      '@semantic-release/exec',
      {
        // Composite Release body aggregates the changed input's upstream notes
        // (Appendix B.4) instead of the commit list. GIT_RANGE scopes the
        // upstream-bump commit lookup to this release.
        generateNotesCmd:
          'NEXT_RELEASE_VERSION=${nextRelease.version} GIT_RANGE=${lastRelease.gitTag || ""}..${nextRelease.gitHead} node scripts/release-notes-from-commits.ts',
        // Build + push only when a release is produced — semantic-release is the
        // "did the version change" gate (Finding 6 / Appendix B.1).
        publishCmd: 'bash scripts/release-image.sh ${nextRelease.version}',
      },
    ],
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        labels: false,
      },
    ],
  ],
}
