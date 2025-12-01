# Local validation — 2026-10-25

Environment: macOS arm64, Bun 1.3.14, local Ollama, `qwen3-coder-32k:latest`.
The engine is OpenCode v1.18.15 (`d7b115f`), with the Rigovo changes in this branch.
These are implementation acceptance checks, not a competitive performance benchmark.

## Automated checks

| Check                                 | Observed result                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/rigovo`: `bun typecheck`    | Passed                                                                                       |
| `packages/rigovo`: `bun test test`    | 5 passed, 12 assertions                                                                      |
| `packages/opencode`: `bun typecheck`  | Passed                                                                                       |
| Retry, compaction and task-tool tests | 125 passed, 1 skipped, 288 assertions                                                        |
| `bun run build:rigovo`                | Compiled native darwin-arm64 CLI; smoke version `2.0.0-alpha.1`; release publishing disabled |

The engine tests require local test sockets. They were rerun outside the restrictive
execution sandbox after socket binding was denied. This does not represent a full
monorepo test run. The GitHub workflow has been added but has not yet run on GitHub.

## Actual Qwen execution

The raw JSONL events are local, ignored artifacts under `.rigovo/validation/`.
All five successful runs below ended with `step_finish.reason = stop` and no
error event. The initial untuned failure is retained separately.

| Artifact              | Actual observation                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `memory-tuned.jsonl`  | One successful `rigovo_remember` call; persisted project note; returned `SAVED` and stopped                   |
| `coding-run.jsonl`    | Created `text_utils.py` and unittest file; executed Python; 4 tests passed                                    |
| `parallel-run.jsonl`  | Two native general subagents wrote `parity.py` and `words.py`; parent wrote integration tests; 2 tests passed |
| `native-run.jsonl`    | Compiled CLI returned `NATIVE_READY`, used no tools, then exited successfully                                 |
| `native-memory.jsonl` | Compiled CLI loaded Rigovo's source plugin and persisted one note; returned `NATIVE_SAVED` and stopped        |

Worker task intervals in `parallel-run.jsonl` overlap by **3,708 ms**. Their child
session IDs are `ses_e8e92886fffegVzNLSMjt2RKWo` and
`ses_e8e92754effe7noZr3woRznX0E`. This demonstrates concurrent task execution, not
that model inference scales linearly or that filesystem ownership is enforced.

Generated code lives in `/private/tmp/rigovo-v2-acceptance`. An independent rerun
of both unittest files passed all 6 tests. Additional direct checks passed for
2,001 signed integers and 200 generated Unicode-whitespace strings.

## Interactive acceptance

Both native interfaces were launched in isolated tmux windows and inspected.
The minimal chat answered `CHAT_READY`, then recalled that exact marker in a
second turn. Both turns returned to an empty prompt without restarting a task.
The full TUI displayed Rigovo branding and `Qwen3 Coder · local 32K Local Qwen`.
The temporary test windows were stopped after inspection.

Observed startup was about 640 ms for the final minimal chat, and the full TUI
reported a first draw of about 2.19 s. These are individual local observations;
model warmup and concurrent runs were not controlled. No speedup over stock
OpenCode or accuracy improvement over its model is claimed.

## Findings and remaining limits

An initial memory test (`memory-run.jsonl`) failed: the default Qwen temperature
caused repeated successful tool calls and the native doom-loop guard stopped it.
Explicit temperature 0 for build/general/title and single-save guidance resolved
that acceptance case. The guard remains enabled. The later native memory run
still used unnecessary todo/echo tools; final guidance now discourages shell
commands used only to print answers. Model behavior is not guaranteed by prompts.

The old Rigovo database is read-only; memory tests prove cross-project exclusion
and byte-identical legacy storage. Retrieval uses bounded lexical matching, not
the former embedding stack. Corrupt legacy task JSON does not break a new chat.

Only the CLI/TUI and local provider integration were validated. The inherited
web/desktop products, all upstream providers, cross-platform builds, long-running
complex tasks and broad model evaluations remain unverified. Rebuild after engine
or TUI edits; use `RIGOVO_SOURCE=1` while developing to bypass an existing binary.

## Stream replay fix

The elevator session exposed a 60-second SSE idle timeout followed by unbounded
provider retries. Each retry emitted the same preamble into a new text part;
this was repeated provider execution rather than proof of a UI defect.

The local profile now permits 240 seconds between chunks and a 300-second total
request. The processor permits two transport retries before text/tool activity;
any text, reasoning or tool activity prevents automatic replay of that turn.
This failure bound does not cap successful task turns. Provider failures return
an error and idle status, preserving partial text and marking partial tools aborted.
Rigovo guidance also requires evidence for UI diagnoses and distinguishes
observations from hypotheses; it cannot guarantee factual accuracy by itself.

Validation: processor, retry and provider-timeout suites passed 77 tests (163
assertions); Rigovo memory tests passed 5 tests (12 assertions). Both affected
packages passed type checks. Three added tests use real local HTTP/SSE streams
for partial text, partial tool JSON and persistent 503 failures. A native Qwen
acceptance run wrote and read `CHECK_READY`, then stopped without error.
The native executable was rebuilt successfully. The user's `elevator_system/`
files were excluded from these edits and commits.

## Startup permission selection

The CLI launcher now offers `Always allow commands` and `Ask every time` once
before entering interactive chat or the full TUI. Allow mode is inherited by
engine workers and applies to both permission services and legacy tool filtering;
it overrides ask/deny rules only for this CLI launch. Ask mode retains the existing
flow. The selection is not saved to project/global permission settings. A fresh
launch asks again; noninteractive launches retain existing rules unless explicitly
started with `--permissions allow`.

All four changed packages passed type checks. Permission/worker tests passed 101
tests, core permission tests passed 12, and Rigovo tests passed 8 (121 total).
Coverage includes primary/worker requests, explicit denials, no persisted grants,
argument validation and unchanged normal approval behavior.

In real native CLI acceptance terminals, option 1 executed `python3 -V` and
returned its observed output despite an explicit project bash denial, without
showing a permission dialog. Option 2, in a project configured to ask, displayed
the existing shell approval dialog for the same command. Both startup menus and
results were captured under ignored `.rigovo/validation/permissions-*.txt`.
A follow-up turn in the same allow-mode CLI executed `python3 -VV` without another
permission dialog. The full TUI also displayed the startup selector and entered
chat after the selection. Temporary acceptance terminals were closed afterward.

## New-application capability prompt

A saved Build-agent response claimed the CLI could only work in existing codebases
and could not create Django applications. Its turn ended without calling tools.
Inspection found no such capability restriction. Qwen was using the inherited
OpenCode fallback system prompt, which identifies itself as an interactive CLI
and heavily discusses existing-code conventions; the refusal was an unsupported
model claim, not an enforced framework or filesystem limitation.

Build and general workers now use `packages/rigovo/src/prompt.ts`, supplied through
`agent.prompt`, which replaces the fallback provider prompt. It explicitly supports
new applications and empty directories, requires actual implementation/testing,
explains that bash working directories do not persist between calls, and requires
repairing configuration/import errors in place. The plugin's identity guidance is
consistent with those capabilities and treats old assistant claims as fallible.

The initial native Django acceptance run created code but entered a navigation
and re-scaffolding loop; it was stopped and retained as
`.rigovo/validation/django-greenfield-initial.jsonl`. Working-directory and in-place
repair guidance was then added before the successful rerun.

The corrected native Qwen run created a new Django `dispatch` project and health
endpoint in `/private/tmp/rigovo-django-greenfield-fixed`, passed `manage.py check`
and its one SimpleTestCase, and ended with reason `stop`. Its 18 tool calls include
one failed ad hoc request check before final successful verification; the raw
`.rigovo/validation/django-greenfield-fixed.jsonl` preserves that history.
Independent checks reran the system check and test, then asserted the health HTTP
200/JSON response and missing-route HTTP 404 using Django's test client. The test
used the already-installed Django 4.2.30 interpreter; no dependencies were installed.
It validates minimal Django scaffolding, not a complete elevator application or
all possible framework tasks. Rigovo type checking and all 8 package tests passed.
The user's existing elevator source and conversation history were not rewritten.

## Bounded workers, shared context and memory retrieval

The native task/session loop is retained. `parallel_tasks` starts independent
native tasks in one call; a process-wide semaphore limits active workers (default
3, configurable 1..8). Queue cancellation, failure isolation, permit release,
background execution and permission behavior have regression coverage. Bounded
workers cannot create descendants while holding a slot, preventing pool deadlock.

Workers share a SQLite board with authored contracts/observations and atomic,
expiring path claims. Claims coordinate cooperative agents; arbitrary shell writes
are not sandboxed by them. The plugin passes bounded shared context and the exact
workspace into child assignments. Project-memory reads reuse connections and a
bounded cache; SQLite data-version checks detect other-worker commits. Injected
retrieval remains stable within a user turn; tools retrieve fresh observations.

History cleanup now scales thresholds to the selected model's usable context
budget, reserving 8192 tokens in the Rigovo profile. Recent turns and skill output
remain protected; raw stored history is retained. Within a single-user long task,
recent-turn protection can still retain tool output until summarization. This is
context management, not an infinite model window or Ollama KV-memory reduction.

Both affected packages passed type checks. The selected native-engine suites
passed **225 tests, 836 assertions, with one existing skip**. Rigovo passed **14
tests and 97 assertions**, including two-process claim contention/cache invalidation
and a real CLI/plugin/native-worker integration against a simulated local SSE
provider. That integration inspects actual model requests: both children receive
one system message with the Rigovo prompt, shared contract, correct workspace and
team/recall tools, plus the explicit user handoff. It proves request assembly and
coordination plumbing; it does not prove a real model follows every instruction.
Tests using loopback fixtures required sandbox networking permission. The native
executable was rebuilt, and formatting/diff checks passed.

Measured retrieval-only microbenchmark: 1000 uncached reads took 4812.59ms versus
375.19ms cached (12.83x), saved under `.rigovo/validation/memory-cache.json`.
This excludes inference and all other agent work and is not an agent speedup.

Initial real-Qwen foreground runs at worker limits 1 and 2 both passed independent
Python acceptance checks, taking 365.6s and 377.8s respectively. Both peaked at one
worker: the model issued task calls in successive turns. Raising a cap alone did
not produce parallelism. Artifacts: `.rigovo/validation/workers-collaboration/`.

The first deterministic batch peaked at two real workers but **failed independent
acceptance**, despite 10 generated tests passing. One worker invented a two-argument
API; another wrote to the parent directory. Elapsed time was 678.8s. The run is
retained at `.rigovo/validation/workers-batch/`; it is neither a successful
collaboration result nor evidence of a speedup. Explicit contract/workspace handoffs
were added afterward. No missing context-injection bug was reproduced in the
wire-level integration test.

Inference kernels, model weights, Ollama parallelism and KV quantization were not
changed. Actual concurrent workers do not establish lower task latency; additional
model requests can make a compute-bound workload slower. These checks cover small
acceptance workloads, not broad accuracy or hardware-throughput limits.

## ForgeCrew deployment preparation (2026-10-27)

The product repository was renamed to `kartikrathee/forgecrew`. The compatible
`bin/forgecrew` launcher reports the new product name. Existing Rigovo package
paths, tool names, environment variables and storage remain compatible.

Validation for this handoff:

- Both affected packages passed `bun typecheck`; the pre-push hook additionally
  passed all 31 monorepo type-check tasks.
- The selected engine suites passed 179 tests, with one existing skip. Rigovo
  passed 15 tests with 109 assertions, including the new tunnel URL/auth checks.
  Local HTTP fixtures required execution outside the restrictive sandbox.
- `actionlint` passed both active workflow definitions, and `kubectl kustomize
deploy/eks` rendered the deployment successfully.
- The Docker image built on local Linux ARM64 with the frozen lockfile. The
  launcher returned `ForgeCrew 2.0.0-alpha.1`; the actual running server returned
  HTTP 200 with `{"healthy":true}` with credentials and HTTP 401 without them.
  The GitHub/EKS image targets AMD64 and still requires its CI build validation.

GitHub returned a `startup_failure` against a deleted workflow record named
`BuildFailed`, without job logs. This is unresolved; local workflow linting is
not evidence of a successful GitHub run. No AWS resources were created, and no
real Cloudflare inference request was tested: AWS account/region and domain/
tunnel credentials are still required. The user selected EKS after being informed
that its control plane alone costs about $144 over 60 days, before worker costs.
