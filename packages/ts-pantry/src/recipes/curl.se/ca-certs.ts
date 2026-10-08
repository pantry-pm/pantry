import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'curl.se/ca-certs',
  name: 'ca-certs',
  programs: [],
  buildDependencies: {
    'curl.se': '*',
  },
  distributable: undefined,
  build: {
    script: [
      'mkdir -p {{prefix}}/ssl',
      // curl.se names bundles by zero-padded date (cacert-2026-03-19.pem); the
      // version is 2026.3.19. Unpadded, the URL 404'd and, without -f, curl
      // saved curl.se's HTML error page as the CA bundle, so every TLS
      // connection through pantry's OpenSSL failed verification. -k is gone
      // too: the certificates everything trusts are not fetched unverified.
      'URL_VER=$(printf "%04d-%02d-%02d" $(echo {{version.raw}} | tr . " "))',
      'curl -fsSL https://curl.se/ca/cacert-$URL_VER.pem -o {{prefix}}/ssl/cert.pem',
      'grep -q "BEGIN CERTIFICATE" {{prefix}}/ssl/cert.pem || { echo "cacert-$URL_VER.pem is not a certificate bundle" >&2; exit 1; }',
    ],
  },
  test: {
    script: [
      'test "$(grep -c "BEGIN CERTIFICATE" {{prefix}}/ssl/cert.pem)" -gt 100',
    ],
  },
}
