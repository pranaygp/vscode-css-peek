'use strict';

import fs = require('fs');
import {
  createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, TextDocumentPositionParams, Definition, InitializeParams, TextDocument
} from 'vscode-languageserver';
import { Uri, StylesheetMap, Selector } from './types'

import findSelector from './core/findSelector'
import { findSymbols, findDefinition, getLanguageService } from './core/findDefinition'
import { create } from './logger'

// Creates the LSP connection
let connection = createConnection(ProposedFeatures.all);

// Create a manager for open text documents
let documents = new TextDocuments();

// Create a map of styleSheet URIs to the stylesheet text content
let styleSheets: StylesheetMap = {};

// The workspace folder this server is operating on
let workspaceFolder: string;

// A list of languages that suport the lookup definition (by default, only html)
let activeLanguages: string[];

// A list of file extensions to lookup for style definitions (defaults to .css, .scss and .less)
let fileSearchExtensions: string[]

let onFileOpen = (event) => {
  connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Document opened: ${event.document.uri}`);
  if (fileSearchExtensions.indexOf('.' + event.document.languageId) > -1) {
    const uri = event.document.uri;
    const languageId = event.document.languageId;
    const text = event.document.getText();
    const document = TextDocument.create(uri, languageId, 1, text);
    const languageService = getLanguageService(document);
    const stylesheet = languageService.parseStylesheet(document);
    styleSheets[event.document.uri] = {
      document,
      stylesheet
    }
  }
}

documents.onDidOpen(onFileOpen)
documents.listen(connection);

documents.onDidChangeContent(onFileOpen)

connection.onInitialize((params) => {
  create(connection.console);
  workspaceFolder = params.rootUri;
  activeLanguages = params.initializationOptions.activeLanguages;
  fileSearchExtensions = params.initializationOptions.fileSearchExtensions;
	connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Started and initialize received`);
  setupStyleMap(params);
	connection.console.log(`[Server(${process.pid}) ${workspaceFolder}] Setup a stylesheet lookup map`);

	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Full
			},
      definitionProvider: true,
      workspaceSymbolProvider: true
		}
	}
});

function setupStyleMap(params: InitializeParams) {
  const styleFiles = params.initializationOptions.stylesheets;

  styleFiles.forEach((fileUri: Uri) => {
    const languageId = fileUri.fsPath.split('.').slice(-1)[0];
    const text = fs.readFileSync(fileUri.fsPath, 'utf8');
    const document = TextDocument.create(fileUri.uri, languageId, 1, text);
    const languageService = getLanguageService(document);
    const stylesheet = languageService.parseStylesheet(document);
    styleSheets[fileUri.uri] = {
      document,
      stylesheet
    };
  });
}

connection.onDefinition((textDocumentPositon: TextDocumentPositionParams): Definition => {
	const documentIdentifier = textDocumentPositon.textDocument;
	const position = textDocumentPositon.position;	

  const document = documents.get(documentIdentifier.uri);

  // Ignore defintiion requests from unsupported languages
  if (!activeLanguages.includes(document.languageId)) {
    return null;
  }

  const selector: Selector = findSelector(document, position);
	if (!selector) {
		return null;
  }

  return findDefinition(selector, styleSheets);
})

connection.onWorkspaceSymbol(({query}) => {
  const selectors: Selector[] = [
    {
      attribute: 'class',
      value: query
    },
    {
      attribute: 'id',
      value: query
    },
  ];

  return selectors
    .reduce((p, selector) => [...p, ...findSymbols(selector, styleSheets)], []);  
})

connection.listen();