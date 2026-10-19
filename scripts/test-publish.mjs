import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Replace publishing commands with local recorders: these tests never contact
// a registry or use real credentials.
const directory = await mkdtemp(join(tmpdir(), "css-peek-publish-test-"));
try {
  const archive = join(directory, "extension with spaces.vsix");
  const log = join(directory, "commands.jsonl");
  await writeFile(archive, "fixture");
  for (const name of ["yarn", "npx"]) {
    await writeFile(
      join(directory, name),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.PUBLISH_TEST_LOG, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');
if (process.env.FAIL_VERIFY && process.argv[2] === 'verify:package') process.exit(2);
`,
      { mode: 0o755 },
    );
  }
  async function run(registry, credentials = {}, failVerify = false) {
    await writeFile(log, "");
    const env = { ...process.env };
    delete env.VSCE_PAT;
    delete env.OVSX_PAT;
    const result = spawnSync(
      "bash",
      [resolve("publish.sh"), registry, archive],
      {
        env: {
          ...env,
          ...credentials,
          PATH: `${directory}:${process.env.PATH}`,
          PUBLISH_TEST_LOG: log,
          ...(failVerify ? { FAIL_VERIFY: "1" } : {}),
        },
        encoding: "utf8",
      },
    );
    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { status: result.status, commands };
  }
  const verify = ["yarn", "verify:package", archive];
  const marketplace = ["yarn", "vsce", "publish", "--packagePath", archive];
  const openVsx = ["npx", "--yes", "ovsx@1.3.0", "publish", archive];
  const credentials = { VSCE_PAT: "test-only", OVSX_PAT: "test-only" };
  assert.deepEqual(await run("all", credentials), {
    status: 0,
    commands: [verify, marketplace, openVsx],
  });
  assert.deepEqual(await run("marketplace", { VSCE_PAT: "test-only" }), {
    status: 0,
    commands: [verify, marketplace],
  });
  assert.deepEqual(await run("open-vsx", { OVSX_PAT: "test-only" }), {
    status: 0,
    commands: [verify, openVsx],
  });
  for (const registry of ["all", "marketplace", "open-vsx", "unknown"]) {
    const missing = await run(registry);
    assert.notEqual(missing.status, 0);
    assert.deepEqual(missing.commands, []);
  }
  assert.deepEqual(await run("all", credentials, true), {
    status: 2,
    commands: [verify],
  });
  console.log(
    "Publishing checks passed: registry isolation, credentials, quoting, and verification gate.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
