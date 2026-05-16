import * as path from "path";
import { Location, SymbolInformation } from "vscode-languageserver/node";
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
      "Document type is " + document.languageId + ", using css instead."
    );
    service = languageServices["css"];
  }
  return service;
}

// Escape regex meta-chars in a selector value. For chars that CSS requires
// to be backslash-escaped inside identifiers (`:` and `/`, used by Tailwind
// for variants and arbitrary-value modifiers), accept an optional backslash
// in the compiled stylesheet so e.g. `.md\:flex` matches the source class
// `md:flex` from HTML.
function escapeSelectorForRegex(value: string): string {
  let out = "";
  for (const ch of value) {
    if (ch === ":" || ch === "/") {
      out += "\\\\?\\" + ch;
    } else if (/[.*+?^${}()|[\]\\]/.test(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function resolveSymbolName(symbols: SymbolInformation[], i: number): string {
  const name = symbols[i].name;
  if (name.startsWith("&")) {
    return resolveSymbolName(symbols, i - 1) + name.slice(1);
  }
  return name;
}

export function findSymbols(
  selector: Selector,
  stylesheetMap: StylesheetMap,
  options: {
    peekVariables?: boolean;
    embeddedStylesheetMap?: StylesheetMap;
  } = {}
): SymbolInformation[] {
  const { peekVariables = true, embeddedStylesheetMap = {} } = options;
  const foundSymbols: SymbolInformation[] = [];

  // Merge the persistent stylesheet cache with any in-memory embedded
  // stylesheets (e.g. `<style>` blocks in HTML/Vue). The persistent cache
  // wins on key collision; embedded entries always use fragment-suffixed
  // keys so collisions don't happen in practice.
  const combinedMap: StylesheetMap = {
    ...embeddedStylesheetMap,
    ...stylesheetMap,
  };

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
  // contain CSS-escaped chars like `\:` or `\/` (Tailwind).
  selection +=
    "(\\[[^\\]]*\\]|:{1,2}[\\w-()]+|\\.[\\w\\\\:/-]+|#[\\w\\\\:/-]+)*\\s*";

  // This regular expression will be used to test the symbol
  const symbolRegexp = new RegExp(
    selection + "$",
    classOrIdSelector ? "" : "i"
  );
  // This regular expression will be used to test if file should even be parsed
  // in the first place
  const fileRegexp = new RegExp(selection, classOrIdSelector ? "" : "i");

  // Test all the symbols against the RegExp
  Object.keys(combinedMap).forEach((uri) => {
    const styleSheet = combinedMap[uri];
    try {
      let symbols: SymbolInformation[];
      if (styleSheet.symbols) {
        // use the cached value
        symbols = styleSheet.symbols;
      } else {
        // The document symbols haven't been extracted and cached yet.
        // Let's first do a dumb check to see if the document even has the text we need in the first place
        // if it doesn't, then we don't need to bother extrating and caching any symbols at all
        const text = styleSheet.document.getText();
        if (text.search(fileRegexp) === -1) return;
        console.log(`Parsing ${path.basename(uri)}`);

        // Looks like it does. Now, let's go ahead and actually get the symbols + cache the symbols for the future
        const languageService = getLanguageService(styleSheet.document);
        const stylesheet = languageService.parseStylesheet(styleSheet.document);
        symbols = styleSheet.symbols = languageService.findDocumentSymbols(
          styleSheet.document,
          stylesheet
        );
      }

      console.log(`${path.basename(uri)} has ${symbols.length} symbols`);
      console.log(`Searching through them all for /${selection}/`);

      symbols.forEach((symbol, i) => {
        if (!peekVariables && symbol.kind === SymbolKind.Variable) {
          return;
        }
        const name = resolveSymbolName(symbols, i);

        // console.log(
        //   `  ${symbol.location.range.start.line}:${
        //     symbol.location.range.start.character
        //   } ${symbol.deprecated ? "[deprecated] " : " "}${
        //     symbol.containerName ? `[container:${symbol.containerName}] ` : " "
        //   } [${symbol.kind}] ${name}`
        // );

        if (name.search(symbolRegexp) !== -1) {
          foundSymbols.push(symbol);
        } else if (!classOrIdSelector) {
          // Special case for tag selectors - match "*" as the rightmost character
          if (/\*\s*$/.test(name)) {
            foundSymbols.push(symbol);
          }
        }
      });

      console.log(`Done`);
    } catch (e) {
      console.log(e.stack);
    }
  });

  return foundSymbols;
}

export function findDefinition(
  selector: Selector,
  stylesheetMap: StylesheetMap,
  options: {
    peekVariables?: boolean;
    embeddedStylesheetMap?: StylesheetMap;
  } = {}
): Location[] {
  return findSymbols(selector, stylesheetMap, options).map(
    ({ location }) => location
  );
}
