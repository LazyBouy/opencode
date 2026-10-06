import os from "os"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorPrompts } from "@/operator/prompts"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { configure, replacements, root, send, session } from "../merge/harness"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([root, OperatorToolPrompt.node, OperatorPrompts.node, OperatorProfileStore.node]),
    replacements,
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const P = OperatorProfile.PREFIX

// The tools a request sent (OpenAI chat format), as { name, description, input_schema }.
type Sent = { tools?: Array<{ function: { name: string; description: string; parameters: unknown } }> }
const sentTools = (body: unknown) =>
  ((body as Sent).tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }))

// Points the global config folder (where namespaces/ lives) inside the test project for one test.
const withGlobal = <A, E, R>(body: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        return previous
      }),
      () => body(),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
        }),
    )
  })

unix("Would be sent equals the tools a request sends: build, an agent denied webfetch, a profile's copy of read", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure({
        agent: { fetchless: { mode: "primary", permission: { webfetch: "deny" } } },
      })
      const prompts = yield* OperatorToolPrompt.Service
      const store = yield* OperatorProfileStore.Service
      for (let index = 0; index < 6; index++) yield* llm.text("ok")

      // build
      yield* send((yield* session()).id, "hello", "build")
      const build = yield* prompts.build({ agent: "build" })
      expect(sentTools((yield* llm.inputs).at(-1))).toEqual(build.list.map(({ strict: _, ...item }) => item))
      expect(build.sent.find((item) => item.name === "read")?.version).toMatchObject({
        kind: "opencode",
        file: "packages/opencode/src/tool/read.txt",
      })
      expect(build.notSent).toContainEqual(expect.objectContaining({ name: "invalid", reason: "internal" }))

      // An agent whose own rules deny webfetch: not sent, and the rule is its own.
      yield* send((yield* session()).id, "hello", "fetchless")
      const fetchless = yield* prompts.build({ agent: "fetchless" })
      expect(sentTools((yield* llm.inputs).at(-1))).toEqual(fetchless.list.map(({ strict: _, ...item }) => item))
      const webfetch = fetchless.notSent.find((item) => item.name === "webfetch")!
      expect(webfetch.reason).toBe("permission")
      expect(fetchless.rows.find((row) => row.index === webfetch.rule)).toMatchObject({
        permission: "webfetch",
        action: "deny",
        part: "agent",
        from: { kind: "agent" },
      })

      // A profile's copy of read is sent as read's description; task still gets its subagent list.
      const key = (yield* (yield* OperatorPrompts.Service).preview({ agent: "build" })).project.key
      const read = yield* store.copyBuiltin("opencode", `${P}tool.read`, "Read files, carefully.")
      const task = yield* store.copyBuiltin("opencode", `${P}tool.task`, "Start a subagent.")
      const opencode = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === OperatorProfile.OPENCODE_PROFILE)!
      const profile = yield* store.saveProfile("opencode", undefined, {
        name: "Careful",
        group: opencode.group,
        slots: { ...opencode.slots, capabilities: [read.id, task.id] },
      })
      yield* store.setAgent(key, "build", { profile: profile.id })
      yield* send((yield* session()).id, "hello", "build")
      const careful = yield* prompts.build({ agent: "build" })
      const captured = sentTools((yield* llm.inputs).at(-1))
      expect(captured).toEqual(careful.list.map(({ strict: _, ...item }) => item))
      expect(captured.find((item) => item.name === "read")?.description).toBe("Read files, carefully.")
      expect(careful.sent.find((item) => item.name === "read")?.version).toMatchObject({
        kind: "copy",
        layer: read.id,
        profile: "Careful",
        override: false,
      })
      const taskSent = careful.sent.find((item) => item.name === "task")!
      expect(taskSent.description).toStartWith("Start a subagent.\nAvailable agent types")
      expect(taskSent.appended?.kind).toBe("subagents")
      expect(taskSent.appended?.subagents?.map((item) => item.name)).toContain("explore")
    }),
  ),
)

unix("explore started by task: Would be sent as a subagent equals the subagent's request", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const prompts = yield* OperatorToolPrompt.Service
      yield* llm.tool("task", { description: "Look around", prompt: "Find the readme", subagent_type: "explore" })
      yield* llm.text("Found it.")
      yield* llm.text("Done.")
      yield* send((yield* session()).id, "explore please", "build")
      const inputs = yield* llm.inputs
      const sub = inputs.find((body) => JSON.stringify(body).includes("file search specialist"))
      expect(sub).toBeDefined()
      const explore = yield* prompts.build({ agent: "explore", runsAs: "subagent" })
      expect(explore.runsAs).toBe("subagent")
      expect(sentTools(sub)).toEqual(explore.list.map(({ strict: _, ...item }) => item))
    }),
  ),
)

unix("why a tool is not sent, and patterns that change nothing", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      yield* configure()
      const prompts = yield* OperatorToolPrompt.Service
      const names = (prompt: OperatorToolPrompt.ToolPrompt) => prompt.sent.map((item) => item.name)
      const home = os.homedir()
      const reasons = (prompt: OperatorToolPrompt.ToolPrompt) =>
        Object.fromEntries(prompt.notSent.map((item) => [item.name, item.reason]))

      // A pattern on read never removes it; only a final `*` deny does.
      expect(
        names(
          yield* prompts.build({
            agent: "build",
            agentRules: [{ permission: "read", pattern: `${home}/*`, action: "allow" }],
          }),
        ),
      ).toContain("read")
      expect(
        names(
          yield* prompts.build({
            agent: "build",
            agentRules: [
              { permission: "read", pattern: "*", action: "deny" },
              { permission: "read", pattern: `${home}/*`, action: "allow" },
            ],
          }),
        ),
      ).toContain("read")
      const readGone = yield* prompts.build({
        agent: "build",
        agentRules: [
          { permission: "read", pattern: `${home}/*`, action: "allow" },
          { permission: "read", pattern: "*", action: "deny" },
        ],
      })
      expect(names(readGone)).not.toContain("read")
      expect(reasons(readGone).read).toBe("permission")
      // edit covers edit and write.
      const noEdit = yield* prompts.build({
        agent: "build",
        agentRules: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      expect(names(noEdit)).not.toContain("edit")
      expect(names(noEdit)).not.toContain("write")
      // apply_patch is for GPT models only.
      expect(reasons(noEdit).apply_patch).toBe("model")
      // task rules change task's description, not whether it is sent.
      const noExplore = yield* prompts.build({
        agent: "build",
        agentRules: [
          { permission: "task", pattern: "*", action: "allow" },
          { permission: "task", pattern: "explore", action: "deny" },
        ],
      })
      const task = noExplore.sent.find((item) => item.name === "task")!
      expect(task.appended?.subagents?.find((item) => item.name === "explore")?.kept).toBe(false)
      expect(task.description).not.toContain("- explore:")
      // Run as a subagent, general loses task (its own rules do not mention it).
      const general = yield* prompts.build({ agent: "general", runsAs: "subagent" })
      expect(reasons(general).task).toBe("subagent")
      expect(
        general.rows.find((row) => row.index === general.notSent.find((item) => item.name === "task")!.rule),
      ).toMatchObject({
        part: "session",
        from: { kind: "session-task" },
      })
      expect(names(yield* prompts.build({ agent: "general", runsAs: "primary" }))).toContain("task")

      // The draft diff: a deny removes webfetch, with the rule; a pattern change changes nothing.
      const drafted = yield* prompts.draft({
        agent: "build",
        agentRules: [{ permission: "webfetch", pattern: "*", action: "deny" }],
      })
      expect(drafted.diff.removed.map((item) => item.name)).toEqual(["webfetch"])
      expect(drafted.rows.find((row) => row.index === drafted.diff.removed[0]!.rule)).toMatchObject({
        permission: "webfetch",
        action: "deny",
      })
      const patterns = yield* prompts.draft({
        agent: "build",
        agentRules: [{ permission: "webfetch", pattern: "https://example.com/*", action: "deny" }],
      })
      expect(patterns.diff).toMatchObject({ added: [], removed: [], changed: [] })
    }),
  ),
)

unix("rules are labelled with where they come from", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      yield* configure({ permission: { bash: { "git push*": "ask" } }, tools: { webfetch: false } })
      const prompts = yield* OperatorToolPrompt.Service
      const build = yield* prompts.build({ agent: "build" })
      const kinds = build.rows.map((row) => row.from.kind)
      expect(kinds[0]).toBe("opencode-default")
      expect(build.rows.find((row) => row.permission === "question" && row.action === "allow")?.from).toEqual({
        kind: "opencode-agent",
        agent: "build",
      })
      const config = path.join((yield* TestInstance).directory, "opencode.json")
      expect(build.rows.find((row) => row.permission === "bash" && row.pattern === "git push*")?.from).toEqual({
        kind: "config-permission",
        path: config,
      })
      expect(build.rows.find((row) => row.permission === "webfetch" && row.action === "deny")?.from).toEqual({
        kind: "config-tools",
        path: config,
      })
      expect(build.rows.at(-1)?.from.kind).toBe("truncation")
      // The bash description is OpenCode's template, with the values it was filled with.
      expect(build.sent.find((item) => item.name === "bash")?.version.template).toMatchObject({
        file: "packages/opencode/src/tool/shell/shell.txt",
        values: { os: process.platform },
      })
      void TestLLMServer
    }),
  ),
)
