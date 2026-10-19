const vscode = require("vscode");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function eventually(check, message) {
  const deadline = Date.now() + 30000;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(message);
}

exports.run = async function () {
  const extension = vscode.extensions.getExtension("pranaygp.vscode-css-peek");
  assert(extension, "CSS Peek must be installed in the web extension host");
  await extension.activate();
  const root = vscode.workspace.workspaceFolders[0].uri;
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(root, "web.html"),
  );
  await vscode.window.showTextDocument(doc);
  const position = doc.positionAt(
    doc.getText().lastIndexOf("web-embedded") + 4,
  );
  await eventually(async () => {
    const definitions = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      doc.uri,
      position,
    );
    return definitions.some(
      (definition) =>
        (definition.uri || definition.targetUri).toString() ===
        doc.uri.toString(),
    );
  }, "browser worker must resolve an embedded HTML selector");
  const hovers = await vscode.commands.executeCommand(
    "vscode.executeHoverProvider",
    doc.uri,
    position,
  );
  assert(
    hovers.some((hover) =>
      hover.contents.some((content) =>
        /web-embedded/.test(content.value || ""),
      ),
    ),
    "browser worker must return CSS hover text from embedded styles",
  );

  const externalPosition = doc.positionAt(
    doc.getText().indexOf("web-external") + 4,
  );
  await eventually(async () => {
    const definitions = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      doc.uri,
      externalPosition,
    );
    return definitions.some((definition) =>
      (definition.uri || definition.targetUri).path.endsWith("/web.css"),
    );
  }, "browser worker must discover CSS through the virtual workspace filesystem");

  const jsx = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(root, "web.jsx"),
  );
  await vscode.window.showTextDocument(jsx);
  await eventually(async () => {
    const definitions = await vscode.commands.executeCommand(
      "vscode.executeDefinitionProvider",
      jsx.uri,
      jsx.positionAt(jsx.getText().indexOf("web-external") + 4),
    );
    return definitions.some((definition) =>
      (definition.uri || definition.targetUri).path.endsWith("/web.css"),
    );
  }, "browser worker must resolve JSX literal expressions");
  // Virtual providers must retain their original URI scheme during LSP
  // initialization. Unsaved CSS updates exercise the server's target scope.
  const stylesheet = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(root, "web.css"),
  );
  const sourceText = doc.getText();
  const stylesheetText = stylesheet.getText();
  try {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(
      stylesheet.uri,
      stylesheet.positionAt(stylesheetText.length),
      "\n.web-live-update { color: teal; }\n",
    );
    edit.insert(
      doc.uri,
      doc.positionAt(sourceText.length),
      '\n<div class="web-live-update"></div>\n',
    );
    assert(
      await vscode.workspace.applyEdit(edit),
      "virtual workspace edits must apply",
    );
    await eventually(async () => {
      const definitions = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        doc.uri,
        doc.positionAt(doc.getText().lastIndexOf("web-live-update") + 4),
      );
      return definitions.some(
        (definition) =>
          (definition.uri || definition.targetUri).toString() ===
          stylesheet.uri.toString(),
      );
    }, "browser worker must resolve unsaved CSS updates in the virtual workspace");
  } finally {
    const restore = new vscode.WorkspaceEdit();
    restore.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
      sourceText,
    );
    restore.replace(
      stylesheet.uri,
      new vscode.Range(
        stylesheet.positionAt(0),
        stylesheet.positionAt(stylesheet.getText().length),
      ),
      stylesheetText,
    );
    assert(
      await vscode.workspace.applyEdit(restore),
      "virtual workspace edits must restore",
    );
  }
  console.log(
    "CSS Peek web integration: embedded definitions, hover, virtual CSS discovery, JSX, unsaved CSS updates passed",
  );
};
