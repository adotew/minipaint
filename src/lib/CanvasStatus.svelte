<script lang="ts">
  import type { ToolMode } from "./core/types";

  interface Props {
    zoom: number;
    brushSize: number;
    toolMode: ToolMode;
  }

  let { zoom, brushSize, toolMode }: Props = $props();

  const modeStyle = $derived(
    toolMode === "eraser"
      ? "background: #ffd9e2; color: #141014;"
      : toolMode === "smudge"
        ? "background: #ede9fe; color: #1e1b4b;"
        : "background: #d8f3ff; color: #0b1720;",
  );
</script>

<div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2 text-xs">
  <div class="rounded-md px-2 py-1 font-medium tracking-wide shadow-sm" style={modeStyle}>
    {toolMode.toUpperCase()}
  </div>
  <div class="rounded-md bg-black/60 px-2 py-1 text-white shadow-sm">
    {Math.round(zoom * 100)}% · {brushSize}px
  </div>
</div>
