import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type {
  BaseLanguageClient,
  LanguageClientOptions,
} from "vscode-languageclient";
import {
  activateWithClientFactory,
  deactivate as deactivateTestRuntime,
} from "../../client/out/extensionRuntime";

const encoder = new TextEncoder();
type Definition = vscode.Location | vscode.LocationLink;

async function definitions(document: vscode.TextDocument, name: string) {
  const offset = document.getText().indexOf(name);
  assert.ok(offset >= 0, `missing class ${name} in test source`);
  const locations = await vscode.commands.executeCommand<Definition[]>(
    "vscode.executeDefinitionProvider",
    document.uri,
    document.positionAt(offset + 1),
  );
  return (locations || []).map((location) =>
    "uri" in location ? location.uri.toString() : location.targetUri.toString(),
  );
}

async function waitFor<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  description: string,
): Promise<T> {
  const end = Date.now() + 15000;
  let value: T;
  do {
    value = await read();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < end);
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

suite("Real extension client integration", function () {
  this.timeout(60000);
  let rootA: vscode.WorkspaceFolder;
  let rootB: vscode.WorkspaceFolder;

  suiteSetup(async () => {
    rootA = vscode.workspace.workspaceFolders!.find(
      (folder) => folder.name === "workspace-a",
    )!;
    rootB = vscode.workspace.workspaceFolders!.find(
      (folder) => folder.name === "workspace-b",
    )!;
    assert.ok(rootA && rootB, "run using tests/fixture.code-workspace");
    const extension = vscode.extensions.getExtension(
      "pranaygp.vscode-css-peek",
    );
    assert.ok(extension, "CSS Peek development extension must be installed");
    await extension.activate();
  });

  test("independent workspace roots never return each other's stylesheets", async () => {
    const [a, b] = await Promise.all([
      vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(rootA.uri, "index.html"),
      ),
      vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(rootB.uri, "index.html"),
      ),
    ]);
    const expectedA = vscode.Uri.joinPath(rootA.uri, "styles.css").toString();
    const expectedB = vscode.Uri.joinPath(rootB.uri, "styles.css").toString();
    await Promise.all([
      waitFor(
        () => definitions(a, "root-shared"),
        (uris) => uris.length > 0,
        "root A server",
      ),
      waitFor(
        () => definitions(b, "root-shared"),
        (uris) => uris.length > 0,
        "root B server",
      ),
    ]);
    assert.deepStrictEqual(await definitions(a, "root-shared"), [expectedA]);
    assert.deepStrictEqual(await definitions(b, "root-shared"), [expectedB]);
    assert.deepStrictEqual(await definitions(a, "root-a-only"), [expectedA]);
    assert.deepStrictEqual(await definitions(b, "root-b-only"), [expectedB]);
  });

  test("nested explicit roots isolate discovery, watcher updates, and opened CSS", async () => {
    const nested = vscode.workspace.workspaceFolders!.find(
      (folder) => folder.name === "nested-workspace",
    )!;
    assert.ok(nested, "nested workspace fixture must be configured");
    const [parent, child] = await Promise.all([
      vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(rootA.uri, "index.html"),
      ),
      vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(nested.uri, "index.html"),
      ),
    ]);
    const styleUri = vscode.Uri.joinPath(nested.uri, "styles.css");
    await waitFor(
      () => definitions(child, "root-shared"),
      (uris) => uris.includes(styleUri.toString()),
      "nested root startup",
    );
    assert.deepStrictEqual(await definitions(child, "root-shared"), [
      styleUri.toString(),
    ]);
    assert.deepStrictEqual(await definitions(child, "root-a-only"), []);
    await vscode.workspace.openTextDocument(styleUri);
    assert.deepStrictEqual(await definitions(parent, "nested-only"), []);
    const dynamicUri = vscode.Uri.joinPath(
      nested.uri,
      `nested-live-${Date.now()}.css`,
    );
    try {
      await vscode.workspace.fs.writeFile(
        dynamicUri,
        encoder.encode(".nested-dynamic { color: purple; }"),
      );
      await waitFor(
        () => definitions(child, "nested-dynamic"),
        (uris) => uris.includes(dynamicUri.toString()),
        "nested stylesheet watcher",
      );
      await vscode.workspace.openTextDocument(dynamicUri);
      assert.deepStrictEqual(await definitions(parent, "nested-dynamic"), []);
    } finally {
      await vscode.workspace.fs.delete(dynamicUri);
    }
  });

  test("many files opened during folder startup remain usable after removal and re-add", async () => {
    const folderUri = vscode.Uri.file(
      path.join(os.tmpdir(), `css-peek-many-${Date.now()}`),
    );
    await vscode.workspace.fs.createDirectory(folderUri);
    const styleUri = vscode.Uri.joinPath(folderUri, "styles.css");
    const sourceUris = Array.from({ length: 40 }, (_, index) =>
      vscode.Uri.joinPath(folderUri, `page-${index}.html`),
    );
    await Promise.all([
      vscode.workspace.fs.writeFile(
        styleUri,
        encoder.encode(".concurrent-open { color: red; }"),
      ),
      ...sourceUris.map((uri) =>
        vscode.workspace.fs.writeFile(
          uri,
          encoder.encode('<div class="concurrent-open"></div>'),
        ),
      ),
    ]);
    async function changeFolders(
      update: () => boolean,
      matches: (event: vscode.WorkspaceFoldersChangeEvent) => boolean,
    ): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listener.dispose();
          reject(new Error("Workspace folder change event timed out"));
        }, 15000);
        const listener = vscode.workspace.onDidChangeWorkspaceFolders(
          (event) => {
            if (!matches(event)) return;
            clearTimeout(timer);
            listener.dispose();
            resolve();
          },
        );
        if (!update()) {
          clearTimeout(timer);
          listener.dispose();
          reject(new Error("VS Code rejected workspace folder update"));
        }
      });
    }
    const addFolder = () =>
      changeFolders(
        () =>
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders!.length,
            0,
            { uri: folderUri, name: "concurrent-startup" },
          ),
        (event) =>
          event.added.some(
            (folder) => folder.uri.toString() === folderUri.toString(),
          ),
      );
    const removeFolder = async () => {
      const index = vscode.workspace.workspaceFolders!.findIndex(
        (folder) => folder.uri.toString() === folderUri.toString(),
      );
      if (index >= 0)
        await changeFolders(
          () => vscode.workspace.updateWorkspaceFolders(index, 1),
          (event) =>
            event.removed.some(
              (folder) => folder.uri.toString() === folderUri.toString(),
            ),
        );
    };
    try {
      await addFolder();
      const documents = await Promise.all(
        sourceUris.map((uri) => vscode.workspace.openTextDocument(uri)),
      );
      await Promise.all(
        documents.map((document) =>
          waitFor(
            () => definitions(document, "concurrent-open"),
            (uris) => uris.includes(styleUri.toString()),
            "concurrent source definition",
          ),
        ),
      );
      await removeFolder();
      await addFolder();
      await waitFor(
        () => definitions(documents[0], "concurrent-open"),
        (uris) => uris.includes(styleUri.toString()),
        "re-added root's server",
      );
      assert.deepStrictEqual(
        await definitions(documents[39], "concurrent-open"),
        [styleUri.toString()],
      );
    } finally {
      await removeFolder();
      await vscode.workspace.fs.delete(folderUri, { recursive: true });
    }
  });

  test("created, externally changed, and deleted closed stylesheets update definitions", async () => {
    const name = `lifecycle-${Date.now()}`;
    const htmlUri = vscode.Uri.joinPath(rootA.uri, `${name}.html`);
    const cssUri = vscode.Uri.joinPath(rootA.uri, `${name}.css`);
    try {
      await vscode.workspace.fs.writeFile(
        htmlUri,
        encoder.encode(`<div class="${name} ${name}-updated"></div>`),
      );
      const document = await vscode.workspace.openTextDocument(htmlUri);
      await vscode.workspace.fs.writeFile(
        cssUri,
        encoder.encode(`.${name} { color: red; }`),
      );
      await waitFor(
        () => definitions(document, name),
        (uris) => uris.includes(cssUri.toString()),
        "new stylesheet",
      );
      await vscode.workspace.fs.writeFile(
        cssUri,
        encoder.encode(`.${name}-updated { color: blue; }`),
      );
      await waitFor(
        () => definitions(document, `${name}-updated`),
        (uris) => uris.includes(cssUri.toString()),
        "externally updated stylesheet",
      );
      assert.deepStrictEqual(await definitions(document, name), []);
      await vscode.workspace.fs.delete(cssUri);
      await waitFor(
        () => definitions(document, `${name}-updated`),
        (uris) => uris.length === 0,
        "deleted stylesheet removal",
      );
    } finally {
      await vscode.workspace.fs.delete(htmlUri);
      try {
        await vscode.workspace.fs.delete(cssUri);
      } catch {
        /* already deleted */
      }
    }
  });

  test("gitignored stylesheets stay excluded when opened in the editor", async () => {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(rootA.uri, "ignored.html"),
    );
    await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(rootA.uri, "ignored.css"),
    );
    // Synchronize with a known definition before testing the absent result.
    const source = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(rootA.uri, "index.html"),
    );
    await waitFor(
      () => definitions(source, "root-a-only"),
      (uris) => uris.length === 1,
      "root A ready",
    );
    assert.deepStrictEqual(await definitions(document, "ignored-class"), []);
  });

  test("enable toggle stops clients and restores definitions without reload", async () => {
    const settings = vscode.workspace.getConfiguration("cssPeek");
    const original = settings.inspect<boolean>("enable")?.workspaceValue;
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(rootB.uri, "index.html"),
    );
    try {
      await settings.update(
        "enable",
        false,
        vscode.ConfigurationTarget.Workspace,
      );
      await waitFor(
        () => definitions(document, "root-b-only"),
        (uris) => uris.length === 0,
        "disabled providers",
      );
      await settings.update(
        "enable",
        true,
        vscode.ConfigurationTarget.Workspace,
      );
      await waitFor(
        () => definitions(document, "root-b-only"),
        (uris) => uris.length === 1,
        "re-enabled provider",
      );
    } finally {
      await settings.update(
        "enable",
        original,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });

  test("untitled markup can resolve an open untitled stylesheet", async () => {
    const css = await vscode.workspace.openTextDocument({
      language: "css",
      content: ".untitled-regression { color: red; }",
    });
    const html = await vscode.workspace.openTextDocument({
      language: "html",
      content: '<div class="untitled-regression"></div>',
    });
    await waitFor(
      () => definitions(html, "untitled-regression"),
      (uris) => uris.includes(css.uri.toString()),
      "untitled stylesheet definition",
    );
  });

  test("server restart initialization reflects stylesheet changes and deletions", async () => {
    const subscriptions: vscode.Disposable[] = [];
    const options = new Map<string, LanguageClientOptions>();
    const context = { subscriptions } as vscode.ExtensionContext;
    const fileUri = vscode.Uri.joinPath(rootA.uri, `restart-${Date.now()}.css`);
    const snapshot = () => {
      const initializer = options.get(
        rootA.uri.toString(),
      )?.initializationOptions;
      return (
        typeof initializer === "function" ? initializer().stylesheets : []
      ) as Array<{ uri: string; text: string }>;
    };
    try {
      // Exercise the production scanner/watchers with a fake process transport.
      // Calling its initialization callback again represents an LSP restart.
      activateWithClientFactory(context, (clientOptions) => {
        options.set(
          clientOptions.workspaceFolder?.uri.toString() || "untitled",
          clientOptions,
        );
        return {
          start: async () => undefined,
          dispose: async () => undefined,
          sendNotification: async () => undefined,
        } as unknown as BaseLanguageClient;
      });
      await waitFor(
        async () => options.has(rootA.uri.toString()),
        Boolean,
        "test runtime startup",
      );
      await vscode.workspace.fs.writeFile(
        fileUri,
        encoder.encode(".before-restart { color: red; }"),
      );
      await waitFor(
        async () =>
          snapshot().find((file) => file.uri === fileUri.toString())?.text,
        (text) => text?.includes("before-restart") === true,
        "initial restart snapshot",
      );
      await vscode.workspace.fs.writeFile(
        fileUri,
        encoder.encode(".after-restart { color: blue; }"),
      );
      await waitFor(
        async () =>
          snapshot().find((file) => file.uri === fileUri.toString())?.text,
        (text) => text?.includes("after-restart") === true,
        "updated restart snapshot",
      );
      await vscode.workspace.fs.delete(fileUri);
      await waitFor(
        async () => snapshot().some((file) => file.uri === fileUri.toString()),
        (present) => !present,
        "deleted file absent from restart snapshot",
      );
    } finally {
      await deactivateTestRuntime();
      subscriptions.forEach((subscription) => subscription.dispose());
      try {
        await vscode.workspace.fs.delete(fileUri);
      } catch {
        /* already deleted */
      }
    }
  });
});
