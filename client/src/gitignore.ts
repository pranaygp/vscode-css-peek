import { workspace as Workspace, Uri } from "vscode";

/**
 * Convert a single `.gitignore` pattern line into one or more VS Code glob
 * patterns.
 *
 * Lines explicitly skipped (returns an empty array):
 *   - blank lines (after trimming)
 *   - comments (lines starting with `#`)
 *   - negation lines (lines starting with `!`)
 *   - lines that reduce to an empty pattern after stripping a leading `/`
 *     or trailing `/`
 *
 * All other lines are passed through with minimal rewriting (anchoring,
 * directory-vs-file expansion, bare-name -> `**\/name` lift). This is a
 * best-effort conversion covering the common cases (directory names, file
 * names, simple `*` globs). When the line could match either a file or a
 * directory, we emit both globs since VS Code globs distinguish files from
 * folders.
 *
 * Unsupported gitignore constructs are NOT detected — they are passed
 * through verbatim and may produce wrong or best-effort matches:
 *   - character classes (e.g. `[abc]`, `[!a-z]`)
 *   - escape sequences (`\#`, `\!`, `\ `)
 *   - `**` in positions where gitignore semantics differ from VS Code's
 *     glob semantics (common shapes like `foo/**` and `**\/foo` work;
 *     exotic placements may not)
 */
export function gitignoreLineToGlob(rawLine: string): string[] {
  const line = rawLine.trim();

  if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) {
    return [];
  }

  let pattern = line;

  const isDirectoryPattern = pattern.endsWith("/");
  if (isDirectoryPattern) {
    pattern = pattern.slice(0, -1);
  }

  const isAnchored = pattern.startsWith("/");
  if (isAnchored) {
    pattern = pattern.slice(1);
  }

  if (pattern.length === 0) {
    return [];
  }

  // Patterns with a slash are workspace-root-relative; bare names match
  // anywhere in the tree.
  const base = isAnchored || pattern.includes("/") ? pattern : `**/${pattern}`;

  // A directory marker (`foo/`) only matches the directory and its contents.
  // Without it, gitignore matches both files and directories — emit both.
  if (isDirectoryPattern) {
    return [`${base}/**`];
  }
  return [base, `${base}/**`];
}

/**
 * Read the workspace root's `.gitignore` and return a set of VS Code glob
 * patterns that approximate its semantics.
 *
 * Uses `vscode.workspace.fs` (rather than Node `fs`) so the reader itself
 * is not tied to local disk. Note: the extension as a whole does not yet
 * declare virtual-workspace support — see `capabilities.virtualWorkspaces`
 * in `package.json` and the server's direct `fs` usage. Returns an empty
 * array if the file does not exist or cannot be read.
 */
export async function readGitignoreGlobs(
  workspaceRoot: Uri
): Promise<string[]> {
  const gitignoreUri = Uri.joinPath(workspaceRoot, ".gitignore");

  let bytes: Uint8Array;
  try {
    bytes = await Workspace.fs.readFile(gitignoreUri);
  } catch {
    return [];
  }

  const content = Buffer.from(bytes).toString("utf-8");
  const globs = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    for (const glob of gitignoreLineToGlob(line)) {
      globs.add(glob);
    }
  }
  return Array.from(globs);
}
