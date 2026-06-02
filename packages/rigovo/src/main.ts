import path from "node:path"
import { fileURLToPath } from "node:url"
import { configuration } from "./config"
import { choosePermissions, needsPermissionChoice, permissionArguments } from "./permissions"

const launch = permissionArguments(process.argv.slice(2))
process.argv = [...process.argv.slice(0, 2), ...launch.args]
// Each CLI launch chooses independently; child engine processes inherit the chosen mode.
delete process.env.RIGOVO_SESSION_PERMISSION
const mode = await (async () => {
  if (launch.mode) return launch.mode
  if (!process.stdin.isTTY || !process.stderr.isTTY || !needsPermissionChoice(launch.args)) return "ask"
  const selected = await choosePermissions()
  if (!selected) process.exit(130)
  return selected
})()
process.env.RIGOVO_SESSION_PERMISSION = mode
const workers = Number(process.env.RIGOVO_MAX_WORKERS ?? 3)
if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error("RIGOVO_MAX_WORKERS must be 1..8")
process.env.RIGOVO_MAX_WORKERS = String(workers)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const home = process.env.RIGOVO_HOME ?? path.join(root, ".rigovo/runtime")
process.env.XDG_DATA_HOME = path.join(home, "data")
process.env.XDG_STATE_HOME = path.join(home, "state")
process.env.XDG_CACHE_HOME = path.join(home, "cache")
process.env.XDG_CONFIG_HOME = path.join(home, "config")
process.env.OPENCODE_DISABLE_AUTOUPDATE = "1"
process.env.OPENCODE_DISABLE_MODELS_FETCH = "1"
process.env.OPENCODE_SHOW_TTFD = "1"
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(
  configuration(
    root,
    process.env.RIGOVO_MODEL,
    process.env.OLLAMA_OPENAI_URL,
    mode,
    process.env.OLLAMA_TUNNEL_HOSTNAME
      ? {
          hostname: process.env.OLLAMA_TUNNEL_HOSTNAME,
          clientID: process.env.CF_ACCESS_CLIENT_ID ?? "",
          clientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? "",
        }
      : undefined,
  ),
)

if (process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) {
  console.log("ForgeCrew 2.0.0-alpha.1 · OpenCode 1.18.15 (d7b115f)")
  process.exit(0)
}

const native = path.join(root, `packages/opencode/dist/opencode-${process.platform}-${process.arch}/bin/opencode`)
if (process.env.RIGOVO_SOURCE !== "1" && typeof process.execve === "function" && (await Bun.file(native).exists())) {
  process.execve(native, [native, ...process.argv.slice(2)], process.env)
}

const entry = path.join(root, "packages/opencode/src/index.ts")
await import("@opentui/solid/preload")
await import(entry)
