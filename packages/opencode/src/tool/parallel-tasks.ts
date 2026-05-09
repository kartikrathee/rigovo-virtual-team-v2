import { Cause, Effect, Schema, SynchronizedRef } from "effect"
import { Tool } from "./tool"
import { TaskTool } from "./task"
import type { SessionID } from "@/session/schema"

export const Parameters = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      description: Schema.String.annotate({ description: "A short description of this independent task" }),
      prompt: Schema.String.annotate({ description: "The complete instructions for this task" }),
      subagent_type: Schema.String.annotate({ description: "The specialized agent type to execute" }),
      task_id: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
})

export interface Child {
  index: number
  description: string
  subagent_type: string
  status: "pending" | "running" | "completed" | "error" | "cancelled"
  sessionId?: SessionID
  parentSessionId?: SessionID
  output?: string
  error?: string
}

export const ParallelTasksTool = Tool.define(
  "parallel_tasks",
  Effect.gen(function* () {
    const task = yield* TaskTool
    const child = yield* task.init()

    return {
      description:
        "Run 2 to 8 independent subagent tasks concurrently in ONE call and wait for their results. " +
        "Use this for non-overlapping work that can proceed at the same time. " +
        "The worker limit controls actual concurrency. Each task uses the native task tool's permissions and depth limits. " +
        "Returns every child's sessionId, status, output or error. A failed task does not discard its siblings' results.",
      parameters: Parameters,
      execute: Effect.fn("ParallelTasksTool.execute")(function* (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ) {
        if (process.env.RIGOVO_MAX_WORKERS === undefined)
          return yield* Effect.die(new Error("parallel_tasks requires the Rigovo worker profile"))
        if (ctx.abort.aborted) return yield* Effect.interrupt

        const state = yield* SynchronizedRef.make<Child[]>(
          params.tasks.map((task, index) => ({
            index,
            description: task.description,
            subagent_type: task.subagent_type,
            status: "pending",
          })),
        )
        const metadata = (children: Child[]) => ({
          children,
          completed: children.filter((child) => child.status === "completed").length,
          failed: children.filter((child) => child.status === "error").length,
        })
        const update = (index: number, patch: Partial<Child>) =>
          SynchronizedRef.updateEffect(state, (children) => {
            const next = children.map((child) => (child.index === index ? { ...child, ...patch } : child))
            return ctx.metadata({ title: "Parallel tasks", metadata: metadata(next) }).pipe(Effect.as(next))
          })

        yield* ctx.metadata({ title: "Parallel tasks", metadata: metadata(yield* SynchronizedRef.get(state)) })
        const execute = Effect.forEach(
          params.tasks,
          (params, index) =>
            child
              .execute(params, {
                ...ctx,
                metadata: (input) =>
                  update(index, {
                    ...(input.metadata?.sessionId ? { sessionId: input.metadata.sessionId } : {}),
                    ...(input.metadata?.parentSessionId ? { parentSessionId: input.metadata.parentSessionId } : {}),
                    status: "running",
                  }),
              })
              .pipe(
                Effect.matchCauseEffect({
                  onSuccess: (result) =>
                    update(index, {
                      sessionId: result.metadata.sessionId,
                      parentSessionId: result.metadata.parentSessionId,
                      status: result.metadata.background ? "running" : "completed",
                      output: result.output,
                    }),
                  onFailure: (cause) => {
                    if (Cause.hasInterrupts(cause) || ctx.abort.aborted) return Effect.interrupt
                    const error = Cause.squash(cause)
                    return update(index, {
                      status: "error",
                      error: error instanceof Error ? error.message : String(error),
                    })
                  },
                }),
                Effect.onInterrupt(() => update(index, { status: "cancelled" })),
              ),
          { concurrency: "unbounded", discard: true },
        )
        const aborted = Effect.callback<never>((resume) => {
          const onAbort = () => resume(Effect.interrupt)
          ctx.abort.addEventListener("abort", onAbort)
          if (ctx.abort.aborted) onAbort()
          return Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))
        })
        yield* Effect.raceFirst(execute, aborted)
        const children = yield* SynchronizedRef.get(state)
        return {
          title: "Parallel tasks",
          metadata: metadata(children),
          output: JSON.stringify({ children }, null, 2),
        }
      }),
    }
  }),
)
