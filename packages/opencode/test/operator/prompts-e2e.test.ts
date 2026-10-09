import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { promptAudit } from "@/operator/plugins"
import { OperatorModels } from "@/operator/models"
import { OperatorProfile } from "@/operator/profile"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorPrompts } from "@/operator/prompts"
import { OperatorPromptText } from "@/operator/prompt-text"
import { SessionCompaction } from "@/session/compaction"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { configure, replacements, root, send, session } from "../merge/harness"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([root, OperatorPrompts.node, OperatorProfileStore.node, OperatorModels.node]),
    replacements,
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const P = OperatorProfile.PREFIX
const PLAN_REMINDER = OperatorPromptText.BUILTINS.find((item) => item.id === "reminder.plan")!.text

type Input = Record<string, unknown> | undefined
const systemMessages = (input: Input) =>
  (Array.isArray(input?.messages) ? input.messages : [])
    .filter((message: { role?: string }) => message.role === "system")
    .map((message: { content?: unknown }) => message.content)
const toolDescription = (input: Input, name: string) =>
  (Array.isArray(input?.tools) ? input.tools : []).find(
    (tool: { function?: { name?: string } }) => tool.function?.name === name,
  )?.function?.description

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

// Points the global config folder (where namespaces/ lives) inside the test project for one test.
// A folder for a new namespace, inside the test project.
const folderFor = (name: string) =>
  TestInstance.pipe(Effect.map((instance) => path.join(instance.directory, "namespaces", name.toLowerCase())))

const withGlobal = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        // Namespace folders must be inside the workspace roots: the test project is one.
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body(dir),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
          promptAudit.listen = undefined
        }),
    )
  })

// Waits for a request whose body contains `text` (title and compaction run on their own fibers).
const request = (text: string) =>
  Effect.gen(function* () {
    const server = yield* TestLLMServer
    const found = (yield* server.inputs).find((input) => JSON.stringify(input).includes(text))
    if (!found) return yield* Effect.fail("not yet")
    return found
  }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }), Effect.orDie)

unix("OpenCode is unchanged: every agent sends upstream's system prompt, tools and reminders", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      yield* write(path.join(directory, "AGENTS.md"), "Use Bun for everything.\n")
      yield* write(path.join(directory, ".opencode", "agent", "triage.md"), "---\nmode: primary\n---\nTriage issues.\n")
      const seen: Array<{ agent: string; upstream: string[]; sent: string[] }> = []
      promptAudit.listen = (entry) => seen.push(entry)
      for (let index = 0; index < 10; index++) yield* llm.text("ok")

      for (const agent of ["build", "plan", "general", "explore", "triage"])
        yield* send((yield* session()).id, "hello", agent)
      // Title generation runs for a session that still has its default title.
      const titled = yield* (yield* Session.Service).create({})
      yield* send(titled.id, "hello", "build")
      yield* request("Generate a title")
      // Compaction of that session.
      const sessions = yield* Session.Service
      const compaction = yield* SessionCompaction.Service
      yield* compaction.create({
        sessionID: titled.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        auto: false,
      })
      const messages = yield* sessions.messages({ sessionID: titled.id })
      yield* compaction.process({ parentID: messages.at(-1)!.info.id, messages, sessionID: titled.id, auto: false })

      expect(seen.map((item) => item.agent).toSorted()).toEqual([
        "build",
        "build",
        "compaction",
        "explore",
        "general",
        "plan",
        "title",
        "triage",
      ])
      for (const item of seen)
        expect({ agent: item.agent, system: item.sent }).toEqual({ agent: item.agent, system: item.upstream })

      // Tool descriptions are the registry's own, and the plan reminder is OpenCode's.
      const inputs = yield* llm.inputs
      const registry = yield* ToolRegistry.Service
      const own = yield* registry.all()
      for (const name of ["read", "bash", "edit", "glob"])
        expect(toolDescription(inputs[0], name)).toBe(own.find((tool) => tool.id === name)!.description)
      expect(JSON.stringify(inputs[1])).toContain(JSON.stringify(PLAN_REMINDER).slice(1, -1))
    }),
  ),
)

unix("the preview is exactly what is sent, for build, explore and title", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const seen: Array<{ agent: string; sent: string[] }> = []
      promptAudit.listen = (entry) => seen.push(entry)
      for (let index = 0; index < 4; index++) yield* llm.text("ok")
      yield* send((yield* session()).id, "hello", "build")
      yield* send((yield* session()).id, "hello", "explore")
      yield* send((yield* (yield* Session.Service).create({})).id, "hello", "build")
      yield* request("Generate a title")
      const prompts = yield* OperatorPrompts.Service
      for (const agent of ["build", "explore", "title"]) {
        const preview = yield* prompts.preview({ agent })
        expect(seen.find((item) => item.agent === agent)?.sent).toEqual([...preview.system])
      }
      expect((yield* prompts.preview({ agent: "title" })).profile).toMatchObject({
        id: `${OperatorProfile.PREFIX}profile.helper.title`,
        source: "helper",
      })
    }),
  ),
)

unix("Purpose comes first for every agent: the namespace's purpose, then the project's", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key
      yield* store.updateNamespace("opencode", { purpose: "We value care." })
      const goal = yield* store.saveLayer("opencode", undefined, {
        name: "Goal",
        type: "purpose",
        section: "purpose",
        text: "Ship the release.",
      })
      yield* store.setProject(key, { purpose: goal.id })
      const seen: Array<{ agent: string; sent: string[] }> = []
      promptAudit.listen = (entry) => seen.push(entry)
      for (let index = 0; index < 3; index++) yield* llm.text("ok")
      yield* send((yield* (yield* Session.Service).create({})).id, "hello", "build")
      yield* request("Generate a title")
      expect(seen.find((item) => item.agent === "build")?.sent[0]).toStartWith("We value care.\nShip the release.\n")
      // A helper agent sends its helper text only.
      expect(seen.find((item) => item.agent === "title")?.sent[0]).toStartWith("You are a title generator.")
      const preview = yield* prompts.preview({ agent: "build" })
      expect(preview.sections.filter((item) => item.automatic).map((item) => item.text)).toEqual([
        "We value care.",
        "Ship the release.",
      ])
      expect(directory).toBeTruthy()
    }),
  ),
)

unix("editable copies change only agents whose profile holds them", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key
      const base = yield* store.copyBuiltin("opencode", `${P}base.default`)
      yield* store.saveLayer("opencode", base.id, {
        name: base.name,
        type: "identity",
        text: "You are a test assistant.",
      })
      const bash = yield* store.copyBuiltin("opencode", `${P}tool.bash`, "Run commands.")
      const opencode = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === OperatorProfile.OPENCODE_PROFILE)!
      const profile = yield* store.saveProfile("opencode", undefined, {
        name: "Brief",
        group: opencode.group,
        slots: {
          ...opencode.slots,
          identity: [base.id],
          capabilities: [bash.id],
        },
      })
      yield* store.setProject(key, { defaultProfile: profile.id })
      // plan keeps OpenCode's profile.
      yield* store.setAgent(key, "plan", { profile: OperatorProfile.OPENCODE_PROFILE })
      for (let index = 0; index < 2; index++) yield* llm.text("ok")
      yield* send((yield* session()).id, "hello", "build")
      yield* send((yield* session()).id, "hello", "plan")
      const inputs = yield* llm.inputs
      expect(String(systemMessages(inputs[0])[0])).toStartWith("You are a test assistant.\n")
      expect(toolDescription(inputs[0], "bash")).toBe("Run commands.")
      expect(String(systemMessages(inputs[1])[0])).not.toContain("You are a test assistant.")
      expect(toolDescription(inputs[1], "bash")).not.toBe("Run commands.")
    }),
  ),
)

unix("an agent's override changes its own slots only", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key
      const role = yield* store.saveLayer("opencode", undefined, {
        name: "Reviewer",
        type: "role",
        section: "role",
        text: "You review release notes.",
      })
      yield* store.setAgent(key, "build", { override: { slots: { role: [role.id] } } })
      yield* llm.text("ok")
      yield* send((yield* session()).id, "hello", "build")
      const sent = systemMessages((yield* llm.inputs)[0])
      const preview = yield* prompts.preview({ agent: "build" })
      expect(sent).toEqual([...preview.system])
      expect(String(sent[0])).toStartWith("You review release notes.\n")
      expect(preview.override).toEqual(["role"])
      expect(preview.sections.find((item) => item.type === "role")).toMatchObject({ layer: role.id, changed: true })
      // Previewing a profile on the agent leaves its override out.
      const plain = yield* prompts.preview({ agent: "build", profile: OperatorProfile.OPENCODE_PROFILE })
      expect(plain.override).toEqual([])
    }),
  ),
)

unix("the tool catalog lists this project's tools with their own descriptions", () =>
  Effect.gen(function* () {
    const catalog = yield* (yield* OperatorPrompts.Service).catalog()
    expect(catalog.tools.some((tool) => tool.id === "read" && tool.builtin.length > 0)).toBe(true)
    expect(catalog.tools.some((tool) => tool.id === "invalid")).toBe(false)
  }),
)

unix("a Dynamic layer's sample is what it fills in for the agent", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      yield* configure()
      const prompts = yield* OperatorPrompts.Service
      const preview = yield* prompts.preview({ agent: "build" })
      const environment = preview.sections.find((item) => item.layer === `${P}generated.environment`)!
      expect((yield* prompts.sample({ agent: "build", layer: `${P}generated.environment` })).text).toBe(
        environment.text,
      )
      const base = yield* prompts.sample({ agent: "build", layer: `${P}slot.base` })
      expect(base.text).toBe(preview.sections.find((item) => item.layer === `${P}${preview.base}`)?.text ?? base.text)
      expect(base.source).toBe(preview.base)
      const title = yield* prompts.sample({ agent: "title", layer: `${P}helper.title` })
      expect(title.text).toStartWith("You are a title generator.")
    }),
  ),
)

unix("every section is traced to its source, down to the file", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* configure({ agent: { reviewer: { mode: "subagent", prompt: "Review the diff." } } })
      yield* write(path.join(directory, "AGENTS.md"), "Use Bun for everything.\n")
      const triage = path.join(directory, ".opencode", "agent", "triage.md")
      // Its model is not available here; the default model stands in.
      yield* write(triage, "---\nmode: primary\nmodel: nowhere/missing\n---\nTriage issues.\n")
      const prompts = yield* OperatorPrompts.Service
      const config = path.join(directory, "opencode.json")
      const traceOf = (agent: string) =>
        prompts
          .preview({ agent })
          .pipe(
            Effect.map((preview) => preview.sections.find((item) => item.entry === `${P}slot.agent-or-base`)!.trace),
          )

      // explore: its own prompt is in OpenCode's definition of it, from explore.txt.
      const explore: OperatorProfile.TraceStep[] = [
        { kind: "agent-own", name: "explore" },
        { kind: "agent-builtin", name: "explore", path: "packages/opencode/src/agent/agent.ts" },
        { kind: "file", path: "packages/opencode/src/agent/prompt/explore.txt" },
      ]
      expect(yield* traceOf("explore")).toEqual(explore)
      expect((yield* prompts.sample({ agent: "explore", layer: `${P}slot.agent` })).trace).toEqual(explore)
      // triage: its agent file; reviewer: its config entry.
      expect(yield* traceOf("triage")).toEqual([
        { kind: "agent-own", name: "triage" },
        { kind: "agent-file", path: triage },
      ])
      expect(yield* traceOf("reviewer")).toEqual([
        { kind: "agent-own", name: "reviewer" },
        { kind: "agent-config", name: "reviewer", path: config },
      ])
      // build has no prompt of its own: the base prompt for the model, by the rule that chose it.
      expect(yield* traceOf("build")).toEqual([
        { kind: "agent-none", name: "build" },
        { kind: "model-rule", name: "test/test-model", detail: "no other rule matches" },
        { kind: "builtin-layer", name: "base.default", detail: `${P}base.default` },
        { kind: "file", path: "packages/opencode/src/session/prompt/default.txt" },
      ])
      const none = yield* prompts.sample({ agent: "build", layer: `${P}slot.agent` })
      expect(none.text).toBe("")
      expect(none.trace).toEqual([{ kind: "agent-none", name: "build" }])
      expect((yield* prompts.sample({ agent: "build", layer: `${P}generated.environment` })).trace).toEqual([
        { kind: "written" },
      ])
      expect((yield* prompts.sample({ agent: "build", layer: `${P}generated.instructions` })).trace).toContainEqual({
        kind: "instruction-file",
        path: path.join(directory, "AGENTS.md"),
      })
      // triage's own model is not available: the default model, set in config, stands in.
      expect((yield* prompts.preview({ agent: "triage" })).modelSource).toEqual({
        model: "test/test-model",
        source: "default",
        path: config,
        agent: { model: "nowhere/missing", path: triage },
      })
    }),
  ),
)

unix("an unsaved override is previewed in place of the saved one; null previews none", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const role = yield* store.saveLayer("opencode", undefined, {
        name: "Scout",
        type: "role",
        section: "role",
        text: "You scout.",
      })
      const draft = yield* prompts.preview({ agent: "explore", override: { slots: { role: [role.id] } } })
      expect(draft.override).toEqual(["role"])
      expect(String(draft.system[0])).toStartWith("You scout.\n")
      const section = draft.sections.find((item) => item.layer === role.id)!
      expect(section.trace).toEqual([
        { kind: "layer", name: "Scout", detail: role.id },
        { kind: "file", path: OperatorProfileStore.itemFile("opencode", "layer", role.id) },
      ])
      expect((yield* prompts.preview({ agent: "explore", override: null })).override).toEqual([])
    }),
  ),
)

unix("the default and small model are traced to where they are set; title runs on the small model", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* configure({ model: undefined, small_model: "test/test-model" })
      const models = yield* OperatorModels.Service
      const prompts = yield* OperatorPrompts.Service
      const defaults = yield* models.defaults()
      // No default model in config: OpenCode's own ranking chooses.
      expect(defaults.model).toEqual({ model: "test/test-model", source: "ranking", how: "default" })
      // Set for this project, in its config.
      expect(defaults.small).toEqual({
        model: "test/test-model",
        source: "small",
        path: path.join(directory, "opencode.json"),
        how: "project",
      })
      expect(defaults.global.model).toBeUndefined()
      expect((yield* prompts.preview({ agent: "title" })).modelSource.source).toBe("small")
      expect(
        (yield* prompts.preview({ agent: "build", providerID: "test", modelID: "test-model" })).modelSource,
      ).toEqual({
        model: "test/test-model",
        source: "chosen",
      })
      // No external plugins: nothing else can change the prompt.
      expect(yield* prompts.plugins()).toEqual({ plugins: [] })
    }),
  ),
)

unix("your Dynamic layer is written once per session by the dynamic generator, then reused", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key
      const notes = yield* store.saveLayer("opencode", undefined, {
        name: "Release date",
        type: "dynamic",
        text: "",
        prompt: "Say when the release is.",
      })
      const opencode = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === OperatorProfile.OPENCODE_PROFILE)!
      const profile = yield* store.saveProfile("opencode", undefined, {
        name: "Dated",
        group: opencode.group,
        slots: { ...opencode.slots, dynamic: [...opencode.slots.dynamic!, notes.id] },
      })
      yield* store.setProject(key, { defaultProfile: profile.id })
      const seen: Array<{ agent: string; sent: string[] }> = []
      promptAudit.listen = (entry) => seen.push(entry)
      yield* llm.text("The release is on Friday.")
      for (let index = 0; index < 2; index++) yield* llm.text("ok")
      // A title of its own, so no title is generated meanwhile.
      const id = (yield* (yield* Session.Service).create({ title: "Release" })).id
      yield* send(id, "When do we ship?", "build")
      yield* send(id, "And then?", "build")
      const builds = seen.filter((item) => item.agent === "build")
      expect(builds).toHaveLength(2)
      for (const item of builds) expect(item.sent[0]).toContain("The release is on Friday.")
      const writer = seen.filter((item) => item.agent === OperatorProfile.DYNAMIC_GENERATOR)
      expect(writer).toHaveLength(1)
      expect(writer[0]!.sent[0]).toStartWith("You write one section of another agent's system prompt.")
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(3)
      expect(JSON.stringify(inputs[0])).toContain("Say when the release is.")
      expect(JSON.stringify(inputs[0])).toContain("When do we ship?")
      // The preview marks where the text goes.
      const preview = yield* prompts.preview({ agent: "build" })
      expect(preview.sections.find((item) => item.layer === notes.id)?.text).toContain("written for each session")
    }),
  ),
)

unix("the purpose generator drafts a project purpose from its files and a brief", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm, directory } = yield* configure()
      yield* Effect.promise(() => Bun.write(path.join(directory, "README.md"), "# Notes\nA notes app for teams.\n"))
      const prompts = yield* OperatorPrompts.Service
      yield* llm.text("We build a notes app for teams.")
      expect(yield* prompts.purpose({ kind: "project", brief: "Keep it short." })).toBe(
        "We build a notes app for teams.",
      )
      const sent = JSON.stringify((yield* llm.inputs)[0])
      expect(sent).toContain("A notes app for teams.")
      expect(sent).toContain("Keep it short.")
      expect(sent).toContain("You write purpose statements")
    }),
  ),
)

unix("a project in another namespace sends OpenCode's prompt from that namespace's own copies, byte for byte", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const before = yield* prompts.preview({ agent: "build" })
      const acme = yield* store.createNamespace({ name: "Acme", folder: yield* folderFor("Acme") })
      yield* store.setProject(before.project.key, { namespace: acme.id })
      const after = yield* prompts.preview({ agent: "build" })
      expect(after.namespace.id).toBe(acme.id)
      expect(after.profile.id).toBe("profile.opencode")
      expect(after.system).toEqual(before.system)
      // A request sends it too.
      const seen: Array<{ agent: string; sent: string[] }> = []
      promptAudit.listen = (entry) => seen.push(entry)
      yield* llm.text("ok")
      yield* send((yield* (yield* Session.Service).create({ title: "Acme" })).id, "hello", "build")
      expect(seen.find((item) => item.agent === "build")?.sent).toEqual([...after.system])
      // Acme's own copy of the base prompt changes Acme's prompt only.
      const base = `${P}${after.base}`
      const copy = (yield* store.catalog(acme.id)).layers.find((item) => item.id === OperatorProfile.own(base))!
      yield* store.saveLayer(acme.id, copy.id, { name: copy.name, type: copy.type, text: "You are Acme's assistant." })
      expect((yield* prompts.preview({ agent: "build" })).system[0]).toStartWith("You are Acme's assistant.")
      expect((yield* store.catalog("opencode")).layers.find((item) => item.id === base)?.text).not.toContain("Acme")
    }),
  ),
)
