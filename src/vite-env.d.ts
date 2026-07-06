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
    saveProjectFile: (bytes: ArrayBuffer) => Promise<boolean>;
    openProjectFile: () => Promise<ArrayBuffer | null>;
  };
}
