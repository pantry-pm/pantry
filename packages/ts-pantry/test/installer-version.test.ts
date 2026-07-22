import { describe, expect, it } from 'bun:test'
import {
  compareInstallerVersionsDesc,
  parseInstallerConstraint,
  resolveInstallerConstraintFromCandidates,
  satisfiesInstallerConstraint,
} from '../src/installer'

describe('installer version constraints', () => {
  it('preserves prerelease metadata while parsing', () => {
    expect(parseInstallerConstraint('^0.17.0-dev')).toEqual({ operator: '^', target: '0.17.0-dev' })
    expect(parseInstallerConstraint('>=0.17.0-dev.1417+20befa4e6')).toEqual({
      operator: '>=',
      target: '0.17.0-dev.1417+20befa4e6',
    })
    expect(parseInstallerConstraint('latest')).toBeNull()
  })

  it('selects the newest matching Zig development build', () => {
    const versions = [
      '0.16.0',
      '0.17.0-dev.131+73c51c142',
      '0.17.0-dev.1417_20befa4e6',
      '0.17.0-dev.1441_d5181a9c9',
    ]
    expect(resolveInstallerConstraintFromCandidates('^0.17.0-dev', versions)).toBe('0.17.0-dev.1441_d5181a9c9')
    expect([...versions].sort(compareInstallerVersionsDesc)[0]).toBe('0.17.0-dev.1441_d5181a9c9')
  })

  it('keeps stable constraints separate from prereleases', () => {
    const stable = parseInstallerConstraint('^0.17.0')!
    const development = parseInstallerConstraint('^0.17.0-dev')!
    expect(satisfiesInstallerConstraint('0.17.0-dev.1441_d5181a9c9', stable)).toBe(false)
    expect(satisfiesInstallerConstraint('0.17.0-dev.1441_d5181a9c9', development)).toBe(true)
    expect(satisfiesInstallerConstraint('0.18.0-dev.1_deadbeef', development)).toBe(false)
  })

  it('implements caret boundaries for zero-major versions', () => {
    expect(satisfiesInstallerConstraint('0.15.9', parseInstallerConstraint('^0.15.1')!)).toBe(true)
    expect(satisfiesInstallerConstraint('0.16.0', parseInstallerConstraint('^0.15.1')!)).toBe(false)
    expect(satisfiesInstallerConstraint('0.0.4', parseInstallerConstraint('^0.0.3')!)).toBe(false)
  })
})
