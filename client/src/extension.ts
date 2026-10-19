import * as path from "path";
import { ExtensionContext } from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import { activateWithClientFactory } from "./extensionRuntime";

export { deactivate } from "./extensionRuntime";

export function activate(context: ExtensionContext): void {
  const module = context.asAbsolutePath(path.join("dist", "server.js"));
  activateWithClientFactory(context, (options, debugPort) => {
    return new LanguageClient(
      "css-peek",
      "CSS Peek",
      {
        run: { module, transport: TransportKind.ipc },
        debug: {
          module,
          transport: TransportKind.ipc,
          options: { execArgv: ["--nolazy", `--inspect=${debugPort}`] },
        },
      },
      options,
    );
  });
}
