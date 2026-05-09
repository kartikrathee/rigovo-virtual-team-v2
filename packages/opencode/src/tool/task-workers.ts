import { Effect, Semaphore } from "effect"

export function limit(env: Record<string, string | undefined> = process.env) {
  if (env.RIGOVO_MAX_WORKERS === undefined && env.RIGOVO_SESSION_PERMISSION === undefined) return
  const value = env.RIGOVO_MAX_WORKERS ?? "3"
  if (!/^[1-8]$/.test(value)) throw new Error("RIGOVO_MAX_WORKERS must be an integer from 1 to 8")
  return Number(value)
}

export function make(capacity: number) {
  const semaphore = Semaphore.makeUnsafe(capacity)
  const state = { limit: capacity, waiting: 0, running: 0 }
  const snapshot = () => ({ ...state })
  const log = () => Effect.logDebug("Task worker pool", snapshot())

  const run = <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        state.waiting++
        return { started: false }
      }),
      (entry) =>
        log().pipe(
          Effect.andThen(
            semaphore.withPermit(
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  entry.started = true
                  state.waiting--
                  state.running++
                }),
                () => log().pipe(Effect.andThen(self)),
                () =>
                  Effect.sync(() => {
                    state.running--
                  }).pipe(Effect.andThen(log())),
              ),
            ),
          ),
        ),
      (entry) =>
        Effect.sync(() => {
          if (!entry.started) state.waiting--
        }).pipe(Effect.andThen(log())),
    )

  const resize = (capacity: number) =>
    semaphore.resize(capacity).pipe(
      Effect.andThen(
        Effect.sync(() => {
          state.limit = capacity
        }),
      ),
    )

  return { run, resize, snapshot }
}

// One process-wide pool, shared by TaskTool instances in every open project.
const shared = make(3)

export function run<A, E, R>(self: Effect.Effect<A, E, R>, capacity: number | undefined) {
  if (capacity === undefined) return self
  return shared.resize(capacity).pipe(Effect.andThen(shared.run(self)))
}

export const snapshot = shared.snapshot

export * as TaskWorkers from "./task-workers"
