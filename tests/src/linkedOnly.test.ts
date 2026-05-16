import * as assert from "assert";
import * as vscode from "vscode";
import { TextDocument as ServerTextDocument } from "vscode-languageserver";

import { findDefinition } from "../../server/out/core/findDefinition";
import { findLinkedStylesheets } from "../../server/out/utils/linkedStylesheets";
import { create } from "../../server/out/logger";
import type { StylesheetMap, Selector } from "../../server/src/types";

async function loadServerDoc(file: string): Promise<ServerTextDocument> {
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

async function loadStylesheets(files: string[]): Promise<StylesheetMap> {
  const map: StylesheetMap = {};
  for (const file of files) {
    const doc = await loadServerDoc(file);
    map[doc.uri] = { document: doc };
  }
  return map;
}

suite("findDefinition: peekToLinkedOnly", () => {
  create(console as any);
  let map: StylesheetMap;
  let sourceDoc: ServerTextDocument;
  let linkedUri: string;
  let unlinkedUri: string;

  suiteSetup(async () => {
    map = await loadStylesheets(["linked.css", "unlinked.css"]);
    sourceDoc = await loadServerDoc("linked.html");
    linkedUri = (await loadServerDoc("linked.css")).uri;
    unlinkedUri = (await loadServerDoc("unlinked.css")).uri;
  });

  test("without restriction, both files are matched", () => {
    const selector: Selector = {
      attribute: "class",
      value: "linked-only-class",
    };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 2);
  });

  test("findLinkedStylesheets discovers <link rel=stylesheet href>", () => {
    const refs = findLinkedStylesheets(sourceDoc);
    assert.ok(
      refs.includes(linkedUri),
      `expected refs to include ${linkedUri}, got ${JSON.stringify(refs)}`
    );
    assert.ok(
      !refs.includes(unlinkedUri),
      `expected refs to NOT include ${unlinkedUri}, got ${JSON.stringify(refs)}`
    );
  });

  test("restriction limits defs to linked stylesheet only", () => {
    const selector: Selector = {
      attribute: "class",
      value: "linked-only-class",
    };
    const allowed = new Set(findLinkedStylesheets(sourceDoc));
    const defs = findDefinition(selector, map, { allowedUris: allowed });
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].uri, linkedUri);
  });

  test("empty allowed set produces zero defs", () => {
    const selector: Selector = {
      attribute: "class",
      value: "linked-only-class",
    };
    const defs = findDefinition(selector, map, {
      allowedUris: new Set<string>(),
    });
    assert.strictEqual(defs.length, 0);
  });
});

suite("findLinkedStylesheets: parsing", () => {
  function makeDoc(uri: string, languageId: string, text: string) {
    return ServerTextDocument.create(uri, languageId, 1, text);
  }

  test("parses JS imports of CSS modules", () => {
    const doc = makeDoc(
      "file:///workspace/src/component.ts",
      "typescript",
      `import './local.css';\nimport styles from "./other.scss";\nimport 'normalize.css';`
    );
    const refs = findLinkedStylesheets(doc);
    assert.deepStrictEqual(refs.sort(), [
      "file:///workspace/src/local.css",
      "file:///workspace/src/other.scss",
    ]);
  });

  test("parses CSS @import", () => {
    const doc = makeDoc(
      "file:///workspace/src/main.scss",
      "scss",
      `@import './partial.scss';\n@import url('./other.css');\n@import 'bare.css';`
    );
    const refs = findLinkedStylesheets(doc);
    assert.deepStrictEqual(refs.sort(), [
      "file:///workspace/src/other.css",
      "file:///workspace/src/partial.scss",
    ]);
  });

  test("ignores <link> tags without rel=stylesheet", () => {
    const doc = makeDoc(
      "file:///workspace/page.html",
      "html",
      `<link rel="icon" href="./favicon.css">\n<link rel="stylesheet" href="./real.css">`
    );
    const refs = findLinkedStylesheets(doc);
    assert.deepStrictEqual(refs, ["file:///workspace/real.css"]);
  });
});
