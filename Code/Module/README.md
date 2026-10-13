# HybridRef

Minimal React image canvas that runs directly in a normal browser tab. A loopback-only Node.js service handles local YAML projects and PNG resources. Use `Start.cmd` at the repository root, or `pnpm start`.

- `Source/Renderer`: canvas UI, interaction geometry and full-image memory cache.
- `Source/Server`: PNG import, per-tab memory storage, deterministic YAML persistence and the local HTTP service.
- `Source/Shared`: the small typed document and browser API.
- `reference/citadel`: the previous implementation, archived for reference and excluded from the application and tests.
- `reference/electron-minimal`: the previous desktop shell, also excluded from the application.

Project-owned files, functions and variables use PascalCase. External APIs, tool-required configuration filenames, existing `.hbr` fields and archived upstream code retain their compatible names.

See `../../README.md` for keyboard controls, storage layout and running tests.
