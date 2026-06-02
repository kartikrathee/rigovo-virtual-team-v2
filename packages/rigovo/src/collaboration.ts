import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

type Entry = { key: string; kind: string; content: string; owner: string; updated: number }

export class Collaboration {
  private db: Database

  constructor(private directory: string) {
    fs.mkdirSync(path.join(directory, ".rigovo"), { recursive: true })
    this.db = new Database(path.join(directory, ".rigovo/collaboration.sqlite"))
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS entry (
        root TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
        content TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(root, owner, key));
      CREATE INDEX IF NOT EXISTS entry_recent ON entry(root, updated DESC);
      CREATE TABLE IF NOT EXISTS claim (
        root TEXT NOT NULL, path TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(root, path));`)
  }

  publish(root: string, owner: string, key: string, kind: string, content: string) {
    if (!root || !owner || !key.trim() || key.length > 100 || !content.trim() || content.length > 2000)
      throw new Error("Shared entries need a key (1..100 characters) and content (1..2000)")
    if (!["decision", "finding", "handoff", "blocker", "result", "tool"].includes(kind))
      throw new Error("Invalid entry kind")
    this.db
      .query(
        `INSERT INTO entry VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(root, owner, key) DO UPDATE SET kind=excluded.kind, content=excluded.content, updated=excluded.updated`,
      )
      .run(root, owner, key.trim(), kind, content.trim(), Date.now())
  }

  read(root: string, query = "", maxChars = 4096) {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])]
    const entries = this.db
      .query("SELECT key,kind,content,owner,updated FROM entry WHERE root=? ORDER BY updated DESC LIMIT 100")
      .all(root) as Entry[]
    const ranked = entries
      .map((entry) => ({
        entry,
        score: terms.filter((term) => `${entry.key} ${entry.content}`.toLowerCase().includes(term)).length,
      }))
      .sort((a, b) => b.score - a.score || b.entry.updated - a.entry.updated)
    const lines: string[] = []
    let remaining = Math.max(0, maxChars)
    for (const { entry } of ranked) {
      const label =
        entry.kind === "tool"
          ? "runtime command result; not proof of test coverage"
          : entry.kind === "decision" && entry.owner === root
            ? "coordinator design contract; not execution evidence"
            : "agent observation; unverified"
      const line = `[${entry.kind}; ${entry.owner}; ${label}] ${entry.key}: ${entry.content}`
      if (line.length + 1 > remaining) continue
      lines.push(line)
      remaining -= line.length + 1
      if (lines.length >= 8) break
    }
    const claims = this.db
      .query("SELECT path,owner FROM claim WHERE root=? AND expires>? ORDER BY path LIMIT 32")
      .all(root, Date.now()) as { path: string; owner: string }[]
    for (const claim of claims) {
      const line = `[file claim; ${claim.owner}] ${claim.path}`
      if (line.length + 1 > remaining) continue
      lines.push(line)
      remaining -= line.length + 1
    }
    return lines.join("\n")
  }

  claim(root: string, owner: string, paths: string[], now = Date.now()) {
    if (!paths.length || paths.length > 32) throw new Error("Claim 1..32 explicit project paths")
    const normalized = [
      ...new Set(
        paths.map((value) => {
          const target = path.resolve(this.directory, value)
          const relative = path.relative(this.directory, target)
          if (
            !relative ||
            relative === ".." ||
            relative.startsWith(".." + path.sep) ||
            path.isAbsolute(relative) ||
            /[*?\[]/.test(value)
          )
            throw new Error(`Invalid owned path: ${value}`)
          // Existing ancestors may be symlinks even when a leaf does not exist yet.
          const parts = relative.split(path.sep)
          for (let n = 1; n <= parts.length; n++) {
            const candidate = path.join(this.directory, ...parts.slice(0, n))
            if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink())
              throw new Error(`Symlink ownership is unsupported: ${value}`)
          }
          return relative.split(path.sep).join("/")
        }),
      ),
    ]
    this.db
      .transaction(() => {
        this.db.query("DELETE FROM claim WHERE expires<=?").run(now)
        const claims = this.db.query("SELECT path,owner FROM claim WHERE owner<>?").all(owner) as {
          path: string
          owner: string
        }[]
        for (const own of normalized) {
          const conflict = claims.find(
            (held) => own === held.path || own.startsWith(held.path + "/") || held.path.startsWith(own + "/"),
          )
          if (conflict)
            throw new Error(
              `${own} overlaps ${conflict.path}, owned by ${conflict.owner}; choose disjoint work or wait for release`,
            )
        }
        for (const own of normalized)
          this.db
            .query(
              `INSERT INTO claim VALUES (?, ?, ?, ?)
        ON CONFLICT(root,path) DO UPDATE SET expires=excluded.expires`,
            )
            .run(root, own, owner, now + 30 * 60_000)
      })
      .immediate()
    return normalized
  }

  release(root: string, owner: string) {
    return this.db.query("DELETE FROM claim WHERE root=? AND owner=?").run(root, owner).changes
  }

  renew(root: string, owner: string) {
    this.db.query("UPDATE claim SET expires=? WHERE root=? AND owner=?").run(Date.now() + 30 * 60_000, root, owner)
  }

  [Symbol.dispose]() {
    this.db.close()
  }
}
