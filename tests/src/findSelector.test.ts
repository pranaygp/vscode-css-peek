import * as assert from "assert";
import * as vscode from "vscode";
import { TextDocument as ServerTextDocument } from "vscode-languageserver";

import findSelector from "../../server/out/core/findSelector";
import { create } from "../../server/out/logger";

type Docs = { vscodeDoc: vscode.TextDocument; serverDoc: ServerTextDocument; text: string };

async function loadDocument(file: string): Promise<Docs> {
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
  return { vscodeDoc, serverDoc, text };
}

suite("findSelector across fixtures", () => {
  create(console as any);
  const files = [
    { name: "example.html", classPrefix: "class=\"", idPrefix: "id=\"" },
    { name: "example.jsx", classPrefix: "className=\"", idPrefix: "id=\"" },
    { name: "test.php", classPrefix: "class=\"", idPrefix: "id=\"" },
  ];

  for (const file of files) {
    suite(file.name, () => {
      let docs: Docs;
      suiteSetup(async () => {
        docs = await loadDocument(file.name);
      });

      function pos(substr: string, offset = 0) {
        const idx = docs.text.indexOf(substr);
        if (idx === -1) {
          throw new Error(`substring ${substr} not found in ${file.name}`);
        }
        return docs.serverDoc.positionAt(idx + offset);
      }

      test("finds id selector", () => {
        const p = pos(`${file.idPrefix}testID` , file.idPrefix.length);
        const selector = findSelector(docs.serverDoc, p, { supportTags: true });
        assert.equal(selector.attribute, "id");
        assert.equal(selector.value, "testID");
      });

      test("finds class selector", () => {
        const p = pos(`${file.classPrefix}test common`, file.classPrefix.length);
        const selector = findSelector(docs.serverDoc, p, { supportTags: true });
        assert.equal(selector.attribute, "class");
        assert.equal(selector.value, "test");
      });

      test("finds id selector after comment", () => {
        const p = pos(`${file.idPrefix}test-2`, file.idPrefix.length);
        const selector = findSelector(docs.serverDoc, p, { supportTags: true });
        assert.equal(selector.attribute, "id");
        assert.equal(selector.value, "test-2");
      });

      test("detects html tag", () => {
        const p = pos("<h1", 1);
        const selector = findSelector(docs.serverDoc, p, { supportTags: true });
        assert.equal(selector.attribute, null);
        assert.equal(selector.value, "h1");
      });

      test("respects supportTags option", () => {
        const p = pos("<h1", 1);
        const selector = findSelector(docs.serverDoc, p, { supportTags: false });
        assert.equal(selector, null);
      });

      test("returns null for invalid positions", () => {
        const commentPos = pos("comment");
        assert.equal(
          findSelector(docs.serverDoc, commentPos, { supportTags: true }),
          null
        );
        const textPos = pos("heading");
        assert.equal(
          findSelector(docs.serverDoc, textPos, { supportTags: true }),
          null
        );
      });
    });
  }
});
