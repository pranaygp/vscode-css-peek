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

function getSelection(selector: Selector): string {
  switch (selector.attribute) {
    case "id":
      return "#" + selector.value;
    case "class":
      return "." + selector.value;
    default:
      return selector.value;
  }
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
  stylesheetMap: StylesheetMap
): SymbolInformation[] {
  const foundSymbols: SymbolInformation[] = [];

  // Construct RegExp of selector to test against the symbols
  let selection = getSelection(selector);
  const classOrIdSelector =
    selector.attribute === "class" || selector.attribute === "id";
  if (selection[0] === ".") {
    selection = "\\" + selection;
  }
  if (!classOrIdSelector) {
    // Tag selectors must have nothing, whitespace, or a combinator before it.
    selection = "(^|[\\s>+~])" + selection;
  }

  selection += "(\\[[^\\]]*\\]|:{1,2}[\\w-()]+|\\.[\\w-]+|#[\\w-]+)*\\s*";

  // This regular expression will be used to test the symbol
  const symbolRegexp = new RegExp(
    selection + "$",
    classOrIdSelector ? "" : "i"
  );
  // This regular expression will be used to test if file should even be parsed
  // in the first place
  const fileRegexp = new RegExp(selection, classOrIdSelector ? "" : "i");

  // Test all the symbols against the RegExp
  Object.keys(stylesheetMap).forEach((uri) => {
    const styleSheet = stylesheetMap[uri];
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
  stylesheetMap: StylesheetMap
): Location[] {
  return findSymbols(selector, stylesheetMap).map(({ location }) => location);
}
