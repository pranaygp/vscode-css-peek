import * as assert from "assert";
import {
  isStylesheetInScope,
  workspaceRootUri,
} from "../../server/out/utils/stylesheetScope";

suite("Stylesheet workspace scope", () => {
  test("prefers the actual virtual workspace URI over a coerced legacy file root", () => {
    const root = workspaceRootUri({
      rootUri: "file:///",
      workspaceFolders: [{ uri: "vscode-test-web://mount/" }],
    });
    assert.strictEqual(root, "vscode-test-web://mount/");
    assert.strictEqual(
      isStylesheetInScope("vscode-test-web://mount/web.css", root, []),
      true,
    );
    assert.strictEqual(
      workspaceRootUri({ rootUri: "file:///workspace", workspaceFolders: [] }),
      "file:///workspace",
    );
    assert.strictEqual(workspaceRootUri({ rootUri: null }), null);
    assert.strictEqual(
      workspaceRootUri({
        rootUri: "file:///workspace",
        workspaceFolders: [{ uri: "file:///workspace" }],
        initializationOptions: { workspaceRootUri: null },
      }),
      null,
      "untitled clients must not inherit a workspace root",
    );
  });

  test("isolates sibling roots including names sharing a prefix", () => {
    assert.strictEqual(
      isStylesheetInScope(
        "file:///workspace/site/style.css",
        "file:///workspace/site",
        [],
      ),
      true,
    );
    assert.strictEqual(
      isStylesheetInScope(
        "file:///workspace/site-two/style.css",
        "file:///workspace/site",
        [],
      ),
      false,
    );
  });

  test("uses root-relative exclusions for initial and opened stylesheets", () => {
    const root = "file:///workspace/site";
    assert.strictEqual(
      isStylesheetInScope(`${root}/generated/main.css`, root, ["generated/**"]),
      false,
    );
    assert.strictEqual(
      isStylesheetInScope(`${root}/src/main.css`, root, ["generated/**"]),
      true,
    );
    assert.strictEqual(
      isStylesheetInScope(`${root}/.cache/main.css`, root, ["**/.cache/**"]),
      false,
    );
  });

  test("decodes escaped paths before matching anchored exclusions", () => {
    const root = "file:///workspace/my%20site";
    assert.strictEqual(
      isStylesheetInScope(`${root}/generated%20styles/main.css`, root, [
        "generated styles/**",
      ]),
      false,
    );
    assert.strictEqual(
      isStylesheetInScope(`${root}/src/main.css`, root, []),
      true,
    );
  });

  test("accepts Windows drive and folder casing differences", () => {
    assert.strictEqual(
      isStylesheetInScope(
        "file:///c:/Projects/Site/src/style.css",
        "file:///C:/projects/site",
        [],
      ),
      true,
    );
    assert.strictEqual(
      isStylesheetInScope(
        "file:///c:/Projects/Site/BUILD/style.css",
        "file:///C:/projects/site",
        ["build/**"],
      ),
      false,
    );
    assert.strictEqual(
      isStylesheetInScope(
        "file:///d:/Projects/Site/style.css",
        "file:///C:/Projects/Site",
        [],
      ),
      false,
    );
  });

  test("keeps virtual paths case sensitive and isolates scheme and authority", () => {
    const root = "vscode-vfs://github/owner/repo";
    assert.strictEqual(
      isStylesheetInScope(`${root}/src/style.css`, root, []),
      true,
    );
    assert.strictEqual(
      isStylesheetInScope(`${root}/SRC/style.css`, root, ["src/**"]),
      true,
    );
    assert.strictEqual(
      isStylesheetInScope(
        "vscode-vfs://other/owner/repo/src/style.css",
        root,
        [],
      ),
      false,
    );
    assert.strictEqual(
      isStylesheetInScope("memfs://github/owner/repo/src/style.css", root, []),
      false,
    );
    assert.strictEqual(
      isStylesheetInScope("vscode-vfs://github/owner/Repo/style.css", root, []),
      false,
    );
  });

  test("rejects malformed URIs and supports untitled documents without a root", () => {
    assert.strictEqual(
      isStylesheetInScope("invalid URI", "file:///workspace", []),
      false,
    );
    assert.strictEqual(
      isStylesheetInScope("untitled:Untitled-1", undefined, []),
      true,
    );
  });
});
