import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const output = path.resolve(process.argv[2] ?? path.join(root, ".rigovo/validation", `workers-${Date.now()}`))
const levels = (process.argv[3] ?? "1,2").split(",").map(Number)
const delegation = process.argv[4] ?? "batch"
if (!["batch", "foreground"].includes(delegation)) throw new Error("Delegation must be batch or foreground")
if (levels.some((level) => !Number.isInteger(level) || level < 1 || level > 8))
  throw new Error("Worker levels must be 1..8")
fs.mkdirSync(output, { recursive: false })
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-worker-benchmark-"))
const model = process.env.RIGOVO_MODEL ?? "qwen3-coder-32k:latest"
const url = new URL(process.env.OLLAMA_OPENAI_URL ?? "http://127.0.0.1:11434/v1")
if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  throw new Error("Use local Ollama")
const warm = await fetch(new URL("/api/generate", url), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    prompt: "Reply READY",
    stream: false,
    keep_alive: "30m",
    options: { temperature: 0, num_predict: 8 },
  }),
})
if (!warm.ok) throw new Error(`Ollama warmup failed: ${warm.status}`)
await warm.json()
const prompt = `Complete this collaboration acceptance task with exactly two general subagents.
First use rigovo_team publish to share a decision keyed api-contract: a.scale(value: int) returns value*2;
b.normalize(text: str) collapses whitespace to single spaces and trims both ends.
${delegation === "batch" ? "Then invoke parallel_tasks ONCE with an array of exactly two general tasks. This tool guarantees scheduling both before joining their results." : "Then issue TWO foreground task tool calls in ONE assistant tool-call batch so they can run concurrently."}
Worker A exclusively owns a.py and test_a.py. Implement scale and unittest negative, zero and positive inputs.
Worker B exclusively owns b.py and test_b.py. Implement normalize and unittest empty input and mixed whitespace.
Each worker must read the shared api-contract with rigovo_team, claim its two files, implement and RUN its own tests,
then publish a concise result with the command and observed test result. Do not spawn nested tasks.
You own only test_integration.py. After both workers finish, write and run integration tests importing both modules.
Run python3 -m unittest discover -v, report only observed results, then stop.
Do not implement either worker's modules yourself. Use standard-library Python only.`

const report: { scope: string; workspace: string; model: string; delegation: string; runs: Record<string, unknown>[] } =
  {
    scope:
      "Small end-to-end collaboration acceptance; shared model, prompt caching and run order affect timings. No general speedup claim.",
    workspace,
    model,
    delegation,
    runs: [],
  }
for (const [index, limit] of levels.entries()) {
  const directory = path.join(workspace, `limit-${limit}-${index}`)
  fs.mkdirSync(directory)
  const events = path.join(output, `events-${index}.jsonl`)
  const logs = path.join(output, `runtime-${index}.log`)
  const started = performance.now()
  const child = Bun.spawn(
    [
      path.join(root, "bin/rigovo"),
      "--permissions",
      "allow",
      "--print-logs",
      "--log-level",
      "DEBUG",
      "run",
      "--dir",
      directory,
      "--format",
      "json",
      prompt,
    ],
    {
      cwd: root,
      env: { ...process.env, RIGOVO_MAX_WORKERS: String(limit) },
      stdout: Bun.file(events),
      stderr: Bun.file(logs),
    },
  )
  const exit = await child.exited
  const elapsed = performance.now() - started
  const parsed = fs
    .readFileSync(events, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const parts = parsed.map((event) => event.part).filter(Boolean)
  const tasks =
    delegation === "batch"
      ? parts
          .filter((part) => part.tool === "parallel_tasks")
          .flatMap((part) =>
            (part.state.metadata?.children ?? []).map((child: { sessionId?: string; status: string }) => ({
              state: {
                status: child.status,
                metadata: { sessionId: child.sessionId },
              },
            })),
          )
      : parts.filter((part) => part.tool === "task")
  const verify = Bun.spawn(["python3", "-m", "unittest", "discover", "-v"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const verification = (await new Response(verify.stderr).text()) + (await new Response(verify.stdout).text())
  const verificationExit = await verify.exited
  fs.writeFileSync(path.join(output, `verification-${index}.txt`), verification)
  const probe = Bun.spawn(
    [
      "python3",
      "-c",
      "from a import scale; from b import normalize; assert [scale(n) for n in (-2,0,3)]==[-4,0,6]; assert normalize('  a\\t b\\n ')== 'a b'; assert normalize('')==''",
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  )
  const probeExit = await probe.exited
  const runtime = fs.readFileSync(logs, "utf8")
  const peaks = [...runtime.matchAll(/message="Task worker pool"[^\n]*running=(\d+)/g)].map((match) => Number(match[1]))
  const ids = tasks.map((task) => task.state.metadata?.sessionId).filter(Boolean)
  const runtimeHome = process.env.RIGOVO_HOME ?? path.join(root, ".rigovo/runtime")
  const database = path.join(runtimeHome, "data/opencode/opencode-rigovo.db")
  const usage: { session: string; input: number; output: number; cached: number }[] = []
  if (fs.existsSync(database)) {
    using db = new Database(database, { readonly: true })
    for (const session of ids) {
      const messages = db.query("SELECT data FROM message WHERE session_id=?").all(session) as { data: string }[]
      const assistant = messages.map((row) => JSON.parse(row.data)).filter((message) => message.role === "assistant")
      usage.push({
        session,
        input: assistant.reduce((sum, message) => sum + (message.tokens?.input ?? 0), 0),
        output: assistant.reduce((sum, message) => sum + (message.tokens?.output ?? 0), 0),
        cached: assistant.reduce((sum, message) => sum + (message.tokens?.cache?.read ?? 0), 0),
      })
    }
  }
  const testCount = Number(verification.match(/Ran (\d+) tests?/)?.[1] ?? 0)
  const passed =
    exit === 0 &&
    !parsed.some((event) => event.type === "error") &&
    tasks.length === 2 &&
    tasks.every((task) => task.state.status === "completed") &&
    parts.findLast((part) => part.type === "step-finish")?.reason === "stop" &&
    verificationExit === 0 &&
    testCount >= 3 &&
    !verification.includes("skipped") &&
    probeExit === 0
  const run = {
    limit,
    elapsed_ms: elapsed,
    passed,
    exit,
    test_count: testCount,
    worker_peak: peaks.length ? Math.max(...peaks) : undefined,
    tasks: ids,
    usage,
  }
  report.runs.push(run)
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(run))
  if (!passed) throw new Error(`Acceptance failed; inspect ${output}`)
}
console.log(`Report: ${output}`)
