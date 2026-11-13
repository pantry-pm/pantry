# Packing a package

`pantry pack` creates the archive used by Pantry's npm publisher without registry
lookups, authentication, or uploads.

```bash
pantry pack
pantry pack ./packages/library --filename ./artifacts/library.tgz --ignore-scripts
```

The default filename is the package name and version with a `.tgz` extension,
written in the current directory. `--filename` selects another output path.
A failed pack leaves an existing output archive intact.

The archive shares publication's manifest rewriting, file selection, ignore
rules, link targets, and executable modes. When packing a package from a
workspace root, missing README and license files come from that root. A
package's own documentation takes precedence. These files and executable
permissions are prepared in a private stage; packing does not add documents or
change executable permissions in the checkout.

Packing runs `prepack`, `prepare`, then `postpack`, following the
[npm packing lifecycle](https://docs.npmjs.com/using-npm/scripts.html/).
`postpack` runs after the archive snapshot is created. A failing hook stops the
pack. Use `--ignore-scripts` when consuming already built package artifacts;
this skips all three hooks.
