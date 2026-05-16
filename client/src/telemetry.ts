import TelemetryReporter from "@vscode/extension-telemetry";

const INSTRUMENTATION_KEY = "7868ce95-465b-4f61-a5f9-99a12abfb3ad";

let reporter: TelemetryReporter | null = null;
let telemetryEnabled = true;

export function initializeReporter(enabled: boolean): TelemetryReporter {
  telemetryEnabled = enabled;
  reporter = new TelemetryReporter(INSTRUMENTATION_KEY);
  return reporter;
}

export function setTelemetryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
}

export function sendTelemetryEvent(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
): void {
  if (!telemetryEnabled || !reporter) {
    return;
  }
  reporter.sendTelemetryEvent(eventName, properties, measurements);
}

export function sendTelemetryErrorEvent(
  eventName: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
): void {
  if (!telemetryEnabled || !reporter) {
    return;
  }
  reporter.sendTelemetryErrorEvent(eventName, properties, measurements);
}
