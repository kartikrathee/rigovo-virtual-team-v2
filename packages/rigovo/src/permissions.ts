export type PermissionMode = "allow" | "ask"

export function permissionArguments(args: string[]) {
  const rest: string[] = []
  const modes: PermissionMode[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--") {
      rest.push(...args.slice(index))
      break
    }
    if (arg !== "--permissions" && !arg.startsWith("--permissions=")) {
      rest.push(arg)
      continue
    }
    const value = arg === "--permissions" ? args[++index] : arg.slice("--permissions=".length)
    if (value !== "allow" && value !== "ask") throw new Error("Use --permissions allow or --permissions ask")
    modes.push(value)
  }
  if (modes.length > 1) throw new Error("Specify --permissions only once")
  const flags = ["--auto", "--yolo", "--dangerously-skip-permissions"]
  const switches = new Map(flags.map((flag) => [flag, false]))
  for (let index = 0; index < rest.length && rest[index] !== "--"; index++) {
    const arg = rest[index]!
    const name = arg.split("=")[0]!
    if (arg.startsWith("--no-") && switches.has(`--${arg.slice(5)}`)) {
      switches.set(`--${arg.slice(5)}`, false)
      continue
    }
    if (!switches.has(name)) continue
    switches.set(name, arg.includes("=") ? arg === `${name}=true` : rest[index + 1] !== "false")
  }
  const auto = [...switches.values()].some(Boolean)
  if (auto && modes[0] === "ask") throw new Error("--permissions ask cannot be combined with auto-approval flags")
  return { args: rest, mode: modes[0] ?? (auto ? "allow" : undefined) }
}

export function needsPermissionChoice(args: string[]) {
  if (args.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))) return false
  const command = args.find((arg) => !arg.startsWith("-"))
  return (
    !command ||
    ![
      "completion",
      "acp",
      "mcp",
      "attach",
      "debug",
      "providers",
      "auth",
      "agent",
      "serve",
      "web",
      "models",
      "stats",
      "export",
      "import",
      "github",
      "pr",
      "session",
      "plugin",
      "plug",
    ].includes(command)
  )
}

export async function choosePermissions(): Promise<PermissionMode | undefined> {
  const { createInterface } = await import("node:readline/promises")
  const controller = new AbortController()
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  terminal.on("SIGINT", () => controller.abort())
  terminal.on("close", () => controller.abort())
  process.stderr.write("\nPermissions for this CLI session:\n  1) Always allow commands\n  2) Ask every time\n")
  try {
    while (!controller.signal.aborted) {
      const answer = (await terminal.question("Choose 1 or 2: ", { signal: controller.signal })).trim()
      if (answer === "1") return "allow"
      if (answer === "2") return "ask"
      process.stderr.write("Enter 1 or 2.\n")
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    terminal.close()
  }
}
