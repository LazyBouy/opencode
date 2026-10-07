export * as OperatorPermissionDecisions from "./permission-decisions"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { OperatorProfileStore } from "./profile-store"
import { OperatorProjects } from "./projects"

// Every decision on a permission request (fixes_spec.md §4.3), made anywhere: the fork's reply card
// (which says what it decided and where, before it replies), and replies from other clients (the TUI,
// an API client), told apart from the fork's by having no such note. Requests that ended without a
// decision are recorded too: their session stopped, their project reloaded, or a merge turn withdrew
// them. Records are kept per session in `<data>/operator/permission-decisions/<sessionID>.jsonl` (the
// last line for a request wins) and deleted with the session.
//
// It also keeps the requests waiting for a reply, in every project (the Permission Inbox), from the
// asked and replied events every project publishes on the global bus.

export const Decision = Schema.Literals(["allow", "allow-session", "allow-agent", "deny", "cancelled"]).annotate({
  description:
    "allow: this request only; allow-session / allow-agent: a rule was added to the session or the agent; deny: rejected (with a note when there is one); cancelled: no decision",
})
export type Decision = typeof Decision.Type

export const Via = Schema.Literals(["inbox", "agent", "session", "details", "project", "chat", "client"]).annotate({
  description: "Where it was decided: a place in the web UI, or client (the TUI or an API client)",
})
export type Via = typeof Via.Type

export const Cause = Schema.Literals(["stopped", "reloaded", "dismissed", "cascade", "covered"]).annotate({
  description:
    "stopped / reloaded / dismissed: why a request ended without a decision; cascade: denied with the request in `by`; covered: allowed by the rule another decision (`by`) added",
})
export type Cause = typeof Cause.Type

export const Written = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Schema.Literals(["allow", "ask", "deny"]),
  where: Schema.String.annotate({ description: "session, or the file the agent's rule was written to" }),
}).annotate({ identifier: "OperatorPermissionDecisionRule" })
export type Written = typeof Written.Type

export const Decided = Schema.Struct({
  requestID: Schema.String,
  sessionID: Schema.String,
  sessionTitle: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  askedAt: Schema.Finite,
  decidedAt: Schema.Finite,
  decision: Decision,
  cause: Schema.optional(Cause),
  by: Schema.optional(Schema.String),
  rule: Schema.optional(Written),
  note: Schema.optional(Schema.String),
  who: Schema.String.annotate({ description: "The config `username` (one shared server password: no logins)" }),
  via: Via,
}).annotate({ identifier: "OperatorPermissionDecision" })
export type Decided = typeof Decided.Type

// A request waiting for a reply, with what is known about where it comes from.
export type Asked = {
  directory: string
  time: number
  request: PermissionV1.Request
  sessionTitle?: string
  agent?: string
  parentID?: string
  project?: string
  namespace?: string
  who?: string
}

// What the fork decided, noted before it replies.
export type Draft = {
  decision: Decision
  via: Via
  cause?: Cause
  by?: string
  rule?: Written
  note?: string
}

export const Filter = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Finite),
})
export type Filter = typeof Filter.Type

export interface Interface {
  /** Requests waiting for a reply in any project, oldest first. */
  readonly asked: () => ReadonlyArray<Asked>
  readonly find: (requestID: string) => Asked | undefined
  /** Notes what the fork is about to reply to a request, so the reply is recorded with it. */
  readonly expect: (requestID: string, draft: Draft) => void
  /** Decisions, newest first. */
  readonly list: (filter: Filter) => Effect.Effect<ReadonlyArray<Decided>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorPermissionDecisions") {}

const folder = () => path.join(Global.Path.data, "operator", "permission-decisions")
const fileOf = (sessionID: string) => path.join(folder(), `${sessionID.replace(/[^\w.-]/g, "_")}.jsonl`)

// What the fork is about to reply to a request (noted before it replies, so the reply is recorded with
// it); a plain function, so code outside the service graph (merge turns) can note it too.
const drafts = new Map<string, Draft>()
export function expect(requestID: string, draft: Draft) {
  drafts.set(requestID, draft)
}

let writes: Promise<unknown> = Promise.resolve()
function append(record: Decided) {
  const next = writes.then(async () => {
    await fs.mkdir(folder(), { recursive: true })
    await fs.appendFile(fileOf(record.sessionID), JSON.stringify(record) + "\n")
  })
  writes = next.catch(() => undefined)
  return next
}

async function readFile(file: string): Promise<Decided[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  const byRequest = new Map<string, Decided>()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as Decided
      byRequest.set(record.requestID, record)
    } catch {
      // a line cut short by a crash
    }
  }
  return [...byRequest.values()]
}

export async function read(filter: Filter): Promise<Decided[]> {
  await writes
  const files = filter.sessionID
    ? [fileOf(filter.sessionID)]
    : (await fs.readdir(folder()).catch(() => [] as string[]))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(folder(), name))
  const all = (await Promise.all(files.map(readFile))).flat()
  return all
    .filter((record) => !filter.agent || record.agent === filter.agent)
    .filter((record) => !filter.project || record.project === filter.project)
    .toSorted((a, b) => b.decidedAt - a.decidedAt)
    .slice(0, filter.limit ?? 200)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const config = yield* Config.Service
    const bridge = yield* EffectBridge.make()
    const asked = new Map<string, Asked>()
    // The request a session's reply cascades from (upstream rejects every other waiting request of the
    // session with a reject, and allows the ones an Always covers), within the same moment.
    const cascading = new Map<string, { requestID: string; reply: string; via: Via }>()

    // Where a request comes from: its session (title, agent), project and namespace, and who decides
    // (the project's config `username`), while its project is loaded.
    const describe = (entry: Asked) =>
      Effect.gen(function* () {
        const info = yield* sessions.get(SessionID.make(entry.request.sessionID)).pipe(Effect.option)
        if (info._tag === "Some") {
          entry.sessionTitle = info.value.title
          entry.agent = info.value.agent
          entry.parentID = info.value.parentID
        }
        const project = yield* Effect.promise(() => OperatorProjects.projectOf(entry.directory))
        entry.project = project?.key ?? entry.directory
        const settings = yield* Effect.promise(() => OperatorProfileStore.readProjects())
        entry.namespace = settings[entry.project]?.namespace ?? "opencode"
        // (Its project is loaded: the request came from it.)
        const exists = yield* Effect.promise(() =>
          fs.stat(entry.directory).then(
            () => true,
            () => false,
          ),
        )
        if (!exists) return
        const cfg = yield* instances.provide({ directory: entry.directory }, config.get()).pipe(Effect.option)
        entry.who = cfg._tag === "Some" ? cfg.value.username : undefined
      }).pipe(Effect.catchCause(() => Effect.void))

    const record = (entry: Asked, draft: Draft) => {
      const time = Date.now()
      const out: Decided = {
        requestID: entry.request.id,
        sessionID: entry.request.sessionID,
        ...(entry.sessionTitle !== undefined ? { sessionTitle: entry.sessionTitle } : {}),
        ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
        directory: entry.directory,
        ...(entry.project !== undefined ? { project: entry.project } : {}),
        ...(entry.namespace !== undefined ? { namespace: entry.namespace } : {}),
        permission: entry.request.permission,
        patterns: [...entry.request.patterns],
        metadata: entry.request.metadata,
        askedAt: entry.time,
        decidedAt: time,
        decision: draft.decision,
        ...(draft.cause ? { cause: draft.cause } : {}),
        ...(draft.by ? { by: draft.by } : {}),
        ...(draft.rule ? { rule: draft.rule } : {}),
        ...(draft.note ? { note: draft.note } : {}),
        who: entry.who ?? (os.userInfo().username || "user"),
        via: draft.via,
      }
      void append(out).catch(() => undefined)
    }

    // A reply with no note from the fork came from another client.
    const inferred = (entry: Asked, reply: string): Draft => {
      const sessionID = entry.request.sessionID
      const first = cascading.get(sessionID)
      if (first && first.requestID !== entry.request.id && first.reply === reply)
        return reply === "reject"
          ? { decision: "deny", via: first.via, cause: "cascade", by: first.requestID }
          : { decision: "allow-session", via: first.via, cause: "covered", by: first.requestID }
      if (reply === "always")
        return {
          decision: "allow-session",
          via: "client",
          rule: {
            permission: entry.request.permission,
            pattern: entry.request.always.join(", "),
            action: "allow",
            where: "session",
          },
        }
      return { decision: reply === "reject" ? "deny" : "allow", via: "client" }
    }

    const end = (requestID: string, draft: (entry: Asked) => Draft) => {
      const entry = asked.get(requestID)
      if (!entry) return
      asked.delete(requestID)
      record(entry, draft(entry))
    }

    const onEvent = (event: GlobalEvent) => {
      const payload = event.payload as { type?: string; properties?: object } | undefined
      const properties = (payload?.properties ?? {}) as { [key: string]: unknown }
      switch (payload?.type) {
        case "permission.asked": {
          if (!event.directory) return
          const request = properties as unknown as PermissionV1.Request
          const entry: Asked = { directory: event.directory, time: Date.now(), request }
          asked.set(request.id, entry)
          bridge.fork(describe(entry))
          return
        }
        case "permission.replied": {
          const requestID = String(properties.requestID)
          const reply = String(properties.reply)
          const sessionID = String(properties.sessionID)
          const draft = drafts.get(requestID)
          drafts.delete(requestID)
          end(requestID, (entry) => draft ?? inferred(entry, reply))
          if (reply !== "once" && !cascading.has(sessionID)) {
            cascading.set(sessionID, { requestID, reply, via: draft?.via ?? "client" })
            setTimeout(() => cascading.delete(sessionID))
          }
          return
        }
        case "session.idle": {
          // A request still waiting when its session stopped was never answered.
          const sessionID = String(properties.sessionID)
          for (const [id, entry] of asked)
            if (entry.request.sessionID === sessionID)
              end(id, () => ({ decision: "cancelled", cause: "stopped", via: "client" }))
          return
        }
        case "server.instance.disposed": {
          for (const [id, entry] of asked)
            if (entry.directory === event.directory)
              end(id, () => ({ decision: "cancelled", cause: "reloaded", via: "client" }))
          return
        }
        case "global.disposed": {
          for (const id of [...asked.keys()])
            end(id, () => ({ decision: "cancelled", cause: "reloaded", via: "client" }))
          return
        }
        case "session.deleted": {
          const id = (properties.info as { id?: string } | undefined)?.id ?? String(properties.sessionID ?? "")
          if (id) void fs.rm(fileOf(id), { force: true }).catch(() => undefined)
          return
        }
      }
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", onEvent)),
      () => Effect.sync(() => GlobalBus.off("event", onEvent)),
    )

    return Service.of({
      asked: () => [...asked.values()].sort((a, b) => a.time - b.time),
      find: (requestID) => asked.get(requestID),
      expect,
      list: (filter) => Effect.promise(() => read(filter)),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, InstanceStore.node, Config.node],
})
