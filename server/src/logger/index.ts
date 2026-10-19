import type { RemoteConsole } from "vscode-languageserver";

export let console: Pick<RemoteConsole, "log"> = { log: () => {} };
export function create(nConsole: RemoteConsole, verbose = false) {
  console = { log: verbose ? nConsole.log.bind(nConsole) : () => {} };
}
