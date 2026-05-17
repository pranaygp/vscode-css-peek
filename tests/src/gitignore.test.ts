import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gitignoreMod = require("../../client/out/gitignore") as {
  gitignoreLineToGlob: (line: string) => string[];
  readGitignoreGlobs: (uri: vscode.Uri) => Promise<string[]>;
};
const { gitignoreLineToGlob, readGitignoreGlobs } = gitignoreMod;

suite("gitignoreLineToGlob", () => {
  test("skips blank lines and comments", () => {
    assert.deepStrictEqual(gitignoreLineToGlob(""), []);
    assert.deepStrictEqual(gitignoreLineToGlob("   "), []);
    assert.deepStrictEqual(gitignoreLineToGlob("# comment"), []);
  });

  test("skips negation lines", () => {
    assert.deepStrictEqual(gitignoreLineToGlob("!keep.css"), []);
  });

  test("unanchored bare names match both files and directories anywhere", () => {
    assert.deepStrictEqual(gitignoreLineToGlob("node_modules"), [
      "**/node_modules",
      "**/node_modules/**",
    ]);
    assert.deepStrictEqual(gitignoreLineToGlob("excluded.css"), [
      "**/excluded.css",
      "**/excluded.css/**",
    ]);
  });

  test("trailing slash matches directories only", () => {
    assert.deepStrictEqual(gitignoreLineToGlob("dist/"), ["**/dist/**"]);
  });

  test("leading slash anchors to workspace root", () => {
    assert.deepStrictEqual(gitignoreLineToGlob("/build"), [
      "build",
      "build/**",
    ]);
    assert.deepStrictEqual(gitignoreLineToGlob("/build/"), ["build/**"]);
  });

  test("nested paths are relative to workspace root", () => {
    assert.deepStrictEqual(gitignoreLineToGlob("packages/foo/dist"), [
      "packages/foo/dist",
      "packages/foo/dist/**",
    ]);
  });

  test("trims whitespace", () => {
    assert.deepStrictEqual(gitignoreLineToGlob("  coverage  "), [
      "**/coverage",
      "**/coverage/**",
    ]);
  });
});

suite("readGitignoreGlobs", () => {
  test("returns empty array when .gitignore is missing", async () => {
    const tmpRoot = vscode.Uri.file(
      path.join(__dirname, `__missing_gitignore_${Date.now()}`)
    );
    const globs = await readGitignoreGlobs(tmpRoot);
    assert.deepStrictEqual(globs, []);
  });

  test("parses .gitignore from the workspace root", async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const globs = await readGitignoreGlobs(root);
    // .gitignore in the test fixture contains `excluded.css`.
    assert.ok(
      globs.includes("**/excluded.css"),
      `expected file glob; got ${JSON.stringify(globs)}`
    );
    assert.ok(
      globs.includes("**/excluded.css/**"),
      `expected dir glob; got ${JSON.stringify(globs)}`
    );
  });
});
