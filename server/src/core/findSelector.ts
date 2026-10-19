import { Position } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Selector } from "../types";
import { findJSXSelector } from "./jsxSelectors";
import { findPugSelector } from "./pugSelectors";
import { findHTMLSelector, htmlSelectorRanges } from "./htmlSelectors";

const javascriptLanguages = new Set([
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
]);
const razorLanguages = new Set(["razor", "aspnetcorerazor", "cshtml"]);

/** Find a literal class/id or native tag at the cursor, using its host syntax. */
export default function findSelector(
  document: TextDocument,
  position: Position,
  settings: { supportTags: boolean },
): Selector | null {
  const offset = document.offsetAt(position);
  if (javascriptLanguages.has(document.languageId))
    return findJSXSelector(document, offset, settings.supportTags);
  if (document.languageId === "pug" || document.languageId === "jade")
    return findPugSelector(document, offset, settings.supportTags);

  const source = document.getText();
  if (document.languageId === "twig")
    return findTwigSelector(source, offset, settings.supportTags);
  const text = razorLanguages.has(document.languageId)
    ? maskRazorCode(source)
    : source;
  return findHTMLSelector(text, offset, settings.supportTags);
}

/** Hide Twig code/comments while keeping literal surrounding markup usable. */
function findTwigSelector(
  source: string,
  offset: number,
  supportTags: boolean,
): Selector | null {
  const pieces: string[] = [];
  const openings = /\{[{%#]/g;
  const marker = "\uE000";
  let previousEnd = 0;
  for (
    let match = openings.exec(source);
    match;
    match = openings.exec(source)
  ) {
    const opening = match[0];
    const closing = opening === "{{" ? "}}" : opening === "{%" ? "%}" : "#}";
    let end = openings.lastIndex;
    let quote = "";
    while (end < source.length) {
      const character = source[end]!;
      if (quote) {
        if (character === "\\") end++;
        else if (character === quote) quote = "";
      } else if (source.startsWith(closing, end)) {
        end += closing.length;
        break;
      } else if (opening !== "{#" && (character === '"' || character === "'"))
        quote = character;
      end++;
    }
    pieces.push(
      source.slice(previousEnd, match.index),
      source
        .slice(match.index, end)
        .replace(/[^\r\n]/g, opening === "{{" ? marker : " "),
    );
    previousEnd = end;
    openings.lastIndex = end;
  }
  const markup = pieces.length
    ? pieces.join("") + source.slice(previousEnd)
    : source;
  for (const range of htmlSelectorRanges(markup)) {
    if (range.start > offset) break;
    if (
      offset <= range.end &&
      !range.selector.value.includes(marker) &&
      (range.selector.attribute !== null || supportTags)
    )
      return range.selector;
  }
  return null;
}

/** Preserve offsets while hiding Razor comments and dedicated C# code blocks. */
function maskRazorCode(text: string): string {
  const regions: string[] = [];
  const markers = /@\*|@(?:code|functions)\b\s*\{/g;
  let previousEnd = 0;
  for (let match = markers.exec(text); match; match = markers.exec(text)) {
    const start = match.index;
    let end: number;
    if (match[0] === "@*") {
      const closing = text.indexOf("*@", markers.lastIndex);
      end = closing < 0 ? text.length : closing + 2;
    } else {
      end = markers.lastIndex;
      let depth = 1;
      while (end < text.length && depth > 0) {
        const character = text[end++];
        if (character === '"' || character === "'") {
          const verbatim = character === '"' && text[end - 2] === "@";
          while (end < text.length) {
            const next = text[end++];
            if (!verbatim && next === "\\") end++;
            else if (next === character) {
              if (verbatim && text[end] === '"') end++;
              else break;
            }
          }
        } else if (character === "/" && text[end] === "/") {
          const newline = text.indexOf("\n", end + 1);
          end = newline < 0 ? text.length : newline;
        } else if (character === "/" && text[end] === "*") {
          const closing = text.indexOf("*/", end + 1);
          end = closing < 0 ? text.length : closing + 2;
        } else if (character === "{") depth++;
        else if (character === "}") depth--;
      }
    }
    regions.push(
      text.slice(previousEnd, start),
      text.slice(start, end).replace(/[^\r\n]/g, " "),
    );
    previousEnd = end;
    markers.lastIndex = end;
  }
  return regions.length ? regions.join("") + text.slice(previousEnd) : text;
}
