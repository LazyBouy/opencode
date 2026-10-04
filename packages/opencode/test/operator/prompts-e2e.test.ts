import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorPrompts } from "@/operator/prompts"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorPrompts.node]), replacements))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

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

unix("the preview is exactly the system prompt that is sent", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    yield* write(path.join(directory, "AGENTS.md"), "Use Bun for everything.\n")
    yield* write(path.join(directory, ".opencode", "identity", "voice.md"), "Be brief.\n")
    yield* llm.text("ok")

    yield* send((yield* session()).id, "hello", "build")
    const preview = yield* (yield* OperatorPrompts.Service).preview({ agent: "build" })

    expect(systemMessages((yield* llm.inputs)[0])).toEqual([...preview.system])
    expect(preview.sections.map((item) => item.kind)).toEqual([
      "identity",
      "base",
      "environment",
      "instructions",
      "skills",
    ])
    expect(preview.base).toBe("base.default")
  }),
)

unix("overrides and switches change what the model receives", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure({ prompts: { environment: false, skills: false } })
    yield* write(path.join(directory, ".opencode", "prompts", "base.default.md"), "You are a test assistant.\n")
    yield* write(path.join(directory, ".opencode", "prompts", "tool.read.md"), "Reads a file, briefly.\n")
    yield* llm.text("ok")

    yield* send((yield* session()).id, "hello", "build")
    const input = (yield* llm.inputs)[0]
    const system = JSON.stringify(systemMessages(input))

    expect(system).toContain("You are a test assistant.")
    expect(system).not.toContain("You are OpenCode")
    expect(system).not.toContain("<env>")
    expect(system).not.toContain("available_skills")
    expect(toolDescription(input, "read")).toBe("Reads a file, briefly.")

    const preview = yield* (yield* OperatorPrompts.Service).preview({ agent: "build" })
    expect(systemMessages(input)).toEqual([...preview.system])
  }),
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
