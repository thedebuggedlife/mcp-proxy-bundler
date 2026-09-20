import { buildMeta } from './lib/build-meta.ts'

function main(): void {
  const name = process.argv[2]
  if (!name) {
    process.stderr.write('Usage: mcp-meta.ts <mcp-name>\n')
    process.exit(2)
  }

  for (const [key, value] of Object.entries(buildMeta(name))) {
    process.stdout.write(`${key}=${value}\n`)
  }
}

main()
