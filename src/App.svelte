<script lang="ts">
  import ColorPicker from "./lib/ColorPicker.svelte";
  import WebGPUCanvas from "./lib/WebGPUCanvas.svelte";

  let color = $state("#aabbcc");
  let brushSize = $state(10);

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
</script>

<div class="fixed left-0 right-0 top-0 z-40 h-10 [-webkit-app-region:drag]"></div>

<div
  class="fixed top-4 right-4 z-50 flex flex-col gap-3 rounded-xl bg-zinc-900 p-4 shadow-2xl [-webkit-app-region:no-drag]"
  class:cursor-grabbing={isDragging}
  style="transform: translate({translate.x}px, {translate.y}px);"
>
  <!-- Dotted drag handle -->
  <div
    class="flex cursor-grab items-center justify-center active:cursor-grabbing"
    onpointerdown={onHandlePointerDown}
  >
    <div class="flex gap-1">
      {#each Array(5) as _}
        <div class="h-1 w-1 rounded-full bg-zinc-500"></div>
      {/each}
    </div>
  </div>

  <ColorPicker {color} onchange={(c: string) => (color = c)} />
</div>

<WebGPUCanvas {color} bind:brushSize />
