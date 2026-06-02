import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TaskWorkers } from "../../src/tool/task-workers"
import { it } from "../lib/effect"

describe("task workers", () => {
  test("only enables limits for Rigovo and validates the worker setting", () => {
    expect(TaskWorkers.limit({})).toBeUndefined()
    expect(TaskWorkers.limit({ RIGOVO_SESSION_PERMISSION: "ask" })).toBe(3)
    expect(TaskWorkers.limit({ RIGOVO_MAX_WORKERS: "1" })).toBe(1)
    expect(TaskWorkers.limit({ RIGOVO_MAX_WORKERS: "8" })).toBe(8)
    for (const value of ["", "0", "9", "-1", "1.5", "3workers", "Infinity"])
      expect(() => TaskWorkers.limit({ RIGOVO_MAX_WORKERS: value })).toThrow("RIGOVO_MAX_WORKERS")
  })

  it.effect("bounds execution while unrelated effects continue", () =>
    Effect.gen(function* () {
      const pool = TaskWorkers.make(2)
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const entered: number[] = []
      const run = (id: number) =>
        pool.run(
          Effect.gen(function* () {
            entered.push(id)
            if (entered.length === 2) yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(release)
            return id
          }),
        )
      const first = yield* run(1).pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* run(2).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(ready)
      const third = yield* run(3).pipe(Effect.forkChild({ startImmediately: true }))

      expect(pool.snapshot()).toEqual({ limit: 2, running: 2, waiting: 1 })
      expect(entered).toEqual([1, 2])
      expect(yield* Effect.succeed("unrelated work")).toBe("unrelated work")

      yield* Deferred.succeed(release, undefined)
      expect(yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(third)])).toEqual([1, 2, 3])
      expect(pool.snapshot()).toEqual({ limit: 2, running: 0, waiting: 0 })
    }),
  )

  it.effect("interrupting a queued request removes it without running it", () =>
    Effect.gen(function* () {
      const pool = TaskWorkers.make(1)
      const release = yield* Deferred.make<void>()
      const first = yield* pool.run(Deferred.await(release)).pipe(Effect.forkChild({ startImmediately: true }))
      const entered: string[] = []
      const queued = yield* pool
        .run(Effect.sync(() => entered.push("cancelled")))
        .pipe(Effect.forkChild({ startImmediately: true }))
      expect(pool.snapshot()).toEqual({ limit: 1, running: 1, waiting: 1 })

      yield* Fiber.interrupt(queued)
      expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true)
      expect(pool.snapshot()).toEqual({ limit: 1, running: 1, waiting: 0 })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* pool.run(Effect.sync(() => entered.push("next")))
      expect(entered).toEqual(["next"])
      expect(pool.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
    }),
  )

  it.effect("interrupting running work releases its permit to a queued request", () =>
    Effect.gen(function* () {
      const pool = TaskWorkers.make(1)
      const first = yield* pool.run(Effect.never).pipe(Effect.forkChild({ startImmediately: true }))
      const queued = yield* pool.run(Effect.succeed("next")).pipe(Effect.forkChild({ startImmediately: true }))
      expect(pool.snapshot()).toEqual({ limit: 1, running: 1, waiting: 1 })
      yield* Fiber.interrupt(first)
      expect(yield* Fiber.join(queued)).toBe("next")
      expect(pool.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
    }),
  )

  it.effect("failures and defects release permits", () =>
    Effect.gen(function* () {
      const pool = TaskWorkers.make(1)
      expect(Exit.isFailure(yield* pool.run(Effect.fail(new Error("failed"))).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* pool.run(Effect.die(new Error("defect"))).pipe(Effect.exit))).toBe(true)
      expect(yield* pool.run(Effect.succeed("next"))).toBe("next")
      expect(pool.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
    }),
  )

  it.effect("resizing keeps held permits and waits until running work falls below the new limit", () =>
    Effect.gen(function* () {
      const pool = TaskWorkers.make(2)
      const first = yield* pool.run(Effect.never).pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* pool.run(Effect.never).pipe(Effect.forkChild({ startImmediately: true }))
      yield* pool.resize(1)
      const queued = yield* pool.run(Effect.succeed("next")).pipe(Effect.forkChild({ startImmediately: true }))
      expect(pool.snapshot()).toEqual({ limit: 1, running: 2, waiting: 1 })
      yield* Fiber.interrupt(first)
      expect(pool.snapshot()).toEqual({ limit: 1, running: 1, waiting: 1 })
      yield* Fiber.interrupt(second)
      expect(yield* Fiber.join(queued)).toBe("next")
      expect(pool.snapshot()).toEqual({ limit: 1, running: 0, waiting: 0 })
    }),
  )
})
