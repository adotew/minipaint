/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module "*?raw" {
  const content: string;
  export default content;
}

interface Window {
  minipaint?: {
    onExportPng: (callback: () => void) => () => void;
    onSaveProject: (callback: () => void) => () => void;
    onOpenProject: (callback: () => void) => () => void;
    onShowGallery: (callback: () => void) => () => void;
    saveProjectFile: (bytes: ArrayBuffer, path?: string | null) => Promise<string | null>;
    openProjectFile: () => Promise<{ path: string; bytes: ArrayBuffer } | null>;
    openRecentProjectFile: (path: string) => Promise<{ path: string; bytes: ArrayBuffer } | null>;
    renameProjectFile: (oldPath: string, newName: string) => Promise<string | null>;
  };
}
