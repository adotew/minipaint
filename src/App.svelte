<script lang="ts">
  import { onMount } from "svelte";
  import ColorPicker from "./lib/ColorPicker.svelte";
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

  // Panel drag state
  let translate = $state({ x: 0, y: 0 });
  let dragStart = { x: 0, y: 0 };
  let translateStart = { x: 0, y: 0 };
  let isDragging = $state(false);

  onMount(() => {
    recentFiles = loadRecentFiles();
  });

  function onHandlePointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    translateStart = { ...translate };
    window.addEventListener("pointermove", onHandlePointerMove);
    window.addEventListener("pointerup", onHandlePointerUp, { once: true });
  }

  function onHandlePointerMove(e: PointerEvent) {
    translate = {
      x: translateStart.x + (e.clientX - dragStart.x),
      y: translateStart.y + (e.clientY - dragStart.y),
    };
  }

  function onHandlePointerUp(_e: PointerEvent) {
    isDragging = false;
    window.removeEventListener("pointermove", onHandlePointerMove);
  }

  function makeProjectFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `minipaint-${timestamp}.minipaint`;
  }

  function focusNode(node: HTMLElement) {
    node.focus();
    node.select();
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
  <div
    role="alert"
    class="fixed left-4 top-16 z-[110] max-w-sm rounded-lg bg-red-950/95 px-3 py-2 text-sm text-red-100 shadow-2xl [-webkit-app-region:no-drag]"
  >
    {actionError}
  </div>
{/if}

{#if !showStartPage}
  <div
    class="fixed top-4 right-4 z-50 flex flex-col gap-3 rounded-xl bg-zinc-900 p-4 shadow-2xl [-webkit-app-region:no-drag]"
    class:cursor-grabbing={isDragging}
    style="transform: translate({translate.x}px, {translate.y}px);"
  >
    <!-- Dotted drag handle -->
    <div class="relative flex items-center justify-center">
      <div class="flex gap-1">
        {#each Array(5) as _}
          <div class="h-1 w-1 rounded-full bg-zinc-500"></div>
        {/each}
      </div>
      <!-- Larger invisible hitbox; visual dots stay the same size/position -->
      <div
        role="button"
        tabindex="-1"
        aria-label="Drag to move panel"
        class="absolute inset-x-0 top-1/2 h-8 -translate-y-1/2 cursor-grab active:cursor-grabbing"
        onpointerdown={onHandlePointerDown}
      ></div>
    </div>

    <ColorPicker {color} onchange={(c: string) => (color = c)} />
  </div>
{/if}

<WebGPUCanvas bind:this={webgpuCanvas} bind:color bind:brushSize />

{#if showStartPage}
  <div class="fixed inset-0 z-[100] flex flex-col bg-zinc-800 text-zinc-100 [-webkit-app-region:no-drag]">
    <header class="flex h-16 shrink-0 items-center justify-end bg-zinc-800 px-8">
      <button
        class="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-700 text-zinc-100 shadow-sm hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
        type="button"
        aria-label="New canvas"
        disabled={!webgpuCanvas}
        onclick={openNewCanvasDialog}
      >
        <svg aria-hidden="true" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>
    </header>

    <main class="min-h-0 flex-1 overflow-y-auto px-8 py-7">
      <div class="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {#each recentFiles as file (file.path)}
          <article class="relative min-w-0">
            <button
              class="w-full text-left"
              type="button"
              aria-label={`Open ${file.name}`}
              onclick={() => void openProject(file.path)}
            >
              <div class="relative aspect-[4/3] rounded-lg bg-white shadow-md ring-1 ring-zinc-700/70"></div>
            </button>
            {#if renamingPath === file.path}
              <form
                class="mt-3 flex items-center gap-1"
                onsubmit={(e) => {
                  e.preventDefault();
                  void confirmRename(file.path);
                }}
              >
                <input
                  class="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                  type="text"
                  use:focusNode
                  bind:value={renameDraft}
                  onkeydown={(e) => {
                    if (e.key === "Escape") cancelRename();
                  }}
                />
                <button
                  class="shrink-0 rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-white"
                  type="submit"
                >
                  Save
                </button>
                <button
                  class="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  type="button"
                  onclick={cancelRename}
                >
                  Cancel
                </button>
              </form>
            {:else}
              <div class="mt-3 flex items-center gap-1">
                <button
                  class="min-w-0 flex-1 truncate text-left text-sm font-medium text-zinc-100"
                  type="button"
                  onclick={() => void openProject(file.path)}
                >
                  {file.name}
                </button>
                <button
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                  type="button"
                  aria-label="File options"
                  onclick={(e) => toggleRecentMenu(e, file.path)}
                >
                  <svg aria-hidden="true" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </button>
              </div>
            {/if}
            {#if recentMenuPath === file.path}
              <div
                class="absolute right-0 top-full z-10 mt-1 min-w-32 rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-sm shadow-xl"
                role="menu"
                tabindex="-1"
              >
                <button
                  class="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  type="button"
                  role="menuitem"
                  onclick={() => startRename(file.path, file.name)}
                >
                  Rename
                </button>
                <button
                  class="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                  type="button"
                  role="menuitem"
                  onclick={() => removeRecentFile(file.path)}
                >
                  Remove
                </button>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    </main>

    {#if showCanvasDialog}
      <div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 px-4">
        <button
          class="absolute inset-0"
          type="button"
          aria-label="Close canvas size dialog"
          onclick={() => (showCanvasDialog = false)}
        ></button>
        <form
          class="relative w-80 rounded-xl bg-zinc-900 p-4 text-zinc-100 shadow-2xl ring-1 ring-zinc-700"
          onsubmit={(e) => {
            e.preventDefault();
            createNewCanvas();
          }}
        >
          <div class="mb-4 text-sm font-medium">Canvas size</div>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-xs text-zinc-400">
              Width
              <input
                class="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                type="number"
                min="64"
                max="8000"
                step="1"
                bind:value={newCanvasWidth}
              />
            </label>
            <label class="text-xs text-zinc-400">
              Height
              <input
                class="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                type="number"
                min="64"
                max="8000"
                step="1"
                bind:value={newCanvasHeight}
              />
            </label>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <button
              class="rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
              type="button"
              onclick={() => (showCanvasDialog = false)}
            >
              Cancel
            </button>
            <button
              class="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
              type="submit"
              disabled={!webgpuCanvas}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    {/if}
  </div>
{/if}
