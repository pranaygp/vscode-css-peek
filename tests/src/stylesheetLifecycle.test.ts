import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { TextDocument as ServerTextDocument } from "vscode-languageserver";

import { findDefinition } from "../../server/out/core/findDefinition";
import { create } from "../../server/out/logger";
import type { Stylesheet, StylesheetMap, Selector } from "../../server/src/types";

// This test mirrors the *logic* of the cssPeek/stylesheetCreated and
// cssPeek/stylesheetDeleted handlers (load -> confirm peek -> delete entry ->
// confirm peek empty); it does not invoke the server handlers directly.
// Cross-check `server/src/server.ts` `loadStylesheet` if behavior changes.
function loadStylesheet(map: StylesheetMap, file: Stylesheet): void {
  const document = ServerTextDocument.create(
    file.uri,
    file.languageId,
    1,
    file.text
  );
  map[file.uri] = { document };
}

const utf8Decoder = new TextDecoder("utf-8");

suite("Stylesheet create/delete lifecycle", () => {
  create(console as any);

  test("removes deleted stylesheets from peek results", async () => {
    const map: StylesheetMap = {};

    // 1. Create a temporary CSS fixture file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "css-peek-test-"));
    const fsPath = path.join(tmpDir, "ephemeral.css");
    fs.writeFileSync(fsPath, ".ephemeral-class { color: rebeccapurple; }\n");
    const uri = vscode.Uri.file(fsPath);

    try {
      // Simulate the client reading the file and pushing the payload to the
      // server via cssPeek/stylesheetCreated.
      const bytes = await vscode.workspace.fs.readFile(uri);
      const stylesheet: Stylesheet = {
        uri: uri.toString(),
        languageId: "css",
        text: utf8Decoder.decode(bytes),
      };
      loadStylesheet(map, stylesheet);

      // 2. Confirm peek finds a symbol in it
      const selector: Selector = {
        attribute: "class",
        value: "ephemeral-class",
      };
      const before = findDefinition(selector, map);
      assert.strictEqual(
        before.length,
        1,
        "Expected to find the class before deletion"
      );
      assert.strictEqual(before[0].uri, uri.toString());

      // 3. Delete the fixture from disk + prune the server's cache
      // (this is what the cssPeek/stylesheetDeleted notification handler does)
      fs.unlinkSync(fsPath);
      delete map[uri.toString()];

      // 4. Confirm peek no longer finds the symbol
      const after = findDefinition(selector, map);
      assert.strictEqual(
        after.length,
        0,
        "Expected no results after stylesheet deletion"
      );
    } finally {
      if (fs.existsSync(fsPath)) {
        fs.unlinkSync(fsPath);
      }
      fs.rmdirSync(tmpDir);
    }
  });
});
