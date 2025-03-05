import { RemoteConsole } from "vscode-languageserver/node";
// import TelemetryReporter from "@vscode/extension-telemetry";

const INSTRUMENTATION_KEY = "7868ce95-465b-4f61-a5f9-99a12abfb3ad";

export let console: RemoteConsole = null;
// export let reporter: TelemetryReporter = null;

export function create(nConsole: RemoteConsole) {
  console = nConsole;
  // reporter = new TelemetryReporter(INSTRUMENTATION_KEY);
}
