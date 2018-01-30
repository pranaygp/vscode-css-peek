import {
  Position, TextDocument
} from 'vscode-languageserver';
import { Scanner, getLanguageService as getHTMLLanguageService, TokenType } from 'vscode-html-languageservice';

import { console } from './../logger';
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
export default function findSelector(document: TextDocument, position: Position): {attribute: string, value: string} {

  const text = document.getText();
  const offset = document.offsetAt(position);

  let start = offset;
  let end = offset;

  let delimeters = [' ', '\'', '"', '\n', '<']

  while (start > 0 && delimeters.indexOf(text.charAt(start - 1)) === -1) {
    start -= 1
  }
  
  while (end < text.length && delimeters.indexOf(text.charAt(end)) === -1) {
    end += 1
  }

  const selectorWord = text.slice(start, end);

  let selector = null;
  const htmlScanner: Scanner = getHTMLLanguageService().createScanner(text);
  let attribute: string = null;

  let tokenType = htmlScanner.scan();
  while (tokenType !== TokenType.EOS) {
    switch (tokenType) {
      case TokenType.StartTag:
        attribute = null;
        if (selectorWord === htmlScanner.getTokenText())
          selector = {attribute: null, value: selectorWord};
        break;
      case TokenType.AttributeName:
        attribute = htmlScanner.getTokenText().toLowerCase();
        break;
      case TokenType.AttributeValue:
        if (attribute === 'class' || attribute === 'id') {
          if (htmlScanner.getTokenText().slice(1, -1).split(' ').indexOf(selectorWord) > -1) {
            selector = { attribute, value: selectorWord }
          }
        }
        break;
    }
    tokenType = htmlScanner.scan();
  }

  if (selector) {
    console.log("Found CSS selector of type " + selector.attribute + " and value " + selector.value);
  } else {
    console.log("Invalid Selector...");
  }

  return selector;
}
