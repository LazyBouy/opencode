import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorMemoryFolders } from "@/operator/memory-folders"
import { OperatorMemoryStore } from "@/operator/memory-store"
import { OperatorModels } from "@/operator/models"
import { OperatorPermissionLive } from "@/operator/permission-live"
import { OperatorPermissionLocks } from "@/operator/permission-locks"
import { promptAudit } from "@/operator/plugins"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorPrompts } from "@/operator/prompts"
import { OperatorPromptText } from "@/operator/prompt-text"
import { OperatorSessionPermissions } from "@/operator/session-permissions"
import { OperatorToolPrompt } from "@/operator/tool-prompt"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

// The memory layers (memory_spec.md §4.1, §7): each level's index in the system prompt, the guidance line
// once before them, cut at the limits; READ ask shows one line and deny nothing; an incognito subagent has
// no agent memory; a memory saved in one session shows from the next call of another.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorPrompts.node,
      OperatorProfileStore.node,
      OperatorModels.node,
      OperatorToolPrompt.node,
      OperatorPermissionLive.node,
      OperatorSessionPermissions.node,
      OperatorPermissionLocks.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const SPEC = `${OperatorProfile.PREFIX}profile.spec`

// The global config folder (which holds the OpenCode namespace's memory here) inside the test project.
const withGlobal = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = Global.Path.config
        ;(Global.Path as { config: string }).config = dir
        return previous
      }),
      () => body(dir),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous
          promptAudit.listen = undefined
        }),
    )
  })

const save = (folder: string, project: string, level: OperatorMemoryFolders.Level, title: string) =>
  Effect.promise(() =>
    OperatorMemoryStore.save({
      folder,
      project,
      level,
      title,
      description: `About ${title}`,
      content: title,
      by: "user",
    }),
  )

// build uses the Spec profile, which holds the memory layers; three levels each get a memory.
const setup = (extra: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const { llm } = yield* configure(extra)
    const prompts = yield* OperatorPrompts.Service
    const key = (yield* prompts.preview({ agent: "build" })).project.key
    yield* (yield* OperatorProfileStore.Service).setAgent(key, "build", { profile: SPEC })
    const folders = yield* Effect.promise(() => OperatorMemoryFolders.of({ project: key, agent: { name: "build" } }))
    yield* save(folders.namespace.folder, key, "namespace", "Org conventions")
    yield* save(folders.project, key, "project", "Release checklist")
    yield* save(folders.agent!, key, "agent", "Prefers short answers")
    return { llm, prompts, key, folders }
  })

unix("Spec shows each level's index after the guidance line, the same in the preview and the request", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm, prompts, folders } = yield* setup()
      const preview = yield* prompts.preview({ agent: "build" })
      const memory = preview.sections.filter((item) => item.memory)
      expect(memory.map((item) => item.layerName)).toEqual(["Namespace memory", "Project memory", "Agent memory"])
      expect(memory[0]!.text).toBe(
        [
          OperatorPromptText.MEMORY_GUIDANCE,
          `<namespace_memory path="${folders.namespace.folder}">`,
          "- [Org conventions](org-conventions.md) — About Org conventions",
          "</namespace_memory>",
        ].join("\n"),
      )
      expect(memory[2]!.text).toBe(
        `<agent_memory path="${folders.agent}">\n- [Prefers short answers](prefers-short-answers.md) — About Prefers short answers\n</agent_memory>`,
      )
      expect(memory[1]!.trace).toEqual([{ kind: "memory-index", path: path.join(folders.project, "MEMORY.md") }])
      // Last in Dynamic: after Environment, References and Instructions.
      const dynamic = preview.sections.filter((item) => item.type === OperatorProfile.DYNAMIC)
      expect(dynamic.at(-1)?.layerName).toBe("Agent memory")

      const seen: string[][] = []
      promptAudit.listen = (entry) => entry.agent === "build" && seen.push(entry.sent)
      yield* llm.text("ok")
      yield* send((yield* session()).id, "hello", "build")
      expect(seen[0]![0]).toBe(preview.system[0])
    }),
  ),
)

unix("an index is cut at the limit, with a line saying how many more there are", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { prompts, key, folders } = yield* setup()
      for (const title of ["Second", "Third"]) yield* save(folders.project, key, "project", title)
      yield* Effect.promise(() => OperatorMemoryFolders.update({ indexLines: 2 }, []))
      const preview = yield* prompts.preview({ agent: "build" })
      const project = preview.sections.find((item) => item.layerName === "Project memory")!
      expect(project.text.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(2)
      expect(project.text).toContain("…1 more memories: use the memory tool to list them")
      yield* Effect.promise(() => fs.rm(path.join(Global.Path.config, "namespaces", "memory.json"), { force: true }))
    }),
  ),
)

unix("READ ask shows one line in place of the index; deny shows nothing", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { prompts } = yield* setup({
        permission: { memory: { "READ(project/*)": "ask", "READ(namespace/*)": "deny" } },
      })
      const preview = yield* prompts.preview({ agent: "build" })
      const names = preview.sections.filter((item) => item.memory).map((item) => item.layerName)
      expect(names).toEqual(["Project memory", "Agent memory"])
      const project = preview.sections.find((item) => item.layerName === "Project memory")!
      expect(project.text).toBe(
        `${OperatorPromptText.MEMORY_GUIDANCE}\nProject memory is available. Read it with the memory tool; reading asks for permission.`,
      )
    }),
  ),
)

unix(
  "a memory saved in one session shows from the next call of another; an incognito subagent has no agent memory",
  () =>
    withGlobal(() =>
      Effect.gen(function* () {
        const { llm, key, folders } = yield* setup()
        const seen: Array<{ session?: string; sent: string[] }> = []
        promptAudit.listen = (entry) => entry.agent === "build" && seen.push({ sent: entry.sent })
        for (let index = 0; index < 3; index++) yield* llm.text("ok")
        const first = (yield* session()).id
        yield* send(first, "hello", "build")
        expect(seen[0]!.sent[0]).not.toContain("Deploy steps")
        yield* save(folders.project, key, "project", "Deploy steps")
        yield* send((yield* session()).id, "hello", "build")
        expect(seen[1]!.sent[0]).toContain("- [Deploy steps](deploy-steps.md) — About Deploy steps")

        // A subagent's session (started by the task tool) runs incognito.
        const child = yield* (yield* Session.Service).create({ parentID: first, title: "child" })
        yield* send(child.id, "hello", "build")
        expect(seen[2]!.sent[0]).toContain("<project_memory")
        expect(seen[2]!.sent[0]).not.toContain("<agent_memory")
      }),
    ),
)

unix("a namespace's OpenCode and Spec profiles hold the memory layers, also when it takes them later", () =>
  withGlobal((dir) =>
    Effect.gen(function* () {
      yield* configure()
      const store = yield* OperatorProfileStore.Service
      const roots = process.env.OPENCODE_WORKSPACE_ROOTS
      process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
      try {
        const memory = ["memory-namespace", "memory-project", "memory-agent"].map((id) => `generated.${id}`)
        const acme = yield* store.createNamespace({ name: "Acme", folder: path.join(path.dirname(dir), "acme") })
        const dynamicOf = (
          catalog: { profiles: ReadonlyArray<{ id: string; slots: Record<string, ReadonlyArray<string>> }> },
          id: string,
        ) => catalog.profiles.find((item) => item.id === id)?.slots[OperatorProfile.DYNAMIC] ?? []
        const catalog = yield* store.catalog(acme.id)
        expect(dynamicOf(catalog, "profile.opencode").slice(-3)).toEqual(memory)
        expect(dynamicOf(catalog, "profile.spec").slice(-3)).toEqual(memory)
        // OpenCode's own OpenCode profile stays upstream's.
        const opencode = yield* store.catalog(OperatorProfile.OPENCODE)
        expect(dynamicOf(opencode, OperatorProfile.OPENCODE_PROFILE).some((id) => id.includes("memory"))).toBe(false)

        // A namespace that took OpenCode's built-ins before the memory layers existed gets them once.
        const folder = path.join(dir, "namespaces", acme.id)
        const file = path.join(folder, "profiles", "profile.opencode.json")
        const profile = JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))
        profile.slots[OperatorProfile.DYNAMIC] = profile.slots[OperatorProfile.DYNAMIC].filter(
          (id: string) => !memory.includes(id),
        )
        yield* Effect.promise(() => fs.writeFile(file, JSON.stringify(profile)))
        const builtins = path.join(folder, "builtins.json")
        const taken = JSON.parse(yield* Effect.promise(() => fs.readFile(builtins, "utf8"))) as string[]
        yield* Effect.promise(() =>
          fs.writeFile(builtins, JSON.stringify(taken.filter((id) => !id.includes("generated.memory")))),
        )
        expect(dynamicOf(yield* store.catalog(acme.id), "profile.opencode").slice(-3)).toEqual(memory)
      } finally {
        if (roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
        else process.env.OPENCODE_WORKSPACE_ROOTS = roots
      }
    }),
  ),
)

// The agent form's preview of an agent not saved yet (agent_form_spec.md §6.2): its memory layers resolve with the
// permissions a new agent starts with (it has no rules of its own yet).
unix("an agent not saved yet previews its memory layers", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { prompts, folders } = yield* setup()
      const preview = yield* prompts.preview({
        agent: "scribe",
        draft: { prompt: "Write things down.", setting: { profile: SPEC } },
      })
      expect(preview.agent).toBe("scribe")
      const memory = preview.sections.filter((item) => item.memory)
      expect(memory[0]?.text).toContain(`<namespace_memory path="${folders.namespace.folder}">`)
      expect(preview.system.join("\n")).toContain("Write things down.")
    }),
  ),
)
