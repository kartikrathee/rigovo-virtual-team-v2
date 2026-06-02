import path from "node:path"
import { pathToFileURL } from "node:url"
import type { PermissionMode } from "./permissions"
import { RIGOVO_PROMPT } from "./prompt"

export function configuration(
  root: string,
  model = "qwen3-coder-32k:latest",
  baseURL = "http://127.0.0.1:11434/v1",
  permissionMode: PermissionMode = "ask",
  tunnel?: { hostname: string; clientID: string; clientSecret: string },
) {
  const url = new URL(baseURL)
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Ollama URL must not contain credentials, query or fragment")
  if (tunnel && (!tunnel.clientID || !tunnel.clientSecret))
    throw new Error("Cloudflare Access requires both service token values")
  if (tunnel && (url.protocol !== "https:" || url.host !== tunnel.hostname || url.pathname !== "/v1")) {
    throw new Error("Ollama tunnel URL must use HTTPS, the approved hostname and /v1")
  }
  if (!tunnel && (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Rigovo's local profile requires a loopback Ollama URL")
  }
  return {
    model: `ollama/${model}`,
    small_model: `ollama/${model}`,
    default_agent: "build",
    agent: {
      build: { temperature: 0, prompt: RIGOVO_PROMPT },
      general: { temperature: 0, prompt: RIGOVO_PROMPT },
      title: { temperature: 0 },
    },
    enabled_providers: ["ollama"],
    share: "disabled",
    autoupdate: false,
    ...(permissionMode === "allow" ? { permission: { "*": "allow" as const } } : {}),
    plugin: [pathToFileURL(path.join(root, "packages/rigovo/src/plugin.ts")).href],
    provider: {
      ollama: {
        npm: "@ai-sdk/openai-compatible",
        name: tunnel ? "Private Qwen tunnel" : "Local Qwen",
        // Ollama can buffer a complete tool-call JSON before sending another SSE chunk.
        options: {
          baseURL,
          apiKey: "ollama",
          timeout: 300000,
          chunkTimeout: 240000,
          ...(tunnel
            ? { headers: { "CF-Access-Client-Id": tunnel.clientID, "CF-Access-Client-Secret": tunnel.clientSecret } }
            : {}),
        },
        models: {
          [model]: {
            name: "Qwen3 Coder · local 32K",
            tool_call: true,
            reasoning: false,
            temperature: true,
            limit: { context: 32768, output: 4096 },
            cost: { input: 0, output: 0 },
            options: { temperature: 0 },
          },
        },
      },
    },
    compaction: { auto: true, prune: true, reserved: 8192 },
  }
}
