import { Position } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  Scanner,
  getLanguageService as getHTMLLanguageService,
  TokenType,
} from "vscode-html-languageservice";

import { console } from "./../logger";
/**
 * Find the selector given the document and the current cursor position.
 * This is found by iterating forwards and backwards from the position to find a valid CSS class/id
 *
 * @param {vscode.TextDocument} document - The Document to check
 * @param {vscode.Position} position - The current cursor position
 * @returns {{attribute: string, value: string}} The valid CSS selector
 *
 * @memberOf PeekFileDefinitionProvider
 */
export default function findSelector(
  document: TextDocument,
  position: Position,
  settings: { supportTags: boolean }
): { attribute: string; value: string } {
  const text = document.getText();
  const offset = document.offsetAt(position);

  let start = offset;
  let end = offset;

  // expand selection to this word specifically
  while (
    start > 0 &&
    text.charAt(start - 1) !== " " &&
    text.charAt(start - 1) !== "'" &&
    text.charAt(start - 1) !== '"' &&
    text.charAt(start - 1) !== "\n" &&
    text.charAt(start - 1) !== "/" &&
    text.charAt(start - 1) !== "<"
  )
    start -= 1;

  while (
    end < text.length &&
    text.charAt(end) !== " " &&
    text.charAt(end) !== "'" &&
    text.charAt(end) !== '"' &&
    text.charAt(end) !== "\n" &&
    text.charAt(end) !== ">"
  )
    end += 1;
  const selectorWord = text.slice(start, end);

  let selector = null;
  const htmlScanner: Scanner = getHTMLLanguageService().createScanner(text);
  let attribute: string = null;

  console.log(`${selectorWord} ${start}`);
  let tokenType = htmlScanner.scan();
  while (tokenType !== TokenType.EOS) {
    switch (tokenType) {
      case TokenType.StartTag:
      case TokenType.EndTag: {
        attribute = null;

        if (!settings.supportTags) {
          break;
        }

        // FOR DEBUGGING
        console.log(
          `  ${htmlScanner.getTokenText()} ${htmlScanner.getTokenOffset()} ${htmlScanner.getTokenEnd()}`
        );
        const tokenOffset = htmlScanner.getTokenOffset();

        if (
          [
            "javascript",
            "typescript",
            "javascriptreact",
            "typescriptreact",
          ].includes(document.languageId)
        ) {
          if (
            selectorWord[0] &&
            selectorWord[0].toUpperCase() === selectorWord[0]
          ) {
            // if the first letter is uppercase, this is a JSX component
            break;
          }
        }

        if (start === tokenOffset)
          selector = { attribute: null, value: selectorWord };
        break;
      }
      case TokenType.AttributeName:
        attribute = htmlScanner.getTokenText().toLowerCase();

        // Convert the attribute to a standard class attribute
        if (attribute === "classname") {
          attribute = "class";
        }

        break;
      case TokenType.AttributeValue:
        // FOR DEBUGGING
        // console.log(
        //   `${htmlScanner.getTokenText()} ${htmlScanner.getTokenOffset()} ${htmlScanner.getTokenEnd()}`
        // );
        if (attribute === "class" || attribute === "id") {
          const values = htmlScanner.getTokenText().slice(1, -1).split(" ");

          // calculate startOffsets for each class/id in this attribute
          // +1 because we sliced earlier, so the first offset is the offset + 1
          let startOffset = htmlScanner.getTokenOffset() + 1;
          const offsets = values.map((v) => {
            const o = startOffset;
            startOffset += v.length + 1; // add 1 for the space
            return o;
          });
          values.forEach((value, i) => {
            const startOffset = offsets[i];

            // FOR DEBUGGING
            // console.log(`  ${value} ${startOffset}`);
            if (start === startOffset) {
              selector = { attribute, value };
            }
          });
        }
        break;
    }
    if (selector) {
      break;
    }
    tokenType = htmlScanner.scan();
  }

  if (selector) {
    console.log(`${selector.value} is a "${selector.attribute || "html tag"}"`);
  } else {
    console.log("Invalid Selector");
  }

  return selector;
}
