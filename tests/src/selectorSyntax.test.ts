import * as assert from "assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import findSelector from "../../server/out/core/findSelector";
import { findDefinition } from "../../server/out/core/findDefinition";
import { create } from "../../server/out/logger";

function select(source: string, word: string, languageId = "typescriptreact") {
  const index = source.lastIndexOf(word);
  assert.notStrictEqual(index, -1, `missing ${word}`);
  const document = TextDocument.create(
    "file:///project/Component.tsx",
    languageId,
    1,
    source,
  );
  return findSelector(
    document,
    document.positionAt(index + Math.floor(word.length / 2)),
    { supportTags: true },
  );
}

suite("selector syntax regressions", () => {
  suiteSetup(() => create({ log() {} } as any));

  test("ignores JavaScript comparisons, strings, comments and TypeScript type arguments (#96)", () => {
    for (const source of [
      "const div = 1; if (count <div) {}",
      "const div = 1; const valid = count <div && div > 0;",
      '// <div className="fake" />',
      "const text = '<div className=\"fake\" />';",
      "const value = factory<div>();",
    ]) {
      const word = source.includes("fake") ? "fake" : "div";
      assert.strictEqual(select(source, word), null, source);
    }
  });

  test("reads JSX literal expressions and keeps component navigation native (#82)", () => {
    assert.deepStrictEqual(
      select('const view = <div className={"container"} />;', "container"),
      { attribute: "class", value: "container" },
    );
    assert.deepStrictEqual(
      select("const view = <div id={'target'} />;", "target"),
      { attribute: "id", value: "target" },
    );
    assert.strictEqual(
      select('const view = <Component className="container" />;', "Component"),
      null,
    );
  });

  test("reads imported classnames aliases, clsx arrays and conditional object keys", () => {
    const source =
      'import ClassNames from "classnames"; const view = <div className={ClassNames("base", [enabled && "visible"], { active: enabled, "is-ready": ready })} />;';
    for (const word of ["base", "visible", "active", "is-ready"]) {
      assert.deepStrictEqual(select(source, word), {
        attribute: "class",
        value: word,
      });
    }
    assert.strictEqual(select(source, "enabled"), null);
    assert.strictEqual(select(source, "ready"), null);
  });

  test("reads conditional literal branches without resolving arbitrary function arguments", () => {
    const source =
      'const view = <div className={condition ? "on" : format("off")} />;';
    assert.deepStrictEqual(select(source, "on"), {
      attribute: "class",
      value: "on",
    });
    assert.strictEqual(select(source, "off"), null);
    assert.strictEqual(select(source, "condition"), null);
  });

  test("CSS modules resolve only in the imported stylesheet", () => {
    const source =
      'import styles from "./Component.module.css"; const view = <div className={styles.container} />;';
    const selector = select(source, "container");
    assert.ok(selector);
    const localUri = "file:///project/Component.module.css";
    const otherUri = "file:///project/Unrelated.module.css";
    const stylesheets = {
      [localUri]: {
        document: TextDocument.create(
          localUri,
          "css",
          1,
          ".container { color: red; }",
        ),
      },
      [otherUri]: {
        document: TextDocument.create(
          otherUri,
          "css",
          1,
          ".container { color: blue; }",
        ),
      },
    };
    assert.deepStrictEqual(
      findDefinition(selector, stylesheets).map(({ uri }) => uri),
      [localUri],
    );
    assert.strictEqual(
      select(
        "const styles = {}; const view = <div className={styles.container} />;",
        "container",
      ),
      null,
    );
  });

  test("CSS module bracket access and local shadowing respect JavaScript scope", () => {
    const source =
      'import styles from "./Component.module.css"; const view = <div className={styles["is-active"]} />;';
    assert.deepStrictEqual(select(source, "is-active"), {
      attribute: "class",
      value: "is-active",
      moduleUri: "file:///project/Component.module.css",
    });
    assert.strictEqual(
      select(
        'import styles from "./Component.module.css"; function render(styles: any) { return <div className={styles.container} />; }',
        "container",
      ),
      null,
    );
    assert.strictEqual(
      select(
        'import styles from "./Component.module.css"; function render() { const styles = other; return <div className={styles.container} />; }',
        "container",
      ),
      null,
    );
  });

  test("hoisted vars and named function expressions shadow imported CSS modules and helpers", () => {
    for (const source of [
      'import styles from "./styles.css"; function View(){ if(ready){ var styles = { button: "x" }; } return <div className={styles.button}/>; }',
      'import styles from "./styles.css"; const View = function styles(){ return <div className={styles.button}/>; };',
      'import styles from "./styles.css"; const View = class styles { render(){ return <div className={styles.button}/>; } };',
      'import cx from "clsx"; function View(){ if(ready){ var cx = custom; } return <div className={cx("button")}/>; }',
      'import cx from "clsx"; const View = function cx(){ return <div className={cx("button")}/>; };',
    ])
      assert.strictEqual(select(source, "button"), null, source);
    const source =
      'import styles from "./styles.css"; function View(){ function nested(){ var styles = {}; } return <div className={styles.button}/>; }';
    assert.deepStrictEqual(select(source, "button"), {
      attribute: "class",
      value: "button",
      moduleUri: "file:///project/styles.css",
    });
  });

  test("reads imported clsx aliases but ignores dynamic fragments and unrelated helpers", () => {
    const source =
      'import { clsx as cx } from "clsx"; const view = <div className={cx(`base`, [condition && "active"], `prefix-${state}`)} />;';
    assert.deepStrictEqual(select(source, "base"), {
      attribute: "class",
      value: "base",
    });
    assert.deepStrictEqual(select(source, "active"), {
      attribute: "class",
      value: "active",
    });
    assert.strictEqual(select(source, "prefix-"), null);
    assert.strictEqual(
      select(
        'function clsx(value: string) { return value; } const view = <div className={clsx("arbitrary")} />;',
        "arbitrary",
      ),
      null,
    );
  });

  test("preserves Lit HTML template selectors and keeps interpolated class fragments opaque", () => {
    const source =
      'import { html as view } from "lit"; const page = view`<div class="container ${dynamic} fixed prefix-${state}"></div>`;';
    for (const word of ["container", "fixed"])
      assert.deepStrictEqual(select(source, word, "javascript"), {
        attribute: "class",
        value: word,
      });
    assert.strictEqual(select(source, "prefix-", "javascript"), null);
    assert.strictEqual(select(source, "dynamic", "javascript"), null);
    assert.strictEqual(
      select(
        'import { html } from "lit"; function render(html) { return html`<div class="fake"></div>`; }',
        "fake",
        "javascript",
      ),
      null,
    );
    assert.deepStrictEqual(
      select(
        'import * as lit from "lit-html"; const view = lit.html`<div id="target"></div>`;',
        "target",
        "javascript",
      ),
      { attribute: "id", value: "target" },
    );
  });

  test("preserves Vue and Angular template property strings without scanning unrelated JS strings", () => {
    const source = `const component = { template: '<section class="container"></section>' };`;
    assert.deepStrictEqual(select(source, "container", "javascript"), {
      attribute: "class",
      value: "container",
    });
    const angular = `@Component({ template: '<section class="container"></section>' }) class View {}`;
    assert.deepStrictEqual(select(angular, "container", "typescript"), {
      attribute: "class",
      value: "container",
    });
    const escaped = String.raw`const component = { template: "<section class=\"container\"></section>" };`;
    assert.deepStrictEqual(select(escaped, "container", "javascript"), {
      attribute: "class",
      value: "container",
    });
  });

  test("cached JSX selectors are invalidated when a document is edited", () => {
    const document = TextDocument.create(
      "file:///project/Component.tsx",
      "typescriptreact",
      1,
      'const view = <div className="before" />;',
    );
    const position = document.positionAt(
      document.getText().indexOf("before") + 2,
    );
    assert.strictEqual(
      findSelector(document, position, { supportTags: true })?.value,
      "before",
    );
    TextDocument.update(
      document,
      [{ text: 'const view = <div className="after" />;' }],
      2,
    );
    assert.strictEqual(
      findSelector(document, position, { supportTags: true })?.value,
      "after",
    );
    const tagPosition = document.positionAt(
      document.getText().indexOf("div") + 1,
    );
    assert.strictEqual(
      findSelector(document, tagPosition, { supportTags: false }),
      null,
    );
  });

  test("nested SCSS parent references use the enclosing rule instead of preceding siblings", () => {
    const uri = "file:///project/styles.scss";
    const document = TextDocument.create(
      uri,
      "scss",
      1,
      ".parent { &__first { color: red; } &__second { color: blue; } &__nested { &--active { color: green; } } }",
    );
    const map = { [uri]: { document } };
    for (const [word, raw] of [
      ["parent__first", "&__first"],
      ["parent__second", "&__second"],
      ["parent__nested--active", "&--active"],
    ]) {
      const definitions = findDefinition(
        { attribute: "class", value: word! },
        map,
      );
      assert.strictEqual(definitions.length, 1, word);
      assert.ok(document.getText(definitions[0]!.range).startsWith(raw!));
    }
  });

  test("Razor and MVC CSS isolation includes own styles and global CSS, excluding sibling components", () => {
    for (const extension of ["razor", "cshtml"]) {
      const sourceUri = `file:///project/Component.${extension}`;
      const own = sourceUri + ".css";
      const sibling = `file:///project/Other.${extension}.css`;
      const global = "file:///project/global.css";
      const map = Object.fromEntries(
        [own, sibling, global].map((uri) => [
          uri,
          {
            document: TextDocument.create(
              uri,
              "css",
              1,
              ".shared { color: red; }",
            ),
          },
        ]),
      );
      const selector = { attribute: "class", value: "shared" };
      assert.deepStrictEqual(
        findDefinition(selector, map, { sourceUri }).map(({ uri }) => uri),
        [own, global],
      );
      assert.deepStrictEqual(
        findDefinition(selector, map, {
          sourceUri,
          allowedUris: new Set(),
        }).map(({ uri }) => uri),
        [own],
        "isolated styles are implicitly linked to their component",
      );
      assert.deepStrictEqual(
        findDefinition(selector, map, {
          sourceUri: "file:///project/index.html",
        }).map(({ uri }) => uri),
        [global],
      );
    }
  });

  test("finds multiline and unquoted HTML class attributes", () => {
    for (const source of [
      '<div class="first\tsecond\nthird">',
      "<div class=second>",
    ]) {
      assert.deepStrictEqual(select(source, "second", "html"), {
        attribute: "class",
        value: "second",
      });
    }
  });

  test("keeps Razor markup available while ignoring C# strings and comments", () => {
    const source =
      '@page "/example"\n@* <div class="commented" /> *@\n<div class="container">Hello</div>\n@code { string value = @"<div class=""fake"" />"; }';
    assert.deepStrictEqual(select(source, "container", "aspnetcorerazor"), {
      attribute: "class",
      value: "container",
    });
    assert.strictEqual(select(source, "commented", "aspnetcorerazor"), null);
    assert.strictEqual(select(source, "fake", "aspnetcorerazor"), null);
  });

  test("Twig native language finds literal markup classes/IDs without parsing template code (#26)", () => {
    const source = `{% extends "base.html.twig" %}\n{# <div class="commented">Not rendered</div> #}\n{{ '<div class="escaped">Output</div>' }}\n<section class="container {{ dynamic }} prefix-{{ suffix }}" id="target">{% if visible %}Hello{% endif %}</section>`;
    assert.deepStrictEqual(select(source, "container", "twig"), {
      attribute: "class",
      value: "container",
    });
    assert.deepStrictEqual(select(source, "target", "twig"), {
      attribute: "id",
      value: "target",
    });
    for (const word of ["commented", "escaped", "dynamic", "prefix-"])
      assert.strictEqual(select(source, word, "twig"), null, word);
  });

  test("reads Pug shorthand and attribute selectors without matching text (#22)", () => {
    for (const [source, word, expected] of [
      [
        "section.card#target Hello",
        "card",
        { attribute: "class", value: "card" },
      ],
      [
        "section.card#target Hello",
        "target",
        { attribute: "id", value: "target" },
      ],
      [
        '.card(class="first second") Hello',
        "second",
        { attribute: "class", value: "second" },
      ],
      ["section.card Hello", "section", { attribute: null, value: "section" }],
      ["p This .card is text", "card", null],
      ["//- comment\n  .card", "card", null],
    ] as const) {
      assert.deepStrictEqual(select(source, word, "pug"), expected, source);
    }
  });
});
