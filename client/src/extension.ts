import * as path from "path";
import { minimatch } from "minimatch";
import {
  workspace as Workspace,
  window as Window,
  ExtensionContext,
  TextDocument,
  OutputChannel,
  WorkspaceFolder,
  Uri,
  WorkspaceConfiguration,
  FileSystemWatcher,
} from "vscode";

import {
  LanguageClient,
  LanguageClientOptions,
  TransportKind,
} from "vscode-languageclient/node";

import {
  initializeReporter,
  sendTelemetryEvent,
  sendTelemetryErrorEvent,
  setTelemetryEnabled,
} from "./telemetry";
import { readGitignoreGlobs } from "./gitignore";

const SUPPORTED_EXTENSIONS = ["css", "scss", "less"];
const SUPPORTED_EXTENSION_REGEX = /\.(css|scss|less)$/;

let defaultClient: LanguageClient;
const clients: Map<string, LanguageClient> = new Map();
// Tracks folders whose LanguageClient is mid-creation. The stylesheet read
// step is asynchronous, so we have to claim the folder before awaiting any
// I/O — otherwise a second matching document opened in the same folder
// during that window would spawn a duplicate server (see #154).
const pendingClientFolders: Set<string> = new Set();
// One filesystem watcher per workspace folder. Disposed when the folder is
// removed or the extension is deactivated so we don't keep firing
// notifications at stopped LanguageClients.
const watchers: Map<string, FileSystemWatcher> = new Map();

const READ_CONCURRENCY = 16;
const utf8Decoder = new TextDecoder("utf-8");

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
  if (_sortedWorkspaceFolders === void 0) {
    _sortedWorkspaceFolders = Workspace.workspaceFolders
      ? Workspace.workspaceFolders
          .map((folder) => {
            let result = folder.uri.toString();
            if (result.charAt(result.length - 1) !== "/") {
              result = result + "/";
            }
            return result;
          })
          .sort((a, b) => {
            return a.length - b.length;
          })
      : [];
  }
  return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(
  () => (_sortedWorkspaceFolders = undefined)
);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
  const sorted = sortedWorkspaceFolders();
  for (const element of sorted) {
    let uri = folder.uri.toString();
    if (uri.charAt(uri.length - 1) !== "/") {
      uri = uri + "/";
    }
    if (uri.startsWith(element)) {
      return Workspace.getWorkspaceFolder(Uri.parse(element))!;
    }
  }
  return folder;
}

export function activate(context: ExtensionContext): void {
  const config: WorkspaceConfiguration = Workspace.getConfiguration("cssPeek");
  const telemetryEnabled: boolean = config.get("enableTelemetry", true);

  const reporter = initializeReporter(telemetryEnabled);
  context.subscriptions.push(reporter);

  context.subscriptions.push(
    Workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cssPeek.enableTelemetry")) {
        const updated = Workspace.getConfiguration("cssPeek").get(
          "enableTelemetry",
          true
        );
        setTelemetryEnabled(updated);
      }
    })
  );

  sendTelemetryEvent("Activate Extension", { context: "client" });

  const module = context.asAbsolutePath(
    path.join("server", "out", "server.js")
  );
  const outputChannel: OutputChannel = Window.createOutputChannel("CSS Peek");

  const peekFromLanguages: Array<string> = config.get(
    "peekFromLanguages"
  ) as Array<string>;
  const peekToInclude = SUPPORTED_EXTENSIONS.map((l) => `**/*.${l}`);
  const peekToExclude: Array<string> = config.get(
    "peekToExclude"
  ) as Array<string>;
  const peekToLinkedOnly: boolean = config.get(
    "peekToLinkedOnly",
    false
  ) as boolean;
  const respectGitignore: boolean = config.get("respectGitignore") as boolean;

  const documentSelector = [
    ...SUPPORTED_EXTENSIONS.map((language) => ({ scheme: "file", language })),
    ...SUPPORTED_EXTENSIONS.map((language) => ({
      scheme: "untitled",
      language,
    })),
    ...peekFromLanguages.map((language) => ({ scheme: "file", language })),
    ...peekFromLanguages.map((language) => ({ scheme: "untitled", language })),
  ];

  type Stylesheet = { uri: string; languageId: string; text: string };

  async function readStylesheet(u: Uri): Promise<Stylesheet | null> {
    try {
      const bytes = await Workspace.fs.readFile(u);
      return {
        uri: u.toString(),
        languageId: u.path.split(".").pop() || "",
        text: utf8Decoder.decode(bytes),
      };
    } catch (err) {
      sendTelemetryErrorEvent("readStylesheet", {
        context: "client",
        method: "readStylesheet",
        uri: u.toString(),
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async function startClientForFolder(
    folder: WorkspaceFolder,
    folderKey: string
  ): Promise<void> {
    try {
      // Discover stylesheets and read their contents via vscode.workspace.fs
      // (works in virtual/web workspaces). Reads are capped to READ_CONCURRENCY
      // so workspaces with thousands of files don't blow up memory at startup.
      let file_searches: Uri[];
      try {
        const gitignoreGlobs = respectGitignore
          ? await readGitignoreGlobs(folder.uri)
          : [];
        const mergedExcludes = Array.from(
          new Set([...(peekToExclude || []), ...gitignoreGlobs])
        );
        file_searches = await Workspace.findFiles(
          `{${(peekToInclude || []).join(",")}}`,
          `{${mergedExcludes.join(",")}}`
        );
      } catch (err) {
        // Don't crash the extension host on a transient findFiles failure;
        // just log and let the next document-open trigger another attempt.
        sendTelemetryErrorEvent("startClientForFolder", {
          context: "client",
          method: "findFiles",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const stylesheets: Stylesheet[] = (
        await mapWithConcurrency(
          file_searches,
          READ_CONCURRENCY,
          readStylesheet
        )
      ).filter((s): s is Stylesheet => s !== null);

      // The folder may have been removed while we were reading files.
      if (!pendingClientFolders.has(folderKey)) return;

      const debugOptions = {
        execArgv: ["--nolazy", `--inspect=${6011 + clients.size}`],
      };
      const serverOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: {
          module,
          transport: TransportKind.ipc,
          options: debugOptions,
        },
      };
      const clientOptions: LanguageClientOptions = {
        documentSelector,
        diagnosticCollectionName: "css-peek",
        synchronize: {
          configurationSection: "cssPeek",
        },
        initializationOptions: {
          stylesheets,
          peekFromLanguages,
          peekToLinkedOnly,
        },
        workspaceFolder: folder,
        outputChannel,
      };
      const client = new LanguageClient(
        "css-peek",
        "CSS Peek",
        serverOptions,
        clientOptions
      );
      client.registerProposedFeatures();

      // Register the client in `clients` BEFORE calling start() so the
      // workspace-folder-removed handler can stop it if the folder is
      // yanked mid-start. If start() throws, undo the registration so the
      // folder can be retried on the next document-open.
      clients.set(folderKey, client);
      try {
        client.start();
      } catch (err) {
        clients.delete(folderKey);
        sendTelemetryErrorEvent("startClientForFolder", {
          context: "client",
          method: "client.start",
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Watch the workspace for stylesheet add/delete events so the server's
      // StylesheetMap stays in sync without a VSCode restart. We only handle
      // create/delete (ignoreChangeEvents=true) because the LSP documents
      // sync covers content edits to open files.
      const watcher = Workspace.createFileSystemWatcher(
        `{${(peekToInclude || []).join(",")}}`,
        false,
        true,
        false
      );
      const isExcluded = (uri: Uri): boolean => {
        if (uri.scheme !== "file") return true;
        return (peekToExclude || []).some(
          (glob) =>
            minimatch(uri.fsPath, glob) || minimatch(uri.toString(), glob)
        );
      };
      watcher.onDidDelete((uri) => {
        if (isExcluded(uri)) return;
        client.sendNotification("cssPeek/stylesheetDeleted", uri.toString());
      });
      watcher.onDidCreate(async (uri) => {
        if (isExcluded(uri)) return;
        const stylesheet = await readStylesheet(uri);
        if (!stylesheet) return;
        client.sendNotification("cssPeek/stylesheetCreated", stylesheet);
      });
      watchers.set(folderKey, watcher);
    } finally {
      pendingClientFolders.delete(folderKey);
    }
  }

  function didOpenTextDocument(document: TextDocument): void {
    try {
      if (
        !["file", "untitled"].includes(document.uri.scheme) ||
        (!peekFromLanguages.includes(document.languageId) &&
          !SUPPORTED_EXTENSION_REGEX.test(document.fileName))
      ) {
        return;
      }

      const uri = document.uri;
      const telemetryData = {
        context: "client",
        uriAuthority: uri.authority,
        uriFragment: uri.fragment,
        uriPath: uri.path,
        uriQuery: uri.query,
        uriScheme: uri.scheme,
        workspaceFolder: null,
      };

      // Untitled files go to a default client.
      if (uri.scheme === "untitled" && !defaultClient) {
        const debugOptions = { execArgv: ["--nolazy", "--inspect=6010"] };
        const serverOptions = {
          run: { module, transport: TransportKind.ipc },
          debug: {
            module,
            transport: TransportKind.ipc,
            options: debugOptions,
          },
        };
        const clientOptions: LanguageClientOptions = {
          documentSelector,
          synchronize: {
            configurationSection: "cssPeek",
          },
          initializationOptions: {
            stylesheets: [],
            peekFromLanguages,
            peekToLinkedOnly,
          },
          diagnosticCollectionName: "css-peek",
          outputChannel,
        };
        defaultClient = new LanguageClient(
          "css-peek",
          "CSS Peek",
          serverOptions,
          clientOptions
        );
        defaultClient.registerProposedFeatures();
        defaultClient.start();
        sendTelemetryEvent("Document Opened", telemetryData);
        return;
      }
      let folder = Workspace.getWorkspaceFolder(uri);
      // Files outside a folder can't be handled. This might depend on the language.
      // Single file languages like JSON might handle files outside the workspace folders.
      if (!folder) {
        sendTelemetryEvent("Document Opened", telemetryData);
        return;
      }
      // If we have nested workspace folders we only start a server on the outer most workspace folder.
      folder = getOuterMostWorkspaceFolder(folder);
      telemetryData.workspaceFolder = folder;

      const folderKey = folder.uri.toString();
      if (!clients.has(folderKey) && !pendingClientFolders.has(folderKey)) {
        // Claim the folder synchronously before any awaits so concurrent
        // didOpenTextDocument calls don't race to start a second server.
        pendingClientFolders.add(folderKey);
        startClientForFolder(folder, folderKey).catch(() => {
          // Errors are already reported via telemetry inside startClientForFolder.
          // The catch is just to satisfy the unhandled-rejection contract.
        });
      }
      sendTelemetryEvent("Document Opened", telemetryData);
    } catch (e) {
      sendTelemetryErrorEvent(e instanceof Error ? e.message : String(e), {
        context: "client",
        method: "didOpenTextDocument",
      });
    }
  }

  Workspace.onDidOpenTextDocument(didOpenTextDocument);
  Workspace.textDocuments.forEach(didOpenTextDocument);
  Workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.removed) {
      const folderKey = folder.uri.toString();
      // If the folder was still mid-spawn, drop the pending claim so the
      // continuation in startClientForFolder bails out before constructing a
      // client.
      pendingClientFolders.delete(folderKey);
      const watcher = watchers.get(folderKey);
      if (watcher) {
        watcher.dispose();
        watchers.delete(folderKey);
      }
      const client = clients.get(folderKey);
      if (client) {
        sendTelemetryEvent("Workspace Folder Closed", {
          context: "client",
          folderName: folder.name,
          uriAuthority: folder.uri.authority,
          uriFragment: folder.uri.fragment,
          uriPath: folder.uri.path,
          uriQuery: folder.uri.query,
          uriScheme: folder.uri.scheme,
        });

        clients.delete(folderKey);
        client.stop();
      }
    }
  });
}

export function deactivate(): Thenable<void> {
  const promises: Thenable<void>[] = [];
  if (defaultClient) {
    promises.push(defaultClient.stop());
  }
  for (const watcher of watchers.values()) {
    watcher.dispose();
  }
  watchers.clear();
  for (const client of clients.values()) {
    promises.push(client.stop());
  }
  sendTelemetryEvent(
    "Deactivate Extension",
    { context: "client" },
    { activeClients: promises.length }
  );
  return Promise.all(promises).then(() => undefined);
}
