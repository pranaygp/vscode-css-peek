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

/**
 * Mirrors the production code path: the client reads file contents via
 * `vscode.workspace.fs.readFile` (which works in virtual/web workspaces),
 * ships `{uri, languageId, text}` tuples to the server, and the server
 * materializes them into a `StylesheetMap` without touching `fs`.
 *
 * Uses `TextDecoder` (browser-safe) rather than `Buffer` to match the
 * production code, which targets both Node and web extension hosts.
 */
const utf8Decoder = new TextDecoder("utf-8");
async function loadStylesheetsViaWorkspaceFs(
  files: string[]
): Promise<StylesheetMap> {
  const map: StylesheetMap = {};
  for (const file of files) {
    const uri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders![0].uri,
      file
    );
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = utf8Decoder.decode(bytes);
    const languageId = file.split(".").pop() || "";
    const serverDoc = ServerTextDocument.create(
      uri.toString(),
      languageId,
      1,
      text
    );
    map[serverDoc.uri] = { document: serverDoc };
  }
  return map;
}

/**
 * Constructs a StylesheetMap whose entries have non-`file` URIs. This is the
 * shape `setupInitialStyleMap` will encounter when running against a virtual
 * workspace (e.g. GitHub Remote Repositories' `vscode-vfs://github/...`),
 * once the client's documentSelector is broadened to those schemes. The
 * server itself is scheme-agnostic — it only ever indexes by the URI string
 * and reads text from the in-memory TextDocument.
 */
function buildVirtualStylesheetMap(): StylesheetMap {
  const map: StylesheetMap = {};
  const entries: Array<{ uri: string; languageId: string; text: string }> = [
    {
      uri: "vscode-vfs://github/example/repo/styles.css",
      languageId: "css",
      text: ".virtual-only { color: red; }\n#virtual-id { color: blue; }\n",
    },
    {
      uri: "vscode-test-web:///workspace/extra.scss",
      languageId: "scss",
      text: ".virtual-only { font-weight: bold; }\n",
    },
  ];
  for (const entry of entries) {
    const doc = ServerTextDocument.create(
      entry.uri,
      entry.languageId,
      1,
      entry.text
    );
    map[doc.uri] = { document: doc };
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

  test("stylesheets loaded via vscode.workspace.fs are discoverable", async () => {
    // Exercises the same code path the extension client now uses to ship
    // stylesheet contents to the server — no `fs` module involved.
    const fsMap = await loadStylesheetsViaWorkspaceFs([
      "stylesheet.css",
      "example.less",
      "example.scss",
      "my_style.scss",
      "extendFailureCase.less",
    ]);

    const classDefs = findDefinition(
      { attribute: "class", value: "test" },
      fsMap
    );
    assert.strictEqual(classDefs.length, 3);

    const idDefs = findDefinition({ attribute: "id", value: "test-2" }, fsMap);
    const idFiles = idDefs
      .map((d) => vscode.Uri.parse(d.uri).path.split("/").pop())
      .sort();
    assert.deepStrictEqual(
      idFiles,
      ["example.less", "example.scss", "stylesheet.css"].sort()
    );
  });

  test("resolves selectors across non-file URI schemes", () => {
    // Verifies the server's scheme-agnosticism: once the client ships
    // stylesheet payloads keyed by `vscode-vfs://` / `vscode-test-web://`
    // URIs (virtual workspaces), findDefinition still resolves them and
    // returns Locations on those schemes — no `file:` assumption anywhere.
    const virtualMap = buildVirtualStylesheetMap();

    const classDefs = findDefinition(
      { attribute: "class", value: "virtual-only" },
      virtualMap
    );
    assert.strictEqual(classDefs.length, 2);
    const schemes = classDefs.map((d) => vscode.Uri.parse(d.uri).scheme).sort();
    assert.deepStrictEqual(schemes, ["vscode-test-web", "vscode-vfs"]);

    const idDefs = findDefinition(
      { attribute: "id", value: "virtual-id" },
      virtualMap
    );
    assert.strictEqual(idDefs.length, 1);
    assert.strictEqual(vscode.Uri.parse(idDefs[0].uri).scheme, "vscode-vfs");
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

suite("findDefinition — special characters", () => {
  create(console as any);
  let map: StylesheetMap;
  suiteSetup(async () => {
    map = await loadStylesheets(["tailwind.css"]);
  });

  test("finds Tailwind variant `md:flex` (escaped `.md\\:flex`)", () => {
    const selector: Selector = { attribute: "class", value: "md:flex" };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 1);
  });

  test("finds slash-value class `bg-red-500/50`", () => {
    const selector: Selector = {
      attribute: "class",
      value: "bg-red-500/50",
    };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 1);
  });

  test("finds Unicode class name `café`", () => {
    const selector: Selector = { attribute: "class", value: "café" };
    const defs = findDefinition(selector, map);
    // tailwind.css defines `.café`, `.foo.café`, and `h1.café` (chained
    // Unicode selectors); resolving `café` should match all three.
    assert.strictEqual(defs.length, 3);
  });

  test("finds class `style:sm` (issue #150)", () => {
    const selector: Selector = { attribute: "class", value: "style:sm" };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 1);
  });

  test("matches chained Unicode class selector `.foo.café`", () => {
    // Resolving `foo` should match the chained rule `.foo.café` because
    // the suffix matcher allows non-ASCII identifier chars after a `.`.
    const selector: Selector = { attribute: "class", value: "foo" };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 1);
  });

  test("matches chained Unicode tag selector `h1.café`", () => {
    // Resolving the `h1` tag should match the chained rule `h1.café`.
    const selector: Selector = { attribute: null as any, value: "h1" };
    const defs = findDefinition(selector, map);
    assert.strictEqual(defs.length, 1);
  });
});
