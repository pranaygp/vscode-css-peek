const { defineConfig } = require("@vscode/test-cli");

const compatibilityExtensions = [
  "Zignd.html-css-class-completion",
  "gencer.html-slim-scss-css-class-completion",
];
const compatibilityExtension = process.env.CSS_PEEK_COMPATIBILITY;
if (
  compatibilityExtension &&
  !compatibilityExtensions.includes(compatibilityExtension)
) {
  throw new Error(
    "CSS_PEEK_COMPATIBILITY must name one supported completion extension",
  );
}

module.exports = defineConfig({
  label: "integration-tests",
  version: process.env.VSCODE_VERSION || "stable",
  files: "tests/out/**/*.test.js",
  extensionDevelopmentPath: [".", "tests/languages"],
  workspaceFolder: "tests/fixture.code-workspace",
  launchArgs: [
    ...(compatibilityExtension
      ? compatibilityExtensions
          .filter((id) => id !== compatibilityExtension)
          .flatMap((id) => ["--disable-extension", id])
      : ["--disable-extensions"]),
    "--skip-welcome",
    "--skip-release-notes",
  ],
  mocha: { timeout: 30000 },
});
