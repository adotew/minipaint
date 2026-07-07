<script lang="ts">
  interface Props {
    x: number;
    y: number;
    width: number;
    height: number;
    maskUrl: string;
  }

  let { x, y, width, height, maskUrl }: Props = $props();
</script>

<div
  class="pointer-events-none absolute"
  style="left: {x}px; top: {y}px; width: {width}px; height: {height}px; transform: translate(-50%, -50%);"
>
  <div
    class="absolute inset-0"
    style="background: rgba(255, 255, 255, 0.01); -webkit-backdrop-filter: invert(1); backdrop-filter: invert(1); -webkit-mask: url('{maskUrl}') center / contain no-repeat; mask: url('{maskUrl}') center / contain no-repeat; filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.9)) drop-shadow(0 0 2px rgba(0, 0, 0, 0.7));"
  ></div>
</div>
