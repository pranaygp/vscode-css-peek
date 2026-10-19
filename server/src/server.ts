"use strict";

import {
  Connection,
  TextDocuments,
  TextDocumentSyncKind,
  TextDocumentPositionParams,
  Definition,
  Hover,
  InitializeParams,
  DidChangeConfigurationNotification,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Stylesheet, StylesheetMap, Selector } from "./types";

import findSelector from "./core/findSelector";
import {
  findSymbols,
  findDefinition,
  isLanguageServiceSupported,
} from "./core/findDefinition";
import { findHover } from "./core/findHover";
import {
  extractEmbeddedStylesheets,
  hasEmbeddedStyles,
} from "./core/embeddedStyles";
import { findLinkedStylesheets } from "./utils/linkedStylesheets";
import { isStylesheetInScope, workspaceRootUri } from "./utils/stylesheetScope";
import { create } from "./logger";

export function startServer(connection: Connection): void {
  const label = (uri: string | null | undefined) =>
    (uri || "untitled").split("/").pop() || "workspace";

  // Create a manager for open text documents
  const documents = new TextDocuments(TextDocument);

  // Keep only stylesheet text and lazily populated symbol arrays. Parsed CSS
  // syntax trees are released after symbol extraction; file events invalidate
  // each entry rather than retaining old document versions.
  const styleSheets: StylesheetMap = {};

  // The workspace folder this server is operating on
  let workspaceFolder: string | null;
  let initialExcludes: string[] = [];

  let hasConfigurationCapability = false;
  let hasWorkspaceFolderCapability = false;

  async function isValidPeekTarget(document: TextDocument) {
    const settings = await getDocumentSettings(document.uri);
    return isStylesheetInScope(document.uri, workspaceFolder, [
      ...initialExcludes,
      ...settings.peekToExclude,
    ]);
  }

  async function isValidPeekSource(document: TextDocument | undefined) {
    if (!document) return false;
    const settings = await getDocumentSettings(document.uri);
    return (
      settings.enable &&
      settings.peekFromLanguages.includes(document.languageId)
    );
  }

  /* Handle Document Updates */
  documents.onDidOpen(async (event) => {
    if (!(await isValidPeekTarget(event.document))) {
      return;
    }

    if (isLanguageServiceSupported(event.document.languageId)) {
      connection.console.log(
        `[Server(${"CSS Peek"}) ${label(workspaceFolder)}/] Document opened: ${label(event.document.uri)}.`,
      );
      styleSheets[event.document.uri] = {
        document: event.document,
      };
    }
  });
  documents.onDidChangeContent(async (event) => {
    if (!(await isValidPeekTarget(event.document))) {
      return;
    }

    if (isLanguageServiceSupported(event.document.languageId)) {
      connection.console.log(
        `[Server(${"CSS Peek"}) ${label(workspaceFolder)}/] Document changed: ${label(event.document.uri)}. Invalidating Cache.`,
      );
      styleSheets[event.document.uri] = {
        document: event.document,
      };
    }
  });
  documents.listen(connection);

  /* Server Initialization */
  connection.onInitialize((params) => {
    create(connection.console, params.trace === "verbose");
    const capabilities = params.capabilities;

    workspaceFolder = workspaceRootUri(params);
    initialExcludes = params.initializationOptions?.peekToExclude || [];
    // Does the client support the `workspace/configuration` request?
    // If not, we will fall back using global settings
    hasConfigurationCapability = !!capabilities.workspace?.configuration;
    hasWorkspaceFolderCapability = !!capabilities.workspace?.workspaceFolders;

    connection.console.log(
      `[Server(${"CSS Peek"}) ${label(workspaceFolder)}/] onInitialize`,
    );
    setupInitialStyleMap(params);
    connection.console.log(
      `[Server(${"CSS Peek"}) ${label(workspaceFolder)}/] setupInitialStylemap`,
    );

    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
        },
        definitionProvider: true,
        hoverProvider: true,
        workspaceSymbolProvider: true,
      },
    };
  });

  /* Sync Configuration Settings */
  interface Settings {
    enable: boolean;
    supportTags: boolean;
    peekVariables: boolean;
    peekFromLanguages: string[];
    peekToExclude: string[];
    peekToLinkedOnly: boolean;
  }
  connection.onInitialized(() => {
    if (hasConfigurationCapability) {
      // Register for all configuration changes.
      connection.client.register(
        DidChangeConfigurationNotification.type,
        undefined,
      );
    }
    if (hasWorkspaceFolderCapability) {
      connection.workspace.onDidChangeWorkspaceFolders((_event) => {
        connection.console.log("Workspace folder change event received.");
      });
    }
  });
  // The global settings, used when the `workspace/configuration` request is not supported by the client.
  const defaultSettings: Settings = {
    enable: true,
    supportTags: true,
    peekVariables: true,
    peekFromLanguages: ["html"],
    peekToExclude: ["**/node_modules/**", "**/bower_components/**"],
    peekToLinkedOnly: false,
  };
  let globalSettings: Settings = defaultSettings;

  // Cache the settings of all open documents
  const documentSettings: Map<string, Thenable<Settings>> = new Map();

  connection.onDidChangeConfiguration((change) => {
    if (hasConfigurationCapability) {
      // Reset all cached document settings
      documentSettings.clear();
    } else {
      globalSettings = { ...defaultSettings, ...change.settings?.cssPeek };
    }
  });

  function getDocumentSettings(resource: string): Thenable<Settings> {
    if (!hasConfigurationCapability) {
      return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
      result = connection.workspace
        .getConfiguration({
          scopeUri: resource,
          section: "cssPeek",
        })
        .then((settings) => ({ ...defaultSettings, ...settings }));
      documentSettings.set(resource, result);
    }
    return result;
  }

  // Only keep settings for open documents
  documents.onDidClose((e) => {
    documentSettings.delete(e.document.uri);
  });

  function loadStylesheet(file: Stylesheet): void {
    const document = TextDocument.create(
      file.uri,
      file.languageId,
      1,
      file.text,
    );
    styleSheets[file.uri] = {
      document,
    };
  }

  function setupInitialStyleMap(params: InitializeParams) {
    const styleFiles: Stylesheet[] =
      params.initializationOptions?.stylesheets || [];

    connection.console.log(
      `[Server(${"CSS Peek"}) ${label(workspaceFolder)}/] Number of style sheets - ${styleFiles.length}`,
    );

    // Stylesheet contents are read on the client (via `vscode.workspace.fs`)
    // and shipped over LSP so the server never touches the host file system.
    // This keeps the server compatible with virtual workspaces and the web build.
    styleFiles.forEach(loadStylesheet);
  }

  // Keep the StylesheetMap in sync with the workspace filesystem. The client
  // pushes these notifications when a stylesheet is created or deleted on disk,
  // so peek results don't reference files that no longer exist.
  connection.onNotification("cssPeek/stylesheetDeleted", (uri: string) => {
    connection.console.log(
      `[Server(${"CSS Peek"})] Stylesheet deleted: ${label(uri)}`,
    );
    delete styleSheets[uri];
  });

  connection.onNotification("cssPeek/stylesheetCreated", (file: Stylesheet) => {
    connection.console.log(
      `[Server(${"CSS Peek"})] Stylesheet created: ${label(file.uri)}`,
    );
    loadStylesheet(file);
  });

  connection.onNotification("cssPeek/stylesheetChanged", (file: Stylesheet) => {
    // An open editor's LSP text includes unsaved edits and must win over disk.
    if (!documents.get(file.uri)) loadStylesheet(file);
  });

  connection.onNotification("cssPeek/stylesheetClosed", (file: Stylesheet) => {
    // The client reads disk only after the LSP didClose was delivered.
    // A new editor may have reopened it while that asynchronous read ran.
    if (!documents.get(file.uri)) loadStylesheet(file);
  });

  connection.onDefinition(
    async (
      textDocumentPositon: TextDocumentPositionParams,
    ): Promise<Definition | null> => {
      const documentIdentifier = textDocumentPositon.textDocument;
      const position = textDocumentPositon.position;

      const document = documents.get(documentIdentifier.uri);

      if (!document || !(await isValidPeekSource(document))) {
        return null;
      }
      const settings = await getDocumentSettings(document.uri);

      const selector = findSelector(document, position, settings);
      if (!selector) {
        return null;
      }

      // For HTML/Vue source documents, also search any embedded `<style>`
      // blocks within the same file. We parse these on-demand rather than
      // caching, since their content is tightly coupled to the host doc.
      const embeddedStylesheetMap = hasEmbeddedStyles(document.languageId)
        ? extractEmbeddedStylesheets(document)
        : {};

      const allowedUris = settings.peekToLinkedOnly
        ? new Set(findLinkedStylesheets(document))
        : undefined;

      return findDefinition(selector, styleSheets, {
        sourceUri: document.uri,
        peekVariables: settings.peekVariables,
        embeddedStylesheetMap,
        allowedUris,
      });
    },
  );

  connection.onHover(
    async (
      textDocumentPositon: TextDocumentPositionParams,
    ): Promise<Hover | null> => {
      const documentIdentifier = textDocumentPositon.textDocument;
      const position = textDocumentPositon.position;

      const document = documents.get(documentIdentifier.uri);

      if (!document || !(await isValidPeekSource(document))) {
        return null;
      }
      const settings = await getDocumentSettings(document.uri);

      const selector = findSelector(document, position, settings);
      if (!selector) {
        return null;
      }

      return findHover(selector, styleSheets, {
        sourceUri: document.uri,
        peekVariables: settings.peekVariables,
        embeddedStylesheetMap: hasEmbeddedStyles(document.languageId)
          ? extractEmbeddedStylesheets(document)
          : {},
        allowedUris: settings.peekToLinkedOnly
          ? new Set(findLinkedStylesheets(document))
          : undefined,
      });
    },
  );

  connection.onWorkspaceSymbol(async ({ query }) => {
    if (query.length < 2) return [];
    const selectors: Selector[] = [
      {
        attribute: "class",
        value: query,
      },
      {
        attribute: "id",
        value: query,
      },
      {
        attribute: "tag",
        value: query,
      },
    ];

    const settings: Settings = hasConfigurationCapability
      ? {
          ...defaultSettings,
          ...(await connection.workspace.getConfiguration({
            scopeUri: workspaceFolder || undefined,
            section: "cssPeek",
          })),
        }
      : globalSettings;

    if (!settings.enable) return [];

    return selectors.flatMap((selector) =>
      findSymbols(selector, styleSheets, {
        peekVariables: settings.peekVariables,
      }),
    );
  });

  connection.listen();
}
