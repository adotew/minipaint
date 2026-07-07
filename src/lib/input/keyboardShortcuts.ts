export type KeyboardShortcutCommand =
  | "space-down"
  | "space-up"
  | "eyedropper-down"
  | "eyedropper-up"
  | "brush-mode"
  | "eraser-mode"
  | "smudge-mode"
  | "add-layer"
  | "zoom-in"
  | "zoom-out"
  | "fit-screen"
  | "zoom-100"
  | "undo"
  | "redo";

export function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return Boolean(
    element?.isContentEditable ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT",
  );
}

export function getKeyDownShortcutCommand(e: KeyboardEvent): KeyboardShortcutCommand | null {
  if (isTypingTarget(e.target)) return null;

  if (e.code === "Space" && !e.repeat) return "space-down";
  if ((e.code === "AltLeft" || e.code === "AltRight") && !e.repeat) return "eyedropper-down";

  const key = e.key.toLowerCase();
  if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (key === "b") return "brush-mode";
    if (key === "e") return "eraser-mode";
    if (key === "s") return "smudge-mode";
  }

  const commandKey = e.ctrlKey || e.metaKey;
  if (!commandKey) return null;

  if (!e.shiftKey && key === "n") return "add-layer";
  if (e.key === "+" || e.key === "=") return "zoom-in";
  if (e.key === "-") return "zoom-out";
  if (e.key === "0") return "fit-screen";
  if (e.key === "1") return "zoom-100";
  if (key === "z" && !e.shiftKey) return "undo";
  if (key === "y" || (key === "z" && e.shiftKey)) return "redo";

  return null;
}

export function getKeyUpShortcutCommand(e: KeyboardEvent): KeyboardShortcutCommand | null {
  if (e.code === "Space") return "space-up";
  if (e.code === "AltLeft" || e.code === "AltRight") return "eyedropper-up";
  return null;
}
