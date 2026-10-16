export * as OperatorHelperRuns from "./helper-runs"

import fs from "fs/promises"
import path from "path"
import { and, desc, eq, isNull, lt, not, like, or } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { OperatorFolderSql } from "./folder-sql"
import { OperatorGenerate } from "./generate"
import { OperatorHelperAgents } from "./helper-agents"
import { OperatorHelperFiles } from "./helper-files"
import { OperatorNotifications } from "./notifications"
import { OperatorPermissionEffective } from "./permission-effective"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"
import { OperatorRegistry } from "./registry"
import { OperatorTrash } from "./trash"

// Helper runs (agent_types_spec.md §4.5–4.7). A helper runs as its own agent (helper-agents.ts), unattended:
// - without actions, as one model call (as the fork's generators are: generate.ts);
// - with actions, in a hidden session of the project it serves: a child of the session that called it (so it is
//   never in Chats, and its cost counts with the caller's), marked `metadata.operator.kind = "helper-run"`. It may
//   do only what its helper declares (permission-live.ts), within its step limit, and is stopped at its time limit.
// Each run is recorded (its helper's Runs): who started it, its status, duration, cost and result, and its session.
// Runs older than the setting (30 days by default) are deleted, with their sessions.
// Agents call callable helpers of their namespace with the `helper` tool (helper-tool.ts), offered only where
// the namespace has one; a run's declared system actions are offered to it alone.

export const StartedBy = Schema.Struct({
  kind: Schema.Literals(["agent", "role", "layer", "trigger"]),
  agent: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  layer: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String).annotate({ description: "The trigger's id" }),
  event: Schema.optional(Schema.String).annotate({
    description: "The trigger in words: daily at 03:00 (Europe/Berlin), an agent finished a turn, …",
  }),
}).annotate({ identifier: "OperatorHelperRunStartedBy" })
export type StartedBy = typeof StartedBy.Type

export const Run = Schema.Struct({
  id: Schema.String,
  helper: Schema.String,
  namespace: Schema.String,
  project: Schema.String.annotate({ description: "The project it served" }),
  startedBy: StartedBy,
  status: Schema.Literals(["running", "done", "failed", "timeout", "cancelled"]),
  startedAt: Schema.Finite,
  endedAt: Schema.optional(Schema.Finite),
  cost: Schema.optional(Schema.Finite),
  input: Schema.String,
  output: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String).annotate({
    description: "Its session (a run with actions): its transcript",
  }),
}).annotate({ identifier: "OperatorHelperRun" })
export type Run = typeof Run.Type

export const Settings = Schema.Struct({
  runDays: Schema.Finite.annotate({ description: "Runs older than this many days are deleted, with their sessions" }),
  triggersPaused: Schema.optional(Schema.Boolean).annotate({
    description: "No trigger starts a helper while this is on (Run now still does); kept when not given",
  }),
}).annotate({ identifier: "OperatorHelperSettings" })
export type Settings = typeof Settings.Type
export const RUN_DAYS = { default: 30, min: 1, max: 3650 } as const

export class RunError extends Schema.TaggedErrorClass<RunError>()("OperatorHelperRunError", {
  message: Schema.String,
}) {}

// The system actions a run may declare, as tools (helper-tool.ts); memory is the memory tool.
export const ACTION_TOOLS = ["list_sessions", "archive_session", "trash_session", "notify"] as const
for (const tool of ["helper", ...ACTION_TOOLS]) OperatorPermissionEffective.declareOptIn(tool)

const root = () => path.join(Global.Path.data, "operator", "helper-runs")
const runFile = (run: Pick<Run, "namespace" | "helper" | "id">) =>
  path.join(root(), run.namespace, run.helper, `${run.id}.json`)
const settingsFile = () => path.join(root(), "settings.json")
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

async function writeRun(run: Run) {
  await fs.mkdir(path.dirname(runFile(run)), { recursive: true })
  await Bun.write(runFile(run), JSON.stringify(run, null, 2))
}

async function readRuns(dir: string): Promise<Run[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const runs = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) =>
        Bun.file(path.join(dir, name))
          .json()
          .catch(() => undefined),
      ),
  )
  return (runs.filter((run) => run && typeof run === "object") as Run[]).toSorted((a, b) => b.startedAt - a.startedAt)
}

export async function readSettings(): Promise<Settings> {
  const data = (await Bun.file(settingsFile())
    .json()
    .catch(() => undefined)) as Partial<Settings> | undefined
  const days = data?.runDays
  return {
    runDays: typeof days === "number" && days >= RUN_DAYS.min ? days : RUN_DAYS.default,
    triggersPaused: data?.triggersPaused === true,
  }
}

export interface Interface {
  /** Runs a helper of a namespace in this project. Its record is kept; a failure is recorded and returned. */
  readonly run: (input: {
    namespace: string
    name: string
    input: string
    startedBy: StartedBy
    /** The session it works for: its run's session is a child of it. */
    parentSessionID?: string
  }) => Effect.Effect<{ output: string; run: Run }, RunError>
  /** A helper's runs, newest first. */
  readonly runs: (namespace: string, name: string) => Effect.Effect<Run[]>
  readonly settings: () => Effect.Effect<Settings>
  readonly setSettings: (input: Settings) => Effect.Effect<Settings, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorHelperRuns") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const db = (yield* Database.Service).db
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const generate = yield* OperatorGenerate.Service
    const store = yield* OperatorProfileStore.Service
    const trash = yield* OperatorTrash.Service
    const instances = yield* InstanceStore.Service
    const fail = (message: string) => new RunError({ message })

    // Deletes runs older than the setting, with their sessions.
    const cleanup = Effect.fnUntraced(function* () {
      const { runDays } = yield* Effect.promise(readSettings)
      const cutoff = Date.now() - runDays * 24 * 60 * 60 * 1000
      const namespaces = yield* Effect.promise(() => fs.readdir(root()).catch(() => [] as string[]))
      for (const ns of namespaces) {
        const helpers = yield* Effect.promise(() => fs.readdir(path.join(root(), ns)).catch(() => [] as string[]))
        for (const helper of helpers) {
          const runs = yield* Effect.promise(() => readRuns(path.join(root(), ns, helper)))
          for (const run of runs.filter((item) => item.startedAt < cutoff && item.status !== "running")) {
            if (run.sessionID) yield* sessions.remove(SessionID.make(run.sessionID)).pipe(Effect.ignore)
            yield* Effect.promise(() => fs.rm(runFile(run), { force: true }))
          }
        }
      }
    })
    yield* cleanup().pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))

    // The model a helper uses here: picked, the default model, or the small model of the default provider.
    const modelFor = Effect.fnUntraced(function* (model: OperatorHelperFiles.Model) {
      if (model.source === "pick" && model.model?.includes("/")) {
        const at = model.model.indexOf("/")
        return yield* provider.getModel(
          ProviderV2.ID.make(model.model.slice(0, at)),
          ModelV2.ID.make(model.model.slice(at + 1)),
        )
      }
      const fallback = yield* provider.defaultModel()
      if (model.source === "small") {
        const small = yield* provider.getSmallModel(fallback.providerID)
        if (small) return small
      }
      return yield* provider.getModel(fallback.providerID, fallback.modelID)
    })

    const textOf = Effect.fnUntraced(function* (ns: string, stored: OperatorHelperFiles.Stored) {
      const catalog = yield* Effect.promise(() => OperatorProfileStore.readNamespace(ns))
      return catalog?.layers.find((item) => item.id === stored.layer)?.text ?? ""
    })

    const run = Effect.fn("OperatorHelperRuns.run")(function* (input: {
      namespace: string
      name: string
      input: string
      startedBy: StartedBy
      parentSessionID?: string
    }) {
      const ctx = yield* InstanceState.context
      const project = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      const stored = yield* Effect.promise(() => OperatorHelperFiles.readOne(input.namespace, input.name))
      if (!stored) return yield* fail(`No helper "${input.name}" in this namespace`)
      const agent = OperatorHelperAgents.agentName(input.namespace, input.name)
      const model = yield* modelFor(stored.model).pipe(Effect.mapError((error) => fail(String(error))))
      // Its agent: OpenCode's defaults (as its own hidden helpers have them), its text, model and step limit. What
      // a run may do is decided by its declared actions (permission-live.ts).
      const base = (yield* agents.get("title"))?.permission ?? []
      OperatorHelperAgents.register(agent, {
        profile: stored.profile,
        info: {
          name: agent,
          ...(stored.description ? { description: stored.description } : {}),
          mode: "subagent",
          hidden: true,
          native: false,
          permission: base,
          options: {},
          prompt: yield* textOf(input.namespace, stored),
          steps: stored.steps,
          model: { providerID: model.providerID, modelID: model.id },
          ...(stored.model.variant ? { variant: stored.model.variant } : {}),
        } satisfies Agent.Info,
      })

      const record: Run = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        helper: input.name,
        namespace: input.namespace,
        project,
        startedBy: input.startedBy,
        status: "running",
        startedAt: Date.now(),
        input: clip(input.input, 4000),
      }
      const finish = (patch: Partial<Run>) =>
        Effect.promise(async () => {
          const done: Run = { ...record, ...patch, endedAt: Date.now() }
          await writeRun(done)
          return done
        })
      const limit = `${stored.timeout} seconds` as const
      const actions = stored.actions ?? []

      // Without actions: one model call.
      if (!actions.length) {
        yield* Effect.promise(() => writeRun(record))
        const called = yield* generate
          .call({
            agent,
            prompt: input.input,
            purpose: `helper ${input.name} (${input.startedBy.kind})`,
            ...((input.parentSessionID ?? input.startedBy.sessionID)
              ? { startedFrom: input.parentSessionID ?? input.startedBy.sessionID }
              : {}),
          })
          .pipe(
            Effect.map(Option.some),
            Effect.raceFirst(Effect.sleep(limit).pipe(Effect.as(Option.none()))),
            Effect.catch((error) => Effect.fail(fail(error.message))),
            Effect.onInterrupt(() => finish({ status: "cancelled" }).pipe(Effect.asVoid)),
            Effect.tapError((error) => finish({ status: "failed", error: error.message })),
          )
        if (Option.isNone(called)) {
          yield* finish({ status: "timeout", error: `It took longer than ${stored.timeout} s` })
          return yield* fail(`The helper took longer than its time limit (${stored.timeout} s)`)
        }
        const done = yield* finish({ status: "done", output: clip(called.value.text, 8000), cost: called.value.cost })
        return { output: called.value.text, run: done }
      }

      // With actions: its own hidden session.
      const session = yield* sessions.create({
        ...(input.parentSessionID ? { parentID: SessionID.make(input.parentSessionID) } : {}),
        title: `${input.name} · helper run`,
        agent,
        metadata: { operator: { kind: "helper-run", helper: input.name, namespace: input.namespace, run: record.id } },
      })
      // Without a session it works for (a layer's preview), it is not a child of one: archived, it stays out of Chats.
      if (!input.parentSessionID) yield* sessions.setArchived({ sessionID: session.id, time: Date.now() })
      const started: Run = { ...record, sessionID: session.id }
      Object.assign(record, started)
      yield* Effect.promise(() => writeRun(record))
      OperatorHelperAgents.startRun(session.id, { agent, actions })
      const cancel = prompts.cancel(session.id).pipe(Effect.ignore)
      const result = yield* prompts
        .prompt({
          sessionID: session.id,
          agent,
          model: { providerID: model.providerID, modelID: model.id },
          ...(stored.model.variant ? { variant: stored.model.variant } : {}),
          parts: [{ type: "text", text: input.input }],
        })
        .pipe(
          Effect.map(Option.some),
          Effect.raceFirst(Effect.sleep(limit).pipe(Effect.as(Option.none()))),
          Effect.mapError((error) => fail(error instanceof Error ? error.message : String(error))),
          Effect.onInterrupt(() => Effect.andThen(cancel, finish({ status: "cancelled" }))),
          Effect.ensuring(Effect.sync(() => OperatorHelperAgents.endRun(session.id))),
        )
      const cost = yield* db
        .select({ cost: SessionTable.cost })
        .from(SessionTable)
        .where(eq(SessionTable.id, session.id))
        .get()
        .pipe(
          Effect.map((row) => row?.cost),
          Effect.orElseSucceed(() => undefined),
        )
      if (Option.isNone(result)) {
        yield* cancel
        yield* finish({ status: "timeout", error: `It took longer than ${stored.timeout} s`, cost })
        return yield* fail(`The helper took longer than its time limit (${stored.timeout} s)`)
      }
      const message = result.value
      const error =
        message.info.role === "assistant" && message.info.error
          ? "message" in message.info.error.data && typeof message.info.error.data.message === "string"
            ? message.info.error.data.message
            : message.info.error.name
          : undefined
      if (error) {
        yield* finish({ status: "failed", error, cost })
        return yield* fail(error)
      }
      const output = message.parts.findLast((part) => part.type === "text")?.text ?? ""
      const done = yield* finish({ status: "done", output: clip(output, 8000), cost })
      yield* cleanup().pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      return { output, run: done }
    })

    const runs = Effect.fn("OperatorHelperRuns.runs")(function* (namespace: string, name: string) {
      return yield* Effect.promise(() => readRuns(path.join(root(), namespace, name)))
    })

    const settings = () => Effect.promise(readSettings)
    const setSettings = Effect.fn("OperatorHelperRuns.setSettings")(function* (input: Settings) {
      const days = input.runDays
      if (!Number.isInteger(days) || days < RUN_DAYS.min || days > RUN_DAYS.max)
        return yield* fail(`Keep runs for ${RUN_DAYS.min} to ${RUN_DAYS.max} days`)
      // Pausing is kept unless it is given.
      const triggersPaused = input.triggersPaused ?? (yield* Effect.promise(readSettings)).triggersPaused === true
      yield* Effect.promise(async () => {
        await fs.mkdir(root(), { recursive: true })
        await Bun.write(settingsFile(), JSON.stringify({ runDays: days, triggersPaused }, null, 2))
      })
      yield* cleanup().pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      return { runDays: days, triggersPaused }
    })

    // The namespace of this instance's project.
    const namespaceHere = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const key = yield* Effect.promise(() => OperatorProjects.keyOf(ctx))
      return (yield* Effect.promise(() => OperatorProfileStore.forProject(key))).catalog.namespace.id
    })

    // A namespace's callable helpers, read again at most once a second.
    // A namespace's callable helpers: kept until a helper changes (or for a second, for changes made elsewhere,
    // such as a restore from Trash).
    const recent = new Map<string, { at: number; revision: number; helpers: OperatorHelperFiles.Stored[] }>()
    const callable = (ns: string) =>
      Effect.promise(async () => {
        const found = recent.get(ns)
        const revision = OperatorHelperFiles.helperRevision()
        if (found && found.revision === revision && Date.now() - found.at < 1000) return found.helpers
        const helpers = (await OperatorHelperFiles.read(ns)).filter((item) => item.callable)
        if (recent.size > 100) recent.clear()
        recent.set(ns, { at: Date.now(), revision, helpers })
        return helpers
      })

    // Offered: a run's declared system actions to it; the helper tool to every other agent of a namespace with a
    // callable helper.
    const offer: OperatorPermissionEffective.Offer = (input) =>
      Effect.gen(function* () {
        if (OperatorHelperAgents.isHelper(input.agent)) {
          const declared = OperatorHelperAgents.runOf(input.sessionID, input.agent) ?? []
          return ACTION_TOOLS.filter((tool) => declared.includes(tool))
        }
        const ns = yield* namespaceHere()
        return (yield* callable(ns)).length ? ["helper"] : []
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))

    const describe = Effect.fnUntraced(function* (agent: string) {
      if (OperatorHelperAgents.isHelper(agent)) return undefined
      const helpers = yield* callable(yield* namespaceHere())
      if (!helpers.length) return undefined
      return [
        "Runs one of this namespace's helpers: a small job done for you, unattended, that returns its output.",
        "Give it `name` and `input`. The helpers:",
        ...helpers.map((item) => `- ${item.name}: ${item.usage || item.description || "no description"}`),
      ].join("\n")
    })

    // The projects of a namespace.
    const projectsOf = Effect.fnUntraced(function* (ns: string) {
      return (yield* store.projects()).filter((item) => item.namespace === ns).map((item) => item.key)
    })

    // A session of the namespace's projects (a system action may touch no other).
    const sessionIn = Effect.fnUntraced(function* (ns: string, id: string) {
      const found = yield* sessions.get(SessionID.make(id)).pipe(Effect.mapError(() => fail(`No session ${id}`)))
      const keys = yield* projectsOf(ns)
      if (!keys.some((key) => found.directory === key || found.directory.startsWith(`${key}/`)))
        return yield* fail(`Session ${id} is not in this namespace`)
      return found
    })

    const action = Effect.fnUntraced(function* (input: {
      sessionID: string
      action: string
      args: Record<string, unknown>
    }) {
      const info = yield* sessions.get(SessionID.make(input.sessionID)).pipe(Effect.mapError(() => fail("No session")))
      const helper = OperatorHelperAgents.parse(info.agent)
      if (!helper) return yield* fail(`${input.action} is a helper's system action`)
      const declared = OperatorHelperAgents.runOf(input.sessionID, info.agent) ?? []
      if (!declared.includes(input.action)) return yield* fail(`${helper.name} doesn't declare ${input.action}`)
      const text = (key: string) => (typeof input.args[key] === "string" ? (input.args[key] as string).trim() : "")
      if (input.action === "list_sessions") {
        const keys = yield* projectsOf(helper.namespace)
        if (!keys.length) return "This namespace has no projects."
        const project = text("project")
        const scope = project ? keys.filter((key) => key === project || path.basename(key) === project) : keys
        if (!scope.length) return `No project ${project} in this namespace.`
        const before = text("before") ? Date.parse(text("before")) : undefined
        if (before !== undefined && Number.isNaN(before)) return yield* fail("`before` is a date, such as 2026-01-31")
        const limit = Math.min(Math.max(Number(input.args.limit) || 50, 1), 200)
        const rows = yield* db
          .select({
            id: SessionTable.id,
            title: SessionTable.title,
            agent: SessionTable.agent,
            directory: SessionTable.directory,
            updated: SessionTable.time_updated,
          })
          .from(SessionTable)
          .where(
            and(
              or(...scope.map((key) => OperatorFolderSql.within(SessionTable.directory, key))),
              isNull(SessionTable.parent_id),
              isNull(SessionTable.time_archived),
              or(isNull(SessionTable.agent), not(like(SessionTable.agent, `${OperatorHelperAgents.PREFIX}%`))),
              text("agent") ? eq(SessionTable.agent, text("agent")) : undefined,
              before !== undefined ? lt(SessionTable.time_updated, before) : undefined,
            ),
          )
          .orderBy(desc(SessionTable.time_updated))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        if (!rows.length) return "No sessions match."
        return rows
          .map(
            (row) =>
              `${row.id} · ${row.title} · ${row.agent ?? "-"} · ${row.directory} · last used ${new Date(row.updated).toISOString()}`,
          )
          .join("\n")
      }
      if (input.action === "archive_session") {
        const found = yield* sessionIn(helper.namespace, text("sessionID"))
        yield* sessions.setArchived({ sessionID: found.id, time: Date.now() })
        return `Archived ${found.id} (${found.title}).`
      }
      if (input.action === "trash_session") {
        const found = yield* sessionIn(helper.namespace, text("sessionID"))
        yield* trash.session(found.id).pipe(Effect.mapError((error) => fail(error.message)))
        return `Moved ${found.id} (${found.title}) to Trash.`
      }
      if (input.action === "notify") {
        const message = text("message")
        if (!message) return yield* fail("Give the `message`")
        const ctx = yield* InstanceState.context
        const project =
          input.args.project === true ? yield* Effect.promise(() => OperatorProjects.keyOf(ctx)) : undefined
        yield* Effect.promise(() =>
          OperatorNotifications.add({
            message,
            helper: helper.name,
            namespace: helper.namespace,
            ...(project ? { project } : {}),
            ...(typeof info.metadata?.operator?.run === "string" ? { run: info.metadata.operator.run } : {}),
          }),
        )
        return "Posted."
      }
      return yield* fail(`Unknown system action ${input.action}`)
    })

    // The registry's hooks run with the request's instance.
    const inInstance = <A, E>(instance: unknown, effect: Effect.Effect<A, E>) =>
      instances.provide({ directory: (instance as InstanceContext).directory }, effect)

    // The model of this project's namespace's role helper, for a role OpenCode's code calls with a model of its
    // choosing (the agent generator: agent/agent.ts); none without one.
    const roleModel = Effect.fnUntraced(function* (role: string) {
      const ns = yield* namespaceHere()
      const holder = yield* Effect.promise(() => OperatorHelperAgents.roleHolder(ns, role))
      if (!holder) return undefined
      const model = yield* modelFor(holder.model)
      return { providerID: String(model.providerID), modelID: String(model.id) }
    })
    const hooks: typeof OperatorRegistry.helpers = {
      agent: OperatorHelperAgents.agent,
      roleModel: (input) =>
        Effect.runPromise(
          instances
            .provide({ directory: input.directory }, roleModel(input.role))
            .pipe(Effect.orElseSucceed(() => undefined)),
        ),
      describe: (input) =>
        Effect.runPromise(
          inInstance(input.instance, describe(input.agent)).pipe(Effect.orElseSucceed(() => undefined)),
        ),
      call: (input) =>
        Effect.runPromise(
          inInstance(
            input.instance,
            Effect.gen(function* () {
              if (OperatorHelperAgents.isHelper(input.agent)) return yield* fail("A helper can't call helpers")
              const ns = yield* namespaceHere()
              const found = (yield* callable(ns)).find((item) => item.name === input.name)
              if (!found) return yield* fail(`No callable helper "${input.name}" in this namespace`)
              const result = yield* run({
                namespace: ns,
                name: found.name,
                input: input.input,
                startedBy: { kind: "agent", agent: input.agent, sessionID: input.sessionID },
                parentSessionID: input.sessionID,
              })
              return {
                output: result.output,
                run: result.run.id,
                ...(result.run.sessionID ? { sessionID: result.run.sessionID } : {}),
              }
            }),
          ),
          { signal: input.abort },
        ),
      run: (input) =>
        Effect.runPromise(
          inInstance(
            input.instance,
            run({
              namespace: input.namespace,
              name: input.name,
              input: input.input,
              startedBy: input.startedBy,
              ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
            }).pipe(Effect.map((result) => result.output)),
          ),
        ),
      action: (input) =>
        Effect.runPromise(
          inInstance(input.instance, action({ sessionID: input.sessionID, action: input.action, args: input.args })),
        ),
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        OperatorRegistry.helpers.agent = hooks.agent
        OperatorRegistry.helpers.roleModel = hooks.roleModel
        OperatorRegistry.helpers.describe = hooks.describe
        OperatorRegistry.helpers.call = hooks.call
        OperatorRegistry.helpers.run = hooks.run
        OperatorRegistry.helpers.action = hooks.action
        OperatorPermissionEffective.offers.add(offer)
      }),
      () =>
        Effect.sync(() => {
          if (OperatorRegistry.helpers.call === hooks.call) {
            OperatorRegistry.helpers.agent = undefined
            OperatorRegistry.helpers.roleModel = undefined
            OperatorRegistry.helpers.describe = undefined
            OperatorRegistry.helpers.call = undefined
            OperatorRegistry.helpers.run = undefined
            OperatorRegistry.helpers.action = undefined
          }
          OperatorPermissionEffective.offers.delete(offer)
        }),
    )

    return Service.of({ run, runs, settings, setSettings })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    Session.node,
    SessionPrompt.node,
    Provider.node,
    Agent.node,
    OperatorGenerate.node,
    OperatorProfileStore.node,
    OperatorTrash.node,
    InstanceStore.node,
  ],
})
