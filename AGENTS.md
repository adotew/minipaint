# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. `src/main.ts` mounts the Svelte app and `src/App.svelte` coordinates the start page, project actions, recent files, dialogs, and the canvas facade. Reusable UI components belong in `src/lib/` using PascalCase names. `src/lib/WebGPUCanvas.svelte` is the main canvas facade, but new pure logic should be extracted to focused modules instead of added there.

Current source module boundaries:

- `src/lib/core/`: shared constants, types, color conversion, geometry, and math helpers.
- `src/lib/document/`: layer state, paint-document orchestration, and undo/redo stroke history.
- `src/lib/gpu/`: WebGPU renderer setup, resources, pipelines, textures, readback, compositing, and brush stamping.
- `src/lib/input/`: brush sizing/pressure, keyboard shortcuts, pan/zoom, and stamp queue helpers.
- `src/lib/persistence/`: `.minipaint` project format, ZIP/PNG encode/decode, and project save/load orchestration.
- `src/lib/app/`: app-level browser helpers such as recent files.
- `src/lib/shaders/`: WGSL shader programs, named descriptively in lowercase.
- `src/assets/`: bundled brush images and other media.

Electron code lives in `electron/`: `main.js` creates the window, `menu.js` defines app menus, `preload.cjs` exposes the safe renderer API, and `projectFiles.js` handles native project-file operations. Development helpers are in `scripts/`. Vite emits browser assets to `dist/`, while packaged desktop artifacts are generated from `electron-builder.yml`. Architecture notes and implementation plans live in `docs/`; read `docs/architecture.md` before large refactors.

## Build, Test, and Development Commands

Use Bun because `bun.lock` is committed.

- `bun install` installs dependencies and the Electron binary.
- `bun run dev` starts the Vite web app.
- `bun run electron:dev` runs Vite and Electron together for desktop development.
- `bun run build` creates the production web bundle in `dist/`.
- `bun run preview` serves the production bundle for local verification.
- `bun run electron:build` builds and packages the desktop application.

No automated test command is currently configured. At minimum, run `bun run build` before submitting code changes and manually verify affected workflows, especially drawing, pressure/opacity, brush resizing, eyedropper/color selection, pan/zoom, layers, undo/redo, project save/load, PNG export, and Electron window/menu/file behavior.

## Coding Style & Naming Conventions

Follow the existing TypeScript and Svelte style: two-space indentation, double quotes, semicolons in scripts, and trailing commas in multiline objects. TypeScript is strict; avoid `any`, unused declarations, unused parameters, and unchecked DOM lookups. Use Svelte 5 runes consistently (`$state`, `$derived`, `$props`, `$bindable`) in components that already use them.

Name Svelte components in PascalCase (`ColorPicker.svelte`), functions and state in camelCase, types/interfaces in PascalCase, and shader files descriptively in lowercase (`stamp.wgsl`). Keep GPU resource lifecycle, readback buffers, event listeners, pointer capture, and animation-frame cleanup explicit. Keep browser renderer code free of Node APIs; use the preload-exposed `window.minipaint` API for Electron-only file operations. Tailwind utility classes are preferred for component styling; shared rules belong in `src/app.css`.

## WebGPU, Persistence, and Refactor Guidelines

Preserve the separation between document state, input handling, GPU resources, and persistence. Prefer adding pure helpers to `core`, `document`, `input`, `gpu`, or `persistence` over expanding `WebGPUCanvas.svelte`. Keep WebGPU changes tested around canvas edges, high zoom/low zoom, layer visibility/order, alpha premultiplication, undo/redo snapshots, and device/context loss paths where relevant. Project files use the `.minipaint` ZIP-based format; update format validation and docs together when changing persistence.

## Testing Guidelines

There is no test directory or testing framework yet. If adding tests, place component or helper tests beside their source as `*.test.ts` and add the corresponding script to `package.json`. For WebGPU or Electron changes, manually test in both a WebGPU-capable browser and Electron on supported hardware.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, sentence-case subjects, with optional Conventional Commit prefixes such as `fix:`. Keep each commit focused. Pull requests should explain user-visible behavior, list verification performed, link relevant issues, and include screenshots or a short recording for UI or brush-rendering changes.
