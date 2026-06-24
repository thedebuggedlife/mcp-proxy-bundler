// @semantic-release/commit-analyzer ships no types; declare the one function the
// release-rules behavioral test uses.
declare module '@semantic-release/commit-analyzer' {
  export function analyzeCommits(
    pluginConfig: { preset?: string; releaseRules?: unknown[] },
    context: {
      commits: { hash: string; message: string }[]
      logger: { log: (...args: unknown[]) => void }
      cwd: string
    },
  ): Promise<string | null>
}
