import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import matter from "gray-matter"
import { Cause, Effect, Exit, Layer } from "effect"
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
import { Global } from "@opencode-ai/core/global"
import { OperatorAgents } from "@/operator/agents"
import { OperatorProfileStore } from "@/operator/profile-store"
import { OperatorProjectConfig } from "@/operator/project-config"
import { Session } from "@/session/session"
import { NpmTest } from "../fake/npm"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Project writes copy the namespace's config only with consent (project-config.ts): these tests give it.
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([
        OperatorAgents.node,
        OperatorProfileStore.node,
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
    Layer.succeed(OperatorProjectConfig.Consent, true),
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

it.instance("creating an agent as a config entry writes agent.<name> into the scope's config", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const agents = yield* OperatorAgents.Service

    const file = yield* agents.create(
      "project",
      "reviewer",
      { description: "Reviews diffs", mode: "subagent", prompt: "Review the diff." },
      "config",
    )

    expect(file).toBe(path.join(directory, ".opencode", "opencode.jsonc"))
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))).toMatchObject({
      agent: { reviewer: { description: "Reviews diffs", mode: "subagent", prompt: "Review the diff." } },
    })
    expect(
      yield* Effect.promise(() => Bun.file(path.join(directory, ".opencode", "agents", "reviewer.md")).exists()),
    ).toBe(false)
  }),
)

it.instance(
  "an agent's prompt comes from its agent file, a config file, OpenCode's definition, or nowhere",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const agents = yield* OperatorAgents.Service

      expect(yield* agents.promptOrigin("reviewer")).toEqual({
        kind: "file",
        path: path.join(directory, ".opencode", "agents", "reviewer.md"),
      })
      expect(yield* agents.promptOrigin("helper")).toEqual({
        kind: "config",
        path: path.join(directory, ".opencode", "opencode.jsonc"),
      })
      expect(yield* agents.promptOrigin("explore")).toEqual({ kind: "builtin" })
      expect(yield* agents.promptOrigin("build")).toEqual({ kind: "none" })
    }),
  {
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode", "agents"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode", "agents", "reviewer.md"),
          "---\nmode: subagent\n---\nReview the diff.\n",
        )
        await fs.writeFile(
          path.join(directory, ".opencode", "opencode.jsonc"),
          JSON.stringify({ agent: { helper: { mode: "subagent", prompt: "Help out." } } }),
        )
      }),
  },
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

    const file = yield* agents.update("project", "build", { temperature: 0.2, home: path.join(directory, "work") })

    expect(file).toBe(path.join(directory, ".opencode", "opencode.jsonc"))
    expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))).toMatchObject({
      agent: { build: { temperature: 0.2, home: path.join(directory, "work") } },
    })
  }),
)

it.instance("an agent's home folder must be inside its project", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const agents = yield* OperatorAgents.Service

    const outside = yield* agents
      .update("project", "build", { home: path.join(path.dirname(directory), "elsewhere") })
      .pipe(Effect.flip)
    expect(outside.message).toContain("must be inside it")
    expect(yield* agents.update("project", "build", { home: "notes" })).toBe(
      path.join(directory, ".opencode", "opencode.jsonc"),
    )
    expect(yield* Effect.promise(() => fs.stat(path.join(directory, "notes")).then((stat) => stat.isDirectory()))).toBe(
      true,
    )
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

// Save in (agent_form_spec.md §1, capability_scopes_spec.md §11): an agent of a whole namespace is a file in the
// namespace folder's `.opencode`, and can't use the Small model; Global has no namespace folder of its own.
const withConfig = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body(dir),
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
        }),
    )
  })

it.instance("an agent saved in a namespace goes in its folder's .opencode; it can't use the Small model", () =>
  withConfig(() =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const agents = yield* OperatorAgents.Service
      const store = yield* OperatorProfileStore.Service
      const folder = path.join(directory, "namespaces", "acme")
      const acme = yield* store.createNamespace({ name: "Acme", folder })
      yield* store.setProject(directory, { namespace: acme.id })

      const file = yield* agents.create("namespace", "scout", { description: "Scouts", prompt: "Scout ahead." })
      expect(file).toBe(path.join(folder, ".opencode", "agents", "scout.md"))
      const written = yield* read(file)
      expect(written.data).toEqual({ description: "Scouts" })
      expect(written.content.trim()).toBe("Scout ahead.")
      // No home made in this project for it: each project has its own.
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(directory, "agents")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      const small = failure(yield* agents.create("namespace", "cheap", { modelSource: "small" }).pipe(Effect.exit))
      expect(small).toBeInstanceOf(OperatorAgents.InvalidError)
      expect((small as Error).message).toContain("Small model")
    }),
  ),
)

it.instance(
  "each agent says where it is defined: built in, this project's file or config",
  () =>
    Effect.gen(function* () {
      const listed = yield* (yield* OperatorAgents.Service).list()
      const level = (name: string) => listed.find((agent) => agent.name === name)?.level
      expect(level("build")).toEqual({ kind: "builtin" })
      expect(level("reviewer")).toEqual({ kind: "project" })
      expect(level("helper")).toEqual({ kind: "project" })
    }),
  {
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode", "agents"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode", "agents", "reviewer.md"),
          "---\nmode: subagent\n---\nReview.\n",
        )
        await fs.writeFile(
          path.join(directory, ".opencode", "opencode.jsonc"),
          JSON.stringify({ agent: { helper: { mode: "subagent", prompt: "Help out." } } }),
        )
      }),
  },
)

it.instance(
  "an agent moves to another project: its file goes there with its prompt setting, and leaves here",
  () =>
    withConfig(() =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const agents = yield* OperatorAgents.Service
        const store = yield* OperatorProfileStore.Service
        const other = path.join(directory, "other")
        yield* Effect.promise(() => fs.mkdir(other, { recursive: true }))
        yield* store.setProject(directory, {})
        yield* store.setProject(other, {})
        yield* store.setAgent(directory, "reviewer", { profile: "opencode:profile.opencode" })

        // Not to a folder that isn't a project, nor over an agent of the same name.
        const refused = failure(yield* agents.move("reviewer", path.join(directory, "nowhere")).pipe(Effect.exit))
        expect(refused).toBeInstanceOf(OperatorAgents.InvalidError)
        expect(failure(yield* agents.move("build", other).pipe(Effect.exit))).toBeInstanceOf(
          OperatorAgents.InvalidError,
        )

        const moved = yield* agents.move("reviewer", other)
        expect(moved).toEqual({
          path: path.join(other, ".opencode", "agents", "reviewer.md"),
          from: { kind: "project" },
        })
        const written = yield* read(moved.path)
        expect(written.data).toEqual({ description: "Reviews diffs", mode: "subagent" })
        expect(written.content.trim()).toBe("Review the diff.")
        const source = path.join(directory, ".opencode", "agents", "reviewer.md")
        expect(
          yield* Effect.promise(() =>
            fs.stat(source).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(yield* store.agent(other, "reviewer")).toEqual({ profile: "opencode:profile.opencode" })

        // A config agent becomes a file there, and its entry goes.
        const entry = yield* agents.move("helper", other)
        expect((yield* read(entry.path)).content.trim()).toBe("Help out.")
        const config = yield* Effect.promise(() =>
          fs.readFile(path.join(directory, ".opencode", "opencode.jsonc"), "utf8"),
        )
        expect(config).not.toContain("Help out.")
      }),
    ),
  {
    init: (directory) =>
      Effect.promise(async () => {
        await fs.mkdir(path.join(directory, ".opencode", "agents"), { recursive: true })
        await fs.writeFile(
          path.join(directory, ".opencode", "agents", "reviewer.md"),
          "---\ndescription: Reviews diffs\nmode: subagent\n---\nReview the diff.\n",
        )
        await fs.writeFile(
          path.join(directory, ".opencode", "opencode.jsonc"),
          JSON.stringify({ agent: { helper: { mode: "subagent", prompt: "Help out." } } }),
        )
      }),
  },
)
