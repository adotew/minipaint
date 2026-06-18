import { HexColorPicker } from "react-colorful";

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
}

export default function ColorPicker({ color, onChange }: ColorPickerProps) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-3 rounded-xl bg-zinc-900 p-4 shadow-2xl">
      <HexColorPicker color={color} onChange={onChange} />

      <div className="flex w-[200px] items-center gap-2">
        <div
          className="box-border h-8 w-8 shrink-0 rounded-md"
          style={{ backgroundColor: color }}
        />
        <input
          type="text"
          value={color}
          onChange={(e) => onChange(e.target.value)}
          className="box-border min-w-0 flex-1 rounded-md bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-100"
        />
      </div>
    </div>
  );
}
