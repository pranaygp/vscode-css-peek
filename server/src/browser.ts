import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/browser";
import { startServer } from "./server";

const worker = self as unknown as DedicatedWorkerGlobalScope;
startServer(
  createConnection(
    ProposedFeatures.all,
    new BrowserMessageReader(worker),
    new BrowserMessageWriter(worker),
  ),
);
