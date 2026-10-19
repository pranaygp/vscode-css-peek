import * as assert from "assert";
import {
  isWithinFolder,
  nearestWorkspaceFolder,
} from "../../client/out/workspaceFolders";

const uri = (path: string, scheme = "file", authority = "") => ({
  path,
  scheme,
  authority,
});

suite("Workspace document ownership", () => {
  test("a nested explicit root owns its documents instead of the outer root", () => {
    const outer = { uri: uri("/workspace/site") };
    const nested = { uri: uri("/workspace/site/packages/child") };
    const sibling = { uri: uri("/workspace/site-two") };
    assert.strictEqual(
      nearestWorkspaceFolder(
        uri("/workspace/site/packages/child/src/index.html"),
        [outer, sibling, nested],
      ),
      nested,
    );
    assert.strictEqual(
      nearestWorkspaceFolder(uri("/workspace/site/index.html"), [
        nested,
        outer,
      ]),
      outer,
    );
    assert.strictEqual(
      nearestWorkspaceFolder(uri("/workspace/site-two/index.html"), [
        outer,
        sibling,
      ]),
      sibling,
    );
  });

  test("routing falls back to the outer root after removing the nested root", () => {
    const outer = { uri: uri("/workspace/site") };
    const nested = { uri: uri("/workspace/site/child") };
    const document = uri("/workspace/site/child/style.css");
    assert.strictEqual(
      nearestWorkspaceFolder(document, [outer, nested]),
      nested,
    );
    assert.strictEqual(nearestWorkspaceFolder(document, [outer]), outer);
  });

  test("virtual folder routing preserves authority and case sensitivity", () => {
    const outer = { uri: uri("/repo", "vscode-vfs", "github") };
    const nested = { uri: uri("/repo/child", "vscode-vfs", "github") };
    assert.strictEqual(
      nearestWorkspaceFolder(
        uri("/repo/child/style.css", "vscode-vfs", "github"),
        [outer, nested],
      ),
      nested,
    );
    assert.strictEqual(
      nearestWorkspaceFolder(
        uri("/repo/child/style.css", "vscode-vfs", "other"),
        [outer, nested],
      ),
      undefined,
    );
    assert.strictEqual(
      nearestWorkspaceFolder(uri("/Repo/style.css", "vscode-vfs", "github"), [
        outer,
      ]),
      undefined,
    );
  });

  test("Windows folder paths ignore casing and root path separators stay bounded", () => {
    assert.strictEqual(
      isWithinFolder(
        uri("/c:/Projects/Site/style.css"),
        uri("/C:/projects/site/"),
      ),
      true,
    );
    assert.strictEqual(
      isWithinFolder(
        uri("/workspace/site-two/style.css"),
        uri("/workspace/site"),
      ),
      false,
    );
    assert.strictEqual(
      isWithinFolder(
        uri("/style.css", "memfs", "root"),
        uri("/", "memfs", "root"),
      ),
      true,
    );
  });
});
