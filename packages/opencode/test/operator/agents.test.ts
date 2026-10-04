import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import matter from "gray-matter"
import { Cause, Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { ConfigAgent } from "@/config/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { OperatorAgents } from "@/operator/agents"
import { Session } from "@/session/session"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      OperatorAgents.node,
      Agent.node,
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Database.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [Npm.node, NpmTest.noop],
    ],
  ),
)

const read = (file: string) => Effect.promise(async () => matter(await fs.readFile(file, "utf8")))
const failure = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

it.instance("creating an agent writes a markdown file the agent loader reads", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const agents = yield* OperatorAgents.Service
    const home = path.join(directory, "homes", "docs")

    const file = yield* agents.create("project", "docs-writer", {
      description: "Writes docs",
      mode: "subagent",
      temperature: 0.3,
      home,
      prompt: "Write clear docs.",
      permission: { edit: "ask", bash: { "*": "deny", "git status": "allow" } },
    })

    expect(file).toBe(path.join(directory, ".opencode", "agents", "docs-writer.md"))
    const written = yield* read(file)
    expect(written.data).toEqual({
      description: "Writes docs",
      mode: "subagent",
      temperature: 0.3,
      home,
      permission: { edit: "ask", bash: { "*": "deny", "git status": "allow" } },
    })
    expect(written.content.trim()).toBe("Write clear docs.")
    const loaded = yield* Effect.promise(() => ConfigAgent.load(path.join(directory, ".opencode")))
    expect(loaded["docs-writer"]).toMatchObject({
      description: "Writes docs",
      mode: "subagent",
      prompt: "Write clear docs.",
    })
    expect(yield* Effect.promise(() => fs.stat(home).then((stat) => stat.isDirectory()))).toBe(true)
  }),
)

it.instance("names must be file-safe and unique", () =>
  Effect.gen(function* () {
    const agents = yield* OperatorAgents.Service
    expect(failure(yield* agents.create("project", "../escape", {}).pipe(Effect.exit))).toBeInstanceOf(
      OperatorAgents.InvalidError,
    )
    expect(failure(yield* agents.create("project", "build", {}).pipe(Effect.exit))).toBeInstanceOf(
      OperatorAgents.ConflictError,
    )
  }),
)

it.instance(
  "editing a file agent rewrites its file; reset settings are removed and the prompt is kept",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const agents = yield* OperatorAgents.Service
      const file = path.join(directory, ".opencode", "agents", "reviewer.md")

      expect(
        yield* agents.update("project", "reviewer", { description: "Reviews carefully", reset: ["temperature"] }),
      ).toBe(file)
      const written = yield* read(file)
      expect(written.data).toEqual({ description: "Reviews carefully", mode: "subagent" })
      expect(written.content.trim()).toBe("Review the diff.")
    }),
  {
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode", "agents"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode", "agents", "reviewer.md"),
          "---\ndescription: Reviews diffs\nmode: subagent\ntemperature: 0.1\n---\nReview the diff.\n",
        )
      }),
  },
)

it.instance("editing a built-in agent writes overrides into the scope's config", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const agents = yield* OperatorAgents.Service

    const file = yield* agents.update("project", "build", {
      temperature: 0.2,
      home: path.join(directory, "work"),
      promptProfile: { mode: "custom", generated: ["instructions"] },
    })

    expect(file).toBe(path.join(directory, ".opencode", "opencode.jsonc"))
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))).toEqual({
      agent: {
        build: {
          temperature: 0.2,
          home: path.join(directory, "work"),
          promptProfile: { mode: "custom", generated: ["instructions"] },
        },
      },
    })
    // The key is known to the agent schema, so it is not sent to the model provider as an option.
    yield* agents.update("project", "build", { reset: ["promptProfile"] })
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).agent.build.promptProfile).toBeUndefined()
  }),
)

it.instance(
  "deleting removes a file agent; built-in agents can only be turned off",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const agents = yield* OperatorAgents.Service
      const file = path.join(directory, ".opencode", "agents", "scratch.md")

      expect(yield* agents.remove("project", "scratch")).toBe(file)
      expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      expect(failure(yield* agents.remove("project", "plan").pipe(Effect.exit))).toBeInstanceOf(
        OperatorAgents.InvalidError,
      )
      expect(failure(yield* agents.remove("project", "missing").pipe(Effect.exit))).toBeInstanceOf(
        OperatorAgents.NotFoundError,
      )
    }),
  {
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode", "agents"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode", "agents", "scratch.md"),
          "---\nmode: subagent\n---\nTemp.\n",
        )
      }),
  },
)

it.instance(
  "an agent's home folder is listed and never sent to the provider as an option",
  () =>
    Effect.gen(function* () {
      const listed = (yield* (yield* OperatorAgents.Service).list()).find((agent) => agent.name === "docs")
      const agent = yield* (yield* Agent.Service).get("docs")

      expect(listed?.home).toBe("/srv/docs")
      expect(agent?.options).toEqual({})
    }),
  { config: { agent: { docs: { mode: "subagent", home: "/srv/docs" } } } },
)

it.instance(
  "turned-off agents stay listed so they can be turned back on",
  () =>
    Effect.gen(function* () {
      const listed = (yield* (yield* OperatorAgents.Service).list()).find((agent) => agent.name === "explore")
      expect(listed).toMatchObject({ name: "explore", disabled: true })
    }),
  { config: { agent: { explore: { disable: true } } } },
)
