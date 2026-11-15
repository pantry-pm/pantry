import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'plantuml.com',
  name: 'plantuml',
  description: 'Generate diagrams from textual description',
  homepage: 'https://plantuml.com/',
  github: 'https://github.com/plantuml/plantuml',
  programs: ['plantuml'],
  versionSource: {
    type: 'github-releases',
    repo: 'plantuml/plantuml',
    // `v1.2026.4-native` releases carry GraalVM native images, not the jar this
    // recipe installs; they are a second artifact of 1.2026.4, not a version.
    tagPattern: /^v(\d+\.\d+\.\d+)$/,
  },
  distributable: {
    url: 'https://github.com/plantuml/plantuml/archive/v{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'graphviz.org': '*',
    'openjdk.org': '*',
  },

  build: {
    script: [
      // The catalog never prunes, so the `-native` entries already in it keep
      // being selected. Those releases publish no plantuml-<version>.jar.
      'case "{{version}}" in *-native) echo "plantuml {{version}} is a native-image release with no jar" >&2; exit 42 ;; esac',
      // curl, not wget: the wget dependency has no CA bundle configured in the
      // build environment and refused github.com's certificate.
      'curl -fL -o plantuml-{{version}}.jar https://github.com/plantuml/plantuml/releases/download/v{{version}}/plantuml-{{version}}.jar',
      'mkdir -p {{prefix}}/libexec',
      'install plantuml-{{version}}.jar {{prefix}}/libexec/',
      'cat <<EOS > plantuml',
      '#!/bin/bash',
      'if [[ "\\$*" != *"-gui"* ]]; then',
      '  VMARGS="-Djava.awt.headless=true"',
      'fi',
      'GRAPHVIZ_DOT="\\$DOT_BIN" exec "\\$JAVA_BIN" \\$VMARGS -jar "\\$PLANTUML_JAR" "\\$@"',
      'EOS',
      '',
      'mkdir -p {{prefix}}/bin',
      'install plantuml {{prefix}}/bin/plantuml',
    ],
  },
}
