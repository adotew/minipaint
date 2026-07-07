<script lang="ts">
  interface Props {
    message: string;
  }

  let { message }: Props = $props();
</script>

<div
  role="alert"
  class="fixed left-4 top-16 z-[110] max-w-sm rounded-lg bg-red-950/95 px-3 py-2 text-sm text-red-100 shadow-2xl [-webkit-app-region:no-drag]"
>
  {message}
</div>
