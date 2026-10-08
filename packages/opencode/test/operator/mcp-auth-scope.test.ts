import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { InstanceRef } from "@/effect/instance-ref"
import { McpAuth } from "@/mcp/auth"
import { testEffect } from "../lib/effect"

// MCP logins per namespace (capability_scopes_spec.md §8): OpenCode's keep upstream's keys (the server
// name); another namespace's are `<namespace>/<server>`, so the same server has a login in each.

const it = testEffect(LayerNode.compile(McpAuth.node))
const projects = () => path.join(Global.Path.config, "namespaces", "projects.json")

it.instance("a namespace's MCP logins are its own; OpenCode's keep the server name as key", () =>
  Effect.gen(function* () {
    const instance = (yield* InstanceRef)!
    const auth = yield* McpAuth.Service
    const before = yield* Effect.promise(() => fs.readFile(projects(), "utf8").catch(() => undefined))
    try {
      yield* auth.set("docs", { tokens: { accessToken: "opencode-token" } })
      expect((yield* auth.all()).docs?.tokens?.accessToken).toBe("opencode-token")

      // The project is in Acme now.
      const key = instance.worktree === "/" ? instance.directory : instance.worktree
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(projects()), { recursive: true })
        await fs.writeFile(projects(), JSON.stringify({ [key]: { namespace: "acme" } }))
      })
      expect(yield* auth.get("docs")).toBeUndefined()
      yield* auth.set("docs", { tokens: { accessToken: "acme-token" } })
      yield* auth.updateOAuthState("docs", "state-acme")
      const all = yield* auth.all()
      expect(all["acme/docs"]).toMatchObject({ tokens: { accessToken: "acme-token" }, oauthState: "state-acme" })
      expect(all.docs?.tokens?.accessToken).toBe("opencode-token")
      expect((yield* auth.get("docs"))?.tokens?.accessToken).toBe("acme-token")
      yield* auth.remove("docs")
      expect((yield* auth.all())["acme/docs"]).toBeUndefined()
      expect((yield* auth.all()).docs).toBeDefined()
    } finally {
      yield* Effect.promise(async () => {
        if (before === undefined) await fs.rm(projects(), { force: true })
        else await fs.writeFile(projects(), before)
      })
      yield* auth.remove("docs")
    }
  }),
)
