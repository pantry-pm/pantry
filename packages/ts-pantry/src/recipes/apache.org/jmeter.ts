import type { Recipe } from '../../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'apache.org/jmeter',
  name: 'jmeter',
  programs: [
    'jmeter',
    'jmeter-server',
    'mirror-server',
  ],
  dependencies: {
    'openjdk.org': '*',
  },
  buildDependencies: {
    'gnu.org/wget': '*',
  },
  distributable: {
    url: 'https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-{{version.raw}}.tgz',
    stripComponents: 1,
  },
  build: {
    script: [
      'rm -r bin/*.bat bin/*.cmd',
      'mkdir -p {{prefix}}',
      'mv bin docs extras lib {{prefix}}/',
      "wget --no-check-certificate -O \"{{prefix}}/lib/ext/jmeter-plugins-manager-1.9.jar\" 'https://search.maven.org/remotecontent?filepath=kg/apc/jmeter-plugins-manager/1.9/jmeter-plugins-manager-1.9.jar'",
    ],
  },
  test: {
    script: [
      'cat $FIXTURE > test.jmx',
      "jmeter -n -t test.jmx | grep 'end of run'",
      'jmeter --version | grep {{version}}',
    ],
  },
}
