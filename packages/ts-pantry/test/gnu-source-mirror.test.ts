import { expect, test } from 'bun:test'
import { sourceDownloadCandidates } from '../scripts/build-package'

test('GNU releases come through the mirror redirector first, ftp.gnu.org second', () => {
  expect(sourceDownloadCandidates('https://ftp.gnu.org/gnu/sed/sed-4.10.tar.gz'))
    .toEqual(['https://ftpmirror.gnu.org/sed/sed-4.10.tar.gz', 'https://ftp.gnu.org/gnu/sed/sed-4.10.tar.gz'])
  expect(sourceDownloadCandidates('http://ftp.gnu.org/pub/gnu/binutils/binutils-with-gold-2.46.tar.gz'))
    .toEqual(['https://ftpmirror.gnu.org/binutils/binutils-with-gold-2.46.tar.gz', 'http://ftp.gnu.org/pub/gnu/binutils/binutils-with-gold-2.46.tar.gz'])
  // Anything else is fetched exactly as written.
  expect(sourceDownloadCandidates('https://github.com/meta/zstd/archive/v1.5.7.tar.gz')).toEqual(['https://github.com/meta/zstd/archive/v1.5.7.tar.gz'])
  expect(sourceDownloadCandidates('https://alpha.gnu.org/gnu/foo/foo-1.0.tar.gz')).toEqual(['https://alpha.gnu.org/gnu/foo/foo-1.0.tar.gz'])
})
