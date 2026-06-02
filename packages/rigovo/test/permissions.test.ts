import { expect, test } from "bun:test"
import { configuration } from "../src/config"
import { needsPermissionChoice, permissionArguments } from "../src/permissions"

test("permission flags are consumed by the launcher and cannot conflict", () => {
  expect(permissionArguments(["--mini", "--permissions", "allow", "/project"])).toEqual({
    args: ["--mini", "/project"],
    mode: "allow",
  })
  expect(permissionArguments(["--permissions=ask", "--continue"])).toEqual({ args: ["--continue"], mode: "ask" })
  expect(() => permissionArguments(["--permissions"])).toThrow()
  expect(() => permissionArguments(["--permissions=all"])).toThrow()
  expect(() => permissionArguments(["--permissions=allow", "--permissions=ask"])).toThrow()
  expect(() => permissionArguments(["--permissions=ask", "--auto"])).toThrow()
  expect(permissionArguments(["--auto"]).mode).toBe("allow")
  expect(permissionArguments(["--auto=false"]).mode).toBeUndefined()
  expect(permissionArguments(["--auto", "false"]).mode).toBeUndefined()
  expect(permissionArguments(["--auto", "--no-auto"]).mode).toBeUndefined()
  expect(permissionArguments(["--auto", "--auto=false"]).mode).toBeUndefined()
  expect(permissionArguments(["--", "--auto"]).mode).toBeUndefined()
  expect(permissionArguments(["--", "--permissions=allow"])).toEqual({
    args: ["--", "--permissions=allow"],
    mode: undefined,
  })
})

test("interactive chats offer the choice while help and utility commands do not", () => {
  for (const args of [[], ["--mini"], ["/project"], ["--continue"], ["run", "Inspect the project"]]) {
    expect(needsPermissionChoice(args)).toBe(true)
  }
  for (const args of [["--help"], ["--version"], ["models"], ["session", "list"], ["debug", "config"]]) {
    expect(needsPermissionChoice(args)).toBe(false)
  }
})

test("allow mode sets a launch-only permission profile and ask preserves existing rules", () => {
  expect(configuration("/source", undefined, undefined, "allow").permission).toEqual({ "*": "allow" })
  expect(configuration("/source", undefined, undefined, "ask").permission).toBeUndefined()
  expect(configuration("/source").permission).toBeUndefined()
})
