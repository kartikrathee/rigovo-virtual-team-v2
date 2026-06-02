import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { RIGOVO_PROMPT } from "../src/prompt"

type Message = { role: string; content?: string | { type: string; text?: string }[] }
type Posted = {
  model: string
  stream?: boolean
  messages: Message[]
  tools?: { type: string; function: { name: string } }[]
}
type Event = {
  type: string
  part?: {
    tool?: string
    text?: string
    state?: { status: string; metadata?: { children?: { sessionId?: string; status: string }[] } }
  }
}

const contract = "SCALE_CONTRACT: scale(value) returns value*2"
const markers = ["TEST_PARENT", "TEST_CHILD_A", "TEST_CHILD_B"] as const

function text(message: Message) {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? []).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n")
}

// Only the provider is simulated. The launcher, plugin hooks, SDK, permissions,
// session ancestry, native task execution and worker queue all run normally.
function completion(body: Posted, value: string | { name: string; args: unknown }) {
  const tool = typeof value === "string" ? undefined : value
  const message = tool
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${crypto.randomUUID()}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      }
    : { role: "assistant", content: value }
  const base = { id: `chatcmpl_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model }
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  if (!body.stream)
    return Response.json({
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
      usage,
    })

  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    ...base,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason }],
  })
  const chunks = [
    chunk({ role: "assistant" }),
    chunk(tool ? { tool_calls: message.tool_calls!.map((call, index) => ({ ...call, index })) } : { content: value }),
    { ...chunk({}, tool ? "tool_calls" : "stop"), usage },
  ]
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  })
}

test("native workers receive the real Rigovo prompt, shared contracts, tools and workspace", async () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-plugin-runtime-")))
  using cleanup = {
    [Symbol.dispose]() {
      fs.rmSync(temporary, { recursive: true, force: true })
    },
  }
  const workspace = path.join(temporary, "workspace")
  fs.mkdirSync(workspace)
  const captured: Record<(typeof markers)[number], Posted[]> = {
    TEST_PARENT: [],
    TEST_CHILD_A: [],
    TEST_CHILD_B: [],
  }
  const unexpected: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        unexpected.push(`${request.method} ${new URL(request.url).pathname}`)
        return Response.json({ error: "Unexpected fixture endpoint" }, { status: 400 })
      }
      const body = (await request.json()) as Posted
      // Title-model requests carry no tools and do not belong to the agent loop.
      if (!body.tools?.length) return completion(body, "Fixture title")
      const lastUser = body.messages.findLast((message) => message.role === "user")
      const marker = markers.find((marker) => lastUser && text(lastUser).includes(marker))
      if (!marker) {
        unexpected.push(`Unrecognized user message: ${lastUser ? text(lastUser) : "missing"}`)
        return completion(body, "Unexpected fixture request")
      }
      captured[marker].push(body)
      if (marker !== "TEST_PARENT") return completion(body, "ACK")
      if (captured.TEST_PARENT.length === 1)
        return completion(body, {
          name: "rigovo_team",
          args: { action: "publish", key: "api-contract", kind: "decision", content: contract },
        })
      if (captured.TEST_PARENT.length === 2)
        return completion(body, {
          name: "parallel_tasks",
          args: {
            tasks: [
              {
                description: "Fixture child A",
                prompt: "TEST_CHILD_A\nAcknowledge your assignment.",
                subagent_type: "general",
              },
              {
                description: "Fixture child B",
                prompt: "TEST_CHILD_B\nAcknowledge your assignment.",
                subagent_type: "general",
              },
            ],
          },
        })
      return completion(body, "DONE")
    },
  })

  try {
    const launcher = fileURLToPath(new URL("../src/main.ts", import.meta.url))
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("RIGOVO_")),
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        launcher,
        "--permissions",
        "allow",
        "run",
        "--dir",
        workspace,
        "--format",
        "json",
        "TEST_PARENT",
      ],
      {
        cwd: workspace,
        env: {
          ...inherited,
          RIGOVO_HOME: path.join(temporary, "runtime"),
          RIGOVO_SOURCE: "1",
          RIGOVO_MAX_WORKERS: "2",
          RIGOVO_MODEL: "rigovo-runtime-fixture",
          OLLAMA_OPENAI_URL: `${server.url.origin}/v1`,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const state = { timedOut: false }
    const timer = setTimeout(() => {
      state.timedOut = true
      child.kill("SIGKILL")
    }, 25_000)
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(state.timedOut, stderr).toBe(false)
      expect(exit, stderr).toBe(0)
      expect(unexpected).toEqual([])
      expect(captured.TEST_PARENT, stdout + stderr).toHaveLength(3)
      expect(captured.TEST_CHILD_A, stdout + stderr).toHaveLength(1)
      expect(captured.TEST_CHILD_B, stdout + stderr).toHaveLength(1)

      for (const marker of markers) {
        const request = captured[marker][0]!
        const systems = request.messages.filter((message) => message.role === "system")
        expect(systems, marker).toHaveLength(1)
        const system = text(systems[0]!)
        expect(system, marker).toContain(RIGOVO_PROMPT)
        expect(system, marker).toContain(`Working directory: ${workspace}`)
        const tools = request.tools!.map((tool) => tool.function.name)
        expect(tools, marker).toContain("rigovo_team")
        expect(tools, marker).toContain("rigovo_recall")
        if (marker !== "TEST_PARENT") {
          // The fixture supplies marker-only assignments. Inspect assembled
          // system messages rather than copying the contract into those inputs.
          expect(system, marker).toContain(contract)
          expect(system, marker).toContain("api-contract")
          const assignment = text(request.messages.findLast((message) => message.role === "user")!)
          expect(assignment, marker).toContain(contract)
          expect(assignment, marker).toContain(`Assigned workspace: ${workspace}`)
        }
      }

      const events = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event)
      expect(events.filter((event) => event.type === "error")).toEqual([])
      const parallel = events.find((event) => event.part?.tool === "parallel_tasks")
      expect(parallel?.part?.state?.status).toBe("completed")
      expect(parallel?.part?.state?.metadata?.children?.map((child) => child.status)).toEqual([
        "completed",
        "completed",
      ])
      expect(new Set(parallel?.part?.state?.metadata?.children?.map((child) => child.sessionId)).size).toBe(2)
      expect(events.findLast((event) => event.type === "text")?.part?.text).toBe("DONE")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
    }
  } finally {
    await server.stop(true)
  }
}, 30_000)
