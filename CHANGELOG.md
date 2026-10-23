# Changelog

## 4.5.1 - 2026-10-22

- Replace retired Marketplace badges with a linked install badge, the current Open VSX version, and CI status.

## 4.5.0 - 2026-10-19

- Prevent duplicate language-server processes during concurrent document opens, workspace changes, failed startup, and shutdown.
- Isolate stylesheet discovery, document synchronization, and file watchers in multi-root workspaces.
- Refresh CSS when files change outside the editor, and discard deleted or ignored stylesheet definitions.
- Support JSX literal expressions, static `clsx`/`classnames` arguments, and imported CSS module members.
- Avoid incorrect CSS definitions for JavaScript comparisons, strings, comments, and TypeScript type arguments.
- Support Pug shorthand classes and IDs, multiline/unquoted HTML attributes, and Razor language aliases.
- Resolve and hover over embedded HTML/Vue CSS, including projects with no separate stylesheet files.
- Preserve HTML templates in Lit and Vue/Angular JavaScript, and handle nested SCSS BEM selectors.
- Add linked-stylesheet-only navigation, root `.gitignore` exclusions, variable filtering, and telemetry opt-out settings.
- Run the language server in a browser worker for VS Code for the Web and support virtual workspace filesystems.
- Bundle desktop and browser runtimes, update dependencies, and add security auditing and package validation.
- Test against current stable VS Code and the minimum supported VS Code 1.91 across desktop CI, plus browser integration tests.

## 4.4.0

- upgrade all dependncies

## 4.3.5

- add vscode.dev support (experimental)

## 4.3.4

- fix tests

## 4.3.2

- Improve performance by incrementally caching the stylesheets as and when needed

## 4.2.0

- Support VSCode Workspace Trust [#107](https://github.com/pranaygp/vscode-css-peek/issues/107)

## 4.1.1

- Add CodeStream Banner

## 3.0.2

- Use Globs for configuration options instead of RegExp via [#61](https://github.com/pranaygp/vscode-css-peek/pull/61) ❤ [@arch-stack](https://github.com/arch-stack)

## 2.2.0

- Initial JSX support via [#49](https://github.com/pranaygp/vscode-css-peek/pull/49) ❤ [@ReiMcCl](https://github.com/ReiMcCl)

## 2.1.1

- (Temporarily) fix bug [#19](https://github.com/pranaygp/vscode-css-peek/issues/18) by handling errors from `findDocumentSymbols`

## 2.1.0

- Add support for Symbol Provider [#18](https://github.com/pranaygp/vscode-css-peek/issues/18)
  > ![Symbol Provider](https://github.com/pranaygp/vscode-css-peek/raw/master/readme/symbolProvider.gif)

## 2.0.3

- Fix bug [#14](https://github.com/pranaygp/vscode-css-peek/issues/14) that caused CSS Peek to fail after any HTML comments

## 2.0.2

- Fix bug that limited the language support only to HTML. Now supports all languages provided by "activeLanguages" config

## 2.0.1

- Fix an error wherby the Overview was missing on the Visual Studio Marketplace

## 2.0.0

- A complete rewrite featuring the new [Language Server Protocol](https://github.com/Microsoft/language-server-protocol)
- Added scss support
- Added multi definition support (provides all CSS rules matching the selector)
- Added support for HTML tag selectors

## 1.3.3

- New Logo

## 1.3.0

- Add configuration option to ignore file from CSS lookup

## 1.2.4

- Crucial bug fix

## 1.2.3

- Workaround for bug if large number of files exist

## 1.2.2

- Better recognition of CSS selector word from cursor position
- Optimize code for fewer file lookups

## 1.2.1

- Fix README typo

## 1.2.0

- Add `less` support
- Configure search file extensions using "css_peek.searchFileExtensions"

## 1.1.0

- Update Icon

## 1.0.0

- Shamelessly copied code from [https://github.com/abierbaum/vscode-file-peek](https://github.com/abierbaum/vscode-file-peek)
