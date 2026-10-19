import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { startServer } from "./server";

startServer(createConnection(ProposedFeatures.all));
