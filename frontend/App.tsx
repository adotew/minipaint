import { useRef, useState } from "react";
import "./App.css";
import ColorPicker from "./components/ColorPicker";

export default function App() {
  const [color, setColor] = useState("#aabbcc");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  function getCtx() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.getContext("2d");
  }

  function drawLine(x1: number, y1: number, x2: number, y2: number) {
    const ctx = getCtx();
    if (!ctx) return;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function startDrawing(e: React.MouseEvent<HTMLCanvasElement>) {
    isDrawingRef.current = true;
    lastPosRef.current = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
  }

  function draw(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;

    const { x, y } = lastPosRef.current;
    const { offsetX, offsetY } = e.nativeEvent;

    drawLine(x, y, offsetX, offsetY);
    lastPosRef.current = { x: offsetX, y: offsetY };
  }

  function stopDrawing() {
    isDrawingRef.current = false;
  }

  return (
    <>
      <ColorPicker color={color} onChange={setColor} />
      <div className="flex h-screen justify-center items-center">
        <canvas
          ref={canvasRef}
          className="bg-white rounded-md"
          width={600}
          height={400}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
        />
      </div>
    </>
  );
}
