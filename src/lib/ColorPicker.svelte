<script lang="ts">
  interface Props {
    color: string;
    onchange: (color: string) => void;
  }
  let { color, onchange }: Props = $props();
</script>

<div class="flex flex-col gap-3">
  <input
    type="color"
    value={color}
    oninput={(e) => onchange(e.currentTarget.value)}
    class="h-10 w-[200px] cursor-pointer rounded-md border-0 bg-transparent"
  />

  <div class="flex w-[200px] items-center gap-2">
    <div
      class="box-border h-8 w-8 shrink-0 rounded-md border border-zinc-600"
      style="background-color: {color}"
    ></div>
    <input
      type="text"
      value={color}
      oninput={(e) => onchange(e.currentTarget.value)}
      class="box-border min-w-0 flex-1 rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-100 outline-none"
    />
  </div>
</div>
