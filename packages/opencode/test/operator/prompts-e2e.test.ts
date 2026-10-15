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
import type { OperatorResolver } from "@/operator/resolver"
import { OperatorResolverBuiltins as B } from "@/operator/resolver-builtins"
import { SessionCompaction } from "@/session/compaction"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { Instruction } from "@/session/instruction"
import { MessageID } from "@/session/schema"
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
      const seen: Array<{
        agent: string
        upstream: string[]
        sent: string[]
        sections?: ReadonlyArray<OperatorProfile.AssembledSection>
      }> = []
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
      // The pipeline's own texts are OpenCode's (dynamic_layer_resolution_spec.md §8): no section fell back.
      const piped = seen.flatMap((item) =>
        (item.sections ?? []).filter((section) => section.parity).map((section) => ({ agent: item.agent, ...section })),
      )
      expect(new Set(piped.map((section) => section.layer))).toEqual(
        new Set([
          `${P}slot.agent-or-base`,
          `${P}generated.environment`,
          `${P}generated.instructions`,
          `${P}generated.skills`,
        ]),
      )
      expect(
        piped.filter((section) => section.parity !== "same").map((section) => [section.agent, section.layer]),
      ).toEqual([])

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

// The agent form's text edits (agent_form_spec.md §6.3–§6.4): the preview of the unsaved texts is what a request
// sends once they are saved, and only this agent sends them.
unix("an agent's own texts: previewed unsaved, sent once saved, by that agent only", () =>
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
      const setting = {
        override: {
          slots: { role: ["agent:1", "agent:2"] },
          layers: {
            "1": { type: "role", text: "You review release notes, briefly.", basedOn: role.id },
            "2": { type: "role", text: "Always cite the pull request." },
          },
        },
      }
      const draft = yield* prompts.preview({ agent: "build", draft: { setting } })
      expect(draft.sections.filter((item) => item.type === "role").map((item) => item.layerName)).toEqual([
        "Reviewer (this agent)",
        "Text (this agent)",
      ])
      expect(draft.sections.find((item) => item.layer === "agent:2")?.trace).toEqual([
        { kind: "agent-local", name: "build", detail: "2" },
        { kind: "file", path: OperatorProfileStore.agentsFile() },
      ])
      // A text cleared while typing stays in the form's preview, empty, and adds nothing to the prompt.
      const cleared = yield* prompts.preview({
        agent: "build",
        draft: {
          setting: {
            override: { ...setting.override, layers: { ...setting.override.layers, "2": { type: "role", text: "" } } },
          },
        },
      })
      expect(cleared.sections.find((item) => item.entry === "agent:2")).toMatchObject({ text: "" })
      expect(cleared.system.join("\n")).not.toContain("Always cite the pull request.")
      yield* store.setAgent(key, "build", setting)
      for (let index = 0; index < 2; index++) yield* llm.text("ok")
      yield* send((yield* session()).id, "hello", "build")
      yield* send((yield* session()).id, "hello", "plan")
      const inputs = yield* llm.inputs
      expect(systemMessages(inputs[0])).toEqual([...draft.system])
      expect(String(systemMessages(inputs[0])[0])).toStartWith(
        "You review release notes, briefly.\nAlways cite the pull request.\n",
      )
      expect(String(systemMessages(inputs[1])[0])).not.toContain("Always cite the pull request.")
    }),
  ),
)

// The agent form's "System Prompt as sent" (agent_form_spec.md §6.2): its unsaved values, for an agent saved or not.
unix("a draft previews the form's prompt and setting; with the saved values it is the saved preview", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key
      const role = yield* store.saveLayer("opencode", undefined, {
        name: "Reviewer",
        type: "role",
        section: "role",
        text: "You review release notes.",
      })
      const setting = { override: { slots: { role: [role.id] } } }
      yield* store.setAgent(key, "build", setting)

      // The saved values: the same prompt as the saved preview.
      const saved = yield* prompts.preview({ agent: "build" })
      const same = yield* prompts.preview({ agent: "build", draft: { setting } })
      expect([...same.system]).toEqual([...saved.system])
      // Without the override (unsaved): the profile's own slots.
      const plain = yield* prompts.preview({ agent: "build", draft: { setting: {} } })
      expect(plain.override).toEqual([])
      expect(plain.system[0]).not.toContain("You review release notes.")

      // An agent not saved yet: its typed prompt where the profile puts the agent's own text, and its chosen profile.
      const spec = `${OperatorProfile.PREFIX}profile.spec`
      const draft = yield* prompts.preview({
        agent: "scribe",
        draft: { prompt: "Write things down clearly.", mode: "subagent", setting: { profile: spec } },
      })
      expect(draft.agent).toBe("scribe")
      expect(draft.profile).toMatchObject({ id: spec, source: "agent" })
      expect(draft.system.join("\n")).toContain("Write things down clearly.")
      expect(draft.sections.filter((item) => item.agentPrompt).map((item) => item.text)).toEqual([
        "Write things down clearly.",
      ])
      // Without a prompt yet, the form gets the Agent prompt slot empty, to write the prompt there; it is not sent.
      const empty = yield* prompts.preview({ agent: "scribe", draft: { prompt: "", setting: { profile: spec } } })
      expect(empty.sections.filter((item) => item.agentPrompt)).toMatchObject([{ text: "" }])
      expect(empty.system.join("\n")).not.toContain("\n\n\n")
      expect((yield* prompts.preview({ agent: "build" })).sections.filter((item) => item.text === "")).toEqual([])
      // Without a draft, an unknown agent is still refused.
      expect((yield* prompts.preview({ agent: "scribe" }).pipe(Effect.flip)).message).toContain("No agent")
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

unix("a Dynamic layer's resolution: Instructions keeps AGENTS.md, the rest lost to it; the base prompt by rule", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* configure()
      yield* write(path.join(directory, "AGENTS.md"), "Use Bun for everything.\n")
      yield* write(path.join(directory, "CLAUDE.md"), "Claude's rules.\n")
      yield* write(path.join(directory, "CONTEXT.md"), "Old context.\n")
      const prompts = yield* OperatorPrompts.Service
      const preview = yield* prompts.preview({ agent: "build" })
      const instructions = preview.sections.find((item) => item.layer === `${P}generated.instructions`)!
      expect(instructions.parity).toBe("same")
      expect(instructions.text).toBe(
        `Instructions from: ${path.join(directory, "AGENTS.md")}\nUse Bun for everything.\n`,
      )
      const of = (name: string) =>
        instructions.resolution!.candidates.find((item) => item.location === path.join(directory, name))
      expect(of("AGENTS.md")).toMatchObject({ selected: true, why: "selected" })
      expect(of("CLAUDE.md")).toMatchObject({ selected: false, why: "lost to AGENTS.md (precedence (name))" })
      expect(of("CONTEXT.md")).toMatchObject({ selected: false, why: "lost to AGENTS.md (precedence (name))" })
      // The base prompt: the family the model's rule chose, OpenCode's text, the same as upstream's.
      const base = preview.sections.find((item) => item.entry === `${P}slot.agent-or-base`)!
      expect(base.parity).toBe("same")
      expect(base.resolution!.inner!.candidates.find((item) => item.selected)?.name).toBe(
        `base.${preview.base.slice(5)}`,
      )
      expect(base.trace[1]).toMatchObject({ kind: "model-rule", detail: "no other rule matches" })
    }),
  ),
)

// A profile like OpenCode's whose dynamic slot also holds (or holds in place of) these layers, as the project's default.
const useDynamic = (key: string, layers: ReadonlyArray<string>, without: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const store = yield* OperatorProfileStore.Service
    const opencode = OperatorProfile.BUILTIN_PROFILES.find((item) => item.id === OperatorProfile.OPENCODE_PROFILE)!
    const dynamic = opencode.slots.dynamic!.filter((id) => !without.includes(id))
    const profile = yield* store.saveProfile("opencode", undefined, {
      name: "Ruled",
      group: opencode.group,
      slots: { ...opencode.slots, dynamic: [...dynamic, ...layers] },
    })
    yield* store.setProject(key, { defaultProfile: profile.id })
  })

unix("a Dynamic layer with rules of its own: a glob by recency, top 3, as Test resolve shows and a request sends", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const key = (yield* prompts.preview({ agent: "build" })).project.key
      for (const [index, name] of ["a", "b", "c", "d", "e"].entries()) {
        const file = path.join(directory, "notes", `${name}.md`)
        yield* write(file, `note ${name}`)
        const at = new Date(Date.UTC(2026, 0, 1 + index))
        yield* Effect.promise(() => fs.utimes(file, at, at))
      }
      const resolver: OperatorResolver.Resolver = {
        sources: [{ kind: "file", location: "notes/*.md", name: "Notes" }],
        filter: [{ kind: "available", need: "text" }],
        score: [{ kind: "recency", weight: 1 }],
        select: { policy: "top", n: 3 },
        template: { header: "<notes>\n", item: "- {name}: {text}", separator: "\n", footer: "\n</notes>" },
      }
      // Without a helper source the layer needs no prompt; its rules are kept in its file.
      const notes = yield* store.saveLayer("opencode", undefined, {
        name: "Recent notes",
        type: "dynamic",
        text: "",
        resolver,
      })
      expect(notes.resolver).toEqual(resolver)
      const file = OperatorProfileStore.itemFile("opencode", "layer", notes.id)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toContain("resolver:")
      expect((yield* store.catalog("opencode")).layers.find((item) => item.id === notes.id)?.resolver).toEqual(resolver)
      yield* useDynamic(key, [notes.id])

      const expected = "<notes>\n- e.md: note e\n- d.md: note d\n- c.md: note c\n</notes>"
      const tested = yield* prompts.sample({ agent: "build", layer: notes.id })
      expect(tested.text).toBe(expected)
      expect(tested.trace[0]).toEqual({ kind: "rules", name: "Recent notes" })
      expect(
        tested.resolution!.candidates.filter((item) => !item.selected).map((item) => [item.name, item.why]),
      ).toEqual([
        ["a.md", "not in the top 3"],
        ["b.md", "not in the top 3"],
      ])
      // Draft rules are tried without saving them.
      const draft = yield* prompts.sample({
        agent: "build",
        layer: notes.id,
        resolver: { ...resolver, select: { policy: "top", n: 1 } },
      })
      expect(draft.text).toBe("<notes>\n- e.md: note e\n</notes>")
      // The preview and a request send what Test resolve showed.
      const preview = yield* prompts.preview({ agent: "build" })
      expect(preview.sections.find((item) => item.layer === notes.id)?.text).toBe(expected)
      const seen: Array<{ agent: string; sent: string[] }> = []
      promptAudit.listen = (entry) => seen.push(entry)
      yield* llm.text("ok")
      yield* send((yield* (yield* Session.Service).create({ title: "Notes" })).id, "hello", "build")
      expect(seen.find((item) => item.agent === "build")!.sent[0]).toContain(expected)
    }),
  ),
)

unix(
  "OpenCode's per-request rules give OpenCode's texts in a layer of yours; an edited copy changes only its own",
  () =>
    withGlobal(() =>
      Effect.gen(function* () {
        const { directory, llm } = yield* configure()
        yield* write(path.join(directory, "AGENTS.md"), "Project rules\n")
        yield* write(path.join(directory, "CONTEXT.md"), "Glossary\n")
        const store = yield* OperatorProfileStore.Service
        const prompts = yield* OperatorPrompts.Service
        const key = (yield* prompts.preview({ agent: "build" })).project.key
        // Edit a copy: one of your Dynamic layers with OpenCode's rules reads its sources the same way.
        for (const id of B.EDITABLE) {
          const copy = yield* store.saveLayer("opencode", undefined, {
            name: `${id} – copy`,
            type: "dynamic",
            text: "",
            resolver: B.RESOLVERS[id]!,
          })
          const mine = yield* prompts.sample({ agent: "build", layer: copy.id })
          const opencode = yield* prompts.sample({ agent: "build", layer: id })
          expect({ id, text: mine.text }).toEqual({ id, text: opencode.text })
        }
        // Its rules edited: Instructions with every project file, in place of OpenCode's.
        const rules = B.RESOLVERS[B.INSTRUCTIONS]!
        const edited = yield* store.saveLayer("opencode", undefined, {
          name: "Every instruction file",
          type: "dynamic",
          text: "",
          resolver: { ...rules, select: { ...rules.select, per: { config: "all", project: "all" } } },
        })
        yield* useDynamic(key, [edited.id], [B.INSTRUCTIONS])
        const seen: Array<{
          agent: string
          sent: string[]
          sections?: ReadonlyArray<OperatorProfile.AssembledSection>
        }> = []
        promptAudit.listen = (entry) => seen.push(entry)
        yield* llm.text("ok")
        yield* send((yield* (yield* Session.Service).create({ title: "Rules" })).id, "hello", "build")
        const build = seen.find((item) => item.agent === "build")!
        expect(build.sent[0]).toContain(`Instructions from: ${path.join(directory, "AGENTS.md")}\nProject rules\n`)
        expect(build.sent[0]).toContain(`Instructions from: ${path.join(directory, "CONTEXT.md")}\nGlossary\n`)
        const section = build.sections!.find((item) => item.layer === edited.id)!
        expect(section.parity).toBeUndefined()
        expect(section.resolution!.candidates.filter((item) => item.selected).length).toBe(2)
      }),
    ),
)

unix("rules of their own only for Dynamic layers; OpenCode's are kept by not keeping them", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      yield* configure()
      const store = yield* OperatorProfileStore.Service
      const rules = B.RESOLVERS[B.SKILLS]!
      const refused = (input: Parameters<typeof store.saveLayer>[2], id?: string) =>
        store.saveLayer("opencode", id, input).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        )
      expect(yield* refused({ name: "Role", type: "identity", text: "x", resolver: rules })).toBe(
        "Only Dynamic layers have rules of their own",
      )
      expect(
        yield* refused({ name: "Top", type: "dynamic", text: "", resolver: { ...rules, select: { policy: "top" } } }),
      ).toBe("Top N needs N")
      // A helper source writes from the prompt: without one, refused.
      expect(yield* refused({ name: "Helper", type: "dynamic", text: "", resolver: B.HELPER_RESOLVER })).toBe(
        "A Dynamic layer needs a prompt",
      )
      // Your layers written by a helper have its rules, not written in their file.
      const written = yield* store.saveLayer("opencode", undefined, {
        name: "Written",
        type: "dynamic",
        text: "",
        prompt: "Say hello.",
      })
      expect(written.resolver).toEqual(B.HELPER_RESOLVER)
      const file = OperatorProfileStore.itemFile("opencode", "layer", written.id)
      expect(yield* Effect.promise(() => Bun.file(file).text())).not.toContain("resolver:")
      // A namespace's version of a per-request layer follows OpenCode's rules until it has its own.
      const acme = yield* store.createNamespace({ name: "Acme", folder: yield* folderFor("Acme") })
      const version = (yield* store.catalog(acme.id)).layers.find((item) => item.replaces === B.SKILLS)!
      expect(version.resolver).toBeUndefined()
      yield* store.saveLayer(acme.id, version.id, { name: version.name, type: version.type, text: "", resolver: rules })
      expect((yield* store.catalog(acme.id)).layers.find((item) => item.id === version.id)?.resolver).toBeUndefined()
      const own = { ...rules, select: { policy: "top" as const, n: 2 } }
      yield* store.saveLayer(acme.id, version.id, { name: version.name, type: version.type, text: "", resolver: own })
      expect((yield* store.catalog(acme.id)).layers.find((item) => item.id === version.id)?.resolver).toEqual(own)
      yield* store.saveLayer(acme.id, version.id, { name: version.name, type: version.type, text: "", resolver: null })
      expect((yield* store.catalog(acme.id)).layers.find((item) => item.id === version.id)?.resolver).toBeUndefined()
      expect((yield* store.catalog(acme.id)).resolvers[B.SKILLS]).toEqual(rules)
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

unix("instruction files apply only to the OpenCode namespace's projects: elsewhere none are sent or attached", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory } = yield* configure()
      yield* write(path.join(directory, "AGENTS.md"), "Project rules\n")
      yield* write(path.join(directory, "sub", "AGENTS.md"), "Nested rules\n")
      const store = yield* OperatorProfileStore.Service
      const prompts = yield* OperatorPrompts.Service
      const instruction = yield* Instruction.Service
      const before = yield* prompts.preview({ agent: "build" })
      expect(before.system[0]).toContain(`Instructions from: ${path.join(directory, "AGENTS.md")}`)
      const nested = (messageID: string) =>
        instruction.resolve([], path.join(directory, "sub", "file.ts"), MessageID.make(messageID))
      expect((yield* nested("msg_before")).map((item) => item.filepath)).toEqual([
        path.join(directory, "sub", "AGENTS.md"),
      ])

      const acme = yield* store.createNamespace({ name: "Acme", folder: yield* folderFor("Acme") })
      yield* store.setProject(before.project.key, { namespace: acme.id })
      const after = yield* prompts.preview({ agent: "build" })
      expect(after.namespace.id).toBe(acme.id)
      expect(after.system[0]).not.toContain("Instructions from:")
      // Its profiles leave the Instructions layer out; no section's text differs from OpenCode's.
      expect(after.sections.some((item) => item.layer.endsWith("generated.instructions"))).toBe(false)
      expect(after.sections.filter((item) => item.parity === "differs")).toEqual([])
      expect(yield* instruction.system()).toEqual([])
      expect(yield* nested("msg_after")).toEqual([])
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
