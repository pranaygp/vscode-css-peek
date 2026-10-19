import * as assert from "assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import { extractEmbeddedStylesheets } from "../../server/out/core/embeddedStyles";
import { findDefinition } from "../../server/out/core/findDefinition";
import { findHover } from "../../server/out/core/findHover";

suite("embedded styles and hover", () => {
  for (const language of ["html", "vue"]) {
    test(`${language} resolves all style blocks with host coordinates`, () => {
      const text =
        '<div class="first second"></div>\n<style>.first { color: red; }</style>\n<style lang="scss">.second { color: blue; }</style>';
      const document = TextDocument.create(
        `file:///component.${language}`,
        language,
        1,
        text,
      );
      const embeddedStylesheetMap = extractEmbeddedStylesheets(document);
      for (const [value, line] of [
        ["first", 1],
        ["second", 2],
      ] as const) {
        const options = { embeddedStylesheetMap };
        const definitions = findDefinition(
          { attribute: "class", value },
          {},
          options,
        );
        assert.strictEqual(definitions.length, 1);
        assert.strictEqual(definitions[0].uri, document.uri);
        assert.strictEqual(definitions[0].range.start.line, line);
        const hover = findHover({ attribute: "class", value }, {}, options);
        assert.ok(hover);
        assert.match(
          (hover.contents as { value: string }).value,
          new RegExp(`\\.${value}`),
        );
      }
    });
  }

  test("linked-only mode still includes styles embedded in the source", () => {
    const document = TextDocument.create(
      "file:///component.html",
      "html",
      1,
      '<div class="local"></div><style>.local { color: red; }</style>',
    );
    const definitions = findDefinition(
      { attribute: "class", value: "local" },
      {},
      {
        embeddedStylesheetMap: extractEmbeddedStylesheets(document),
        allowedUris: new Set(),
      },
    );
    assert.strictEqual(definitions.length, 1);
  });

  test("reparses embedded styles after document edits", () => {
    const document = TextDocument.create(
      "file:///component.vue",
      "vue",
      1,
      "<style>.before { color: red; }</style>",
    );
    const before = extractEmbeddedStylesheets(document);
    assert.strictEqual(extractEmbeddedStylesheets(document), before);
    TextDocument.update(
      document,
      [{ text: "<style>.after { color: blue; }</style>" }],
      2,
    );
    const after = extractEmbeddedStylesheets(document);
    assert.notStrictEqual(after, before);
    assert.strictEqual(
      findDefinition(
        { attribute: "class", value: "before" },
        {},
        { embeddedStylesheetMap: after },
      ).length,
      0,
    );
    assert.strictEqual(
      findDefinition(
        { attribute: "class", value: "after" },
        {},
        { embeddedStylesheetMap: after },
      ).length,
      1,
    );
  });

  test("hover respects linked stylesheet restriction", () => {
    const a = TextDocument.create(
      "file:///a.css",
      "css",
      1,
      ".shared { color: red; }",
    );
    const b = TextDocument.create(
      "file:///b.css",
      "css",
      1,
      ".shared { color: blue; }",
    );
    const hover = findHover(
      { attribute: "class", value: "shared" },
      {
        [a.uri]: { document: a },
        [b.uri]: { document: b },
      },
      { allowedUris: new Set([b.uri]) },
    );
    assert.ok(hover);
    assert.match((hover.contents as { value: string }).value, /blue/);
  });
});
