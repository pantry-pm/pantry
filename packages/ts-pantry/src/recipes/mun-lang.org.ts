import type { Recipe } from '../../scripts/recipe-types'

export const recipe: Recipe = {
  domain: 'mun-lang.org',
  platforms: ['darwin', 'linux/x86-64'],
  name: 'mun',
  description: 'Source code for the Mun language and runtime.',
  homepage: 'https://mun-lang.org',
  github: 'https://github.com/mun-lang/mun',
  programs: ['mun'],
  versionSource: {
    type: 'github-releases',
    repo: 'mun-lang/mun',
    stable: false,
  },
  distributable: {
    url: 'https://github.com/mun-lang/mun/archive/refs/tags/{{version.tag}}.tar.gz',
    stripComponents: 1,
  },

  dependencies: {
    'invisible-island.net/ncurses': '6',
    'sourceware.org/libffi': '3',
    'gnome.org/libxml2': '2',
  },
  // The toolchain is declared only for the releases it can build, so the
  // versions refused below do not download Rust and LLVM just to be refused.
  dependencyOverrides: [{
    if: '>=0.5.0',
    buildDependencies: {
      'rust-lang.org': '^1.74.1',
      'rust-lang.org/cargo': '*',
      // inkwell is built with its llvm14-0 feature; no other major links.
      'llvm.org': '^14',
    },
  }],

  build: {
    script: [
      // 0.5.0 is the first release on LLVM 14. 0.4.0 pins inkwell to LLVM 13
      // and 0.3.0 to LLVM 11 (crates/mun_codegen/Cargo.toml), which this
      // toolchain does not provide. Report those as having no buildable source
      // rather than fail the publish on them.
      {
        run: 'echo "mun {{version}} predates LLVM 14 and cannot be built with this toolchain" >&2; exit 42',
        if: '<0.5.0',
      },
      'cargo install --path crates/mun --root {{prefix}} --locked',
    ],
  },
}
