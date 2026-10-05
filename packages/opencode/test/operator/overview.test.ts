import { expect } from "bun:test"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { OperatorOverview } from "@/operator/overview"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      OperatorOverview.node,
      Database.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

it.instance("lists a directory's sessions newest first, filtered by agent and title", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const sessions = yield* Session.Service
    const overview = yield* OperatorOverview.Service
    const build = yield* sessions.create({ title: "Fix the parser", agent: "build" })
    const plan = yield* sessions.create({ title: "Plan the release", agent: "plan" })

    expect((yield* overview.sessions({ directory })).map((session) => session.id)).toEqual([plan.id, build.id])
    expect((yield* overview.sessions({ directory, agent: "plan" })).map((session) => session.id)).toEqual([plan.id])
    expect((yield* overview.sessions({ directory, search: "parser" })).map((session) => session.id)).toEqual([build.id])
    expect((yield* overview.sessions({ directory, limit: 1 })).map((session) => session.id)).toEqual([plan.id])
  }),
)

it.instance("adds up sessions, tokens and cost by agent and by day", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const overview = yield* OperatorOverview.Service
    const { db } = yield* Database.Service
    const before = yield* overview.stats({ days: 7, offset: 0 })

    const first = yield* sessions.create({ title: "One", agent: "stats-agent" })
    yield* sessions.create({ title: "Two", agent: "stats-agent" })
    yield* db
      .update(SessionTable)
      .set({ cost: 1.25, tokens_input: 100, tokens_output: 40 })
      .where(eq(SessionTable.id, first.id))
      .run()
      .pipe(Effect.orDie)
    const after = yield* overview.stats({ days: 7, offset: 0 })

    expect(after.range.sessions - before.range.sessions).toBe(2)
    expect(after.range.cost - before.range.cost).toBeCloseTo(1.25)
    expect(after.range.tokens.input - before.range.tokens.input).toBe(100)
    expect(after.activeToday - before.activeToday).toBe(2)
    expect(after.agents.find((row) => row.agent === "stats-agent")).toMatchObject({ sessions: 2, cost: 1.25 })
    expect(after.days).toHaveLength(7)
    expect(after.days.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10))
    expect((after.days.at(-1)?.sessions ?? 0) - (before.days.at(-1)?.sessions ?? 0)).toBe(2)
    expect((after.days.at(-1)?.tokens ?? 0) - (before.days.at(-1)?.tokens ?? 0)).toBe(140)
  }),
)

it.instance(
  "lists projects with their session totals",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const overview = yield* OperatorOverview.Service
      const created = yield* sessions.create({ title: "Counted", agent: "build" })

      const project = (yield* overview.projects()).find((item) => item.id === created.projectID)
      expect(project?.sessions).toBeGreaterThanOrEqual(1)
      expect(project?.lastActivity).toBeGreaterThanOrEqual(created.time.updated)
      expect(project?.folder).toBeUndefined()
    }),
  { git: true },
)

it.instance("lists each folder outside git where sessions ran, not one shared project", () =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const sessions = yield* Session.Service
    const overview = yield* OperatorOverview.Service
    yield* sessions.create({ title: "Outside git", agent: "build" })

    const projects = yield* overview.projects()
    expect(projects.some((item) => item.worktree === "/")).toBe(false)
    const folder = projects.find((item) => item.worktree === directory)
    expect(folder).toMatchObject({ folder: true, global: false, name: path.basename(directory) })
    expect(folder?.sessions).toBeGreaterThanOrEqual(1)
  }),
)

it.effect("reports the server version and start time", () =>
  Effect.gen(function* () {
    const status = (yield* OperatorOverview.Service).status()
    expect(status.startedAt).toBeLessThanOrEqual(Date.now())
    expect(status.version.length).toBeGreaterThan(0)
  }),
)
