import { build } from "esbuild";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isBuiltin } from "node:module";

await mkdir("dist", { recursive: true });
const common = {
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: "external",
  metafile: true,
  logLevel: "info",
  target: "es2022",
  // The language services' UMD entry uses a forwarded require parameter that
  // bundlers cannot follow. Resolve their ESM entry to include every dependency.
  mainFields: ["module", "main"],
};
const results = await Promise.all([
  build({
    ...common,
    entryPoints: ["client/src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: ["server/src/node.ts"],
    outfile: "dist/server.js",
    platform: "node",
    format: "cjs",
  }),
  build({
    ...common,
    entryPoints: ["client/src/browser.ts"],
    outfile: "dist/extension-browser.js",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    format: "cjs",
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: ["server/src/browser.ts"],
    outfile: "dist/server-browser.js",
    platform: "browser",
    mainFields: ["browser", "module", "main"],
    format: "iife",
  }),
]);
for (const { metafile } of results) {
  for (const [path, { imports }] of Object.entries(metafile.outputs)) {
    for (const entry of imports.filter(({ external }) => external)) {
      if (entry.path !== "vscode" && !isBuiltin(entry.path)) {
        throw new Error(
          `${path} has an unbundled runtime dependency: ${entry.path}`,
        );
      }
      if (path.includes("browser") && entry.path !== "vscode") {
        throw new Error(`${path} imports a Node module: ${entry.path}`);
      }
    }
  }
}
await writeFile(
  "dist/metafile.json",
  JSON.stringify(
    results.map(({ metafile }) => metafile),
    null,
    2,
  ),
);

// Retain licenses for dependencies included in the bundles, even when their
// source comments are removed by minification.
const packages = new Map();
for (const { metafile } of results) {
  for (const input of Object.keys(metafile.inputs).filter((path) =>
    path.includes("node_modules/"),
  )) {
    let directory = dirname(input);
    while (directory !== ".") {
      try {
        const pkg = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (!pkg.name) throw new Error("Not a package root");
        const key = `${pkg.name}@${pkg.version}`;
        if (!packages.has(key)) {
          const files = (await readdir(directory)).filter((file) =>
            /^(licen[cs]e|notice)(\.|$)/i.test(file),
          );
          const license = await Promise.all(
            files.sort().map((file) => readFile(join(directory, file), "utf8")),
          );
          packages.set(
            key,
            `${key}\nLicense: ${pkg.license || "see source"}\n${license.join("\n")}`,
          );
        }
        break;
      } catch {
        directory = dirname(directory);
      }
    }
  }
}
await writeFile(
  "dist/THIRD_PARTY_NOTICES.txt",
  [...packages.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text)
    .join("\n\n---\n\n"),
);
