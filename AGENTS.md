# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. `src/main.ts` mounts the Svelte app, `src/App.svelte` defines the main interface, and reusable components belong in `src/lib/`. WebGPU rendering is concentrated in `src/lib/WebGPUCanvas.svelte`, with WGSL programs under `src/lib/shaders/`. Store brush images and other bundled media in `src/assets/`. Electron's main process is `electron/main.js`; development helpers are in `scripts/`. Vite emits browser assets to `dist/`, while packaged desktop artifacts are generated from `electron-builder.yml`.

## Build, Test, and Development Commands

Use Bun because `bun.lock` is committed.

- `bun install` installs dependencies and the Electron binary.
- `bun run dev` starts the Vite web app on port 1420.
- `bun run electron:dev` runs Vite and Electron together for desktop development.
- `bun run build` creates the production web bundle in `dist/`.
- `bun run preview` serves the production bundle for local verification.
- `bun run electron:build` builds and packages the desktop application.

No automated test command is currently configured. At minimum, run `bun run build` before submitting changes and manually verify drawing, brush sizing, color selection, undo/redo, and Electron window behavior when affected.

## Coding Style & Naming Conventions

Follow the existing TypeScript and Svelte style: two-space indentation, double-quoted strings, semicolons in scripts, and trailing commas in multiline objects. TypeScript is strict; avoid `any`, unused declarations, and unchecked DOM lookups. Name Svelte components in PascalCase (`ColorPicker.svelte`), functions and state in camelCase, and shader files descriptively in lowercase (`stamp.wgsl`). Keep GPU resource lifecycle and pointer-event cleanup explicit. Tailwind utility classes are preferred for component styling; shared rules belong in `src/app.css`.

## Testing Guidelines

There is no test directory or testing framework yet. If adding tests, place component tests beside their source as `*.test.ts` and add the corresponding script to `package.json`. WebGPU changes should also be tested in a browser and Electron on hardware with WebGPU support, including canvas edges and undo/redo paths.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, sentence-case subjects, with optional Conventional Commit prefixes such as `fix:`. Keep each commit focused. Pull requests should explain user-visible behavior, list verification performed, link relevant issues, and include screenshots or a short recording for UI or brush-rendering changes.
