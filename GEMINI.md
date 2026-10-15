# GEMINI.md

@./AGENTS.md

The shared project rules are in `AGENTS.md`, imported above. If the import did not load, read `AGENTS.md` before doing anything else. Scope and key decisions are in `docs/design.md`; behavior is documented in `docs/`.

## Gemini CLI notes

- Before a change that touches architecture, the result contract, the storage schema, sync semantics, or an open question in `docs/design.md`, describe your plan and wait for approval before editing.
- Do not use web search or fetch tools to "verify" behavior against live documentation sites during tests or development checks. Use the local fixture corpus and fixture server.
- Run the test command from `AGENTS.md` → Commands before reporting a task complete. If you could not run it, say so.
- Put project-wide rule changes in `AGENTS.md`, not here, so every agent sees them. This file is only for Gemini-specific notes.
