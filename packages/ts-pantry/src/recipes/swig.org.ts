import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'swig.org',
  name: 'swig',
  description: 'SWIG is a software development tool that connects programs written in C and C++ with a variety of high-level programming languages.',
  homepage: 'https://www.swig.org/',
  github: 'https://github.com/swig/swig',
  programs: ['swig', 'ccache-swig'],
  versionSource: {
    type: 'github-tags',
    repo: 'swig/swig',
  },
  distributable: {
    url: 'https://downloads.sourceforge.net/project/swig/swig/swig-{{version}}/swig-{{version}}.tar.gz',
    stripComponents: 1,
  },
  dependencies: {
    'pcre.org/v2': '*',
  },
  runtime: {
    env: { SWIG_LIB: '{{prefix}}/lib' },
  },

  build: {
    script: [
      './configure --prefix={{prefix}} --with-swiglibdir={{prefix}}/lib',
      'make --jobs {{hw.concurrency}}',
      'make install',
      '',
    ],
  },
  test: {
    required: true,
    script: [
      '"{{prefix}}/bin/swig" -version',
      'test -f "$("{{prefix}}/bin/swig" -swiglib)/swig.swg"',
      `cat > probe.i <<'PANTRY_SWIG'
%module pantry_swig_probe
%inline %{
int answer(void) {
  return 42;
}
%}
PANTRY_SWIG`,
      '"{{prefix}}/bin/swig" -python -o probe_wrap.c probe.i',
      'test -s probe_wrap.c',
      'test -s pantry_swig_probe.py',
    ],
  },
}
