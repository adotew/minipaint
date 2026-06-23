// Start Vite dev server, then launch Electron.
import { spawn } from "child_process";

// Launch Vite first
const vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
  stdio: "inherit",
  shell: true,
});

// Wait for Vite to be ready
await new Promise((resolve) => setTimeout(resolve, 2000));

// Launch Electron pointing to the Vite dev server
const electron = spawn(
  "npx",
  ["electron", "."],
  {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: "http://localhost:1420" },
    shell: true,
  },
);

electron.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  electron.kill();
  vite.kill();
  process.exit(0);
});
