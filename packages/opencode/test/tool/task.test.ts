import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { TaskWorkers } from "../../src/tool/task-workers"
import { ParallelTasksTool, type Child } from "../../src/tool/parallel-tasks"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Tool } from "../../src/tool/tool"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function withWorkerLimit<A, E, R>(effect: Effect.Effect<A, E, R>, capacity = 1) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.RIGOVO_MAX_WORKERS
      process.env.RIGOVO_MAX_WORKERS = String(capacity)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.RIGOVO_MAX_WORKERS
        else process.env.RIGOVO_MAX_WORKERS = previous
      }),
  )
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "bounded workers reject nested tasks before they can deadlock on ancestor permits",
    () =>
      withWorkerLimit(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const child = yield* sessions.create({ parentID: chat.id, title: "child" })
          const tool = yield* TaskTool
          const def = yield* tool.init()
          const exit = yield* def
            .execute(
              { description: "nested", prompt: "nested", subagent_type: "general" },
              {
                sessionID: child.id,
                messageID: assistant.id,
                agent: "general",
                abort: new AbortController().signal,
                extra: { promptOps: stubOps() },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          expect(yield* sessions.children(child.id)).toHaveLength(0)
          expect(TaskWorkers.snapshot().waiting).toBe(0)
        }),
      ),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("foreground and background execution share worker permits", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const firstReady = yield* Deferred.make<void>()
        const secondReady = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const releaseSecond = yield* Deferred.make<void>()
        const prompts: string[] = []
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.sessionID === chat.id) return reply(input, "notified")
              const text = input.parts[0]?.type === "text" ? input.parts[0].text : ""
              prompts.push(text)
              yield* Deferred.succeed(text === "first" ? firstReady : secondReady, undefined)
              yield* Deferred.await(text === "first" ? releaseFirst : releaseSecond)
              return reply(input, text)
            }),
        }
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const first = yield* def
          .execute({ description: "first", prompt: "first", subagent_type: "general" }, context)
          .pipe(Effect.forkChild)
        yield* Deferred.await(firstReady)
        const second = yield* def.execute(
          { description: "second", prompt: "second", subagent_type: "general", background: true },
          context,
        )

        expect(second.metadata.background).toBe(true)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 1, waiting: 1 })
        expect(prompts).toEqual(["first"])
        expect((yield* sessions.create({ title: "unrelated work" })).title).toBe("unrelated work")

        yield* Deferred.succeed(releaseFirst, undefined)
        expect((yield* Fiber.join(first)).output).toContain("first")
        yield* Deferred.await(secondReady)
        expect(prompts).toEqual(["first", "second"])
        yield* Deferred.succeed(releaseSecond, undefined)
        expect((yield* jobs.wait({ id: second.metadata.sessionId })).info?.status).toBe("completed")
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
      }),
    ),
  )

  background.instance("cancelling a queued background task prevents child execution", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const prompts: string[] = []
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Effect.gen(function* () {
                  if (input.sessionID === chat.id) return reply(input, "notified")
                  prompts.push(input.sessionID)
                  yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(release)
                  return reply(input, "done")
                }),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const params = { description: "inspect", prompt: "inspect", subagent_type: "general", background: true }
        const first = yield* def.execute(params, context)
        yield* Deferred.await(ready)
        const queued = yield* def.execute(params, context)
        expect(TaskWorkers.snapshot().waiting).toBe(1)
        yield* jobs.cancel(queued.metadata.sessionId)
        expect((yield* jobs.get(queued.metadata.sessionId))?.status).toBe("cancelled")
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 1, waiting: 0 })
        yield* Deferred.succeed(release, undefined)
        yield* jobs.wait({ id: first.metadata.sessionId })
        expect(prompts).toEqual([first.metadata.sessionId])
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
      }),
    ),
  )

  background.instance("aborting a queued foreground task cancels its worker request", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const prompts: string[] = []
        const controller = new AbortController()
        const context = {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: (input) =>
                Effect.gen(function* () {
                  if (input.sessionID === chat.id) return reply(input, "notified")
                  prompts.push(input.sessionID)
                  yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(release)
                  return reply(input, "done")
                }),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const params = { description: "inspect", prompt: "inspect", subagent_type: "general" }
        const first = yield* def.execute({ ...params, background: true }, context)
        yield* Deferred.await(ready)
        const queued = yield* def.execute(params, { ...context, abort: controller.signal }).pipe(Effect.forkChild)
        yield* Effect.yieldNow.pipe(
          Effect.repeat({ until: () => TaskWorkers.snapshot().waiting === 1 }),
          Effect.timeout("2 seconds"),
        )
        controller.abort()
        expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 1, waiting: 0 })
        yield* Deferred.succeed(release, undefined)
        yield* jobs.wait({ id: first.metadata.sessionId })
        expect(prompts).toEqual([first.metadata.sessionId])
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
      }),
    ),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})

const batch = {
  tasks: [
    { description: "first", prompt: "first", subagent_type: "general" },
    { description: "second", prompt: "second", subagent_type: "general" },
  ],
}

const seedParallel = Effect.fn("ParallelTasksTest.seed")(function* (promptOps: TaskPromptOps) {
  const { chat, assistant } = yield* seed()
  const tool = yield* ParallelTasksTool
  const def = yield* tool.init()
  const context: Tool.Context = {
    sessionID: chat.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
  return { def, context }
})

describe("tool.parallel_tasks", () => {
  it.instance("native tasks surface assistant model errors even when a partial text result exists", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const { context } = yield* seedParallel({
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              const result = reply(input, "partial output is not success")
              if (result.info.role === "assistant")
                result.info.error = {
                  name: "APIError",
                  data: { message: "provider rejected request", isRetryable: false },
                }
              return result
            }),
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        expect(Exit.isFailure(yield* def.execute(batch.tasks[0]!, context).pipe(Effect.exit))).toBe(true)
        const child = (yield* sessions.children(context.sessionID))[0]!
        const job = yield* jobs.get(child.id)
        expect(job?.status).toBe("error")
        expect(job?.error).toContain("provider rejected request")
        expect(job?.output).toBeUndefined()
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
      }),
    ),
  )

  it.instance("reports assistant model errors as failed children rather than completed executions", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const { def, context } = yield* seedParallel({
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              const result = reply(input, "worker text")
              if (
                result.info.role === "assistant" &&
                input.parts[0]?.type === "text" &&
                input.parts[0].text === "first"
              )
                result.info.error = { name: "ContextOverflowError", data: { message: "context window exceeded" } }
              return result
            }),
        })
        const result = yield* def.execute(batch, context)
        expect(result.metadata.children.map((child) => child.status)).toEqual(["error", "completed"])
        expect(result.metadata.children[0]?.error).toContain("context window exceeded")
        expect(result.metadata.children[0]?.output).toBeUndefined()
        expect(result.metadata.completed).toBe(1)
        expect(result.metadata.failed).toBe(1)
      }),
    ),
  )

  it.instance("starts two native children before either finishes and aggregates their metadata", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const entered: string[] = []
        const snapshots: Child[][] = []
        const { def, context } = yield* seedParallel({
          ...stubOps(),
          prompt: (input) =>
            Effect.gen(function* () {
              entered.push(input.sessionID)
              if (entered.length === 2) yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return reply(input, `finished ${input.parts[0]?.type === "text" ? input.parts[0].text : ""}`)
            }),
        })
        const metadata: Tool.Context["metadata"] = (input) =>
          Effect.sync(() => {
            expect(input.metadata?.sessionId).toBeUndefined()
            snapshots.push(input.metadata?.children as Child[])
          })
        const fiber = yield* def.execute(batch, { ...context, metadata }).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 2, running: 2, waiting: 0 })
        expect(new Set(entered).size).toBe(2)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(fiber)
        expect(result.metadata.completed).toBe(2)
        expect(result.metadata.failed).toBe(0)
        expect(result.metadata.children.map((child) => child.status)).toEqual(["completed", "completed"])
        expect(result.metadata.children.map((child) => child.output)).toEqual([
          expect.stringContaining("finished first"),
          expect.stringContaining("finished second"),
        ])
        expect(result.metadata.children.every((child) => child.parentSessionId === context.sessionID)).toBe(true)
        expect(snapshots.at(-1)).toEqual(result.metadata.children)
        expect(JSON.parse(result.output).children).toEqual(result.metadata.children)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 2, running: 0, waiting: 0 })
      }),
      2,
    ),
  )

  it.instance("one batch still respects a worker capacity of one", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const entered: string[] = []
        const { def, context } = yield* seedParallel({
          ...stubOps(),
          prompt: (input) =>
            Effect.gen(function* () {
              entered.push(input.sessionID)
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return reply(input, "done")
            }),
        })
        const fiber = yield* def.execute(batch, context).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        yield* Effect.yieldNow.pipe(
          Effect.repeat({ until: () => TaskWorkers.snapshot().waiting === 1 }),
          Effect.timeout("2 seconds"),
        )
        expect(entered).toHaveLength(1)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 1, waiting: 1 })
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(fiber)).metadata.completed).toBe(2)
        expect(new Set(entered).size).toBe(2)
      }),
    ),
  )

  it.instance("a child failure settles alongside its successful sibling", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const { def, context } = yield* seedParallel({
          ...stubOps(),
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.parts[0]?.type === "text" && input.parts[0].text === "first")
                return yield* Effect.die(new Error("first worker failed"))
              yield* Deferred.succeed(ready, undefined)
              yield* Deferred.await(release)
              return reply(input, "second worker completed")
            }),
        })
        const fiber = yield* def.execute(batch, context).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(fiber)
        expect(result.metadata.children.map((child) => child.status)).toEqual(["error", "completed"])
        expect(result.metadata.children[0]?.error).toContain("first worker failed")
        expect(result.metadata.children[0]?.sessionId).toBeDefined()
        expect(result.metadata.children[1]?.output).toContain("second worker completed")
        expect(result.metadata.completed).toBe(1)
        expect(result.metadata.failed).toBe(1)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
      }),
    ),
  )

  it.instance("uses each native task permission check and preserves the bypass context", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { def, context } = yield* seedParallel(stubOps())
        const permissions: string[] = []
        const ask: Tool.Context["ask"] = (input) =>
          Effect.gen(function* () {
            permissions.push(input.permission)
            expect(input.patterns).toEqual(["general"])
            if (input.metadata.description === "first") return yield* Effect.fail(new Error("Permission denied"))
          }).pipe(Effect.orDie)
        const result = yield* def.execute(batch, { ...context, ask })
        expect(permissions).toEqual(["task", "task"])
        expect(result.metadata.children.map((child) => child.status)).toEqual(["error", "completed"])
        expect(result.metadata.children[0]?.sessionId).toBeUndefined()
        expect(result.metadata.children[0]?.error).toContain("Permission denied")
        expect(yield* sessions.children(context.sessionID)).toHaveLength(1)

        const bypassed = yield* def.execute(batch, {
          ...context,
          ask,
          extra: { ...context.extra, bypassAgentCheck: true },
        })
        expect(bypassed.metadata.completed).toBe(2)
        expect(permissions).toHaveLength(2)
      }),
    ),
  )

  it.instance("abort interrupts the batch and cancels running and queued children", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const ready = yield* Deferred.make<void>()
        const controller = new AbortController()
        const snapshots: Child[][] = []
        const { def, context } = yield* seedParallel({
          ...stubOps(),
          prompt: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const fiber = yield* def
          .execute(batch, {
            ...context,
            abort: controller.signal,
            metadata: (input) => Effect.sync(() => void snapshots.push(input.metadata?.children as Child[])),
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        yield* Effect.yieldNow.pipe(
          Effect.repeat({ until: () => TaskWorkers.snapshot().waiting === 1 }),
          Effect.timeout("2 seconds"),
        )
        controller.abort()
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
        expect(TaskWorkers.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
        expect((yield* jobs.list()).map((job) => job.status)).toEqual(["cancelled", "cancelled"])
        expect(snapshots.at(-1)?.map((child) => child.status)).toEqual(["cancelled", "cancelled"])
      }),
    ),
  )

  it.instance("validates batch sizes before creating child sessions", () =>
    withWorkerLimit(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { def, context } = yield* seedParallel(stubOps())
        expect(Exit.isFailure(yield* def.execute({ tasks: batch.tasks.slice(0, 1) }, context).pipe(Effect.exit))).toBe(
          true,
        )
        expect(
          Exit.isFailure(
            yield* def.execute({ tasks: Array.from({ length: 9 }, () => batch.tasks[0]!) }, context).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* sessions.children(context.sessionID)).toHaveLength(0)
      }),
    ),
  )
})
