<script lang="ts">
  import ColorPicker from "./lib/ColorPicker.svelte";
  import WebGPUCanvas from "./lib/WebGPUCanvas.svelte";

  let color = $state("#aabbcc");
  let brushSize = $state(10);
</script>

<div class="fixed top-4 right-4 z-50 flex flex-col gap-3 rounded-xl bg-zinc-900 p-4 shadow-2xl">
  <ColorPicker {color} onchange={(c: string) => (color = c)} />

  <div class="flex w-[200px] flex-col gap-1">
    <label class="text-xs font-medium text-zinc-300" for="brush-size">
      Size: {brushSize}px
    </label>
    <input
      id="brush-size"
      type="range"
      min={1}
      max={100}
      value={brushSize}
      oninput={(e) => (brushSize = Number(e.currentTarget.value))}
      class="w-full accent-zinc-100"
    />
  </div>
</div>

<WebGPUCanvas {color} {brushSize} />
