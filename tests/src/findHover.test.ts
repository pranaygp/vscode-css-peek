import * as assert from "assert";
import * as vscode from "vscode";
import { TextDocument as ServerTextDocument } from "vscode-languageserver";

import { findHover } from "../../server/out/core/findHover";
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

suite("findHover", () => {
  create(console as any);
  let map: StylesheetMap;
  suiteSetup(async () => {
    map = await loadStylesheets(["stylesheet.css", "example.scss"]);
  });

  test("returns markdown hover with css source for a class selector", () => {
    const selector: Selector = { attribute: "class", value: "test" };
    const hover = findHover(selector, map);
    assert.ok(hover, "expected a hover result");
    const contents = hover!.contents as { kind: string; value: string };
    assert.strictEqual(contents.kind, "markdown");
    assert.match(contents.value, /^```css\n/);
    assert.match(contents.value, /\n```$/);
    assert.ok(
      contents.value.includes(".test"),
      `expected hover to include the selector body, got: ${contents.value}`
    );
  });

  test("returns markdown hover with css source for an id selector", () => {
    const selector: Selector = { attribute: "id", value: "testID" };
    const hover = findHover(selector, map);
    assert.ok(hover, "expected a hover result");
    const contents = hover!.contents as { kind: string; value: string };
    assert.ok(contents.value.includes("#testID"));
    assert.ok(contents.value.includes("color: green"));
  });

  test("returns null when no matching selector exists", () => {
    const selector: Selector = {
      attribute: "class",
      value: "this-class-does-not-exist-anywhere",
    };
    const hover = findHover(selector, map);
    assert.strictEqual(hover, null);
  });
});
