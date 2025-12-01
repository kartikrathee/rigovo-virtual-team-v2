# ForgeCrew

ForgeCrew is the new product name for this Rigovo v2 fork. Launch it with
`./bin/forgecrew`; the existing Rigovo launcher, package paths, environment
variables and stored data remain compatible.

For GitHub Actions, EKS and local GPU inference through Cloudflare, see
[the deployment guide](deploy/README.md).

Local Qwen coding agent, minimal chat and full terminal UI. This is a source fork
of OpenCode v1.18.15, not a wrapper around an installed OpenCode binary. The native
engine provides streaming, tools, persistent conversations, compaction, permissions,
LSP and concurrent subagents. Rigovo adds a local model profile and compatibility
with project memories from the previous Python implementation.

Build and general workers use the dedicated instructions in
[`packages/rigovo/src/prompt.ts`](packages/rigovo/src/prompt.ts). They support
creating new applications in empty directories, including Django projects, as
well as modifying existing applications. These instructions replace the engine's
fallback provider prompt and describe tool working directories, testing and
repairing failures in place. Retrieved memories and earlier assistant claims do
not define the agent's capabilities.

The earlier modified checkout and generated applications are preserved separately.
See [UPSTREAM.md](UPSTREAM.md) for the pinned source and MIT attribution. The
unmodified upstream introduction is [README.upstream.md](README.upstream.md).

## Setup

Requires Bun 1.3.14 (the lockfile's version), Ollama and the Qwen3 Coder weights.
From this checkout:

```sh
HUSKY=0 bun install --frozen-lockfile
ollama pull qwen3-coder:30b
ollama create qwen3-coder-32k -f packages/rigovo/Modelfile
bun run build:rigovo
```

Ollama must be listening at `http://127.0.0.1:11434`. If it is not already running,
start it in another terminal:

```sh
OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=2 ollama serve
```

The 32K model tag preserves Qwen's tool template and increases its context window.
Two parallel requests require more memory than one; choose concurrency to fit your
machine. The launcher does not start or replace an existing Ollama server.

## Chat, TUI and one-shot tasks

Supply the project directory you want the agent to work on:

```sh
# Conversational terminal chat with a compact interface
./bin/rigovo --mini /absolute/path/to/project

# Full terminal UI
./bin/rigovo /absolute/path/to/project

# Resume the latest conversation
./bin/rigovo --mini --continue /absolute/path/to/project

# One request, then exit; no automatic task restart
./bin/rigovo run --dir /absolute/path/to/project "Inspect the tests and explain how to run them."

# Machine-readable events for performance/debugging
./bin/rigovo run --dir /absolute/path/to/project --format json "Your task" > run.jsonl
```

At startup, interactive chat and the full TUI offer two options:

1. **Always allow commands** — allow all tool permissions for this CLI launch,
   including worker sessions, edits and external paths. No subsequent permission
   prompts are shown, and existing deny rules are overridden for this launch.
2. **Ask every time** — keep the existing permission rules and approval dialogs.
   Operations already allowed by those rules continue to work as before.

The selection lasts until the CLI exits. Restarting or resuming in a new CLI
launch offers the choice again. It is not written to project settings or saved
as a global preference. Noninteractive runs retain the existing rules unless
you explicitly pass `--permissions allow`. You can also select either mode
directly, without the startup menu:

```sh
./bin/rigovo --mini --permissions allow /absolute/path/to/project
./bin/rigovo --mini --permissions ask /absolute/path/to/project
```

Help/version and utility commands do not show the selector. Use `/exit` to close
interactive chat.
For substantive independent work, the agent can use **`parallel_tasks`** to launch
2–8 native workers in one call. The scheduler runs at most three workers at once
by default and queues the rest. Each worker owns implementation and verification;
the primary agent joins results and performs integration checks. A failed child
returns its error alongside completed siblings. Nested worker creation is disabled
in bounded mode so an ancestor cannot hold a slot while waiting for descendants.

Select the limit for a CLI launch:

```sh
RIGOVO_MAX_WORKERS=2 ./bin/rigovo --mini /absolute/path/to/project
```

The limit is per CLI process; the Ollama server independently limits model request
concurrency. More workers can increase memory pressure and need not improve speed.
Simple tasks should stay with one agent.

Workers share a conversation-family board through **`rigovo_team`**. It supports
short decisions, interface contracts, findings, blockers, results and atomic path
claims. Claims reject overlapping files/directories, renew during activity, release
on completion/idle, and expire after 30 minutes without renewal. They coordinate
cooperative agents; they are not an OS filesystem sandbox and do not constrain
arbitrary shell writes. The primary agent can release a failed worker's claims.
Shared entries carry author provenance. Coordinator decisions define interface
contracts; worker findings remain unverified observations. Runtime command records
preserve command/exit/output evidence, which alone does not prove test coverage.

Project-memory retrieval uses a bounded cache invalidated by SQLite `data_version`
when another worker commits. Injected context is a character-budgeted snapshot for
the current user turn to avoid changing the prompt prefix after every tool call.
`rigovo_recall` and `rigovo_team` read fresh observations explicitly. Shared board
data lives in `.rigovo/collaboration.sqlite`; separate task families and projects
do not see one another's board entries.

On macOS, double-click `rigovo-chat.command`, `rigovo.command` or
`rigovo-logs.command`. The first two default to this checkout; select another
workspace with `RIGOVO_WORKSPACE=/absolute/path ./rigovo-chat.command`.

## Runtime and development

```sh
# In a separate terminal: native engine logs
./rigovo-logs.command

# Detailed logs directly in the foreground
./bin/rigovo --mini --log-level DEBUG --print-logs /absolute/path/to/project

# Optional event traces for minimal chat (includes conversation content)
OPENCODE_DIRECT_TRACE=1 ./bin/rigovo --mini /absolute/path/to/project

# Always use TypeScript source during development
RIGOVO_SOURCE=1 ./bin/rigovo --mini /absolute/path/to/project

# Rebuild after changing engine or TUI source
bun run build:rigovo
```

The launcher prefers this checkout's compiled engine when present, otherwise runs
this checkout's source. It never invokes `~/.opencode/bin/opencode`. The Rigovo
plugin remains a source-loaded plugin in both modes. `build:rigovo` explicitly
disables publishing and embeds the TUI, not the web application. The inherited
web/desktop packages have not been validated as Rigovo products.

State is isolated under `.rigovo/runtime` (override `RIGOVO_HOME` with an absolute
path). Logs are in `data/opencode/log/opencode.log` under that runtime directory;
optional mini traces are in `data/opencode/log/direct/`. The internal `opencode`
name is retained for engine compatibility. Upstream project instructions and
compatible configuration can still be loaded by the engine.

The model defaults to `ollama/qwen3-coder-32k:latest`, with a 32K context and a 4K
response limit per model turn. The latter is not a four-request task budget.
Set `RIGOVO_MODEL` to another compatible local model or `OLLAMA_OPENAI_URL` to a
loopback HTTP Ollama endpoint; this profile's context limits remain 32K/4K.

Context management reserves 8K of the window and scales old-tool-output pruning
thresholds to the selected model's usable budget. Recent turns and skill outputs
remain protected. Raw history is retained; pruning marks old results as compacted
for model context. The inherited recent-turn protection still retains tool output
within a single-user long task; summarization handles its eventual overflow.
This does not expand the model window or reduce Ollama's allocated KV buffer.

Project notes use `.rigovo/memory-v2.sqlite`. Existing `.rigovo/local.db` memories
are read-only and filtered by the original project UUID. Retrieval ranks bounded
notes by matching words and recency, rather than importing the old embedding
pipeline. An unfinished `.rigovo/direct-chat.json` task is available on explicit
request; completed tasks are not automatically resumed. Agent notes are labeled
as unverified observations, not execution evidence.

## Checks

```sh
(cd packages/rigovo && bun typecheck && bun test test)
(cd packages/opencode && bun typecheck)
(cd packages/opencode && bun test test/session/retry.test.ts test/session/compaction.test.ts test/tool/task.test.ts --timeout 30000)
```

See [VALIDATION.md](VALIDATION.md) for actual local-Qwen runs and their limits.
The fork's GitHub workflow runs the selected checks without downloading a model.
Upstream release/deployment workflows are archived under
`.github/upstream-workflows/` and are not active workflows.

Focused performance/coordination experiments (temporary fixtures, no application edits):

```sh
(cd packages/rigovo && bun run script/benchmark-memory.ts)
bun run packages/rigovo/script/benchmark-workers.ts .rigovo/validation/my-workers 1,2 batch
```

The worker output directory must be new. Results include wall time, actual active
worker peak, token usage, generated test counts and independent verification.
These are small acceptance workloads, not proof of a general speedup. For a
run-order control, repeat in a new directory with levels `2,1`. The retrieval
microbenchmark excludes inference and all other agent work.

## GitHub handoff

Push the **whole source tree from this checkout** on branch `opencode-rewrite`.
Its commits replace the old tracked Python pipeline, add the Rigovo integration,
isolate CI, and document validation. Review and merge the branch when ready:

```sh
git status --short
git log --oneline 98aaef9..HEAD
git push -u origin opencode-rewrite
```

The configured origin is `https://github.com/kartikrathee/rigovo-virtual-team.git`.
Nothing has been pushed automatically. Do not copy only `packages/rigovo`: it
needs the forked engine, TUI, workspace packages, patches and `bun.lock`.
`node_modules`, compiled `dist`, `.rigovo`, logs, model weights and the separate
application workspace are excluded. Rebuild the native executable after cloning.
The original dirty checkout at `../rigovo-virtual-team` is untouched; its
uncommitted files are not silently included in this rewrite branch.
