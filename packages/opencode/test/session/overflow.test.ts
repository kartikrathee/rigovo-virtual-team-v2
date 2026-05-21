import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { isOverflow, usable } from "@/session/overflow"
import { ProviderTest } from "../fake/provider"

describe("session overflow budget", () => {
  test.each([
    { name: "configured reserve without an input limit", input: undefined, reserved: 12_000, expected: 20_768 },
    { name: "configured reserve with an input limit", input: 30_000, reserved: 12_000, expected: 18_000 },
    { name: "response capacity exceeds configured reserve", input: undefined, reserved: 1_000, expected: 24_576 },
    { name: "response capacity with an input limit", input: 30_000, reserved: 1_000, expected: 21_808 },
    { name: "default response reserve", input: undefined, reserved: undefined, expected: 24_576 },
    { name: "input limit cannot exceed context", input: 80_000, reserved: 12_000, expected: 20_768 },
    { name: "oversized reserve clamps to zero", input: undefined, reserved: 40_000, expected: 0 },
    { name: "reserve larger than input clamps to zero", input: 4_000, reserved: 12_000, expected: 0 },
    { name: "zero input cap retains upstream unspecified semantics", input: 0, reserved: 12_000, expected: 20_768 },
  ])("$name", (row) => {
    const cfg: ConfigV1.Info = { compaction: { reserved: row.reserved } }
    const model = ProviderTest.model({ limit: { context: 32_768, input: row.input, output: 8_192 } })
    expect(usable({ cfg, model })).toBe(row.expected)
  })

  test("runtime output cap determines actual response headroom", () => {
    const cfg: ConfigV1.Info = {}
    const model = ProviderTest.model({ limit: { context: 32_768, output: 16_384 } })
    expect(usable({ cfg, model, outputTokenMax: 4_096 })).toBe(28_672)
  })

  test("large output capacity is fully reserved with or without an input limit", () => {
    const cfg: ConfigV1.Info = {}
    for (const input of [undefined, 200_000]) {
      const model = ProviderTest.model({ limit: { context: 200_000, input, output: 32_000 } })
      expect(usable({ cfg, model })).toBe(168_000)
    }
  })

  test("overflow triggers exactly at the configured reserve boundary", () => {
    const cfg: ConfigV1.Info = { compaction: { reserved: 12_000 } }
    const model = ProviderTest.model({ limit: { context: 32_768, output: 8_192 } })
    const tokens = { input: 19_000, output: 1_000, reasoning: 0, cache: { read: 767, write: 0 } }
    expect(isOverflow({ cfg, model, tokens })).toBe(false)
    expect(isOverflow({ cfg, model, tokens: { ...tokens, cache: { read: 768, write: 0 } } })).toBe(true)
  })

  test("unknown context and disabled automatic compaction do not trigger overflow", () => {
    const cfg: ConfigV1.Info = { compaction: { reserved: 12_000 } }
    const model = ProviderTest.model({ limit: { context: 0, output: 8_192 } })
    const tokens = { input: 100_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } }
    expect(usable({ cfg, model })).toBe(0)
    expect(isOverflow({ cfg, model, tokens })).toBe(false)
    expect(isOverflow({ cfg: { ...cfg, compaction: { auto: false } }, model, tokens })).toBe(false)
  })
})
