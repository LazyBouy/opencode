import fs from "fs/promises"
import path from "path"
import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { OperatorHelperFiles } from "@/operator/helper-files"
import { OperatorHelperRuns } from "@/operator/helper-runs"
import { OperatorHelperTriggerRules as Rules } from "@/operator/helper-trigger-rules"
import { OperatorHelperTriggers } from "@/operator/helper-triggers"
import { OperatorHelpers } from "@/operator/helpers"
import { OperatorProfileStore } from "@/operator/profile-store"
import { GlobalBus } from "@/bus/global"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { configure, replacements, root } from "../merge/harness"

// Helper triggers (agent_types_spec.md §4.9; the user's choices of 2026-10-13): schedules in a saved time zone, a
// missed schedule run once, untouched sessions in batches, an agent's finished turn and a new project; one run at a
// time, at most its runs an hour, and "Pause all triggers".

const trigger = (on: OperatorHelperFiles.Trigger["on"], extra: Partial<OperatorHelperFiles.Trigger> = {}) =>
  ({ id: "", on, enabled: true, ...extra }) as OperatorHelperFiles.Trigger

test("triggers are checked, and a schedule is due in its own time zone", () => {
  let n = 0
  const made = () => `t${++n}`
  const [daily, weekly, hourly, cron, old] = Rules.check(
    [
      trigger("daily", { at: "03:00", tz: "Europe/Berlin", days: 9 }),
      trigger("weekly", { at: "03:00", day: 1, tz: "Europe/Berlin" }),
      trigger("hourly", { minute: 15, tz: "UTC" }),
      trigger("cron", { cron: "30 2 * * 1-5", tz: "UTC", input: "  Be brief.  " }),
      trigger("session.untouched", { days: 365, at: "01:00" }),
    ],
    made,
  )
  // Ids made; only the fields a kind uses are kept; the runs an hour default to 20.
  expect([daily!.id, weekly!.id]).toEqual(["t1", "t2"])
  expect(daily).toEqual({ id: "t1", on: "daily", enabled: true, at: "03:00", tz: "Europe/Berlin", maxPerHour: 20 })
  expect(cron!.input).toBe("Be brief.")
  expect(old).toEqual({ id: "t5", on: "session.untouched", enabled: true, days: 365, maxPerHour: 20 })
  // An id given is kept; a repeated one is made again.
  expect(
    Rules.check([trigger("session.turn", { id: "abc" }), trigger("session.turn", { id: "abc" })], made).map(
      (item) => item.id,
    ),
  ).toEqual(["abc", "t6"])

  // Monday 03:00 in Berlin (summer time) is 01:00 UTC.
  expect(new Date(Rules.nextAt(weekly!, Date.parse("2026-10-13T12:00:00Z"))!).toISOString()).toBe(
    "2026-10-19T01:00:00.000Z",
  )
  expect(new Date(Rules.nextAt(hourly!, Date.parse("2026-10-13T12:20:00Z"))!).toISOString()).toBe(
    "2026-10-13T13:15:00.000Z",
  )
  expect(Rules.describe(weekly!)).toBe("weekly on Monday at 03:00 (Europe/Berlin)")
  expect(Rules.describe(old!)).toBe("sessions untouched for 365 days")

  for (const [wrong, message] of [
    [trigger("daily", { at: "03:00" }), "needs its time zone"],
    [trigger("daily", { at: "3am", tz: "UTC" }), "HH:MM"],
    [trigger("cron", { cron: "0 3 * *", tz: "UTC" }), "5 fields"],
    [trigger("daily", { at: "03:00", tz: "Mars/Base" }), "time zone"],
    [trigger("session.untouched", {}), "days"],
    [trigger("session.turn", { maxPerHour: 0 }), "runs an hour"],
  ] as const)
    expect(() => Rules.check([wrong], made)).toThrow(message)
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      root,
      OperatorProfileStore.node,
      OperatorHelpers.node,
      OperatorHelperRuns.node,
      OperatorHelperTriggers.node,
    ]),
    [...replacements, [InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

// The global config folder (where namespaces/ lives) inside the test project, for one test.
const withGlobal = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = path.join((yield* TestInstance).directory, "global-config")
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = { config: Global.Path.config, roots: process.env.OPENCODE_WORKSPACE_ROOTS }
        ;(Global.Path as { config: string }).config = dir
        process.env.OPENCODE_WORKSPACE_ROOTS = path.dirname(dir)
        return previous
      }),
      () => body,
      (previous) =>
        Effect.sync(() => {
          ;(Global.Path as { config: string }).config = previous.config
          if (previous.roots === undefined) delete process.env.OPENCODE_WORKSPACE_ROOTS
          else process.env.OPENCODE_WORKSPACE_ROOTS = previous.roots
        }),
    )
  })

// The test project as a project of OpenCode's namespace (its default project), and a helper without actions.
const setup = (name: string, triggers: OperatorHelperFiles.Trigger[]) =>
  Effect.gen(function* () {
    const { llm } = yield* configure()
    const { directory } = yield* TestInstance
    // The helper settings are server-wide: not paused by an earlier test.
    yield* (yield* OperatorHelperRuns.Service).setSettings({ runDays: 30, triggersPaused: false })
    yield* (yield* OperatorProfileStore.Service).setProject(directory, {})
    yield* (yield* OperatorHelpers.Service).create("opencode", {
      name,
      model: { source: "default" },
      text: "Do what the trigger says.",
      triggers,
    })
    return { llm, directory }
  })

const runsOf = (name: string) =>
  Effect.gen(function* () {
    yield* (yield* OperatorHelperTriggers.Service).idle()
    return yield* (yield* OperatorHelperRuns.Service).runs("opencode", name)
  })

// Runs started from a listener (a new project) begin a moment later.
const waitForRuns = (name: string, count: number) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 100; tries++) {
      const found = yield* runsOf(name)
      if (found.length >= count && found.every((run) => run.status !== "running")) return found
      yield* Effect.sleep("50 millis")
    }
    return yield* runsOf(name)
  })

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

unix("a schedule starts its helper when due, once for missed starts, and not while paused", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm, directory } = yield* setup("nightly", [
        trigger("daily", { at: "03:00", tz: "UTC", input: "Tidy up." }),
      ])
      const triggers = yield* OperatorHelperTriggers.Service
      const runs = yield* OperatorHelperRuns.Service
      for (const text of ["one", "two", "three"]) yield* llm.text(text)
      const t0 = Date.parse("2026-01-01T12:00:00Z")

      // First seen: it starts afresh; nothing runs.
      yield* triggers.check(t0)
      expect(yield* runsOf("nightly")).toEqual([])
      // Due the next night: one run, started by its trigger, in the namespace's default project.
      yield* triggers.check(t0 + DAY)
      const [first] = yield* runsOf("nightly")
      expect(first).toMatchObject({
        status: "done",
        output: "one",
        project: directory,
        startedBy: { kind: "trigger", event: "daily at 03:00 (UTC)" },
      })
      expect(first!.input).toContain("Started by its trigger: daily at 03:00 (UTC).")
      expect(first!.input).toContain("Tidy up.")
      // The server was down for five nights: one run.
      yield* triggers.check(t0 + 6 * DAY)
      yield* triggers.check(t0 + 6 * DAY + 60_000)
      expect(yield* runsOf("nightly")).toHaveLength(2)

      // Paused: nothing starts, and what it missed doesn't run when it resumes.
      yield* runs.setSettings({ runDays: 30, triggersPaused: true })
      yield* triggers.check(t0 + 8 * DAY)
      yield* runs.setSettings({ runDays: 30, triggersPaused: false })
      yield* triggers.check(t0 + 8 * DAY + 60_000)
      expect(yield* runsOf("nightly")).toHaveLength(2)
      // Its status says when it is next due.
      const [status] = yield* triggers.status("opencode", "nightly")
      expect(new Date(status!.next!).toISOString()).toBe("2026-01-10T03:00:00.000Z")
      // Run now: at once, paused or not.
      yield* runs.setSettings({ runDays: 30, triggersPaused: true })
      expect(yield* triggers.fire({ namespace: "opencode", name: "nightly", id: status!.id })).toBe(true)
      const [manual] = yield* runsOf("nightly")
      expect(manual!.input).toContain("Started by hand (Run now)")
      expect(yield* runsOf("nightly")).toHaveLength(3)
    }),
  ),
)

unix("a trigger runs at most its runs an hour; more starts are skipped and counted", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm } = yield* setup("hourly", [trigger("hourly", { minute: 0, tz: "UTC", maxPerHour: 1 })])
      const triggers = yield* OperatorHelperTriggers.Service
      yield* llm.text("ok")
      const t0 = Date.parse("2026-01-01T12:30:00Z")
      yield* triggers.check(t0)
      yield* triggers.check(t0 + HOUR)
      yield* triggers.check(t0 + 2 * HOUR)
      expect(yield* runsOf("hourly")).toHaveLength(1)
      const [status] = yield* triggers.status("opencode", "hourly")
      expect(status!.skipped).toBe(1)
    }),
  ),
)

unix("sessions untouched for N days go to one run, each once", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm } = yield* setup("archiver", [trigger("session.untouched", { days: 30 })])
      const triggers = yield* OperatorHelperTriggers.Service
      const sessions = yield* Session.Service
      const db = (yield* Database.Service).db
      yield* llm.text("archived")
      const old = yield* sessions.create({ title: "Old work" })
      const fresh = yield* sessions.create({ title: "Fresh work" })
      const now = Date.now()
      yield* db
        .update(SessionTable)
        .set({ time_updated: now - 40 * DAY })
        .where(eq(SessionTable.id, old.id))
        .run()
        .pipe(Effect.orDie)

      yield* triggers.check(now)
      const [run] = yield* runsOf("archiver")
      expect(run!.input).toContain("last used more than 30 days ago")
      expect(run!.input).toContain(old.id)
      expect(run!.input).not.toContain(fresh.id)
      // Reported once: the next check (an hour on) has nothing new.
      yield* triggers.check(now + HOUR + 1000)
      expect(yield* runsOf("archiver")).toHaveLength(1)
    }),
  ),
)

unix("a finished turn starts its namespace's turn triggers; a new project starts its project triggers", () =>
  withGlobal(
    Effect.gen(function* () {
      const { llm, directory } = yield* setup("watcher", [
        trigger("session.turn", { input: "Note what happened." }),
        trigger("project.created"),
      ])
      const triggers = yield* OperatorHelperTriggers.Service
      const sessions = yield* Session.Service
      for (const text of ["noted", "welcomed", "seen"]) yield* llm.text(text)

      const chat = yield* sessions.create({ title: "Chat" })
      const child = yield* sessions.create({ title: "Sub", parentID: chat.id })
      yield* triggers.turn(child.id)
      expect(yield* runsOf("watcher")).toEqual([])
      yield* triggers.turn(chat.id)
      // Once, though session.idle and session.status both say so.
      yield* triggers.turn(chat.id)
      const [turned] = yield* runsOf("watcher")
      expect(turned).toMatchObject({
        project: directory,
        startedBy: { kind: "trigger", event: "an agent finished a turn" },
      })
      expect(turned!.input).toContain(`Session: ${chat.id} · Chat`)
      expect(turned!.input).toContain("Note what happened.")
      expect(yield* runsOf("watcher")).toHaveLength(1)

      // A new project of the namespace: the run is in it.
      const other = path.join(directory, "second")
      yield* Effect.promise(() => fs.mkdir(other, { recursive: true }))
      yield* (yield* OperatorProfileStore.Service).setProject(other, {})
      const runs = yield* waitForRuns("watcher", 2)
      expect(runs).toHaveLength(2)
      expect(runs[0]).toMatchObject({ project: other, startedBy: { event: "a project was created" } })
      expect(runs[0]!.input).toContain("Project: second")

      // The event itself: session.idle on the server's bus.
      const later = yield* sessions.create({ title: "Later chat" })
      GlobalBus.emit("event", { directory, payload: { type: "session.idle", properties: { sessionID: later.id } } })
      const after = yield* waitForRuns("watcher", 3)
      expect(after[0]!.input).toContain(`Session: ${later.id} · Later chat`)
    }),
  ),
)

unix("a helper with a wrong trigger isn't saved", () =>
  withGlobal(
    Effect.gen(function* () {
      yield* configure()
      const error = yield* (yield* OperatorHelpers.Service)
        .create("opencode", {
          name: "broken",
          model: { source: "default" },
          text: "x",
          triggers: [trigger("daily", { at: "25:00", tz: "UTC" })],
        })
        .pipe(Effect.flip)
      expect(error.message).toContain("HH:MM")
    }),
  ),
)
