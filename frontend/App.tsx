import { useState } from "react";
import "./App.css";
import ColorPicker from "./components/ColorPicker";
import WebGPUCanvas from "./components/WebGPUCanvas";

export default function App() {
  const [color, setColor] = useState("#aabbcc");
  const [brushSize, setBrushSize] = useState(10);

  return (
    <>
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-3 rounded-xl bg-zinc-900 p-4 shadow-2xl">
        <ColorPicker color={color} onChange={setColor} />

        <div className="flex w-[200px] flex-col gap-1">
          <label className="text-xs font-medium text-zinc-300">
            Size: {brushSize}px
          </label>
          <input
            type="range"
            min={1}
            max={100}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-full accent-zinc-100"
          />
        </div>
      </div>

      <div className="flex h-screen justify-center items-center">
        <WebGPUCanvas color={color} brushSize={brushSize} />
      </div>
    </>
  );
}
