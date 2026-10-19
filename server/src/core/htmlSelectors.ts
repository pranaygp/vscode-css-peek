import { getLanguageService, TokenType } from "vscode-html-languageservice";
import { Selector } from "../types";

export interface SelectorRange {
  start: number;
  end: number;
  selector: Selector;
}

const htmlLanguageService = getLanguageService();

/** Shared scanner for markup documents and recognizable framework templates. */
export function* htmlSelectorRanges(
  text: string,
): IterableIterator<SelectorRange> {
  const scanner = htmlLanguageService.createScanner(text);
  let attribute: string | null = null;
  for (
    let type = scanner.scan();
    type !== TokenType.EOS;
    type = scanner.scan()
  ) {
    const start = scanner.getTokenOffset();
    const end = scanner.getTokenEnd();
    switch (type) {
      case TokenType.StartTag:
      case TokenType.EndTag:
        attribute = null;
        yield {
          start,
          end,
          selector: { attribute: null, value: scanner.getTokenText() },
        };
        break;
      case TokenType.AttributeName: {
        const name = scanner.getTokenText().toLowerCase();
        attribute = name === "classname" ? "class" : name;
        break;
      }
      case TokenType.AttributeValue:
        if (attribute === "class" || attribute === "id") {
          const quote =
            text[start] === '"' || text[start] === "'" ? text[start] : "";
          const valueStart = start + (quote ? 1 : 0);
          const valueEnd = end - (quote && text[end - 1] === quote ? 1 : 0);
          for (const word of text
            .slice(valueStart, valueEnd)
            .matchAll(/\S+/g)) {
            const wordStart = valueStart + word.index!;
            yield {
              start: wordStart,
              end: wordStart + word[0].length,
              selector: { attribute, value: word[0] },
            };
          }
        }
        break;
    }
  }
}

export function findHTMLSelector(
  text: string,
  offset: number,
  supportTags: boolean,
): Selector | null {
  for (const range of htmlSelectorRanges(text)) {
    if (range.start > offset) break;
    if (
      offset <= range.end &&
      (range.selector.attribute !== null || supportTags)
    )
      return range.selector;
  }
  return null;
}
