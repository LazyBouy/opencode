import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { configure, send, session, unix } from "../merge/harness"

const systemText = (input: Record<string, unknown> | undefined) =>
  JSON.stringify(
    (Array.isArray(input?.messages) ? input.messages : []).filter(
      (message: { role?: string }) => message.role === "system",
    ),
  )

// Built-in agents belong to the OpenCode project, so a layer for them is a global one (all projects).
unix("identity layers reach the model's system prompt for the agents they name", () =>
  Effect.gen(function* () {
    const { directory, llm } = yield* configure()
    const previous = Global.Path.config
    ;(Global.Path as { config: string }).config = path.join(directory, "global-config")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previous
      }),
    )
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(Global.Path.config, "identity"), { recursive: true })
      await fs.writeFile(
        path.join(Global.Path.config, "identity", "voice.md"),
        "---\nagents: [build]\n---\nAlways answer like a pirate.\n",
      )
    })
    yield* llm.text("Arr")
    yield* llm.text("Plan")

    yield* send((yield* session()).id, "hello", "build")
    yield* send((yield* session()).id, "hello", "plan")

    const inputs = yield* llm.inputs
    expect(systemText(inputs[0])).toContain("Always answer like a pirate.")
    expect(systemText(inputs[1])).not.toContain("Always answer like a pirate.")
  }),
)
