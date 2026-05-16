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
import { extractEmbeddedStylesheets } from "../../server/out/core/embeddedStyles";
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

suite("findDefinition with embedded <style> blocks", () => {
  create(console as any);

  async function loadHostDoc(file: string) {
    const vscodeDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, file)
    );
    return ServerTextDocument.create(
      vscodeDoc.uri.toString(),
      vscodeDoc.languageId,
      vscodeDoc.version,
      vscodeDoc.getText()
    );
  }

  test("finds class defined in a <style> block of the same HTML file", async () => {
    const hostDoc = await loadHostDoc("example.html");
    const embedded = extractEmbeddedStylesheets(hostDoc);
    assert.ok(Object.keys(embedded).length > 0, "should find a <style> block");

    const selector: Selector = { attribute: "class", value: "embedded-class" };
    const defs = findDefinition(selector, {}, { embeddedStylesheetMap: embedded });

    assert.strictEqual(defs.length, 1);
    // The returned location should reference the host HTML file (peek
    // navigates the user to the embedded <style> region in the original
    // file, not to some synthetic URI).
    assert.strictEqual(defs[0].uri, hostDoc.uri);

    // Verify the location points at the actual `.embedded-class` rule by
    // grabbing the slice of host text at the returned range.
    const text = hostDoc.getText();
    const startOffset = hostDoc.offsetAt(defs[0].range.start);
    assert.ok(
      text.slice(startOffset).startsWith(".embedded-class"),
      `expected text at definition to start with ".embedded-class", got: ${text.slice(
        startOffset,
        startOffset + 40
      )}`
    );
  });

  test("finds id defined in a <style> block of the same HTML file", async () => {
    const hostDoc = await loadHostDoc("example.html");
    const embedded = extractEmbeddedStylesheets(hostDoc);

    const selector: Selector = { attribute: "id", value: "embedded-id" };
    const defs = findDefinition(selector, {}, { embeddedStylesheetMap: embedded });

    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].uri, hostDoc.uri);
    const startOffset = hostDoc.offsetAt(defs[0].range.start);
    assert.ok(hostDoc.getText().slice(startOffset).startsWith("#embedded-id"));
  });

  test("returns nothing for non-html/vue documents", async () => {
    const cssDoc = await loadHostDoc("stylesheet.css");
    const embedded = extractEmbeddedStylesheets(cssDoc);
    assert.deepStrictEqual(embedded, {});
  });
});
