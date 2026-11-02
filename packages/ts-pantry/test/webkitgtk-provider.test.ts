// craft-native.org's Linux artifact could not be published: its binary links
// seven libraries the recipe never provided, and ELF normalization refused it.
// Three of those sonames belong to a WebKit API that had no owner in the
// catalog at all, so a dependency declaration alone could not have fixed it.
// These tests pin the provider's identity and the closure that must exist.

import { describe, expect, it } from 'bun:test'
import { recipeDepsToSpecs } from '../src/dependency-spec'
import { pantry } from '../src/packages'
import { recipe as craft } from '../src/recipes/craft-native.org'
import { recipe as webkitgtk } from '../src/recipes/webkitgtk.org'

const cmakeArgs = (webkitgtk.build?.env?.CMAKE_ARGS ?? []) as string[]
const byDomain = new Map(Object.values(pantry).map(entry => [(entry as any).domain, entry as any]))

describe('the WebKitGTK provider owns the API craft actually links', () => {
  it('selects the GTK3 4.1 API rather than the GTK4 6.0 default', () => {
    // OptionsGTK.cmake defaults USE_GTK4 ON, which produces webkitgtk-6.0.
    // Only USE_GTK4=OFF yields WEBKITGTK_API_INFIX "2" and so the
    // libwebkit2gtk-4.1 / libjavascriptcoregtk-4.1 sonames craft needs.
    expect(cmakeArgs).toContain('-DUSE_GTK4=OFF')
    expect(cmakeArgs).toContain('-DPORT=GTK')
  })

  it('is not a WPE or GTK4 substitute', () => {
    expect(webkitgtk.domain).toBe('webkitgtk.org')
    expect(webkitgtk.domain).not.toContain('wpewebkit')
    expect(JSON.stringify(webkitgtk.dependencies)).not.toContain('wpewebkit')
    expect(JSON.stringify(webkitgtk.dependencies)).not.toContain('gtk4')
  })

  it('ships the helper processes and injected bundle its libraries spawn', () => {
    // libwebkit2gtk does not render in-process: it execs WebKitWebProcess and
    // WebKitNetworkProcess from PKGLIBEXECDIR and dlopens the injected bundle.
    // A consumer that bundles only the .so gets a library that fails on the
    // first page it creates.
    expect(webkitgtk.runtimeResources).toEqual([
      'libexec/webkit2gtk-4.1',
      'lib/webkit2gtk-4.1/injected-bundle',
    ])
  })

  it('builds only where the GTK3 stack is published', () => {
    expect(webkitgtk.platforms).toEqual(['linux/x86-64'])
  })
})

describe('the provider only claims a closure the catalog can satisfy', () => {
  it('disables GStreamer itself, not merely video and web audio', () => {
    // GStreamerChecks.cmake guards on USE_GSTREAMER and then calls
    // find_package(GStreamer REQUIRED COMPONENTS app pbutils) with app and
    // pbutils listed unconditionally — ENABLE_VIDEO=OFF alone still fails
    // configure. Pantry publishes gstreamer.freedesktop.org/orc and no
    // GStreamer core, so the subsystem is off until those recipes exist.
    expect(cmakeArgs).toContain('-DUSE_GSTREAMER=OFF')
    expect(cmakeArgs).toContain('-DENABLE_VIDEO=OFF')
    expect(cmakeArgs).toContain('-DENABLE_WEB_AUDIO=OFF')
    expect(JSON.stringify(webkitgtk.dependencies)).not.toContain('gstreamer')
  })

  it('turns off every feature whose provider the catalog lacks', () => {
    // Each has a find_package ... FATAL_ERROR in OptionsGTK.cmake and no
    // provider here: Enchant, libhyphen, libmanette, libdrm/GBM.
    for (const flag of ['-DENABLE_SPELLCHECK=OFF', '-DUSE_LIBHYPHEN=OFF', '-DENABLE_GAMEPAD=OFF', '-DUSE_LIBDRM=OFF', '-DUSE_GBM=OFF'])
      expect(cmakeArgs).toContain(flag)
  })

  it('requires libsoup3, which is what the 4.1 API is', () => {
    // 2.54 calls find_package(Soup3 3.0.0 REQUIRED) unconditionally; the
    // libsoup2 API 4.0 variant is gone.
    expect((webkitgtk.dependencies as any)['libsoup.org']).toBe('^3')
  })

  it('names only domains that exist in the catalog', () => {
    const declared = Object.keys(webkitgtk.dependencies ?? {})
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.filter(domain => !byDomain.has(domain))).toEqual([])
  })
})

describe("craft declares its Linux runtime closure and nothing on Darwin", () => {
  const specs = recipeDepsToSpecs(craft.dependencies as any)

  it('covers each unresolved library through its owning provider', () => {
    // libgtk-3 / libgdk-3 → gtk3; libglib-2.0 / libgobject-2.0 / libgio-2.0 →
    // glib; libwebkit2gtk-4.1 / libjavascriptcoregtk-4.1 → webkitgtk.
    expect(specs).toEqual([
      'linux:gtk.org/gtk3^3.24',
      'linux:gnome.org/glib^2',
      'linux:webkitgtk.org^2.54',
    ])
  })

  it('adds nothing on Darwin, which uses the system WebKit framework', () => {
    expect(specs.every(spec => spec.startsWith('linux:'))).toBe(true)
    expect(specs.some(spec => spec.startsWith('darwin'))).toBe(false)
  })

  it('points every declared provider at a real catalog entry', () => {
    for (const spec of specs) {
      const domain = spec.slice('linux:'.length).replace(/[@^~<>=].*$/, '')
      expect(byDomain.get(domain)).toBeDefined()
    }
  })
})
