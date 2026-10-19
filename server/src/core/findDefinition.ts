import { Location, SymbolInformation } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  getCSSLanguageService,
  getSCSSLanguageService,
  getLESSLanguageService,
  LanguageService,
  SymbolKind,
} from "vscode-css-languageservice";

import { Selector, StylesheetMap } from "../types";
import { console } from "./../logger";

const languageServices: { [id: string]: LanguageService } = {
  css: getCSSLanguageService(),
  scss: getSCSSLanguageService(),
  less: getLESSLanguageService(),
};

export function isLanguageServiceSupported(serviceId: string) {
  return !!languageServices[serviceId];
}

export function getLanguageService(document: TextDocument) {
  let service = languageServices[document.languageId];
  if (!service) {
    console.log(
      "Document type is " + document.languageId + ", using css instead.",
    );
    service = languageServices["css"];
  }
  return service;
}

// Escape regex meta-chars in a selector value. For chars that CSS requires
// to be backslash-escaped inside identifiers (`:` and `/`, used by Tailwind
// for variants and arbitrary-value modifiers), accept an optional backslash
// in the compiled stylesheet so e.g. `.md\:flex` matches the source class
// `md:flex` from HTML. `:` and `/` are not regex meta-chars, so they are
// emitted unescaped — important under the `u` flag, where identity escapes
// of non-syntax chars are a SyntaxError.
function escapeSelectorForRegex(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === ":" || ch === "/") {
      out += "\\\\?" + ch;
    } else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

const symbolNames = new WeakMap<SymbolInformation[], string[]>();

function resolvedSymbolNames(symbols: SymbolInformation[]): string[] {
  const cached = symbolNames.get(symbols);
  if (cached) return cached;
  const parents: number[] = [];
  const names: string[] = [];
  const compare = (
    left: { line: number; character: number },
    right: { line: number; character: number },
  ) => left.line - right.line || left.character - right.character;
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    while (parents.length) {
      const parent = symbols[parents[parents.length - 1]];
      if (
        compare(parent.location.range.start, symbol.location.range.start) < 0 &&
        compare(parent.location.range.end, symbol.location.range.end) >= 0
      )
        break;
      parents.pop();
    }
    const name = symbol.name;
    names[i] =
      name.startsWith("&") && parents.length
        ? names[parents[parents.length - 1]] + name.slice(1)
        : name;
    parents.push(i);
  }
  symbolNames.set(symbols, names);
  return names;
}

export function findSymbols(
  selector: Selector,
  stylesheetMap: StylesheetMap,
  options: {
    peekVariables?: boolean;
    embeddedStylesheetMap?: StylesheetMap;
    allowedUris?: Set<string>;
    sourceUri?: string;
  } = {},
): SymbolInformation[] {
  const {
    peekVariables = true,
    embeddedStylesheetMap = {},
    allowedUris,
    sourceUri,
  } = options;
  const foundSymbols: SymbolInformation[] = [];

  // Construct RegExp of selector to test against the symbols
  const classOrIdSelector =
    selector.attribute === "class" || selector.attribute === "id";
  const escapedValue = escapeSelectorForRegex(selector.value);
  let selection: string;
  switch (selector.attribute) {
    case "id":
      selection = "#" + escapedValue;
      break;
    case "class":
      selection = "\\." + escapedValue;
      break;
    default:
      // Tag selector — value is a tag name, no escaping of special CSS chars needed.
      selection = "(^|[\\s>+~])" + escapedValue;
      break;
  }

  // Suffix matcher: allow chained selectors, including class/id names that
  // contain CSS-escaped chars like `\:` or `\/` (Tailwind) and non-ASCII
  // identifier characters (e.g. `.foo.café`). The `u` flag enables Unicode
  // property escapes (`\p{L}`, `\p{N}`) so identifier chars beyond ASCII
  // `\w` are matched too.
  const identChars = "[\\p{L}\\p{N}_\\\\:/-]";
  // Pseudo-class chars must not place `\w` adjacent to `-` (interpreted as
  // a range under the `u` flag). Put `-` at the end of the class instead.
  selection +=
    "(\\[[^\\]]*\\]|:{1,2}[\\w()-]+|\\." +
    identChars +
    "+|#" +
    identChars +
    "+)*\\s*";

  // This regular expression will be used to test the symbol
  const symbolRegexp = new RegExp(
    selection + "$",
    classOrIdSelector ? "u" : "iu",
  );
  // This regular expression will be used to test if file should even be parsed
  // in the first place
  const fileRegexp = new RegExp(selection, classOrIdSelector ? "u" : "iu");

  // Test all the symbols against the RegExp
  const search = (map: StylesheetMap, embedded: boolean) =>
    Object.keys(map).forEach((uri) => {
      const isolated = /\.(?:razor|cshtml)\.css$/i.test(uri);
      const ownIsolated =
        isolated && sourceUri !== undefined && uri === sourceUri + ".css";
      if (sourceUri && isolated && !ownIsolated) return;
      if (
        (!embedded && allowedUris && !allowedUris.has(uri) && !ownIsolated) ||
        (selector.moduleUri && selector.moduleUri !== uri)
      )
        return;
      // Persistent entries take precedence without allocating a merged cache.
      if (embedded && stylesheetMap[uri]) return;
      const styleSheet = map[uri];
      try {
        let symbols: SymbolInformation[];
        if (styleSheet.symbols) {
          // use the cached value
          symbols = styleSheet.symbols;
        } else {
          // Avoid parsing unrelated files. SCSS/LESS parent references can
          // compose names absent from the source text (e.g. `.card` + `&__title`).
          const text = styleSheet.document.getText();
          if (
            text.search(fileRegexp) === -1 &&
            !(
              classOrIdSelector &&
              /^(?:scss|less)$/.test(styleSheet.document.languageId) &&
              text.includes("&")
            )
          )
            return;
          const languageService = getLanguageService(styleSheet.document);
          const stylesheet = languageService.parseStylesheet(
            styleSheet.document,
          );
          symbols = styleSheet.symbols = languageService.findDocumentSymbols(
            styleSheet.document,
            stylesheet,
          );
        }

        const names = resolvedSymbolNames(symbols);
        symbols.forEach((symbol, i) => {
          if (!peekVariables && symbol.kind === SymbolKind.Variable) {
            return;
          }
          const name = names[i];

          if (name.search(symbolRegexp) !== -1) {
            foundSymbols.push(symbol);
          } else if (!classOrIdSelector) {
            // Special case for tag selectors - match "*" as the rightmost character
            if (/\*\s*$/.test(name)) {
              foundSymbols.push(symbol);
            }
          }
        });
      } catch (e) {
        console.log(e instanceof Error ? e.stack || e.message : String(e));
      }
    });
  search(embeddedStylesheetMap, true);
  search(stylesheetMap, false);

  return foundSymbols;
}

export function findDefinition(
  selector: Selector,
  stylesheetMap: StylesheetMap,
  options: {
    peekVariables?: boolean;
    embeddedStylesheetMap?: StylesheetMap;
    allowedUris?: Set<string>;
    sourceUri?: string;
  } = {},
): Location[] {
  return findSymbols(selector, stylesheetMap, options).map(
    ({ location }) => location,
  );
}
