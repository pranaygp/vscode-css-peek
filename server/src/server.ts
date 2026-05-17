"use strict";

import fs = require("fs");
import { minimatch } from "minimatch";
import * as path from "path";
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocumentPositionParams,
  Definition,
  Hover,
  InitializeParams,
  DidChangeConfigurationNotification,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Uri, StylesheetMap, Selector } from "./types";

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
import { create } from "./logger";

// Creates the LSP connection
const connection = createConnection(ProposedFeatures.all);

// Create a manager for open text documents
const documents = new TextDocuments(TextDocument);

// Create a map of styleSheet URIs to the stylesheet text content
// NOTE: this is a really bad cache in practice. Large files will occupy tons of memory without being reused
// We should use an in-memory javascript database of some sort with a basic cache invalidation strategy
// like LRU, an implement some sort of memory cap
const styleSheets: StylesheetMap = {};

// The workspace folder this server is operating on
let workspaceFolder: string | null;

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

async function isValidPeekTarget(document: TextDocument) {
  const settings = await getDocumentSettings(document.uri);
  return !settings.peekToExclude.find((glob) => minimatch(document.uri, glob));
}

async function isValidPeekSource(document: TextDocument) {
  const settings = await getDocumentSettings(document.uri);
  return settings.peekFromLanguages.includes(document.languageId);
}

/* Handle Document Updates */
documents.onDidOpen(async (event) => {
  if (!(await isValidPeekTarget(event.document))) {
    return;
  }

  if (isLanguageServiceSupported(event.document.languageId)) {
    connection.console.log(
      `[Server(${process.pid}) ${path.basename(
        workspaceFolder
      )}/] Document opened: ${path.basename(event.document.uri)}.`
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
      `[Server(${process.pid}) ${path.basename(
        workspaceFolder
      )}/] Document changed: ${path.basename(
        event.document.uri
      )}. Invalidating Cache.`
    );
    styleSheets[event.document.uri] = {
      document: event.document,
    };
  }
});
documents.listen(connection);

/* Server Initialization */
connection.onInitialize((params) => {
  create(connection.console);
  const capabilities = params.capabilities;

  workspaceFolder = params.rootUri;
  // Does the client support the `workspace/configuration` request?
  // If not, we will fall back using global settings
  hasConfigurationCapability =
    capabilities.workspace && !!capabilities.workspace.configuration;
  hasWorkspaceFolderCapability =
    capabilities.workspace && !!capabilities.workspace.workspaceFolders;

  connection.console.log(
    `[Server(${process.pid}) ${path.basename(workspaceFolder)}/] onInitialize`
  );
  setupInitialStyleMap(params);
  connection.console.log(
    `[Server(${process.pid}) ${path.basename(
      workspaceFolder
    )}/] setupInitialStylemap`
  );

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
      },
      definitionProvider: true,
      hoverProvider: true,
      workspaceSymbolProvider: true,
    },
  };
});

/* Sync Configuration Settings */
interface Settings {
  supportTags: boolean;
  peekVariables: boolean;
  peekFromLanguages: string[];
  peekToExclude: string[];
}
connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
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
  supportTags: true,
  peekVariables: true,
  peekFromLanguages: ["html"],
  peekToExclude: ["**/node_modules/**", "**/bower_components/**"],
};
let globalSettings: Settings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<Settings>> = new Map();

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <Settings>(change.settings.cssPeek || defaultSettings);
  }
});

function getDocumentSettings(resource: string): Thenable<Settings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "cssPeek",
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
  documentSettings.delete(e.document.uri);
});

function setupInitialStyleMap(params: InitializeParams) {
  const styleFiles = params.initializationOptions.stylesheets;

  connection.console.log(
    `[Server(${process.pid}) ${path.basename(
      workspaceFolder
    )}/] Number of style sheets - ${styleFiles.length}`
  );

  styleFiles.forEach((fileUri: Uri) => {
    const languageId = fileUri.fsPath.split(".").slice(-1)[0];
    // TODO: this is bad. stop using the file system directly. Instead, use the VSCode
    // fs API to support the virutal filesystem
    // https://github.com/microsoft/vscode/wiki/Virtual-Workspaces
    const text = fs.readFileSync(fileUri.fsPath, "utf8");
    const document = TextDocument.create(fileUri.uri, languageId, 1, text);
    styleSheets[fileUri.uri] = {
      document,
    };
  });
}

connection.onDefinition(
  async (
    textDocumentPositon: TextDocumentPositionParams
  ): Promise<Definition> => {
    const documentIdentifier = textDocumentPositon.textDocument;
    const position = textDocumentPositon.position;

    const document = documents.get(documentIdentifier.uri);

    if (!(await isValidPeekSource(document))) {
      return null;
    }
    const settings = await getDocumentSettings(document.uri);

    const selector: Selector = findSelector(document, position, settings);
    if (!selector) {
      return null;
    }

    // For HTML/Vue source documents, also search any embedded `<style>`
    // blocks within the same file. We parse these on-demand rather than
    // caching, since their content is tightly coupled to the host doc.
    const embeddedStylesheetMap = hasEmbeddedStyles(document.languageId)
      ? extractEmbeddedStylesheets(document)
      : {};

    return findDefinition(selector, styleSheets, {
      peekVariables: settings.peekVariables,
      embeddedStylesheetMap,
    });
  }
);

connection.onHover(
  async (
    textDocumentPositon: TextDocumentPositionParams
  ): Promise<Hover | null> => {
    const documentIdentifier = textDocumentPositon.textDocument;
    const position = textDocumentPositon.position;

    const document = documents.get(documentIdentifier.uri);

    if (!document || !(await isValidPeekSource(document))) {
      return null;
    }
    const settings = await getDocumentSettings(document.uri);

    const selector: Selector = findSelector(document, position, settings);
    if (!selector) {
      return null;
    }

    return findHover(selector, styleSheets, {
      peekVariables: settings.peekVariables,
    });
  }
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

  const settings = hasConfigurationCapability
    ? ((await connection.workspace.getConfiguration({
        section: "cssPeek",
      })) as Settings) || defaultSettings
    : globalSettings;

  return selectors.reduce(
    (p, selector) => [
      ...p,
      ...findSymbols(selector, styleSheets, {
        peekVariables: settings.peekVariables,
      }),
    ],
    []
  );
});

connection.listen();
