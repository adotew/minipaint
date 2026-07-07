<script lang="ts">
  interface Props {
    width: number;
    height: number;
    canCreate: boolean;
    onclose: () => void;
    oncreate: () => void;
  }

  let {
    width = $bindable(),
    height = $bindable(),
    canCreate,
    onclose,
    oncreate,
  }: Props = $props();
</script>

<div class="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 px-4">
  <button
    class="absolute inset-0"
    type="button"
    aria-label="Close canvas size dialog"
    onclick={onclose}
  ></button>
  <form
    class="relative w-80 rounded-xl bg-zinc-900 p-4 text-zinc-100 shadow-2xl ring-1 ring-zinc-700"
    onsubmit={(e) => {
      e.preventDefault();
      oncreate();
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
          bind:value={width}
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
          bind:value={height}
        />
      </label>
    </div>
    <div class="mt-4 flex justify-end gap-2">
      <button
        class="rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800"
        type="button"
        onclick={onclose}
      >
        Cancel
      </button>
      <button
        class="rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        type="submit"
        disabled={!canCreate}
      >
        Create
      </button>
    </div>
  </form>
</div>
