import { URL } from "url";
import { TextDocument } from "vscode-languageserver-textdocument";

/**
 * Parse a source document for explicit stylesheet references and resolve them
 * to absolute URIs (string form).
 *
 * Supported syntaxes (intentionally simple string matching, not a full parser):
 *   - HTML / templating: <link rel="stylesheet" href="..."> (any attribute order)
 *   - JS / TS / JSX / TSX / Svelte / Vue: import './foo.css' / import "foo.css"
 *   - CSS / SCSS / LESS: @import 'foo.css' / @import url('foo.css')
 *
 * Limitations: no CSS-in-JS, no Sass `@use` / `@forward`, no dynamic imports,
 * no URL/module resolution through bundler aliases, no `<style src="...">`,
 * and no following of transitive `@import`s.
 */
export function findLinkedStylesheets(document: TextDocument): string[] {
  const text = document.getText();
  const baseUri = document.uri;
  const refs = new Set<string>();

  const addRef = (raw: string | undefined | null) => {
    if (!raw) return;
    const ref = raw.trim();
    if (!ref) return;
    const resolved = resolveStylesheetUri(baseUri, ref);
    if (resolved) refs.add(resolved);
  };

  // <link rel="stylesheet" href="...">  (rel and href can be in any order)
  const linkTagRe = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkTagRe.exec(text)) !== null) {
    const tag = linkMatch[0];
    if (!/\brel\s*=\s*["']?\s*stylesheet\b/i.test(tag)) continue;
    const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (hrefMatch) addRef(hrefMatch[2] ?? hrefMatch[3]);
  }

  // import './foo.css' / import "foo.scss" (also handles `import x from './foo.css'`)
  const importRe =
    /\bimport\b[^'";]*?["']([^"']+\.(?:css|scss|sass|less))["']/gi;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importRe.exec(text)) !== null) {
    addRef(importMatch[1]);
  }

  // @import 'foo.css' / @import url('foo.css') / @import url(foo.css)
  const atImportRe =
    /@import\s+(?:url\(\s*)?["']?([^"')\s;]+\.(?:css|scss|sass|less))["']?\s*\)?/gi;
  let atImportMatch: RegExpExecArray | null;
  while ((atImportMatch = atImportRe.exec(text)) !== null) {
    addRef(atImportMatch[1]);
  }

  return Array.from(refs);
}

/**
 * Resolve a stylesheet reference (as written in source) against the source
 * document's URI. Returns an absolute URI string, or null if it can't be
 * resolved (e.g. bare module imports like `import 'normalize.css'`).
 */
function resolveStylesheetUri(baseUri: string, ref: string): string | null {
  // Absolute URL (http://, https://, file://, vscode-resource:, etc.)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    try {
      return new URL(ref).toString();
    } catch {
      return null;
    }
  }

  // Protocol-relative URL — can't resolve without a host context.
  if (ref.startsWith("//")) return null;

  // Bare specifier (no leading ./ ../ /) — likely a node_modules import. Skip.
  if (!ref.startsWith("/") && !ref.startsWith("./") && !ref.startsWith("../")) {
    return null;
  }

  try {
    return new URL(ref, baseUri).toString();
  } catch {
    return null;
  }
}
