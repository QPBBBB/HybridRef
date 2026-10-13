# Citadel reference and attribution

HybridRef initially imported [Citadel](https://github.com/kannibalk1w1/Citadel), by Kieran Beckenkrager, under the MIT License.

- Imported commit: `be207e612a7e07ae78d26635e94d0e67169c8c6e`, upstream version `0.4.0`.
- The previous implementation is preserved under `Code/Module/reference/citadel` as reference source. It is excluded from the active build, tests and packaged app.
- The current application is a new, minimal image-only canvas. Citadel's large UI, recording, media, document and multi-board modules are not loaded.
- Original attribution remains in `Code/Module/LICENSE`, `Code/Module/THIRD_PARTY_NOTICES.md`, and `Code/Module/licenses/`. Existing bundled resources and the old Demo retain their provenance.

The active browser application uses React, a local Node.js HTTP service, sharp, yaml and bmp-js. The former Electron host is archived under `Code/Module/reference/electron-minimal` and is not used or installed by the active application. Native YAML projects use `formatVersion: 2`; both existing demos remain intact.
