import { minimatch } from "minimatch";

export function workspaceRootUri(params: {
  rootUri?: string | null;
  workspaceFolders?: Array<{ uri: string }> | null;
  initializationOptions?: { workspaceRootUri?: string | null };
}): string | null {
  if (params.initializationOptions?.workspaceRootUri !== undefined) {
    return params.initializationOptions.workspaceRootUri;
  }
  // The language client's legacy rootUri can be converted to a file URI.
  // Workspace folders retain the actual remote/virtual provider's scheme.
  return params.workspaceFolders?.[0]?.uri || params.rootUri || null;
}

/** Match target exclusions consistently for disk, remote and virtual URIs. */
export function isStylesheetInScope(
  uri: string,
  workspaceRoot: string | null | undefined,
  excludes: string[],
): boolean {
  try {
    const resource = new URL(uri);
    const pathname = decodeURIComponent(resource.pathname);
    const windows =
      resource.protocol === "file:" && /^\/[a-z]:/i.test(pathname);
    let relative = pathname;
    if (workspaceRoot) {
      const root = new URL(workspaceRoot);
      const rootPath =
        decodeURIComponent(root.pathname).replace(/\/$/, "") + "/";
      const scopedPath = windows ? pathname.toLowerCase() : pathname;
      const prefix = windows ? rootPath.toLowerCase() : rootPath;
      if (
        resource.protocol !== root.protocol ||
        resource.host !== root.host ||
        !scopedPath.startsWith(prefix)
      )
        return false;
      relative = pathname.slice(rootPath.length);
    }
    return !excludes.some((glob) =>
      [uri, pathname, relative].some((value) =>
        minimatch(value, glob, { dot: true, nocase: windows }),
      ),
    );
  } catch {
    // A malformed URI cannot identify a stylesheet in this workspace.
    return false;
  }
}
