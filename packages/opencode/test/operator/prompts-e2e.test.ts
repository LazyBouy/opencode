import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorPrompts } from "@/operator/prompts"
import { OperatorPromptText } from "@/operator/prompt-text"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { configure, replacements, root, send, session } from "../merge/harness"

const it = testEffect(
  LayerNode.compile(LayerNode.group([root, OperatorPrompts.node, OperatorProfileStore.node]), replacements),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const DEFAULT_BASE = OperatorPromptText.BUILTINS.find((item) => item.id === "base.default")!.text

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

// Points the global config folder (where profile/ lives) inside the test project for one test.
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
        }),
    )
  })

unix("build sends the base prompt, then capabilities, the environment and AGENTS.md; the preview matches", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      yield* write(path.join(directory, "AGENTS.md"), "Use Bun for everything.\n")
      yield* write(path.join(global, "identity", "voice.md"), "Be brief.\n")
      // Scoped to this project, which built-in agents do not belong to.
      yield* write(path.join(directory, ".opencode", "identity", "repo.md"), "Repo agents only.\n")
      yield* llm.text("ok")

      yield* send((yield* session()).id, "hello", "build")
      const sent = systemMessages((yield* llm.inputs)[0])
      const preview = yield* (yield* OperatorPrompts.Service).preview({ agent: "build" })

      expect(sent).toEqual([...preview.system])
      expect(preview.project.key).toBe("opencode")
      expect(preview.profile.id).toBe("default")
      expect(preview.sections.map((item) => [item.groupName, item.layerName])).toEqual([
        ["Purpose", "base.default"],
        ["Identity", "voice"],
        ["Capabilities", "Skills"],
        ["Environment", "Environment"],
        ["Project instructions", "Instructions"],
      ])
      expect(preview.sections.filter((item) => item.mandatory).map((item) => item.entry)).toEqual(["purpose.goal"])
      expect(sent).toHaveLength(2)
      expect(sent[0]).toBe(`${DEFAULT_BASE}\nBe brief.`)
      expect(String(sent[1])).toStartWith("Skills provide specialized instructions")
      expect(String(sent[1])).toContain("Use Bun for everything.")
      expect(JSON.stringify(sent)).not.toContain("Repo agents only.")
    }),
  ),
)

unix("an agent with its own prompt sends the base prompt in Purpose and its prompt in Identity", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      yield* llm.text("ok")

      yield* send((yield* session()).id, "hello", "explore")
      const sent = systemMessages((yield* llm.inputs)[0])
      const preview = yield* (yield* OperatorPrompts.Service).preview({ agent: "explore" })

      expect(sent).toEqual([...preview.system])
      expect(String(sent[0])).toStartWith(DEFAULT_BASE)
      expect(preview.sections.find((item) => item.layer === "slot.agent")?.groupName).toBe("Identity")
    }),
  ),
)

unix("title generation sends the base prompt before the title prompt; the preview matches", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { llm } = yield* configure()
      yield* llm.text("ok")
      yield* llm.text("A short title")

      const created = yield* (yield* Session.Service).create({})
      yield* send(created.id, "hello", "build")
      const server = yield* TestLLMServer
      const titled = yield* Effect.gen(function* () {
        const found = (yield* server.inputs).find((input) => JSON.stringify(input).includes("Generate a title"))
        if (!found) return yield* Effect.fail("not yet")
        return found
      }).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }), Effect.orDie)
      const preview = yield* (yield* OperatorPrompts.Service).preview({ agent: "title" })

      expect(preview.profile.id).toBe("helper")
      expect(systemMessages(titled)).toEqual([...preview.system])
      expect(String(preview.system[0])).toStartWith(DEFAULT_BASE)
    }),
  ),
)

unix("a project agent gets its project's goal instead of the base prompt", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      yield* write(path.join(directory, ".opencode", "agent", "triage.md"), "---\nmode: primary\n---\nTriage issues.\n")
      const prompts = yield* OperatorPrompts.Service
      const project = (yield* prompts.preview({ agent: "triage" })).project.key
      expect(project).not.toBe("opencode")
      yield* write(
        path.join(global, "profile", "layers", "goal.md"),
        `---\nname: Goal\nsection: purpose\npurpose: goal\nprojects:\n  - ${project}\n---\nShip the release this week.\n`,
      )
      yield* llm.text("ok")

      yield* send((yield* session()).id, "hello", "triage")
      const sent = systemMessages((yield* llm.inputs)[0])
      const preview = yield* prompts.preview({ agent: "triage" })

      expect(sent).toEqual([...preview.system])
      expect(sent[0]).toBe("Ship the release this week.\nTriage issues.")
      expect(preview.sections.find((item) => item.layer === "goal")?.mandatory).toBe(true)
    }),
  ),
)

unix("a goal, a role layer in a group and the project's default profile reach a real request", () =>
  withGlobal(() =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure()
      yield* write(path.join(directory, ".opencode", "agent", "triage.md"), "---\nmode: primary\n---\nTriage issues.\n")
      const prompts = yield* OperatorPrompts.Service
      const store = yield* OperatorProfileStore.Service
      const project = (yield* prompts.preview({ agent: "triage" })).project.key

      yield* store.saveLayer(undefined, {
        name: "Release goal",
        section: "purpose",
        purpose: "goal",
        projects: [project],
        text: "Ship the release.",
      })
      const role = yield* store.saveLayer(undefined, {
        name: "Reviewer",
        section: "role",
        projects: "*",
        text: "You review release notes.",
      })
      const group = yield* store.saveGroup(undefined, {
        name: "Release roles",
        type: "role",
        projects: "*",
        layers: [role.id],
      })
      const profile = yield* store.saveProfile(undefined, {
        name: "Release",
        projects: "*",
        groups: ["builtin.purpose", group.id, "builtin.identity", "builtin.instructions"],
      })
      yield* store.saveDefaults({ projects: { [project]: profile.id } })
      yield* llm.text("ok")

      yield* send((yield* session()).id, "hello", "triage")
      const sent = systemMessages((yield* llm.inputs)[0])
      const preview = yield* prompts.preview({ agent: "triage" })

      expect(sent).toEqual([...preview.system])
      expect(preview.profile).toEqual({ id: "release", name: "Release" })
      expect(sent[0]).toBe("Ship the release.\nYou review release notes.\nTriage issues.")
      // `build` belongs to OpenCode, so this project's default and goal do not reach it.
      expect((yield* prompts.preview({ agent: "build" })).profile.id).toBe("default")
    }),
  ),
)

unix("overrides and the legacy switches change what the model receives", () =>
  withGlobal((global) =>
    Effect.gen(function* () {
      const { directory, llm } = yield* configure({ prompts: { environment: false, skills: false } })
      yield* write(
        path.join(global, "profile", "layers", "terse.md"),
        "---\nname: Terse\nsection: base\noverrides: base.default\nprojects:\n  - opencode\n---\nYou are a test assistant.\n",
      )
      yield* write(path.join(directory, ".opencode", "prompts", "tool.read.md"), "Reads a file, briefly.\n")
      yield* llm.text("ok")

      yield* send((yield* session()).id, "hello", "build")
      const input = (yield* llm.inputs)[0]
      const system = JSON.stringify(systemMessages(input))

      expect(system).toContain("You are a test assistant.")
      expect(system).not.toContain(JSON.stringify(DEFAULT_BASE.slice(0, 60)).slice(1, -1))
      expect(system).not.toContain("<env>")
      expect(system).not.toContain("available_skills")
      expect(toolDescription(input, "read")).toBe("Reads a file, briefly.")

      const preview = yield* (yield* OperatorPrompts.Service).preview({ agent: "build" })
      expect(systemMessages(input)).toEqual([...preview.system])
      expect(preview.sections[0]).toMatchObject({ layer: "terse", overrides: "base.default" })
    }),
  ),
)

unix("the catalog lists every built-in prompt with this project's overrides", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const prompts = yield* OperatorPrompts.Service
    yield* prompts.write("project", "reminder.plan", "Plan only.")

    const catalog = yield* prompts.catalog()
    expect(catalog.prompts.find((item) => item.id === "reminder.plan")).toMatchObject({ project: "Plan only." })
    expect(catalog.prompts.find((item) => item.id === "base.kimi")?.builtin).toContain("You are OpenCode")
    expect(catalog.tools.some((tool) => tool.id === "read" && tool.builtin.length > 0)).toBe(true)
    expect(
      yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".opencode", "prompts", "reminder.plan.md"), "utf8"),
      ),
    ).toBe("Plan only.\n")
    expect(yield* prompts.write("project", "not-a-prompt", "x").pipe(Effect.flip)).toBeInstanceOf(
      OperatorPrompts.NotFoundError,
    )
  }),
)
