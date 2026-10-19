import { ExtensionContext, Uri } from "vscode";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
  LanguageClient,
} from "vscode-languageclient/browser";
import { activateWithClientFactory } from "./extensionRuntime";
import { closeOnWorkerError } from "./workerLifecycle";

export { deactivate } from "./extensionRuntime";

class RestartableWorkerReader extends BrowserMessageReader {
  private readonly removeWorkerListeners: () => void;

  constructor(worker: Worker) {
    super(worker);
    // The library reader reports an error but never closes a failed worker's
    // transport, leaving requests pending indefinitely. Closing it invokes
    // the language client's normal, bounded server restart policy.
    this.removeWorkerListeners = closeOnWorkerError(worker, () =>
      this.fireClose(),
    );
  }

  override dispose(): void {
    this.removeWorkerListeners();
    super.dispose();
  }
}

export function activate(context: ExtensionContext): void {
  activateWithClientFactory(context, (options) => {
    let worker: Worker | undefined;
    class BrowserClient extends LanguageClient {
      override async dispose(timeout?: number): Promise<void> {
        try {
          await super.dispose(timeout);
        } finally {
          worker?.terminate();
          worker = undefined;
        }
      }
    }
    return new BrowserClient(
      "css-peek",
      "CSS Peek",
      async () => {
        // Restarting a crashed server must release its previous worker too.
        worker?.terminate();
        worker = new Worker(
          Uri.joinPath(
            context.extensionUri,
            "dist",
            "server-browser.js",
          ).toString(),
        );
        worker.addEventListener("error", (event) => {
          options.outputChannel?.error(
            `Language server worker failed: ${event.message}`,
          );
        });
        return {
          reader: new RestartableWorkerReader(worker),
          writer: new BrowserMessageWriter(worker),
        };
      },
      options,
    );
  });
}
