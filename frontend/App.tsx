import { useEffect, useRef, useState } from "react";
import "./App.css";
import ColorPicker from "./components/ColorPicker";

export default function App() {
  const [color, setColor] = useState("#aabbcc");

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color;
    ctx.fillRect(50, 50, 200, 100);
  }, [color]);

  return (
    <>
      <ColorPicker color={color} onChange={setColor} />
      <div className="flex h-screen justify-center items-center">
        <canvas
          ref={canvasRef}
          className="bg-white rounded-md"
          width={600}
          height={400}
        />
      </div>
    </>
  );
}
