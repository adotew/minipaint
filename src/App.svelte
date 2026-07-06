<script lang="ts">
  import ColorPicker from "./lib/ColorPicker.svelte";
  import WebGPUCanvas from "./lib/WebGPUCanvas.svelte";

  let color = $state("#aabbcc");
  let brushSize = $state(10);

  type CanvasHandle = {
    exportAsPng: () => Promise<void>;
  };

  let webgpuCanvas: CanvasHandle | undefined = $state();
  let isExporting = $state(false);
  let exportError = $state<string | null>(null);

  // Panel drag state
  let translate = $state({ x: 0, y: 0 });
  let dragStart = { x: 0, y: 0 };
  let translateStart = { x: 0, y: 0 };
  let isDragging = $state(false);

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

  async function exportPng() {
    if (isExporting) return;

    isExporting = true;
    exportError = null;

    try {
      if (!webgpuCanvas) throw new Error("Canvas is not ready to export yet.");
      await webgpuCanvas.exportAsPng();
    } catch (e) {
      console.error(e);
      exportError = e instanceof Error ? e.message : "Failed to export PNG.";
    } finally {
      isExporting = false;
    }
  }

  $effect(() => {
    const unsubscribe = window.minipaint?.onExportPng(() => {
      void exportPng();
    });

    return () => unsubscribe?.();
  });
</script>

{#if exportError}
  <div
    role="alert"
    class="fixed left-4 top-16 z-50 max-w-sm rounded-lg bg-red-950/95 px-3 py-2 text-sm text-red-100 shadow-2xl [-webkit-app-region:no-drag]"
  >
    {exportError}
  </div>
{/if}

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

<WebGPUCanvas bind:this={webgpuCanvas} {color} bind:brushSize />
