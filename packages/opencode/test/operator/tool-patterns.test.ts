import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorToolPatterns } from "@/operator/tool-patterns"
import { testEffect } from "../lib/effect"
import { replacements, root } from "../merge/harness"

// Each tool's permission pattern (memory_spec.md §9): OpenCode's tools from their code, a custom tool's
// as written for it (its id and `*` until then).

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorToolPatterns.node]), replacements))

it.instance(
  "OpenCode's tools from their code; a custom tool's as written for it",
  () =>
    Effect.gen(function* () {
      const patterns = yield* OperatorToolPatterns.Service
      const of = (list: ReadonlyArray<OperatorToolPatterns.Pattern>, tool: string) =>
        list.find((item) => item.tool === tool)
      const list = yield* patterns.list()
      expect(of(list, "bash")).toMatchObject({ permission: "bash", form: "command", source: "code", editable: false })
      expect(of(list, "write")).toMatchObject({ permission: "edit", form: "path" })
      expect(of(list, "external_directory")).toMatchObject({ permission: "external_directory", form: "absolute" })
      expect(of(list, "memory")).toMatchObject({ form: "verbs", verbs: ["READ", "WRITE", "FORGET"] })
      expect(of(list, "hello")).toMatchObject({
        permission: "hello",
        form: "custom",
        text: "*",
        source: "default",
        editable: true,
      })
      // The rules that apply by default: OpenCode's `*` line among them.
      expect(of(list, "bash")!.defaults.some((line) => line.level === "opencode")).toBe(true)

      const saved = yield* patterns.save({
        tool: "hello",
        permission: "greet",
        verbs: ["say"],
        text: "who is greeted",
        examples: [{ pattern: "SAY(world)", action: "allow" }],
      })
      expect(saved).toMatchObject({ permission: "greet", verbs: ["SAY"], form: "verbs", source: "user" })
      expect(of(yield* patterns.list(), "hello")).toMatchObject({ source: "user", text: "who is greeted" })
      // OpenCode's tools are not edited.
      expect(
        Exit.isFailure(
          yield* Effect.exit(patterns.save({ tool: "bash", permission: "x", verbs: [], text: "", examples: [] })),
        ),
      ).toBe(true)
      yield* Effect.promise(() =>
        fs.rm(path.join(Global.Path.config, "namespaces", "tool-patterns.json"), { force: true }),
      )
    }),
  {
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode", "tools"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode", "tools", "hello.ts"),
          "export default {\n  description: 'hello tool',\n  args: {},\n  execute: async () => 'hello',\n}\n",
        )
      }),
  },
)
