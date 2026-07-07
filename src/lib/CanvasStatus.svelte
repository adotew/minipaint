<script lang="ts">
  interface Props {
    zoom: number;
    brushSize: number;
  }

  let { zoom, brushSize }: Props = $props();
</script>

<div class="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
  {Math.round(zoom * 100)}% · {brushSize}px
</div>
