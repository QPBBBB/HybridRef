# AgentKnowledge

- Read README.md first, then the relevant Elements/ and Alignment/ documents.
- HybridRef.cmd is the public local interface. Inspect IDs and validate resources; let the user refresh the canvas after writing.
- Route all routine agent mutations through HybridRef.cmd, including batches. Do not import private modules or generate alternate resource-writing scripts. Fix or extend this CLI if it fails or is missing a capability. Direct YAML instructions are for understanding the schema and user-requested manual editing, not an automatic fallback for command errors.
- New modules and public capabilities must ship their agent interface, documentation, and runnable examples together. Keep examples executable with bundled dependencies and include them in validation.
- Do not introduce a second resource schema. Code/Module/Source/Server/Storage.ts and Shared/Arrows.ts define validation and geometry.
