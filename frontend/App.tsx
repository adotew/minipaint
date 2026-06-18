import { useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const logoClassName =
    "h-[6em] p-[1.5em] transition-[filter] duration-700 will-change-[filter]";
  const linkClassName =
    "font-medium text-[#646cff] no-underline hover:text-[#535bf2] dark:hover:text-[#24c8db]";
  const fieldClassName =
    "rounded-lg border border-transparent bg-white px-[1.2em] py-[0.6em] font-[inherit] text-base font-medium text-[#0f0f0f] shadow-[0_2px_2px_rgba(0,0,0,0.2)] outline-none transition-colors duration-200 dark:bg-[#0f0f0f98] dark:text-white";

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <main className="m-0 min-h-screen pt-[10vh] text-center">
      <h1 className="my-[0.67em] text-center text-[2em] font-bold">
        Welcome to Tauri + React
      </h1>

      <div className="flex justify-center">
        <a href="https://vite.dev" target="_blank" className={linkClassName}>
          <img
            src="/vite.svg"
            className={`${logoClassName} hover:drop-shadow-[0_0_2em_#747bff]`}
            alt="Vite logo"
          />
        </a>
        <a href="https://tauri.app" target="_blank" className={linkClassName}>
          <img
            src="/tauri.svg"
            className={`${logoClassName} hover:drop-shadow-[0_0_2em_#24c8db]`}
            alt="Tauri logo"
          />
        </a>
        <a href="https://react.dev" target="_blank" className={linkClassName}>
          <img
            src={reactLogo}
            className={`${logoClassName} hover:drop-shadow-[0_0_2em_#61dafb]`}
            alt="React logo"
          />
        </a>
      </div>
      <p className="my-[1em]">
        Click on the Tauri, Vite, and React logos to learn more.
      </p>

      <form
        className="flex justify-center"
        onSubmit={(e) => {
          e.preventDefault();
          greet();
        }}
      >
        <input
          className={`${fieldClassName} mr-[5px]`}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Enter a name..."
        />
        <button
          type="submit"
          className={`${fieldClassName} cursor-pointer hover:border-[#396cd8] active:border-[#396cd8] active:bg-[#e8e8e8] dark:active:bg-[#0f0f0f69]`}
        >
          Greet
        </button>
      </form>
      <p className="my-[1em]">{greetMsg}</p>
    </main>
  );
}

export default App;
