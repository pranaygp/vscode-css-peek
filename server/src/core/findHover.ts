import { Hover, MarkupKind } from "vscode-languageserver";

import { Selector, StylesheetMap } from "../types";
import { findSymbols } from "./findDefinition";

const MAX_LINES = 20;

export function findHover(
  selector: Selector,
  stylesheetMap: StylesheetMap,
  options: {
    peekVariables?: boolean;
    embeddedStylesheetMap?: StylesheetMap;
    allowedUris?: Set<string>;
    sourceUri?: string;
  } = {},
): Hover | null {
  const symbols = findSymbols(selector, stylesheetMap, options);
  if (symbols.length === 0) {
    return null;
  }

  const symbol = symbols[0];
  const styleSheet =
    stylesheetMap[symbol.location.uri] ||
    Object.values(options.embeddedStylesheetMap || {}).find(
      (entry) =>
        entry.document.uri === symbol.location.uri &&
        entry.document.getText(symbol.location.range).trim().length > 0,
    );
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
