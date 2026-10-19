import * as assert from "assert";
import * as vscode from "vscode";

type Definition = vscode.Location | vscode.LocationLink;

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders!.find(
    (item) => item.name === "fixture",
  );
  assert.ok(folder, "run tests with tests/fixture.code-workspace");
  return vscode.Uri.joinPath(folder.uri, name);
}

function wordPosition(
  document: vscode.TextDocument,
  word: string,
): vscode.Position {
  const index = document.getText().indexOf(word);
  assert.ok(index >= 0, `missing ${word}`);
  return document.positionAt(index + Math.floor(word.length / 2));
}

async function definitions(
  document: vscode.TextDocument,
  word: string,
): Promise<string[]> {
  const result = await vscode.commands.executeCommand<Definition[]>(
    "vscode.executeDefinitionProvider",
    document.uri,
    wordPosition(document, word),
  );
  return [
    ...new Set(
      (result || []).map((item) =>
        "uri" in item ? item.uri.toString() : item.targetUri.toString(),
      ),
    ),
  ];
}

async function eventually<T>(
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 20000;
  let value: T;
  do {
    value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

suite("Razor and Twig providers", function () {
  this.timeout(60000);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(
      "pranaygp.vscode-css-peek",
    );
    assert.ok(extension);
    await extension.activate();
  });

  for (const [source, language, className, stylesheet, color] of [
    [
      "Counter.razor",
      "aspnetcorerazor",
      "csspeek-razor-isolated",
      "Counter.razor.css",
      "rebeccapurple",
    ],
    ["View.cshtml", "razor", "csspeek-razor-mvc", "View.css", "cadetblue"],
    ["Example.twig", "twig", "csspeek-twig-static", "Example.css", "royalblue"],
  ]) {
    test(`${source} finds definitions and CSS hover using default ${language} settings`, async () => {
      const opened = await vscode.workspace.openTextDocument(fixture(source!));
      // Razor language extensions assign these IDs; select them explicitly so
      // this test doesn't require the unrelated .NET SDK/C# extension install.
      const document = await vscode.languages.setTextDocumentLanguage(
        opened,
        language!,
      );
      const expected = fixture(stylesheet!).toString();
      const found = await eventually(
        () => definitions(document, className!),
        (uris) => uris.includes(expected),
        `${source} definition`,
      );
      assert.deepStrictEqual(found, [expected]);
      await eventually(
        async () => {
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            "vscode.executeHoverProvider",
            document.uri,
            wordPosition(document, className!),
          );
          return (hovers || [])
            .flatMap((hover) => hover.contents)
            .map((content) =>
              typeof content === "string" ? content : content.value,
            )
            .join("\n");
        },
        (text) => text.includes(color!),
        `${source} CSS hover`,
      );
      if (source === "Example.twig") {
        assert.deepStrictEqual(
          await definitions(document, "csspeek-twig-comment"),
          [],
        );
        assert.deepStrictEqual(
          await definitions(document, "csspeek-twig-code"),
          [],
        );
      }
      if (source === "Counter.razor") {
        assert.deepStrictEqual(
          await definitions(document, "csspeek-razor-comment"),
          [],
        );
        assert.deepStrictEqual(
          await definitions(document, "csspeek-razor-code"),
          [],
        );
      }
    });
  }
});

(process.env.CSS_PEEK_COMPATIBILITY ? suite : suite.skip)(
  "CSS completion extension compatibility (#95)",
  function () {
    this.timeout(90000);
    let document: vscode.TextDocument;

    suiteSetup(async () => {
      const target = process.env.CSS_PEEK_COMPATIBILITY!;
      assert.ok(
        [
          "Zignd.html-css-class-completion",
          "gencer.html-slim-scss-css-class-completion",
        ].includes(target),
        "select one completion extension per integration run",
      );
      for (const id of ["pranaygp.vscode-css-peek", target]) {
        const extension = vscode.extensions.getExtension(id);
        assert.ok(
          extension,
          `${id} must be installed for CSS_PEEK_COMPATIBILITY`,
        );
        await extension.activate();
        assert.ok(extension.isActive, `${id} must be active`);
        console.log(
          `Compatibility extension ${id}@${extension.packageJSON.version} active`,
        );
      }
      // These extensions are forks and both register the same cache command.
      // Test their compatibility with CSS Peek separately, disabling the other.
      const other =
        target === "Zignd.html-css-class-completion"
          ? "gencer.html-slim-scss-css-class-completion"
          : "Zignd.html-css-class-completion";
      assert.notStrictEqual(
        vscode.extensions.getExtension(other)?.isActive,
        true,
        "the other completion extension must remain disabled",
      );
      document = await vscode.workspace.openTextDocument(
        fixture("provider-compatibility.html"),
      );
    });

    test("the selected completion extension provides its supported CSS suggestions", async () => {
      const expected =
        process.env.CSS_PEEK_COMPATIBILITY ===
        "gencer.html-slim-scss-css-class-completion"
          ? ["csspeek-compatibility-css", "csspeek-compatibility-scss"]
          : ["csspeek-compatibility-css"];
      const prefix = 'class="csspeek-compatibility-';
      const position = document.positionAt(
        document.getText().indexOf(prefix) + prefix.length,
      );
      const labels = await eventually(
        async () => {
          const completions =
            await vscode.commands.executeCommand<vscode.CompletionList>(
              "vscode.executeCompletionItemProvider",
              document.uri,
              position,
            );
          return (completions?.items || []).map((item) =>
            typeof item.label === "string" ? item.label : item.label.label,
          );
        },
        (values) => expected.every((name) => values.includes(name)),
        `real suggestions from ${process.env.CSS_PEEK_COMPATIBILITY}`,
      );
      for (const name of expected) assert.ok(labels.includes(name));
    });

    test("CSS Peek CSS and SCSS definitions resolve with the selected completion extension active", async () => {
      for (const [name, stylesheet] of [
        ["csspeek-compatibility-css", "provider-compatibility.css"],
        ["csspeek-compatibility-scss", "provider-compatibility.scss"],
      ]) {
        const expected = fixture(stylesheet!).toString();
        const found = await eventually(
          () => definitions(document, name!),
          (uris) => uris.includes(expected),
          `${name} definition`,
        );
        assert.deepStrictEqual(found, [expected]);
      }
    });
  },
);
