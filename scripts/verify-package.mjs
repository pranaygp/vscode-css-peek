import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { setTimeout, clearTimeout } from "node:timers";
import yauzl from "yauzl";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const path = process.argv[2] || `${manifest.name}-${manifest.version}.vsix`;
const archive = await new Promise((resolve, reject) => {
  yauzl.open(path, { lazyEntries: true }, (error, zip) =>
    error ? reject(error) : resolve(zip),
  );
});
const entries = [];
const bundled = new Map();
await new Promise((resolve, reject) => {
  archive.on("error", reject);
  archive.on("end", resolve);
  archive.on("entry", (entry) => {
    entries.push(entry.fileName);
    if (
      ["extension/package.json", "extension/dist/server.js"].includes(
        entry.fileName,
      )
    ) {
      archive.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => {
          bundled.set(entry.fileName, Buffer.concat(chunks).toString());
          archive.readEntry();
        });
      });
    } else {
      if (/^extension\/dist\/.*\.js$/.test(entry.fileName)) {
        assert.ok(
          entry.uncompressedSize > 1000,
          `${entry.fileName} is unexpectedly empty`,
        );
        assert.ok(
          entry.uncompressedSize < 4 * 1024 * 1024,
          `${entry.fileName} exceeds 4 MiB`,
        );
      }
      archive.readEntry();
    }
  });
  archive.readEntry();
});
const packed = JSON.parse(bundled.get("extension/package.json"));
assert.equal(packed.version, manifest.version);
for (const entry of [
  packed.main,
  packed.browser,
  "./dist/server.js",
  "./dist/server-browser.js",
]) {
  assert.ok(
    entries.includes(`extension/${entry.replace(/^\.\//, "")}`),
    `Missing runtime entry: ${entry}`,
  );
}
assert.ok(
  entries.every(
    (entry) =>
      !/node_modules\/|\.ts$|\.map$|\/tests\/|metafile\.json$/.test(entry),
  ),
  "VSIX contains development files",
);
assert.ok(
  entries.length < 30,
  `Unexpected package growth: ${entries.length} files`,
);

// Run the server extracted from the VSIX outside the checkout. Development
// node_modules must never conceal a missing bundled runtime dependency.
const directory = await mkdtemp(join(tmpdir(), "css-peek-package-"));
let child;
try {
  const server = join(directory, "server.cjs");
  await writeFile(server, bundled.get("extension/dist/server.js"));
  child = fork(server, ["--node-ipc"], {
    cwd: directory,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_PATH: "" },
  });
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  let nextId = 0;
  const pending = new Map();
  child.on("message", (message) => {
    const callbacks = pending.get(message.id);
    if (!callbacks) return;
    pending.delete(message.id);
    if (message.error)
      callbacks.reject(new Error(JSON.stringify(message.error)));
    else callbacks.resolve(message.result);
  });
  child.on("exit", (code) => {
    for (const { reject } of pending.values())
      reject(new Error(`Packaged server exited (${code}): ${output}`));
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timeout = setTimeout(
        () =>
          reject(new Error(`Packaged server timeout in ${method}: ${output}`)),
        15000,
      );
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.send({ jsonrpc: "2.0", id, method, params });
    });
  const initialized = await request("initialize", {
    processId: null,
    rootUri: "file:///packaged-test",
    capabilities: {},
    initializationOptions: {
      stylesheets: [
        {
          uri: "file:///packaged-test/styles.css",
          languageId: "css",
          text: ".packaged { color: red; }",
        },
      ],
      peekFromLanguages: ["html"],
    },
  });
  assert.equal(initialized.capabilities.definitionProvider, true);
  child.send({ jsonrpc: "2.0", method: "initialized", params: {} });
  child.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///packaged-test/index.html",
        languageId: "html",
        version: 1,
        text: '<div class="packaged"></div><style>.packaged { color: blue; }</style>',
      },
    },
  });
  const definitions = await request("textDocument/definition", {
    textDocument: { uri: "file:///packaged-test/index.html" },
    position: { line: 0, character: 15 },
  });
  assert.ok(
    definitions.some(({ uri }) => uri === "file:///packaged-test/styles.css"),
    "Packaged server failed external CSS lookup",
  );
  assert.ok(
    definitions.some(({ uri }) => uri === "file:///packaged-test/index.html"),
    "Packaged server failed embedded HTML lookup",
  );
  const styleUri = "file:///packaged-test/styles.css";
  child.send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: styleUri,
        languageId: "css",
        version: 1,
        text: ".packaged { color: green; }",
      },
    },
  });
  // A delayed disk read from an earlier close must not replace a reopened
  // editor's unsaved content.
  child.send({
    jsonrpc: "2.0",
    method: "cssPeek/stylesheetClosed",
    params: { uri: styleUri, languageId: "css", text: ".stale {}" },
  });
  const lookup = () =>
    request("textDocument/definition", {
      textDocument: { uri: "file:///packaged-test/index.html" },
      position: { line: 0, character: 15 },
    });
  assert.ok(
    (await lookup()).some(({ uri }) => uri === styleUri),
    "A late close snapshot overwrote an open stylesheet",
  );
  child.send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri: styleUri, version: 2 },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 9 },
          },
          text: "edited",
        },
      ],
    },
  });
  assert.ok(
    (await lookup()).every(({ uri }) => uri !== styleUri),
    "Incremental CSS edits retained a removed selector",
  );
  child.send({
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: {
        uri: "file:///packaged-test/index.html",
        version: 2,
      },
      contentChanges: [
        {
          range: {
            start: { line: 0, character: 12 },
            end: { line: 0, character: 20 },
          },
          text: "edited",
        },
      ],
    },
  });
  assert.ok(
    (await lookup()).some(({ uri }) => uri === styleUri),
    "Incremental markup edits failed to resolve the updated CSS selector",
  );
  await request("shutdown", null);
  child.send({ jsonrpc: "2.0", method: "exit" });
} finally {
  child?.kill();
  await rm(directory, { recursive: true, force: true });
}
console.log(
  `Verified ${path}: ${entries.length} files, all entry points present; isolated packaged server resolves external and embedded CSS without development dependencies.`,
);
