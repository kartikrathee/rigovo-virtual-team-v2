import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Collaboration } from "../src/collaboration"
import { MemoryReader, remember } from "../src/memory"

test("memory cache observes commits from other connections, including database creation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-cache-"))
  using reader = new MemoryReader(root)
  expect(reader.recall("alpha")).toEqual([])
  remember(root, "alpha contract version one", "first")
  expect(reader.recall("alpha")[0]?.content).toBe("alpha contract version one")
  reader.recall("alpha")
  expect(reader.stats.hits).toBe(1)
  using writer = new Database(path.join(root, ".rigovo/memory-v2.sqlite"))
  writer.query("INSERT INTO fact VALUES (?, ?, ?)").run("beta contract from another worker", "second", Date.now())
  expect(reader.recall("beta")[0]?.content).toBe("beta contract from another worker")
  expect(reader.stats.reloads).toBe(3)
  const result = reader.recall("beta")
  result[0]!.content = "mutated by caller"
  expect(reader.recall("beta")[0]?.content).toContain("another worker")
})

test("memory context is bounded without deleting or truncating stored observations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-budget-"))
  remember(root, "a".repeat(1900), "first")
  remember(root, "b".repeat(1900), "second")
  using reader = new MemoryReader(root)
  const facts = reader.recall("", 4, 2000)
  expect(facts).toHaveLength(1)
  expect(facts[0]!.content.length).toBe(1900)
  expect(reader.recall("", 4, 4000)).toHaveLength(2)
})

test("shared context isolates task families and projects while retaining author provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-team-"))
  using board = new Collaboration(root)
  using other = new Collaboration(fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-other-")))
  board.publish("one", "parent", "contract", "decision", "Return JSON with total and status")
  board.publish("one", "worker", "contract", "finding", "Worker implementation uses status=ok")
  expect(board.read("one")).toContain("parent")
  expect(board.read("one")).toContain("worker")
  expect(board.read("one")).toContain("unverified")
  expect(board.read("two")).toBe("")
  expect(other.read("one")).toBe("")
  expect(board.read("one", "", 30).length).toBeLessThanOrEqual(30)
})

test("path claims reject overlaps atomically, expire, and preserve unrelated claims", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-claims-"))
  using board = new Collaboration(root)
  const now = Date.now()
  board.claim("one", "first", ["src"], now)
  expect(() => board.claim("one", "second", ["other.py", "src/api.py"], now)).toThrow("overlaps")
  expect(board.claim("one", "third", ["other.py"], now)).toEqual(["other.py"])
  expect(() => board.claim("different-conversation", "second", ["src/api.py"], now)).toThrow("overlaps")
  expect(() => board.claim("one", "second", ["../outside"], now)).toThrow()
  fs.symlinkSync(os.tmpdir(), path.join(root, "linked"))
  expect(() => board.claim("one", "second", ["linked/target"], now)).toThrow("Symlink")
  expect(board.release("one", "first")).toBe(1)
  expect(board.claim("one", "second", ["src/api.py"], now)).toEqual(["src/api.py"])
  expect(board.claim("one", "fourth", ["src"], now + 30 * 60_000 + 1)).toEqual(["src"])
})

test("independent processes cannot acquire the same project path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-race-"))
  {
    using initial = new Collaboration(root)
  }
  const module = new URL("../src/collaboration.ts", import.meta.url).href
  const processes = ["one", "two"].map((owner) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Collaboration } = await import(${JSON.stringify(module)});
     using board = new Collaboration(${JSON.stringify(root)});
     try { board.claim("root", ${JSON.stringify(owner)}, ["module.py"]); }
     catch (error) { if (!error.message.includes("overlaps")) throw error; process.exitCode=2; }`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  )
  const exits = await Promise.all(processes.map((child) => child.exited))
  expect(await Promise.all(processes.map((child) => new Response(child.stderr).text()))).toEqual(["", ""])
  expect(exits.sort()).toEqual([0, 2])
})
