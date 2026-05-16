import { workspace as Workspace, Uri } from "vscode";

/**
 * Convert a single `.gitignore` pattern line into one or more VS Code glob
 * patterns.
 *
 * Returns an empty array for lines that should be skipped (blank, comment,
 * negation, or patterns we can't represent as a simple glob).
 *
 * Best-effort conversion covering common cases (directory names, file names,
 * simple globs). When the line could match either a file or a directory, we
 * emit both globs since VS Code globs distinguish files from folders.
 *
 * Known limitations: negation lines (`!pattern`), character classes, and
 * patterns with `**` semantics that differ from gitignore are not handled.
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
 * Uses `vscode.workspace.fs` so it works in virtual workspaces. Returns an
 * empty array if the file does not exist or cannot be read.
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
