export interface FolderUri {
  scheme: string;
  authority: string;
  path: string;
}

export function isWithinFolder(uri: FolderUri, folder: FolderUri): boolean {
  if (uri.scheme !== folder.scheme || uri.authority !== folder.authority)
    return false;
  let pathname = uri.path.replace(/\/$/, "");
  let root = folder.path.replace(/\/$/, "");
  if (uri.scheme === "file" && /^\/[a-z]:/i.test(folder.path)) {
    pathname = pathname.toLowerCase();
    root = root.toLowerCase();
  }
  return pathname === root || pathname.startsWith(root + "/");
}

/** Explicit nested workspace roots own their documents independently. */
export function nearestWorkspaceFolder<T extends { uri: FolderUri }>(
  uri: FolderUri,
  folders: readonly T[],
): T | undefined {
  let nearest: T | undefined;
  for (const folder of folders) {
    if (
      isWithinFolder(uri, folder.uri) &&
      (!nearest || folder.uri.path.length > nearest.uri.path.length)
    )
      nearest = folder;
  }
  return nearest;
}
