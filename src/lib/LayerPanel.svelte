<script lang="ts">
  import { tick } from "svelte";
  import type { LayerListItem } from "./document/layers";

  interface Props {
    layers: LayerListItem[];
    ondelete: (id: string) => void;
    onselect: (id: string) => void;
    onreorder: (topToBottomIds: string[]) => void;
    onvisiblechange: (id: string, visible: boolean) => void;
    onnamechange: (id: string, name: string) => void;
    onlockedchange: (id: string, locked: boolean) => void;
  }

  let {
    layers,
    ondelete,
    onselect,
    onreorder,
    onvisiblechange,
    onnamechange,
    onlockedchange,
  }: Props = $props();

  let panelEl: HTMLDivElement | undefined = $state();
  let renameInputEl: HTMLInputElement | undefined = $state();
  let translate = $state({ x: 0, y: 0 });
  let dragStart = { x: 0, y: 0 };
  let translateStart = { x: 0, y: 0 };
  let isDragging = $state(false);
  let contextMenu = $state<{ layer: LayerListItem; x: number; y: number } | null>(null);
  let renamingLayerId = $state<string | null>(null);
  let renameValue = $state("");
  let draggedLayerId = $state<string | null>(null);
  let dropTargetLayerId = $state<string | null>(null);
  let dropPosition = $state<"before" | "after">("before");
  let suppressNextClick = false;

  let visibleLayers = $derived(layers.slice().reverse());
  let canDelete = $derived(layers.length > 1);

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

  function onHandlePointerUp() {
    isDragging = false;
    window.removeEventListener("pointermove", onHandlePointerMove);
  }

  function selectLayer(id: string) {
    contextMenu = null;
    onselect(id);
  }

  function openLayerMenu(e: MouseEvent, layer: LayerListItem) {
    e.preventDefault();
    e.stopPropagation();

    const rect = panelEl?.getBoundingClientRect();
    contextMenu = {
      layer,
      x: rect ? e.clientX - rect.left : e.clientX,
      y: rect ? e.clientY - rect.top : e.clientY,
    };
  }

  async function startRename(layer: LayerListItem) {
    contextMenu = null;
    renamingLayerId = layer.id;
    renameValue = layer.name;
    onselect(layer.id);
    await tick();
    renameInputEl?.focus();
    renameInputEl?.select();
  }

  function finishRename(layer: LayerListItem) {
    if (renamingLayerId !== layer.id) return;
    const name = renameValue.trim() || layer.name;
    renamingLayerId = null;
    if (name !== layer.name) onnamechange(layer.id, name);
  }

  function cancelRename() {
    renamingLayerId = null;
  }

  function onRenameKeyDown(e: KeyboardEvent, layer: LayerListItem) {
    e.stopPropagation();

    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(layer);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  function onLayerClick(id: string) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    selectLayer(id);
  }

  function onLayerKeyDown(e: KeyboardEvent, id: string) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    selectLayer(id);
  }

  function onLayerDragStart(e: DragEvent, layer: LayerListItem) {
    if (renamingLayerId === layer.id) {
      e.preventDefault();
      return;
    }

    contextMenu = null;
    draggedLayerId = layer.id;
    suppressNextClick = true;
    e.dataTransfer?.setData("text/plain", layer.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function updateDropIndicator(e: DragEvent, targetLayer: LayerListItem) {
    if (!draggedLayerId || draggedLayerId === targetLayer.id) {
      dropTargetLayerId = null;
      return;
    }

    const rect = e.currentTarget instanceof HTMLElement
      ? e.currentTarget.getBoundingClientRect()
      : null;

    dropTargetLayerId = targetLayer.id;
    dropPosition = rect && e.clientY > rect.top + rect.height / 2 ? "after" : "before";
  }

  function onLayerDragOver(e: DragEvent, targetLayer: LayerListItem) {
    if (!draggedLayerId) return;
    e.preventDefault();
    updateDropIndicator(e, targetLayer);
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  }

  function onLayerDrop(e: DragEvent, targetLayer: LayerListItem) {
    e.preventDefault();
    e.stopPropagation();

    const sourceId = draggedLayerId ?? e.dataTransfer?.getData("text/plain");
    draggedLayerId = null;
    dropTargetLayerId = null;
    if (!sourceId || sourceId === targetLayer.id) return;

    const nextOrder = visibleLayers.map((layer) => layer.id).filter((id) => id !== sourceId);
    const targetIndex = nextOrder.indexOf(targetLayer.id);
    if (targetIndex < 0) return;

    const insertAfterTarget = dropPosition === "after";
    nextOrder.splice(targetIndex + (insertAfterTarget ? 1 : 0), 0, sourceId);
    onreorder(nextOrder);
  }

  function onLayerDragEnd() {
    draggedLayerId = null;
    dropTargetLayerId = null;
  }

  function toggleVisibility(layer: LayerListItem) {
    contextMenu = null;
    onvisiblechange(layer.id, !layer.visible);
  }

  function toggleLayerVisibility(e: MouseEvent, layer: LayerListItem) {
    e.stopPropagation();
    toggleVisibility(layer);
  }

  function toggleLocked(layer: LayerListItem) {
    contextMenu = null;
    onlockedchange(layer.id, !layer.locked);
  }

  function deleteLayer(layer: LayerListItem) {
    if (!canDelete) return;
    contextMenu = null;
    ondelete(layer.id);
  }

  $effect(() => {
    function onWindowClick() {
      contextMenu = null;
    }

    function onWindowKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") contextMenu = null;
    }

    window.addEventListener("click", onWindowClick);
    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("click", onWindowClick);
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  });
</script>

<div
  bind:this={panelEl}
  class="fixed left-4 top-24 z-50 flex w-[232px] flex-col gap-3 rounded-xl bg-zinc-900 p-4 text-zinc-100 shadow-2xl [-webkit-app-region:no-drag]"
  class:cursor-grabbing={isDragging}
  style="transform: translate({translate.x}px, {translate.y}px);"
>
  <div class="relative flex items-center justify-center">
    <div class="flex gap-1">
      {#each Array(5) as _}
        <div class="h-1 w-1 rounded-full bg-zinc-500"></div>
      {/each}
    </div>
    <div
      role="button"
      tabindex="-1"
      aria-label="Drag to move layers panel"
      class="absolute inset-x-0 top-1/2 h-8 -translate-y-1/2 cursor-grab active:cursor-grabbing"
      onpointerdown={onHandlePointerDown}
    ></div>
  </div>

  <div class="flex max-h-80 flex-col gap-1 overflow-y-auto pr-1">
    {#each visibleLayers as layer (layer.id)}
      <div
        role="button"
        tabindex="0"
        draggable={renamingLayerId !== layer.id}
        class="relative cursor-grab rounded-md border px-2 py-1.5 text-left transition active:cursor-grabbing {draggedLayerId === layer.id ? 'opacity-50' : ''} {layer.active ? 'border-zinc-600 bg-zinc-800/50' : 'border-zinc-800 bg-zinc-950/70 hover:bg-zinc-800/40'}"
        onclick={() => onLayerClick(layer.id)}
        onkeydown={(e) => onLayerKeyDown(e, layer.id)}
        oncontextmenu={(e) => openLayerMenu(e, layer)}
        ondragstart={(e) => onLayerDragStart(e, layer)}
        ondragover={(e) => onLayerDragOver(e, layer)}
        ondrop={(e) => onLayerDrop(e, layer)}
        ondragend={onLayerDragEnd}
      >
        {#if dropTargetLayerId === layer.id && dropPosition === "before"}
          <div class="pointer-events-none absolute -top-1 left-1 right-1 h-0.5 rounded-full bg-zinc-300"></div>
        {/if}
        {#if dropTargetLayerId === layer.id && dropPosition === "after"}
          <div class="pointer-events-none absolute -bottom-1 left-1 right-1 h-0.5 rounded-full bg-zinc-300"></div>
        {/if}
        {#if renamingLayerId === layer.id}
          <input
            bind:this={renameInputEl}
            bind:value={renameValue}
            class="w-full rounded bg-zinc-800 px-1 py-0.5 text-xs outline-none focus:ring-1 focus:ring-zinc-500"
            aria-label="Layer name"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => onRenameKeyDown(e, layer)}
            onblur={() => finishRename(layer)}
          />
        {:else}
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1 truncate text-xs text-zinc-100">
              {layer.name}
            </div>
            <button
              class="rounded p-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-white"
              type="button"
              aria-label={layer.visible ? "Hide layer" : "Show layer"}
              onclick={(e) => toggleLayerVisibility(e, layer)}
            >
              {#if layer.visible}
                <svg aria-hidden="true" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              {:else}
                <svg aria-hidden="true" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 3l18 18" />
                  <path d="M10.6 10.6A2 2 0 0 0 12 14a2 2 0 0 0 1.4-.6" />
                  <path d="M9.9 4.3A10.8 10.8 0 0 1 12 4c6.5 0 10 8 10 8a17.8 17.8 0 0 1-3.2 4.3" />
                  <path d="M6.6 6.6C3.6 8.6 2 12 2 12s3.5 8 10 8a10.8 10.8 0 0 0 4.1-.8" />
                </svg>
              {/if}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if contextMenu}
    <div
      role="menu"
      tabindex="-1"
      class="absolute z-10 min-w-36 rounded-md border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-xl"
      style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
    >
      <button
        role="menuitem"
        class="block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800"
        type="button"
        onclick={() => startRename(contextMenu!.layer)}
      >
        Rename
      </button>
      <button
        role="menuitem"
        class="block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800"
        type="button"
        onclick={() => toggleVisibility(contextMenu!.layer)}
      >
        {contextMenu.layer.visible ? "Hide" : "Show"}
      </button>
      <button
        role="menuitem"
        class="block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800"
        type="button"
        onclick={() => toggleLocked(contextMenu!.layer)}
      >
        {contextMenu.layer.locked ? "Unlock" : "Lock"}
      </button>
      <button
        role="menuitem"
        class="block w-full rounded px-2 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
        type="button"
        disabled={!canDelete}
        onclick={() => deleteLayer(contextMenu!.layer)}
      >
        Delete
      </button>
    </div>
  {/if}
</div>
