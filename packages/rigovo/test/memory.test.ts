import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { configuration } from "../src/config"
import { pendingGoal, projectID, recall, remember } from "../src/memory"

test("project notes persist, deduplicate and remain isolated across workspaces", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-memory-"))
  const one = path.join(root, "one")
  const two = path.join(root, "two")
  remember(one, "Django tests use manage.py test", "session-one")
  remember(one, "Django tests use manage.py test", "session-two")
  remember(two, "Other workspace uses a separate database", "session-three")
  expect(recall(one, "Django")).toHaveLength(1)
  expect(recall(one, "Django")[0]?.content).toContain("manage.py test")
  expect(recall(two, "database")[0]?.content).not.toContain("Django")
})

test("legacy retrieval is read-only and excludes another project's memories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-legacy-"))
  fs.mkdirSync(path.join(root, ".rigovo"))
  const file = path.join(root, ".rigovo/local.db")
  {
    using db = new Database(file)
    db.exec("CREATE TABLE memories (content TEXT, source_project_id TEXT, usage_count INTEGER)")
    db.query("INSERT INTO memories VALUES (?, ?, 1)").run("Project uses pytest", projectID(root))
    db.query("INSERT INTO memories VALUES (?, ?, 10)").run("Foreign project secret", projectID("/different"))
  }
  const original = fs.readFileSync(file)
  expect(recall(root, "pytest").map((fact) => fact.content)).toEqual(["Project uses pytest"])
  expect(fs.readFileSync(file)).toEqual(original)
})

test("the stored pending task is context and completed tasks are not resumed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-goal-"))
  fs.mkdirSync(path.join(root, ".rigovo"))
  const file = path.join(root, ".rigovo/direct-chat.json")
  fs.writeFileSync(file, JSON.stringify({ description: "Build scheduler", status: "paused" }))
  expect(pendingGoal(root)).toBe("Build scheduler")
  fs.writeFileSync(file, JSON.stringify({ description: "Build scheduler", status: "completed" }))
  expect(pendingGoal(root)).toBeUndefined()
})

test("local configuration pins both model routes and rejects remote endpoints", () => {
  const config = configuration("/source")
  expect(config.model).toBe("ollama/qwen3-coder-32k:latest")
  expect(config.small_model).toBe(config.model)
  expect(config.enabled_providers).toEqual(["ollama"])
  expect(() => configuration("/source", "qwen", "https://remote.test/v1")).toThrow()
})

test("a partially written legacy goal cannot break the current conversation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-goal-"))
  fs.mkdirSync(path.join(root, ".rigovo"))
  fs.writeFileSync(path.join(root, ".rigovo/direct-chat.json"), '{"description":')
  expect(pendingGoal(root)).toBeUndefined()
})
