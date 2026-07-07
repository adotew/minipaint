<script lang="ts">
  import { onMount } from "svelte";
  import ActionError from "./lib/ActionError.svelte";
  import ColorPanel from "./lib/ColorPanel.svelte";
  import NewCanvasDialog from "./lib/NewCanvasDialog.svelte";
  import StartPage from "./lib/StartPage.svelte";
  import WebGPUCanvas from "./lib/WebGPUCanvas.svelte";
  import {
    addRecentFileToList,
    fileNameFromPath,
    loadRecentFiles,
    removeRecentFileFromList,
    renameRecentFileInList,
    renameRecentFileLocally,
    saveRecentFiles,
    stripProjectExtension,
    type RecentFile,
  } from "./lib/app/recentFiles";

  let color = $state("#aabbcc");
  let brushSize = $state(10);

  type CanvasHandle = {
    newProject: (width?: number, height?: number) => void;
    exportAsPng: () => Promise<void>;
    saveProject: () => Promise<Blob>;
    loadProject: (blob: Blob) => Promise<{ width: number; height: number }>;
  };

  type OpenProjectResult = {
    path: string;
    bytes: ArrayBuffer;
  };

  let webgpuCanvas: CanvasHandle | undefined = $state();
  let isExporting = $state(false);
  let isSaving = $state(false);
  let actionError = $state<string | null>(null);
  let showStartPage = $state(true);
  let showCanvasDialog = $state(false);
  let newCanvasWidth = $state(4000);
  let newCanvasHeight = $state(4000);
  let currentCanvasWidth = $state(4000);
  let currentCanvasHeight = $state(4000);
  let recentFiles = $state<RecentFile[]>([]);
  let currentProjectPath = $state<string | null>(null);
  let recentMenuPath = $state<string | null>(null);
  let renamingPath = $state<string | null>(null);
  let renameDraft = $state("");

  onMount(() => {
    recentFiles = loadRecentFiles();
  });

  function makeProjectFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `minipaint-${timestamp}.minipaint`;
  }

  function addRecentFile(path: string) {
    recentFiles = addRecentFileToList(recentFiles, path);
    saveRecentFiles(recentFiles);
  }

  function startRename(path: string, currentName: string) {
    renamingPath = path;
    renameDraft = currentName;
    recentMenuPath = null;
  }

  function cancelRename() {
    renamingPath = null;
    renameDraft = "";
  }

  async function confirmRename(path: string) {
    actionError = null;
    const newName = renameDraft.trim();
    if (!newName || recentFiles.find((item) => item.path === path)?.name === newName) {
      cancelRename();
      return;
    }

    try {
      const rename = window.minipaint?.renameProjectFile;
      if (rename) {
        const newPath = await rename(path, newName);
        if (!newPath) {
          cancelRename();
          return;
        }
        recentFiles = renameRecentFileInList(recentFiles, path, newPath, newName);
        if (currentProjectPath === path) currentProjectPath = newPath;
      } else {
        recentFiles = renameRecentFileLocally(recentFiles, path, newName);
      }
      saveRecentFiles(recentFiles);
      cancelRename();
    } catch (e) {
      console.error(e);
      actionError = e instanceof Error ? e.message : "Failed to rename project.";
    }
  }

  function removeRecentFile(path: string) {
    recentFiles = removeRecentFileFromList(recentFiles, path);
    saveRecentFiles(recentFiles);
    if (recentMenuPath === path) recentMenuPath = null;
  }

  function toggleRecentMenu(e: MouseEvent, path: string) {
    e.stopPropagation();
    recentMenuPath = recentMenuPath === path ? null : path;
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openNewCanvasDialog() {
    actionError = null;
    showCanvasDialog = true;
  }

  function createNewCanvas() {
    actionError = null;

    try {
      if (!webgpuCanvas) throw new Error("Canvas is not ready yet.");
      webgpuCanvas.newProject(newCanvasWidth, newCanvasHeight);
      currentCanvasWidth = Math.round(Math.max(64, Math.min(8000, newCanvasWidth)));
      currentCanvasHeight = Math.round(Math.max(64, Math.min(8000, newCanvasHeight)));
      currentProjectPath = null;
      showCanvasDialog = false;
      showStartPage = false;
    } catch (e) {
      console.error(e);
      actionError = e instanceof Error ? e.message : "Failed to create canvas.";
    }
  }

  async function exportPng() {
    if (isExporting) return;

    isExporting = true;
    actionError = null;

    try {
      if (!webgpuCanvas) throw new Error("Canvas is not ready to export yet.");
      await webgpuCanvas.exportAsPng();
    } catch (e) {
      console.error(e);
      actionError = e instanceof Error ? e.message : "Failed to export PNG.";
    } finally {
      isExporting = false;
    }
  }

  async function saveProject() {
    if (isSaving) return;

    isSaving = true;
    actionError = null;

    try {
      if (!webgpuCanvas) throw new Error("Canvas is not ready to save yet.");
      const blob = await webgpuCanvas.saveProject();
      const bytes = await blob.arrayBuffer();
      const savedPath = await window.minipaint?.saveProjectFile?.(bytes, currentProjectPath);
      if (savedPath === undefined) {
        downloadBlob(blob, makeProjectFilename());
      } else if (savedPath) {
        currentProjectPath = savedPath;
        addRecentFile(savedPath);
      }
    } catch (e) {
      console.error(e);
      actionError = e instanceof Error ? e.message : "Failed to save project.";
    } finally {
      isSaving = false;
    }
  }

  async function loadProjectResult(result: OpenProjectResult) {
    if (!webgpuCanvas) throw new Error("Canvas is not ready to open a project yet.");
    const info = await webgpuCanvas.loadProject(new Blob([result.bytes], { type: "application/x-minipaint" }));
    currentCanvasWidth = info.width;
    currentCanvasHeight = info.height;
    currentProjectPath = result.path;
    addRecentFile(result.path);
    showStartPage = false;
  }

  async function openProject(path: string | undefined = undefined) {
    actionError = null;

    try {
      recentMenuPath = null;
      const result = path
        ? await window.minipaint?.openRecentProjectFile?.(path)
        : await window.minipaint?.openProjectFile?.();
      if (!result) return;
      await loadProjectResult(result);
    } catch (e) {
      console.error(e);
      actionError = e instanceof Error ? e.message : "Failed to open project.";
    }
  }

  $effect(() => {
    function onWindowClick() {
      recentMenuPath = null;
    }

    function onWindowKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") recentMenuPath = null;
    }

    window.addEventListener("click", onWindowClick);
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("click", onWindowClick);
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  });

  $effect(() => {
    const name = currentProjectPath
      ? stripProjectExtension(fileNameFromPath(currentProjectPath))
      : "Untitled";
    document.title = showStartPage
      ? "minipaint"
      : `${name} · ${currentCanvasWidth} × ${currentCanvasHeight}`;
  });

  $effect(() => {
    const unsubscribeExport = window.minipaint?.onExportPng(() => {
      void exportPng();
    });
    const unsubscribeSave = window.minipaint?.onSaveProject?.(() => {
      void saveProject();
    });
    const unsubscribeOpen = window.minipaint?.onOpenProject?.(() => {
      void openProject();
    });
    const unsubscribeGallery = window.minipaint?.onShowGallery?.(() => {
      showStartPage = true;
      showCanvasDialog = false;
      recentMenuPath = null;
    });

    return () => {
      unsubscribeExport?.();
      unsubscribeSave?.();
      unsubscribeOpen?.();
      unsubscribeGallery?.();
    };
  });
</script>

{#if actionError}
  <ActionError message={actionError} />
{/if}

{#if !showStartPage}
  <ColorPanel bind:color />
{/if}

<WebGPUCanvas bind:this={webgpuCanvas} bind:color bind:brushSize />

{#if showStartPage}
  <StartPage
    {recentFiles}
    canCreateCanvas={Boolean(webgpuCanvas)}
    {recentMenuPath}
    {renamingPath}
    bind:renameDraft
    onnewcanvas={openNewCanvasDialog}
    onopenproject={(path) => void openProject(path)}
    ontogglerecentmenu={toggleRecentMenu}
    onstartrename={startRename}
    onconfirmrename={(path) => void confirmRename(path)}
    oncancelrename={cancelRename}
    onremovefile={removeRecentFile}
  />

  {#if showCanvasDialog}
    <NewCanvasDialog
      bind:width={newCanvasWidth}
      bind:height={newCanvasHeight}
      canCreate={Boolean(webgpuCanvas)}
      onclose={() => (showCanvasDialog = false)}
      oncreate={createNewCanvas}
    />
  {/if}
{/if}
