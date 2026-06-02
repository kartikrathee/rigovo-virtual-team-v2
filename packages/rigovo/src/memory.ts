import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type Fact = { content: string; source: string; updated: number }

export function projectID(directory: string) {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")
  const bytes = createHash("sha1").update(namespace).update(directory).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 80
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = bytes.toString("hex")
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
}

export function remember(directory: string, content: string, session: string) {
  const text = content.trim()
  if (!text || text.length > 2000) throw new Error("Memory must contain 1..2000 characters")
  fs.mkdirSync(path.join(directory, ".rigovo"), { recursive: true })
  using db = new Database(path.join(directory, ".rigovo/memory-v2.sqlite"))
  db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL")
  db.exec("CREATE TABLE IF NOT EXISTS fact (content TEXT PRIMARY KEY, session TEXT NOT NULL, updated INTEGER NOT NULL)")
  db.exec("CREATE INDEX IF NOT EXISTS fact_updated ON fact(updated DESC)")
  db.query("INSERT INTO fact VALUES (?, ?, ?) ON CONFLICT(content) DO UPDATE SET updated=excluded.updated").run(
    text,
    session,
    Date.now(),
  )
}

export function recall(directory: string, query = "", limit = 4): Fact[] {
  using reader = new MemoryReader(directory)
  return reader.recall(query, limit, 8192)
}

function readNotes(db: Database): Fact[] {
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='fact'").get()) return []
  return db
    .query("SELECT content, 'agent note; unverified' AS source, updated FROM fact ORDER BY updated DESC LIMIT 100")
    .all() as Fact[]
}

function readLegacy(db: Database, directory: string): Fact[] {
  if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get()) return []
  return db
    .query(
      "SELECT content, 'legacy Rigovo memory' AS source, 0 AS updated FROM memories WHERE source_project_id = ? ORDER BY usage_count DESC LIMIT 100",
    )
    .all(projectID(directory)) as Fact[]
}

/** Per-plugin cache. SQLite data_version invalidates results after other workers commit. */
export class MemoryReader {
  private sources = new Map<string, { inode: number; db: Database }>()
  private revision = ""
  private facts: Fact[] = []
  private cache = new Map<string, Fact[]>()
  readonly stats = { hits: 0, misses: 0, reloads: 0 }

  constructor(private directory: string) {}

  recall(query = "", limit = 4, maxChars = 4096): Fact[] {
    const files = ["memory-v2.sqlite", "local.db"].map((name) => path.join(this.directory, ".rigovo", name))
    const versions = files
      .map((file) => {
        const stat = fs.statSync(file, { throwIfNoEntry: false })
        const source = this.sources.get(file)
        if (!stat || (source && source.inode !== stat.ino)) {
          source?.db.close()
          this.sources.delete(file)
        }
        if (!stat) return "missing"
        const current = this.sources.get(file) ?? { inode: stat.ino, db: new Database(file, { readonly: true }) }
        this.sources.set(file, current)
        const version = current.db.query("PRAGMA data_version").get() as { data_version: number }
        return `${stat.ino}:${version.data_version}`
      })
      .join("|")
    if (versions !== this.revision) {
      this.revision = versions
      const current = this.sources.get(files[0]!)
      const legacy = this.sources.get(files[1]!)
      this.facts = [...(current ? readNotes(current.db) : []), ...(legacy ? readLegacy(legacy.db, this.directory) : [])]
      this.cache.clear()
      this.stats.reloads++
    }
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].sort()
    const key = JSON.stringify([terms, limit, maxChars])
    const cached = this.cache.get(key)
    if (cached) {
      this.stats.hits++
      return cached.map((fact) => ({ ...fact }))
    }
    this.stats.misses++
    const ranked = this.facts
      .map((fact) => ({ fact, score: terms.filter((term) => fact.content.toLowerCase().includes(term)).length }))
      .sort((a, b) => b.score - a.score || b.fact.updated - a.fact.updated)
      .filter((item, index, all) => all.findIndex((other) => other.fact.content === item.fact.content) === index)
    const selected: Fact[] = []
    let remaining = Math.max(0, maxChars)
    for (const { fact } of ranked) {
      if (selected.length >= Math.max(0, limit)) break
      if (fact.content.length > remaining) continue
      selected.push({ ...fact })
      remaining -= fact.content.length
    }
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, selected)
    return selected.map((fact) => ({ ...fact }))
  }

  [Symbol.dispose]() {
    for (const source of this.sources.values()) source.db.close()
    this.sources.clear()
    this.cache.clear()
  }
}

export function pendingGoal(directory: string): string | undefined {
  const file = path.join(directory, ".rigovo/direct-chat.json")
  if (!fs.existsSync(file)) return
  const raw = fs.readFileSync(file, "utf8")
  const value: unknown = (() => {
    try {
      return JSON.parse(raw)
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  })()
  if (typeof value !== "object" || value === null || !("description" in value)) return
  if ("status" in value && value.status === "completed") return
  return typeof value.description === "string" ? value.description : undefined
}
