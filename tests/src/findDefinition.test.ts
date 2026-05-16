import * as assert from "assert";
import * as vscode from "vscode";
import {
  SymbolInformation,
  SymbolKind,
  TextDocument as ServerTextDocument,
} from "vscode-languageserver";

import {
  findDefinition,
  findSymbols,
} from "../../server/out/core/findDefinition";
import { create } from "../../server/out/logger";
import type { StylesheetMap, Selector } from "../../server/src/types";

async function loadStylesheets(files: string[]): Promise<StylesheetMap> {
  const map: StylesheetMap = {};
  for (const file of files) {
    const vscodeDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, file)
    );
    const text = vscodeDoc.getText();
    const serverDoc = ServerTextDocument.create(
      vscodeDoc.uri.toString(),
      vscodeDoc.languageId,
      vscodeDoc.version,
      text
    );
    map[serverDoc.uri] = { document: serverDoc };
  }
  return map;
}

suite("findDefinition", () => {
  create(console as any);
  let map: StylesheetMap;
  suiteSetup(async () => {
    map = await loadStylesheets([
      "stylesheet.css",
      "example.less",
      "example.scss",
      "my_style.scss",
      "extendFailureCase.less",
    ]);
  });

  test("finds class selector definitions", () => {
    const selector: Selector = { attribute: "class", value: "test" };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 3);
    const files = defs
      .map((d) => vscode.Uri.parse(d.uri).path.split("/").pop())
      .sort();
    assert.deepStrictEqual(
      files,
      ["example.scss", "stylesheet.css", "stylesheet.css"].sort()
    );
  });

  test("finds id selector definitions across files", () => {
    const selector: Selector = { attribute: "id", value: "test-2" };
    const defs = findDefinition(selector, map).sort((a, b) =>
      a.uri.localeCompare(b.uri)
    );
    assert.strictEqual(defs.length, 3);
    const files = defs.map((d) =>
      vscode.Uri.parse(d.uri).path.split("/").pop()
    );
    assert.deepStrictEqual(
      files.sort(),
      ["example.less", "example.scss", "stylesheet.css"].sort()
    );
  });

  test("finds tag selector definitions", () => {
    const selector: Selector = { attribute: null as any, value: "h1" };
    const defs = findDefinition(selector, map).sort(
      (a, b) => a.range.start.line - b.range.start.line
    );
    assert.strictEqual(defs.length, 4);
    const lines = defs.map((d) => d.range.start.line);
    assert.deepStrictEqual(lines, [0, 16, 16, 19]);
  });

  test("peekVariables toggle filters Variable-kind symbols", () => {
    // Pre-populate the symbol cache with a Variable symbol whose name would
    // otherwise match the selector. Isolates the filter from the language
    // service's name resolution (preprocessor variables like `$foo` don't
    // normally match HTML class/id/tag regexes).
    const uri = "file:///__test_variables.scss";
    const doc = ServerTextDocument.create(uri, "scss", 1, "");
    const variableSymbol: SymbolInformation = {
      name: ".test",
      kind: SymbolKind.Variable,
      location: {
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      },
    };
    const buildMap = (): StylesheetMap => ({
      [uri]: { document: doc, symbols: [variableSymbol] },
    });
    const selector: Selector = { attribute: "class", value: "test" };

    assert.strictEqual(
      findSymbols(selector, buildMap(), { peekVariables: true }).length,
      1,
      "variable should be included when peekVariables=true"
    );
    assert.strictEqual(
      findSymbols(selector, buildMap()).length,
      1,
      "variable should be included when option is omitted (default true)"
    );
    assert.strictEqual(
      findSymbols(selector, buildMap(), { peekVariables: false }).length,
      0,
      "variable should be filtered when peekVariables=false"
    );
  });

  test("peekVariables=false does not filter non-variable symbols", async () => {
    const localMap = await loadStylesheets(["stylesheet.css"]);
    const selector: Selector = { attribute: "class", value: "test" };
    const defs = findDefinition(selector, localMap, { peekVariables: false });
    assert.ok(
      defs.length > 0,
      "class selectors should still resolve when peekVariables=false"
    );
  });
});
