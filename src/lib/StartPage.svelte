<script lang="ts">
  import type { RecentFile } from "./app/recentFiles";

  interface Props {
    recentFiles: RecentFile[];
    canCreateCanvas: boolean;
    recentMenuPath: string | null;
    renamingPath: string | null;
    renameDraft: string;
    onnewcanvas: () => void;
    onopenproject: (path: string) => void;
    ontogglerecentmenu: (e: MouseEvent, path: string) => void;
    onstartrename: (path: string, currentName: string) => void;
    onconfirmrename: (path: string) => void;
    oncancelrename: () => void;
    onremovefile: (path: string) => void;
  }

  let {
    recentFiles,
    canCreateCanvas,
    recentMenuPath,
    renamingPath,
    renameDraft = $bindable(),
    onnewcanvas,
    onopenproject,
    ontogglerecentmenu,
    onstartrename,
    onconfirmrename,
    oncancelrename,
    onremovefile,
  }: Props = $props();

  function focusNode(node: HTMLElement) {
    node.focus();
    node.select();
  }
</script>

<div class="fixed inset-0 z-[100] flex flex-col bg-zinc-800 text-zinc-100 [-webkit-app-region:no-drag]">
  <header class="flex h-16 shrink-0 items-center justify-end bg-zinc-800 px-8">
    <button
      class="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-700 text-zinc-100 shadow-sm hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-40"
      type="button"
      aria-label="New canvas"
      disabled={!canCreateCanvas}
      onclick={onnewcanvas}
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
            onclick={() => onopenproject(file.path)}
          >
            <div class="relative aspect-[4/3] rounded-lg bg-white shadow-md ring-1 ring-zinc-700/70"></div>
          </button>
          {#if renamingPath === file.path}
            <form
              class="mt-3 flex items-center gap-1"
              onsubmit={(e) => {
                e.preventDefault();
                onconfirmrename(file.path);
              }}
            >
              <input
                class="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-zinc-500"
                type="text"
                use:focusNode
                bind:value={renameDraft}
                onkeydown={(e) => {
                  if (e.key === "Escape") oncancelrename();
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
                onclick={oncancelrename}
              >
                Cancel
              </button>
            </form>
          {:else}
            <div class="mt-3 flex items-center gap-1">
              <button
                class="min-w-0 flex-1 truncate text-left text-sm font-medium text-zinc-100"
                type="button"
                onclick={() => onopenproject(file.path)}
              >
                {file.name}
              </button>
              <button
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                type="button"
                aria-label="File options"
                onclick={(e) => ontogglerecentmenu(e, file.path)}
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
                onclick={() => onstartrename(file.path, file.name)}
              >
                Rename
              </button>
              <button
                class="block w-full rounded px-2 py-1.5 text-left text-zinc-200 hover:bg-zinc-800"
                type="button"
                role="menuitem"
                onclick={() => onremovefile(file.path)}
              >
                Remove
              </button>
            </div>
          {/if}
        </article>
      {/each}
    </div>
  </main>
</div>
