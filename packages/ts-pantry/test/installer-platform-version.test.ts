import { describe, expect, it } from 'bun:test'
import { registryVersionsForPlatform } from '../src/installer'

describe('registry platform version resolution', () => {
  const metadata = {
    versions: {
      '0.17.0-dev.1552_79dc16a0e': {
        platforms: {
          'darwin-arm64': {},
          'linux-x86-64': {},
        },
      },
      '0.17.0-dev.1564_97ced1272': {
        platforms: {
          'darwin-arm64': {},
        },
      },
    },
  }

  it('only returns versions published for the requested target', () => {
    expect(registryVersionsForPlatform(metadata, { os: 'linux', arch: 'x86_64' }))
      .toEqual(['0.17.0-dev.1552_79dc16a0e'])
  })

  it('uses the registry platform spelling for ARM targets', () => {
    expect(registryVersionsForPlatform(metadata, { os: 'darwin', arch: 'aarch64' }))
      .toEqual(['0.17.0-dev.1552_79dc16a0e', '0.17.0-dev.1564_97ced1272'])
  })
})
