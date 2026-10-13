# HybridRef

- Current scope: a minimal, image-only reference board. Citadel is a reference, not the active application.
- Runs directly in the user's browser. React/TypeScript UI plus a Node.js service bound to 127.0.0.1; no Electron in the active application. Infinite canvas, multi-select, snapping, alignment, pan/zoom, image resize, clipboard, delete and undo/redo.
- Source/dependencies: `Code/Module`; icons/images/fonts: `Code/Resource`. Previous Citadel implementation is archived in `Code/Module/reference/citadel` and excluded from builds/tests.
- No text items, multiple boards, media players, recording, transcription, plugins or onboarding in the minimal app.
- Native `.hbr` is deterministic YAML plus same-directory `<stem>Resource/` PNG files. All imported images normalize to compressed PNG; animated images use their first frame.
- Keep all current-project image bytes and decoded images in memory. Browser file operations use a typed HTTP client; each tab has an isolated server-side image store. Browser clipboard and file input handle images.
- Keep the repository root limited to `Code/`, `Project/`, `.gitignore`, `README.md`, and `Start.cmd` (plus hidden `.git` metadata). The PowerShell launcher implementation lives in `Code/Module/Scripts/StartHybridRef.ps1`; generated state, logs and screenshots stay under `Code/Module/Runtime/`. Demo: `Project/Demo/Demo.hbr` with `Project/Demo/DemoResource/`; the demo generator must refuse to overwrite an existing project.
- Resolve the default `Project/` directory relative to the repository location. New projects request a name and immediately create `Project/<Name>/<Name>.hbr` plus `<Name>Resource/`, including the resource directory for an empty project.
- Run `pnpm typecheck`, `pnpm test:run`, `pnpm build`, `pnpm exec playwright test` from `Code/Module`.
- Preserve upstream licenses and third-party notices under `Code/Module`, and the provenance statement in `README.md`. Do not overwrite user-edited projects. Do not commit/push or publish unless requested.
- Use PascalCase for all project-owned source filenames, functions, methods, constants, variables, parameters, and local import/destructuring bindings. Active code is in `Code/Module/Source`, `Scripts`, and `E2E`; run `pnpm check:naming` (also part of `pnpm typecheck`). Preserve standard tooling filenames (`package.json`, `tsconfig.json`, `pnpm*.yaml`, `*.config.ts`), standard repository/legal filenames, external API property names, existing YAML/HTTP data keys, content-hash asset names, and archived/third-party material.
