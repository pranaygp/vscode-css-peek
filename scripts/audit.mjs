import { readFile } from "node:fs/promises";
import lockfile from "@yarnpkg/lockfile";

// Query exact installed versions from Yarn's lockfile, including workspace and
// development dependencies. This avoids generating a second, divergent lockfile.
const packages = {};
for (const path of process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["yarn.lock"]) {
  const parsed = lockfile.parse(await readFile(path, "utf8"));
  if (parsed.type !== "success") throw new Error(`Invalid lockfile: ${path}`);
  for (const [selector, { version }] of Object.entries(parsed.object)) {
    const alias = selector.indexOf("@npm:");
    const name = selector.slice(
      alias < 0 ? 0 : alias + 5,
      selector.lastIndexOf("@"),
    );
    if (version) (packages[name] ??= new Set()).add(version);
  }
}
const response = await fetch(
  "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      Object.fromEntries(
        Object.entries(packages).map(([name, versions]) => [
          name,
          [...versions],
        ]),
      ),
    ),
    signal: AbortSignal.timeout(60000),
  },
);
if (!response.ok)
  throw new Error(`npm security audit failed: HTTP ${response.status}`);
const advisories = Object.entries(await response.json()).flatMap(
  ([name, entries]) => entries.map((entry) => ({ ...entry, name })),
);
for (const advisory of advisories) {
  console.log(
    `${advisory.severity}: ${advisory.name} ${[...packages[advisory.name]].join(", ")} (${advisory.vulnerable_versions}): ${advisory.title}\n  ${advisory.url}`,
  );
}
const blocking = advisories.filter(({ severity }) =>
  ["moderate", "high", "critical"].includes(severity),
);
console.log(
  `Audited ${Object.keys(packages).length} packages: ${advisories.length} advisories (${blocking.length} moderate or higher).`,
);
if (blocking.length) process.exitCode = 1;
