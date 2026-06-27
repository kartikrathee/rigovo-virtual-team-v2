import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"

export type PermissionMode = "auto" | "normal"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const locked = process.env.RIGOVO_SESSION_PERMISSION === "allow"
    const [store, setStore] = createStore<{ mode: PermissionMode }>({
      mode: locked || args.auto ? "auto" : "normal",
    })
    return {
      locked,
      get mode() {
        return store.mode
      },
      set(mode: PermissionMode) {
        if (locked) return
        setStore("mode", mode)
      },
      toggle() {
        if (locked) return
        setStore("mode", (mode) => (mode === "auto" ? "normal" : "auto"))
      },
    }
  },
})
