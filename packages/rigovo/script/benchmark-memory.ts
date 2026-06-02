import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { MemoryReader, recall, remember } from "../src/memory"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rigovo-memory-bench-"))
for (let index = 0; index < 40; index++)
  remember(root, `Module ${index} uses the shared API contract and unittest for verification.`, "benchmark")
const iterations = 1000
const query = "API contract unittest"
const cold = performance.now()
for (let index = 0; index < iterations; index++) recall(root, query)
const uncached = performance.now() - cold
using reader = new MemoryReader(root)
reader.recall(query)
const warm = performance.now()
for (let index = 0; index < iterations; index++) reader.recall(query)
const cached = performance.now() - warm
console.log(
  JSON.stringify(
    {
      scope: "Project-memory retrieval only; excludes model inference and end-to-end agent work",
      iterations,
      uncached_ms: uncached,
      cached_ms: cached,
      ratio: uncached / cached,
      stats: reader.stats,
    },
    null,
    2,
  ),
)
