import { expect, test } from "bun:test"
import { configuration } from "../src/config"

const tunnel = { hostname: "inference.example.com", clientID: "test-client", clientSecret: "test-secret" }

test("remote inference requires an explicit host and authenticated HTTPS", () => {
  const config = configuration("/source", undefined, "https://inference.example.com/v1", "ask", tunnel)
  expect(config.provider.ollama.options.headers).toEqual({
    "CF-Access-Client-Id": "test-client",
    "CF-Access-Client-Secret": "test-secret",
  })
  expect(configuration("/source").provider.ollama.options.headers).toBeUndefined()
  expect(() => configuration("/source", undefined, "https://inference.example.com/v1")).toThrow()
  for (const url of [
    "http://inference.example.com/v1",
    "https://other.example.com/v1",
    "https://inference.example.com:444/v1",
    "https://inference.example.com/wrong",
    "https://user:pass@inference.example.com/v1",
    "https://inference.example.com/v1?key=secret",
    "https://inference.example.com/v1#secret",
  ])
    expect(() => configuration("/source", undefined, url, "ask", tunnel)).toThrow()
  for (const credentials of [
    { ...tunnel, clientID: "" },
    { ...tunnel, clientSecret: "" },
  ]) {
    expect(() => configuration("/source", undefined, "https://inference.example.com/v1", "ask", credentials)).toThrow()
  }
})
