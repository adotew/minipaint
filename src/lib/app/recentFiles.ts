export type RecentFile = {
  path: string;
  name: string;
};

const RECENT_FILES_KEY = "minipaint.recentFiles";
const MAX_RECENT_FILES = 8;

export function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function stripProjectExtension(name: string) {
  return name.replace(/\.minipaint$/i, "");
}

export function loadRecentFiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentFile => {
        return Boolean(
          item &&
            typeof item === "object" &&
            "path" in item &&
            "name" in item &&
            typeof item.path === "string" &&
            typeof item.name === "string",
        );
      })
      .map((item) => ({ ...item, name: stripProjectExtension(item.name) }))
      .slice(0, MAX_RECENT_FILES);
  } catch {
    return [];
  }
}

export function saveRecentFiles(files: RecentFile[]) {
  localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
}

export function addRecentFileToList(files: RecentFile[], path: string) {
  const existing = files.find((item) => item.path === path);
  const file = {
    path,
    name: existing?.name ?? stripProjectExtension(fileNameFromPath(path)),
  };
  return [file, ...files.filter((item) => item.path !== path)].slice(0, MAX_RECENT_FILES);
}

export function renameRecentFileInList(files: RecentFile[], path: string, newPath: string, fallbackName: string) {
  return files.map((item) =>
    item.path === path
      ? { path: newPath, name: stripProjectExtension(fileNameFromPath(newPath)) || fallbackName }
      : item,
  );
}

export function renameRecentFileLocally(files: RecentFile[], path: string, name: string) {
  return files.map((item) =>
    item.path === path ? { ...item, name } : item,
  );
}

export function removeRecentFileFromList(files: RecentFile[], path: string) {
  return files.filter((item) => item.path !== path);
}
