import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { InstanceRef } from "@/effect/instance-ref"
import { OperatorLayout } from "@/operator/layout"
import { OperatorMemoryDefaults } from "@/operator/memory-defaults"
import { OperatorMemoryService } from "@/operator/memory-service"
import { OperatorMemoryTool } from "@/operator/memory-tool"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { OperatorRegistry } from "@/operator/registry"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { OperatorTrashFiles } from "@/operator/trash-files"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

// The memory tool (memory_spec.md §5, §6, §4.3): every action asks `<VERB>(<level>/<file>)` first, a
// denied level is left out of list, an incognito session reads namespace and project memory only, and
// in the OpenCode namespace the tool is offered only on opt-in.

type Context = Awaited<ReturnType<NonNullable<typeof OperatorRegistry.memory.context>>>
type Asked = { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }

async function setup(fields: Partial<Context> = {}) {
  const project = await tmpdir()
  const context: Context = {
    project: project.path,
    namespace: "acme",
    folders: {
      namespace: path.join(project.path, "ns", ".memory"),
      project: path.join(project.path, ".memory"),
      agent: path.join(project.path, ".memory", "agents", "build"),
    },
    incognito: false,
    writes: true,
    read: { namespace: "deny", project: "ask", agent: "allow" },
    ...fields,
  }
  OperatorRegistry.memory.context = async () => context
  const asked: Asked[] = []
  const run = (args: Record<string, unknown>, ask: (input: Asked) => Promise<void> = async () => undefined) =>
    Effect.runPromise(
      Effect.promise(() =>
        OperatorMemoryTool.memoryTool.execute(
          args as never,
          {
            sessionID: "ses_memory",
            messageID: "msg_memory",
            agent: "build",
            directory: project.path,
            worktree: project.path,
            abort: new AbortController().signal,
            metadata: () => undefined,
            ask: async (input: Asked) => {
              asked.push(input)
              return ask(input)
            },
          } as never,
        ),
      ).pipe(Effect.provideService(InstanceRef, {} as never)),
    )
  return { project, context, asked, run }
}
const output = (result: unknown) => (typeof result === "string" ? result : (result as { output: string }).output)

afterEach(() => {
  OperatorRegistry.memory.context = undefined
})

describe("the memory tool", () => {
  test("save, list, update and forget, each asking its verb and target first", async () => {
    const { project, context, asked, run } = await setup()
    await using _ = project
    const saved = await run({
      action: "save",
      level: "agent",
      title: "Prefers short answers",
      description: "The user wants answers under five lines",
      content: "Keep answers short.",
    })
    expect(output(saved)).toContain(
      "- [Prefers short answers](prefers-short-answers.md) — The user wants answers under five lines",
    )
    expect(asked[0]).toMatchObject({
      permission: "memory",
      patterns: ["WRITE(agent/prefers-short-answers.md)"],
      always: ["WRITE(agent/*)"],
      metadata: { title: "Prefers short answers", description: "The user wants answers under five lines" },
    })
    expect(String(asked[0]!.metadata.diff)).toContain("+Keep answers short.")

    // list: the denied namespace level is left out; project asks; agent is allowed.
    const listed = output(await run({ action: "list" }))
    expect(listed).not.toContain("namespace_memory")
    expect(listed).toContain(`<agent_memory path="${context.folders.agent}">`)
    expect(listed).toContain("prefers-short-answers.md")
    expect(asked.at(-1)!.patterns).toEqual(["READ(project/*)"])
    await expect(run({ action: "list", level: "namespace" })).rejects.toThrow("Reading namespace memory is not allowed")

    await run({ action: "update", level: "agent", file: "prefers-short-answers.md", content: "Under five lines." })
    expect(asked.at(-1)!.patterns).toEqual(["WRITE(agent/prefers-short-answers.md)"])
    expect(String(asked.at(-1)!.metadata.diff)).toContain("-Keep answers short.")
    expect(String(asked.at(-1)!.metadata.diff)).toContain("+Under five lines.")

    await run({ action: "forget", level: "agent", file: "prefers-short-answers.md" })
    expect(asked.at(-1)!.patterns).toEqual(["FORGET(agent/prefers-short-answers.md)"])
    expect(await Bun.file(path.join(context.folders.agent!, "prefers-short-answers.md")).exists()).toBe(false)
    expect(
      (await OperatorTrashFiles.list()).some((entry) => entry.name === "Prefers short answers (agent memory)"),
    ).toBe(true)
  })

  test("a refused ask stops the action, and its error reaches the session as it is", async () => {
    const { project, context, run } = await setup()
    await using _ = project
    const refused = new Error("rejected by the user")
    const error = await run(
      { action: "save", level: "project", title: "T", description: "D", content: "C" },
      async () => {
        throw refused
      },
    ).catch((caught: unknown) => caught)
    expect(error).toBe(refused)
    expect(await Bun.file(path.join(context.folders.project, "MEMORY.md")).exists()).toBe(false)
  })

  test("an incognito session reads namespace and project memory only, and never writes", async () => {
    const { project, run } = await setup({
      incognito: true,
      writes: false,
      folders: { namespace: "/nowhere/.memory", project: "/nowhere/p/.memory" },
      read: { namespace: "allow", project: "allow", agent: "deny" },
    })
    await using _ = project
    await expect(run({ action: "save", level: "project", title: "T", description: "D", content: "C" })).rejects.toThrow(
      "runs incognito",
    )
    await expect(run({ action: "read", level: "agent", file: "x.md" })).rejects.toThrow("runs incognito")
    const listed = output(await run({ action: "list" }))
    expect(listed).toContain("namespace_memory")
    expect(listed).not.toContain("agent_memory")
  })
})

describe("the defaults", () => {
  test("written once: the global config's lines; a namespace's own at its level", async () => {
    const file = await OperatorLayout.globalConfigFile()
    const before = await fs.readFile(file, "utf8").catch(() => undefined)
    const settings = await OperatorLayout.readSettings()
    try {
      await OperatorLayout.writeSettings({ ...settings, memoryDefaults: undefined })
      expect(await OperatorMemoryDefaults.ensure({ OPENCODE_MEMORY_DEFAULTS: "on" })).toBe(true)
      const written = parse(await fs.readFile(file, "utf8"))
      expect(written.permission.memory).toEqual(OperatorMemoryDefaults.GLOBAL)
      // Deleted by the user: not written again.
      await fs.writeFile(file, before ?? "{}")
      expect(await OperatorMemoryDefaults.ensure({ OPENCODE_MEMORY_DEFAULTS: "on" })).toBe(false)
      expect(await fs.readFile(file, "utf8")).toBe(before ?? "{}")
      expect(await OperatorMemoryDefaults.ensure({ OPENCODE_TEST_HOME: "x" })).toBe(false)
    } finally {
      if (before === undefined) await fs.rm(file, { force: true })
      else await fs.writeFile(file, before)
      await OperatorLayout.writeSettings(settings)
    }
    expect(Global.Path.config).toBeTruthy()
  })
})

// On real requests: OpenCode's tool list is upstream's unless memory is opted into.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorToolPrompt.node,
      OperatorPermissionLive.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
      OperatorMemoryService.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
type Body = { tools?: Array<{ function: { name: string } }> }
const toolsOf = (body: unknown) => ((body as Body).tools ?? []).map((tool) => tool.function.name)

unix("in the OpenCode namespace the tool is offered only with a memory allow below Global", () =>
  Effect.gen(function* () {
    const plain = yield* configure()
    yield* plain.llm.text("ok")
    yield* send((yield* session()).id, "hello", "build")
    expect(toolsOf((yield* plain.llm.inputs)[0])).not.toContain("memory")
  }),
)

unix("a project's memory allow opts the OpenCode namespace in", () =>
  Effect.gen(function* () {
    const opted = yield* configure({ permission: { memory: { "WRITE(agent/*)": "allow" } } })
    yield* opted.llm.text("ok")
    yield* send((yield* session()).id, "hello", "build")
    expect(toolsOf((yield* opted.llm.inputs)[0])).toContain("memory")
  }),
)
