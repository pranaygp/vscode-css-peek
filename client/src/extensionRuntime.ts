import { minimatch } from "minimatch";
import {
  workspace as Workspace,
  window as Window,
  CancellationTokenSource,
  ExtensionContext,
  RelativePattern,
  TextDocument,
  WorkspaceFolder,
  Uri,
} from "vscode";
import type {
  BaseLanguageClient,
  LanguageClientOptions,
} from "vscode-languageclient";
import { ClientLifecycle, ClientResource } from "./clientLifecycle";
import { readGitignoreGlobs } from "./gitignore";
import { isWithinFolder, nearestWorkspaceFolder } from "./workspaceFolders";
import {
  initializeReporter,
  sendTelemetryEvent,
  sendTelemetryErrorEvent,
  setTelemetryEnabled,
} from "./telemetry";

const STYLESHEET_LANGUAGES = ["css", "scss", "less"];
const STYLESHEET_GLOB = "**/*.{css,scss,less}";
const READ_CONCURRENCY = 16;
const utf8Decoder = new TextDecoder("utf-8");
type Stylesheet = { uri: string; languageId: string; text: string };
export type ClientFactory = (
  options: LanguageClientOptions,
  debugPort: number,
) => BaseLanguageClient;

let shutdown: (() => Promise<void>) | undefined;

export function activateWithClientFactory(
  context: ExtensionContext,
  createClient: ClientFactory,
): void {
  const output = Window.createOutputChannel("CSS Peek", { log: true });
  const config = () => Workspace.getConfiguration("cssPeek");
  const reporter = initializeReporter(config().get("enableTelemetry", true));
  context.subscriptions.push(output, reporter);
  let active = true;
  let ready = true;
  let generation = 0;
  let nextDebugPort = 6010;

  const reportError = (method: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[${method}] ${message}`);
    sendTelemetryErrorEvent(method, { context: "client", error: message });
  };
  const clients = new ClientLifecycle<ClientResource>((error) =>
    reportError("client lifecycle", error),
  );

  function owningFolder(uri: Uri): WorkspaceFolder | undefined {
    return nearestWorkspaceFolder(uri, Workspace.workspaceFolders || []);
  }

  async function readStylesheet(uri: Uri): Promise<Stylesheet | undefined> {
    try {
      return {
        uri: uri.toString(),
        languageId: uri.path.split(".").pop() || "css",
        text: utf8Decoder.decode(await Workspace.fs.readFile(uri)),
      };
    } catch (error) {
      reportError(`read ${uri.toString()}`, error);
      return undefined;
    }
  }

  function createResource(folder?: WorkspaceFolder): ClientResource {
    const settings = config();
    const languages = Array.from(
      new Set([
        ...STYLESHEET_LANGUAGES,
        ...settings.get<string[]>("peekFromLanguages", ["html"]),
      ]),
    );
    const nestedRoots = folder
      ? (Workspace.workspaceFolders || [])
          .filter(
            (candidate) =>
              candidate.uri.toString() !== folder.uri.toString() &&
              isWithinFolder(candidate.uri, folder.uri),
          )
          .map(
            (candidate) =>
              escapeGlob(
                candidate.uri.path.slice(
                  folder.uri.path.replace(/\/$/, "").length + 1,
                ),
              ) + "/**",
          )
      : [];
    const peekToExclude = [
      ...settings.get<string[]>("peekToExclude", []),
      ...nestedRoots,
    ];
    const cancellation = new CancellationTokenSource();
    let client: BaseLanguageClient | undefined;
    let watcher:
      ReturnType<typeof Workspace.createFileSystemWatcher> | undefined;
    let ignoreWatcher:
      ReturnType<typeof Workspace.createFileSystemWatcher> | undefined;
    let cancelled = false;
    let started = false;
    let excludes = peekToExclude;
    // Coalesce events during discovery/startup; replay after initialization so
    // files created, changed or deleted while scanning cannot leave stale data.
    const pending = new Map<string, { uri: Uri; deleted: boolean }>();
    const revisions = new Map<string, number>();
    const stylesheets = new Map<string, Stylesheet>();
    let nextRevision = 0;

    const isExcluded = (uri: Uri): boolean => {
      if (!folder) return uri.scheme !== "untitled";
      if (owningFolder(uri)?.uri.toString() !== folder.uri.toString())
        return true;
      const relative = uri.path.slice(
        folder.uri.path.replace(/\/$/, "").length + 1,
      );
      return excludes.some((glob) => minimatch(relative, glob, { dot: true }));
    };

    const acceptsDocument = (document: TextDocument): boolean =>
      folder
        ? owningFolder(document.uri)?.uri.toString() === folder.uri.toString()
        : document.uri.scheme === "untitled";
    const shouldSync = (document: TextDocument): boolean =>
      acceptsDocument(document) &&
      (!STYLESHEET_LANGUAGES.includes(document.languageId) ||
        !isExcluded(document.uri));

    async function changed(uri: Uri, deleted: boolean): Promise<void> {
      if (cancelled || isExcluded(uri)) return;
      const key = uri.toString();
      const revision = ++nextRevision;
      revisions.set(key, revision);
      if (!started) {
        pending.set(key, { uri, deleted });
        return;
      }
      try {
        if (deleted) {
          stylesheets.delete(key);
          await client!.sendNotification("cssPeek/stylesheetDeleted", key);
        } else {
          // The open document is authoritative, including unsaved edits.
          const document = Workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === key,
          );
          const stylesheet = document
            ? {
                uri: key,
                languageId: document.languageId,
                text: document.getText(),
              }
            : await readStylesheet(uri);
          if (stylesheet && !cancelled && revisions.get(key) === revision) {
            stylesheets.set(key, stylesheet);
            await client!.sendNotification(
              "cssPeek/stylesheetChanged",
              stylesheet,
            );
          }
        }
      } catch (error) {
        if (!cancelled) reportError("stylesheet change", error);
      } finally {
        if (revisions.get(key) === revision) revisions.delete(key);
      }
    }

    return {
      async start(): Promise<void> {
        if (folder) {
          if (settings.get("respectGitignore", true)) {
            ignoreWatcher = Workspace.createFileSystemWatcher(
              new RelativePattern(folder, ".gitignore"),
            );
            ignoreWatcher.onDidCreate(restart);
            ignoreWatcher.onDidChange(restart);
            ignoreWatcher.onDidDelete(restart);
            excludes = Array.from(
              new Set([...excludes, ...(await readGitignoreGlobs(folder.uri))]),
            );
          }
          if (cancelled) return;
          const pattern = new RelativePattern(folder, STYLESHEET_GLOB);
          watcher = Workspace.createFileSystemWatcher(pattern);
          watcher.onDidCreate((uri) => void changed(uri, false));
          watcher.onDidChange((uri) => void changed(uri, false));
          watcher.onDidDelete((uri) => void changed(uri, true));
          const files = await Workspace.findFiles(
            pattern,
            excludes.length ? `{${excludes.join(",")}}` : null,
            undefined,
            cancellation.token,
          );
          let next = 0;
          await Promise.all(
            Array.from(
              { length: Math.min(READ_CONCURRENCY, files.length) },
              async () => {
                while (!cancelled && next < files.length) {
                  const uri = files[next++];
                  if (isExcluded(uri)) continue;
                  const stylesheet = await readStylesheet(uri);
                  if (stylesheet && !cancelled)
                    stylesheets.set(stylesheet.uri, stylesheet);
                }
              },
            ),
          );
        }
        if (cancelled) return;
        const documentSelector = languages.map((language) =>
          folder
            ? {
                language,
                scheme: folder.uri.scheme,
                pattern: folderDocumentPattern(folder.uri),
              }
            : { language, scheme: "untitled" },
        );
        client = createClient(
          {
            documentSelector,
            diagnosticCollectionName: "css-peek",
            synchronize: { configurationSection: "cssPeek" },
            initializationOptions: () => ({
              stylesheets: Array.from(stylesheets.values()),
              workspaceRootUri: folder?.uri.toString() || null,
              peekFromLanguages: settings.get("peekFromLanguages", ["html"]),
              peekToLinkedOnly: settings.get("peekToLinkedOnly", false),
              peekToExclude: excludes,
            }),
            middleware: {
              didOpen: (document, next) =>
                shouldSync(document) ? next(document) : Promise.resolve(),
              didChange: (event, next) =>
                shouldSync(event.document) ? next(event) : Promise.resolve(),
              provideDefinition: (document, position, token, next) =>
                acceptsDocument(document)
                  ? next(document, position, token)
                  : null,
              provideHover: (document, position, token, next) =>
                acceptsDocument(document)
                  ? next(document, position, token)
                  : null,
              didClose: async (document, next) => {
                if (!shouldSync(document)) return;
                await next(document);
                if (
                  cancelled ||
                  !STYLESHEET_LANGUAGES.includes(document.languageId) ||
                  isExcluded(document.uri)
                )
                  return;
                if (document.uri.scheme === "untitled") {
                  stylesheets.delete(document.uri.toString());
                  await client!.sendNotification(
                    "cssPeek/stylesheetDeleted",
                    document.uri.toString(),
                  );
                  return;
                }
                const stylesheet = await readStylesheet(document.uri);
                if (cancelled) return;
                if (stylesheet) {
                  stylesheets.set(stylesheet.uri, stylesheet);
                  await client!.sendNotification(
                    "cssPeek/stylesheetClosed",
                    stylesheet,
                  );
                } else {
                  stylesheets.delete(document.uri.toString());
                  await client!.sendNotification(
                    "cssPeek/stylesheetDeleted",
                    document.uri.toString(),
                  );
                }
              },
            },
            workspaceFolder: folder,
            outputChannel: output,
          },
          nextDebugPort++,
        );
        await client.start();
        if (cancelled) return;
        started = true;
        const changes = Array.from(pending.values());
        pending.clear();
        await Promise.all(
          changes.map(({ uri, deleted }) => changed(uri, deleted)),
        );
      },
      cancel(): void {
        cancelled = true;
        cancellation.cancel();
        watcher?.dispose();
        ignoreWatcher?.dispose();
        pending.clear();
        revisions.clear();
        stylesheets.clear();
      },
      async stop(): Promise<void> {
        cancellation.dispose();
        watcher?.dispose();
        ignoreWatcher?.dispose();
        if (client) await client.dispose();
      },
    };
  }

  function didOpenTextDocument(document: TextDocument): void {
    if (!active || !ready || !config().get("enable", true)) return;
    const languages = config().get<string[]>("peekFromLanguages", ["html"]);
    if (
      !languages.includes(document.languageId) &&
      !STYLESHEET_LANGUAGES.includes(document.languageId)
    )
      return;
    const folder = owningFolder(document.uri);
    if (!folder && document.uri.scheme !== "untitled") return;
    const key = folder?.uri.toString() || "untitled";
    void clients.start(key, () => createResource(folder));
  }

  // Topology/configuration changes invalidate whole client generations. A
  // removed then re-added URI can never revive an older in-flight startup.
  function restart(): void {
    const currentGeneration = ++generation;
    ready = false;
    void clients.clear().then(() => {
      if (!active || generation !== currentGeneration) return;
      ready = true;
      Workspace.textDocuments.forEach(didOpenTextDocument);
    });
  }

  context.subscriptions.push(
    Workspace.onDidOpenTextDocument(didOpenTextDocument),
    Workspace.onDidChangeWorkspaceFolders(restart),
    Workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cssPeek.enableTelemetry")) {
        setTelemetryEnabled(config().get("enableTelemetry", true));
      }
      if (
        [
          "enable",
          "peekFromLanguages",
          "peekToExclude",
          "respectGitignore",
        ].some((name) => event.affectsConfiguration(`cssPeek.${name}`))
      )
        restart();
    }),
    { dispose: () => void stop() },
  );

  function stop(): Promise<void> {
    active = false;
    ++generation;
    return clients.dispose();
  }
  shutdown = stop;
  sendTelemetryEvent("Activate Extension", { context: "client" });
  Workspace.textDocuments.forEach(didOpenTextDocument);
}

function escapeGlob(value: string): string {
  return value.replace(/[?*[\]{}]/g, (char) => `[${char}]`);
}

function folderDocumentPattern(folder: Uri): string {
  // The LSP document selector accepts string patterns rather than VS Code
  // RelativePatterns. Escape folder names containing glob metacharacters.
  const root = escapeGlob(
    (folder.scheme === "file" ? folder.fsPath : folder.path)
      .replace(/\\/g, "/")
      .replace(/\/$/, ""),
  );
  return `${root}/**/*`;
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
