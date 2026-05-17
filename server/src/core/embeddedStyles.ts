import { TextDocument } from "vscode-languageserver-textdocument";
import {
  Scanner,
  getLanguageService as getHTMLLanguageService,
  TokenType,
} from "vscode-html-languageservice";

import { StylesheetMap } from "../types";

/**
 * Determines whether a source document may contain embedded `<style>` blocks
 * that this extension should also search for definitions.
 */
export function hasEmbeddedStyles(languageId: string): boolean {
  return languageId === "html" || languageId === "vue";
}

/**
 * Map a `<style lang="...">` attribute value to a language id our CSS
 * language services understand. Anything we don't recognise falls back to
 * plain CSS.
 */
function languageIdFromLangAttr(lang: string | null): string {
  if (!lang) return "css";
  const normalised = lang.toLowerCase();
  switch (normalised) {
    case "scss":
    case "sass":
      return "scss";
    case "less":
      return "less";
    case "css":
    case "postcss":
      return "css";
    default:
      return "css";
  }
}

/**
 * Replace every character of `source` outside of `[start, end)` with a space,
 * preserving newline characters so that line/column positions for content
 * within the embedded region match the parent document exactly.
 */
function maskOutside(source: string, start: number, end: number): string {
  // Only the *outside* regions need masking; the inner [start, end) slice is
  // copied verbatim. We mask each outside region with a single regex pass to
  // avoid per-character string concatenation.
  const mask = (s: string) => s.replace(/[^\n\r]/g, " ");
  return (
    mask(source.slice(0, start)) +
    source.slice(start, end) +
    mask(source.slice(end))
  );
}

/**
 * Extract every embedded `<style>` block in an HTML/Vue document and return a
 * `StylesheetMap` of virtual documents whose offsets match the host document.
 *
 * Each entry's URI carries a `#style-<index>` fragment so the cache key is
 * unique per block but still tied back to the host document URI.
 */
export function extractEmbeddedStylesheets(
  document: TextDocument
): StylesheetMap {
  if (!hasEmbeddedStyles(document.languageId)) {
    return {};
  }

  const text = document.getText();
  const scanner: Scanner = getHTMLLanguageService().createScanner(text);
  const result: StylesheetMap = {};

  let inStyleTag = false;
  let currentAttribute: string | null = null;
  let currentLang: string | null = null;
  let blockIndex = 0;

  let tokenType = scanner.scan();
  while (tokenType !== TokenType.EOS) {
    switch (tokenType) {
      case TokenType.StartTag: {
        const tagName = scanner.getTokenText().toLowerCase();
        inStyleTag = tagName === "style";
        currentAttribute = null;
        currentLang = null;
        break;
      }
      case TokenType.AttributeName: {
        currentAttribute = scanner.getTokenText().toLowerCase();
        break;
      }
      case TokenType.AttributeValue: {
        if (inStyleTag && currentAttribute === "lang") {
          // Strip surrounding quotes if present.
          const raw = scanner.getTokenText();
          currentLang = raw.replace(/^['"]|['"]$/g, "");
        }
        currentAttribute = null;
        break;
      }
      case TokenType.Styles: {
        if (!inStyleTag) break;
        const start = scanner.getTokenOffset();
        const end = scanner.getTokenEnd();
        const languageId = languageIdFromLangAttr(currentLang);
        const maskedText = maskOutside(text, start, end);
        // Use the host document URI on the embedded TextDocument so the
        // resulting SymbolInformation locations point back at the host file
        // (this is what makes peek/goto jump to the embedded `<style>` block
        // in the original document). The map key includes a fragment so the
        // cache slot stays distinct from the host's own entry (and from other
        // `<style>` blocks in the same document).
        const cacheKey = `${document.uri}#style-${blockIndex++}`;
        const embeddedDoc = TextDocument.create(
          document.uri,
          languageId,
          document.version,
          maskedText
        );
        result[cacheKey] = { document: embeddedDoc };
        break;
      }
      case TokenType.EndTag: {
        inStyleTag = false;
        currentAttribute = null;
        currentLang = null;
        break;
      }
    }
    tokenType = scanner.scan();
  }

  return result;
}
