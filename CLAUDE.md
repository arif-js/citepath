# CLAUDE.md

@AGENTS.md

The shared project rules are in `AGENTS.md`, imported above. If the import did not load, read `AGENTS.md` before doing anything else. Scope and key decisions are in `docs/design.md`; behavior is documented in `docs/`.

## Claude Code notes

- For work that touches architecture, the result contract, the storage schema, sync semantics, or an open question in `docs/design.md`, use plan mode and get approval before editing.
- Before a large exploratory search across the repository, check whether reading `docs/design.md` and the relevant module is enough.
- Run the test command from `AGENTS.md` → Commands before reporting a task complete. If you could not run it, say so.
- Put project-wide rule changes in `AGENTS.md`, not here, so every agent sees them. This file is only for Claude-specific notes.
