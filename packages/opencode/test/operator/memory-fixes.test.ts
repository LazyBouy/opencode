import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { OperatorMemory } from "@/operator/memory"
import { Instruction } from "@/session/instruction"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"
import { configure, replacements, root, send, session } from "../merge/harness"

// The fixes of memory_spec.md §11: an image read sends the nested instructions it records as loaded
// (§11.1); an @-mentioned file's nested instructions count as loaded for the session (§11.2); the Memory
// page says how an agent with a home loads instruction files (§11.4).

const it = testEffect(LayerNode.compile(LayerNode.group([root, OperatorMemory.node]), replacements))

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
)
const write = (file: string, text: string | Buffer) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

it.instance("an image read sends the nested instructions it records as loaded", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    yield* write(path.join(directory, "sub", "AGENTS.md"), "Nested rules\n")
    yield* write(path.join(directory, "sub", "pic.png"), PNG)
    yield* llm.tool("read", { filePath: path.join(directory, "sub", "pic.png") })
    yield* llm.text("ok")
    const id = (yield* session()).id
    yield* send(id, "look at the picture", "build")
    const messages = yield* (yield* Session.Service).messages({ sessionID: id })
    const read = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool" && part.tool === "read")
    expect(read?.type === "tool" && read.state.status === "completed").toBe(true)
    if (read?.type !== "tool" || read.state.status !== "completed") return
    expect(read.state.output).toContain("Image read successfully")
    expect(read.state.output).toContain("<system-reminder>")
    expect(read.state.output).toContain("Nested rules")
    expect(read.state.metadata?.loaded).toEqual([path.join(directory, "sub", "AGENTS.md")])
  }),
)

it.instance("an @-mentioned file's nested instructions count as loaded for the session", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    yield* write(path.join(directory, "sub", "AGENTS.md"), "Nested rules\n")
    yield* write(path.join(directory, "sub", "a.ts"), "export const a = 1\n")
    yield* llm.text("ok")
    const id = (yield* session()).id
    yield* (yield* SessionPrompt.Service).prompt({
      sessionID: id,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
      parts: [
        { type: "text", text: "look at this" },
        {
          type: "file",
          mime: "text/plain",
          filename: "a.ts",
          url: pathToFileURL(path.join(directory, "sub", "a.ts")).href,
        },
      ],
    })
    const messages = yield* (yield* Session.Service).messages({ sessionID: id })
    const mentioned = messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "text" && part.synthetic && Array.isArray(part.metadata?.loaded))
    expect(mentioned?.type === "text" ? mentioned.metadata?.loaded : undefined).toEqual([
      path.join(directory, "sub", "AGENTS.md"),
    ])
    // A later read under the same folder doesn't attach them again.
    const again = yield* (yield* Instruction.Service).resolve(
      messages,
      path.join(directory, "sub", "b.ts"),
      MessageID.make("msg_later"),
    )
    expect(again).toEqual([])
  }),
)

it.instance("the Memory page loads instruction files from an agent's home, nested ones only below it", () =>
  Effect.gen(function* () {
    const { directory } = yield* configure({ agent: { docs: { home: "agents/docs/" } } })
    yield* write(path.join(directory, "AGENTS.md"), "Root rules\n")
    yield* write(path.join(directory, "agents", "docs", "AGENTS.md"), "Docs rules\n")
    yield* write(path.join(directory, "agents", "docs", "guides", "AGENTS.md"), "Guide rules\n")
    yield* write(path.join(directory, "packages", "web", "AGENTS.md"), "Web rules\n")
    const memory = yield* OperatorMemory.Service
    const loadedOf = (files: ReadonlyArray<{ path: string; loaded: string }>, file: string) =>
      files.find((item) => item.path === path.join(directory, ...file.split("/")))?.loaded
    const project = (yield* memory.overview()).files
    expect(loadedOf(project, "AGENTS.md")).toBe("always")
    expect(loadedOf(project, "packages/web/AGENTS.md")).toBe("when-reading")
    const docs = (yield* memory.overview("docs")).files
    expect(loadedOf(docs, "agents/docs/AGENTS.md")).toBe("always")
    expect(loadedOf(docs, "AGENTS.md")).toBe("always")
    expect(loadedOf(docs, "agents/docs/guides/AGENTS.md")).toBe("when-reading")
    expect(loadedOf(docs, "packages/web/AGENTS.md")).toBe("never")
  }),
)
