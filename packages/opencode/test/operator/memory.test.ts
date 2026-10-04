import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { OperatorMemory } from "@/operator/memory"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, session } from "../merge/harness"

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorMemory.node]), replacements))

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

it.instance("lists every file added to prompts, with how it is loaded", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure()
    yield* write(path.join(directory, "AGENTS.md"), "Use Bun.\n")
    yield* write(path.join(directory, "packages", "web", "AGENTS.md"), "Use Solid.\n")
    yield* write(path.join(directory, "node_modules", "dep", "AGENTS.md"), "Ignored.\n")
    yield* write(path.join(directory, "CLAUDE.md"), "Shadowed by AGENTS.md.\n")
    yield* write(path.join(directory, "packages", "web", "CLAUDE.md"), "Shadowed too.\n")
    yield* write(path.join(directory, "packages", "api", "CLAUDE.md"), "Used here.\n")
    yield* write(path.join(directory, ".opencode", "identity", "voice.md"), "Be brief.\n")
    yield* write(path.join(directory, ".opencode", "prompts", "reminder.plan.md"), "Plan only.\n")

    const overview = yield* (yield* OperatorMemory.Service).overview()
    const found = (file: string) => overview.files.find((item) => item.path === file)

    expect(found(path.join(directory, "AGENTS.md"))).toMatchObject({
      kind: "instructions",
      scope: "project",
      loaded: "always",
      editable: true,
      size: 9,
    })
    expect(found(path.join(directory, "packages", "web", "AGENTS.md"))).toMatchObject({
      kind: "nested",
      loaded: "when-reading",
    })
    expect(found(path.join(directory, "node_modules", "dep", "AGENTS.md"))).toBeUndefined()
    expect(found(path.join(directory, "CLAUDE.md"))?.loaded).toBe("never")
    expect(found(path.join(directory, "packages", "web", "CLAUDE.md"))?.loaded).toBe("never")
    expect(found(path.join(directory, "packages", "api", "CLAUDE.md"))?.loaded).toBe("when-reading")
    expect(found(path.join(directory, ".opencode", "identity", "voice.md"))?.kind).toBe("identity")
    expect(found(path.join(directory, ".opencode", "prompts", "reminder.plan.md"))?.kind).toBe("prompt")
    expect(overview.creatable.map((item) => item.scope)).not.toContain("project")
  }),
)

it.instance("reports the database with a count for every table", () =>
  Effect.gen(function* () {
    yield* configure()
    yield* session()
    const overview = yield* (yield* OperatorMemory.Service).overview()

    expect(overview.database.path).toBeTruthy()
    expect(overview.database.tables.find((table) => table.name === "session")?.rows).toBeGreaterThanOrEqual(1)
    expect(overview.database.tables.map((table) => table.name)).toContain("message")
    expect(overview.summaries).toEqual([])
  }),
)

it.instance("reads and writes only memory files", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const memory = yield* OperatorMemory.Service
    const agents = path.join(directory, "AGENTS.md")

    expect((yield* memory.overview()).creatable).toContainEqual({ scope: "project", path: agents })
    expect(yield* memory.write(agents, "Created here.\n")).toEqual({ kind: "instructions", scope: "project" })
    expect(yield* memory.read(agents)).toBe("Created here.\n")

    const outside = yield* Effect.exit(memory.read(path.join(directory, "opencode.json")))
    expect(Exit.isFailure(outside)).toBe(true)
    const other = yield* Effect.exit(memory.write(path.join(directory, "notes.md"), "no"))
    expect(Exit.isFailure(other)).toBe(true)
  }),
)
