# OpenCode source attribution

Rigovo v2 is a source fork of [anomalyco/opencode](https://github.com/anomalyco/opencode),
tag `v1.18.15`, commit `d7b115f623760e68a4749d16508a9eca350f246f`.
The upstream MIT license and copyright notice are preserved in `LICENSE`.

The fork retains OpenCode's model streaming, session persistence, compaction,
tools, subagents, permissions, LSP, CLI and terminal UI. Rigovo-specific code lives
in `packages/rigovo`: a local-Qwen launch profile, project memory compatibility,
source-scoped memory tools, and completion/verification guidance. This replaces
the former Python role pipeline in this isolated rewrite checkout.

The engine now also includes Rigovo's bounded native worker scheduler,
`parallel_tasks` batch tool, and context-budget-aware history cleanup in
`packages/opencode`. The native session/tool loop remains upstream-derived.
`packages/rigovo` supplies cached project-memory retrieval and a shared worker
board with cooperative file claims. These changes do not accelerate model
inference kernels or replace Ollama's model/KV cache.

The original modified Rigovo repository remains at `../rigovo-virtual-team`.
No old session database or generated application files are deleted or migrated
in place. Legacy Rigovo memories are read through a read-only SQLite connection.
