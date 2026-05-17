import { SymbolInformation } from "vscode-css-languageservice";
import { TextDocument } from "vscode-languageserver-textdocument";

export type StylesheetMap = {
  [uri: string]: {
    document: TextDocument;
    symbols?: SymbolInformation[];
  };
};

// A stylesheet payload passed from the client during LSP initialization.
// The client reads file contents via `vscode.workspace.fs.readFile`
// (which works in virtual/web workspaces) and ships them to the server, so
// the server never needs to touch the host file system itself.
export type Stylesheet = {
  /**
   * The actual Uri string representation
   */
  readonly uri: string;

  /**
   * The language id of the stylesheet (e.g. "css", "scss", "less").
   */
  readonly languageId: string;

  /**
   * The full text content of the stylesheet.
   */
  readonly text: string;
};

export type Selector = { attribute: string; value: string };
