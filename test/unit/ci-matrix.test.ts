import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverMcps } from '../../scripts/discover-mcps.ts'

describe('ci matrix discovery', () => {
  it('discovers the real mcps/ directory', () => {
    expect(discoverMcps()).toEqual(['hevy', 'todoist'])
  })

  describe('with a synthetic mcps dir', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'mcps-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('lists only dirs containing mcp.yaml, sorted', () => {
      for (const name of ['todoist', 'hevy']) {
        mkdirSync(join(dir, name))
        writeFileSync(join(dir, name, 'mcp.yaml'), 'name: x\n')
      }
      // a directory without mcp.yaml is ignored
      mkdirSync(join(dir, 'incomplete'))
      // a stray file at the top level is ignored
      writeFileSync(join(dir, '.gitkeep'), '')

      expect(discoverMcps(dir)).toEqual(['hevy', 'todoist'])
    })

    it('returns an empty array for an empty dir', () => {
      expect(discoverMcps(dir)).toEqual([])
    })

    it('returns an empty array for a missing dir', () => {
      expect(discoverMcps(join(dir, 'does-not-exist'))).toEqual([])
    })
  })
})
