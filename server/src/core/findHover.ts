import { Hover, MarkupKind } from "vscode-languageserver/node";

import { Selector, StylesheetMap } from "../types";
import { findSymbols } from "./findDefinition";

const MAX_LINES = 20;

export function findHover(
  selector: Selector,
  stylesheetMap: StylesheetMap,
  options?: { peekVariables?: boolean }
): Hover | null {
  const symbols = findSymbols(selector, stylesheetMap, options);
  if (symbols.length === 0) {
    return null;
  }

  const symbol = symbols[0];
  const styleSheet = stylesheetMap[symbol.location.uri];
  if (!styleSheet) {
    return null;
  }

  const source = styleSheet.document.getText(symbol.location.range);
  const lines = source.split(/\r?\n/);
  const truncated = lines.length > MAX_LINES;
  const snippet = (truncated ? lines.slice(0, MAX_LINES) : lines).join("\n");
  const suffix = truncated ? "\n/* … */" : "";

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: "```css\n" + snippet + suffix + "\n```",
    },
  };
}
