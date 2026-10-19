![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/pranaygp.vscode-css-peek?logo=visualstudiocode)
![Visual Studio Marketplace Version (including pre-releases)](https://img.shields.io/visual-studio-marketplace/v/pranaygp.vscode-css-peek?logo=visualstudiocode)
[![Open VSX](https://img.shields.io/badge/Open%20VSX-vscode--css--peek-purple)](https://open-vsx.org/extension/pranaygp/vscode-css-peek)

# 🔍 CSS Peek

Find CSS, SCSS, and Less definitions from HTML, React JSX/TSX, Vue, Svelte, Razor, Pug, and HTML-like templates. CSS Peek runs in desktop VS Code and VS Code for the Web, including virtual workspaces. Requires VS Code 1.91 or newer.

This was heavily inspired by a similar feature in [Brackets](http://brackets.io/) called CSS Inline Editors.

![working](https://github.com/pranaygp/vscode-css-peek/raw/master/readme/working.gif)

The extension supports all the normal capabilities of symbol definition tracking, but does it for css selectors (classes, IDs and HTML tags). This includes:

- Peek: load the css file inline and make quick edits right there. (`Ctrl+Shift+F12`)
- Go To: jump directly to the css file or open it in a new editor (`F12`)
- Hover: show the definition in a hover over the symbol (`Ctrl+hover`)

In addition, it supports the Symbol Provider so you can quickly jump to the right CSS/SCSS/LESS code if you already know the class or ID name (You need to enter atleast 2 characters for this to work. This command can take a few seconds if you have large stylesheets)

![Symbol Provider](https://github.com/pranaygp/vscode-css-peek/raw/master/readme/symbolProvider.gif)

## Supported syntax

- HTML-like `class` and `id` attributes, including multiline and unquoted values.
- JSX strings, literal expressions, static branches, `clsx`/`classnames` arguments, and members of imported CSS modules. Dynamic values and CSS-in-JS runtime styles are not evaluated.
- Pug shorthand classes and IDs and HTML-style Pug attributes.
- Same-file `<style>` blocks in HTML and Vue, including `lang="scss"` and `lang="less"`.
- Independent project roots in a multi-root workspace. Stylesheets from another project root are excluded.

CSS Peek navigates to existing selectors; it does not generate CSS for utility classes or download remote stylesheets. Styles must exist in the opened workspace or an embedded style block.

To reuse an already-open CSS editor, set VS Code's `workbench.editor.revealIfOpen` to `true`. VS Code controls editor placement and Go to Definition shortcuts.

## Configuration

- `cssPeek.enable` - Enable or disable CSS Peek without reloading the window.
- `cssPeek.supportTags` - Enable Peeking from HTML tags in addition to classnames and IDs. React components are ignored, but it's a good idea to disable this feature when using Angular.
- `cssPeek.peekFromLanguages` - A list of vscode language names where the extension should be used.
- `cssPeek.peekToExclude` - Exclude stylesheet globs. Defaults skip dependency folders, build output, coverage, and Git internals.
- `cssPeek.respectGitignore` - Merge the root `.gitignore` into stylesheet exclusions (default `true`). Nested ignore files and negated patterns are not supported.
- `cssPeek.peekToLinkedOnly` - Restrict results to stylesheets directly linked or imported by the source file (default `false`). Embedded styles remain available. This does not resolve bundler aliases, package imports, or transitive imports.
- `cssPeek.peekVariables` - Include preprocessor variable symbols (default `true`).
- `cssPeek.trace.server` - Set to `verbose` when collecting diagnostics in Output → CSS Peek.
- `cssPeek.enableTelemetry` - Send anonymous usage data and error reports to help improve CSS Peek. Defaults to `true`. Set to `false` to opt out.

See editor docs for more details

- [Visual Studio Code: Goto Definition](https://code.visualstudio.com/docs/editor/editingevolved#_go-to-definition)
- [Visual Studio Code: Peek](https://code.visualstudio.com/docs/editor/editingevolved#_peek)
- [Visual Studio Code: Open Symbol By Name](https://code.visualstudio.com/Docs/editor/editingevolved#_open-symbol-by-name)

## Telemetry

CSS Peek collects anonymous usage data and error reports to help improve the extension. There are **two** ways to opt out:

1. **Disable for this extension only.** Set `"cssPeek.enableTelemetry": false` in your VSCode settings.
2. **Disable telemetry for all extensions.** Set VSCode's global `"telemetry.telemetryLevel": "off"` (see [VSCode telemetry docs](https://code.visualstudio.com/docs/configure/telemetry)). CSS Peek honors this setting automatically via `@vscode/extension-telemetry`.

Either setting will prevent CSS Peek from sending any telemetry events.

# Contributing

Use Node.js 24 and Yarn 1.22.22. Install with `yarn install --frozen-lockfile`, then run:

```sh
yarn build
yarn lint
yarn prettier
yarn test                # on Linux: xvfb-run -a yarn test
yarn test:web            # install Chromium first: npx playwright install chromium
yarn audit:dependencies
yarn package
yarn verify:package vscode-css-peek-4.5.0.vsix
```

CI runs the desktop integration suite on Linux, macOS, and Windows with current stable VS Code, tests the minimum supported editor, exercises the browser worker, audits the lockfile, and checks the packaged VSIX. The package contains bundled runtimes and can be installed without development dependencies.

To publish, pass the verified VSIX to `./publish.sh path/to/extension.vsix` with `VSCE_PAT` and `OVSX_PAT` supplied by your secret manager. This publishes the same archive to both registries without rebuilding it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes.
