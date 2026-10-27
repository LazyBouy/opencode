export * as OperatorProjectInbox from "./inbox"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { OperatorProjectRecords } from "../project-records"
import { OperatorQueue } from "../queue"
import { OperatorQueueStore } from "../queue-store"
import { OperatorTrashFiles } from "../trash-files"
import { OperatorMessageLog } from "./log"
import { OperatorMessagePlaces } from "./places"
import { OperatorMessage } from "./message"
import { OperatorInboxRules as Rules } from "./rules"
import { OperatorMessagingSeams } from "./seams"
import { OperatorInboxTransport } from "./transport"

// The Project inbox (SPEC-0023 §8): a project's way in for messages that don't come from its own agents' sessions
// directly: `ping` to the inbox, the user ("New message"), the API, and later other projects (phase 4). On SQLite
// (no broker), a message is routed as it arrives:
//   1. the rules, in order: the first that matches decides (rules.ts);
//   2. no rule, and the project has a manager: to the manager's main session, `with manager` (it routes it with
//      `ping forward` or `drop`, or the user does on the Project inbox page);
//   3. no rule, no manager: as addressed when it names a recipient; otherwise the unmatched setting: dead letter
//      (the default) or broadcast to every member (at most 50).
// Routed copies are queue messages of their own (queue.ts), from the original sender, with the same correlation
// id, `via` the inbox message. Every step is in the message log (log.ts). No session code: sessions are reached
// through the queue and seams.ts.

export const MAX_HOPS = 8
/** Announced when an inbox message changes, for the Project inbox page. */
export const UPDATED = "operator.inbox.updated"
export const MAX_RECIPIENTS = 50

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("OperatorProjectInboxInvalid", {
  message: Schema.String,
}) {}
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("OperatorProjectInboxNotFound", {
  message: Schema.String,
}) {}

type Message = OperatorMessage.Message
type Target = Rules.Target
/** Who acted: the user (the Project inbox page) or an agent (the manager). */
export type By = { kind: "user" } | { kind: "agent"; agent: string }
const byName = (by: By) => (by.kind === "user" ? "you" : by.agent)

/** A message entering a project's inbox. */
export type Entry = {
  /** The project's folder (its key). */
  project: string
  from: OperatorMessage.From
  /** The recipient it asks for, if any: here, or (from another project) one of this project's. */
  to?: OperatorMessage.To
  body: OperatorMessage.Body
  priority?: OperatorQueueStore.Priority
  steer?: boolean
  correlationID?: string
  replyTo?: string
  /** Inboxes it passed through before this one. */
  hops?: number
  /** Its id, when the sender made it up already (its correlation id is the first message's id). */
  id?: string
}

export const Sample = Schema.Struct({
  text: Schema.String,
  type: Schema.optional(Schema.Literals(["text", "file-location"])),
  fromProject: Schema.optional(Schema.String).annotate({ description: "The sender's project id (default: this)" }),
  fromAgent: Schema.optional(Schema.String),
  fromSession: Schema.optional(Schema.String).annotate({ description: "The session it was sent from" }),
  fromKind: Schema.optional(Schema.Literals(["user", "agent", "system", "external"])),
  to: Schema.optional(Rules.Target),
  priority: Schema.optional(Rules.Priority),
  correlationID: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String),
}).annotate({ identifier: "OperatorInboxSample" })
export type Sample = typeof Sample.Type

/** A conversation: every message sharing a correlation id, oldest first, and the sessions they went between. */
export const Conversation = Schema.Struct({
  correlationID: Schema.String,
  messages: Schema.Array(OperatorMessage.Message),
  sessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.String),
      directory: Schema.optional(Schema.String),
      exists: Schema.Boolean.annotate({ description: "False once the session was deleted" }),
    }).annotate({ identifier: "OperatorConversationSession" }),
  ),
}).annotate({ identifier: "OperatorConversation" })
export type Conversation = typeof Conversation.Type

export const TestResult = Schema.Struct({
  by: Schema.Literals(["rule", "manager", "as addressed", "broadcast", "dead letter"]),
  rule: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
  detail: Schema.String,
}).annotate({ identifier: "OperatorInboxTestResult" })
export type TestResult = typeof TestResult.Type

export interface Interface {
  /** Puts a message into a project's inbox and routes it; the message as routed. */
  readonly enter: (entry: Entry) => Effect.Effect<Message, InvalidError>
  /** The messages that entered a project's inbox, newest first. */
  readonly messages: (
    project: string,
    filter: { status?: OperatorMessage.Status; from?: string; limit?: number },
  ) => Effect.Effect<Message[]>
  /** One message (an inbox message, or any message in the log). */
  readonly get: (id: string) => Effect.Effect<Message, NotFoundError>
  /** Its record: an inbox message comes with its routed copies. */
  readonly record: (id: string) => Effect.Effect<Message, NotFoundError>
  /** Sends a message waiting for the manager, or a dead letter, to agents, sessions or groups of its project. */
  readonly forward: (
    id: string,
    to: ReadonlyArray<Target>,
    by: By,
    project?: string,
  ) => Effect.Effect<Message, InvalidError | NotFoundError>
  readonly drop: (
    id: string,
    reason: string,
    by: By,
    project?: string,
  ) => Effect.Effect<Message, InvalidError | NotFoundError>
  /** Routes a dead letter (or a message waiting for the manager) again, e.g. after a rule was added. */
  readonly routeAgain: (id: string) => Effect.Effect<Message, InvalidError | NotFoundError>
  /** Sends a dead letter to every member. */
  readonly broadcast: (id: string, by: By) => Effect.Effect<Message, InvalidError | NotFoundError>
  /** Moves a dead letter (or a dropped message) to Trash. */
  readonly remove: (id: string) => Effect.Effect<void, InvalidError | NotFoundError>
  readonly inbox: (project: string) => Effect.Effect<Rules.Inbox>
  readonly setRules: (project: string, rules: ReadonlyArray<Rules.Rule>) => Effect.Effect<Rules.Inbox, InvalidError>
  readonly setUnmatched: (project: string, unmatched: Rules.Unmatched) => Effect.Effect<Rules.Inbox>
  /** Which rule (or what else) would take a sample message: the saved rules, or the ones given. */
  readonly test: (project: string, sample: Sample, rules?: ReadonlyArray<Rules.Rule>) => Effect.Effect<TestResult>
  /** Per project (unique id): messages waiting for the manager, and dead letters. */
  readonly counts: () => Effect.Effect<Record<string, { waiting: number; deadLetters: number }>>
  /** Every message with this correlation id (at most 500), and the sessions involved. */
  readonly conversation: (correlationID: string) => Effect.Effect<Conversation>
  /** How messages from other projects reach inboxes: SQLite (routed as they arrive), or RabbitMQ and its state. */
  readonly transport: () => { kind: "sqlite" } | ({ kind: "rabbitmq" } & OperatorInboxTransport.State)
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorProjectInbox") {}

/** A project's unique id (its folder until it has one), and the folder of one (places.ts). */
export const projectIdOf = OperatorMessagePlaces.idOf
export const projectKeyOf = OperatorMessagePlaces.keyOf

type Recipient = { agent: string; sessionID?: string; label: string }
type Outcome = { status: OperatorMessage.Status; step: OperatorMessage.Step; routedBy?: string; routedTo?: string[] }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const instances = yield* InstanceStore.Service
    const queue = yield* OperatorQueue.Service
    const seams = yield* OperatorMessagingSeams.Service
    const log = () => OperatorMessageLog.log()

    // The message an inbox message answers, when an agent of this project sent it (for "Replies go to their
    // sender"): by replyTo, else by correlation id. A routed copy keeps its original's sender, so it counts too: a
    // reply from another project names the copy its sender got.
    const originalOf = (message: Pick<Message, "id" | "replyTo" | "correlationID">, project: string) => {
      const sentHere = (found: Message | undefined): found is Message =>
        !!found &&
        found.id !== message.id &&
        found.from.kind === "agent" &&
        !!found.from.agent &&
        !!found.from.session &&
        found.from.project === project
      if (message.replyTo) {
        const found = log().get(message.replyTo)
        if (sentHere(found)) return found
      }
      if (!message.correlationID) return undefined
      return log().list({ correlationID: message.correlationID, limit: 50 }).find(sentHere)
    }

    // The members a broadcast goes to: the project's members, else every agent that runs sessions of its own.
    const membersOf = (key: string) =>
      Effect.gen(function* () {
        const record = yield* Effect.promise(() => OperatorProjectRecords.get(key))
        if (record.members.length) return [...record.members]
        return (yield* instances.provide({ directory: key }, seams.agents()))
          .filter((agent) => agent.mode !== "subagent" && !agent.hidden)
          .map((agent) => agent.name)
      })

    // Targets to recipients: an agent, a session (as its agent), a group's members.
    const resolve = (key: string, targets: ReadonlyArray<Target>) =>
      Effect.gen(function* () {
        const record = yield* Effect.promise(() => OperatorProjectRecords.get(key))
        const found: Recipient[] = []
        const problems: string[] = []
        for (const target of targets) {
          if (target.type === "agent") found.push({ agent: target.id, label: target.id })
          else if (target.type === "session") {
            const session = yield* instances.provide({ directory: key }, seams.session(target.id))
            if (!session?.agent) problems.push(`no session ${target.id} that has run`)
            else
              found.push({
                agent: session.agent,
                sessionID: target.id,
                label: `${session.agent} (session ${target.id})`,
              })
          } else {
            const group = record.groups.find((item) => item.name === target.id || item.id === target.id)
            if (!group) problems.push(`no group ${target.id}`)
            else found.push(...group.members.map((agent) => ({ agent, label: agent })))
          }
        }
        const seen = new Set<string>()
        const unique = found.filter((item) => {
          const id = `${item.agent}\n${item.sessionID ?? ""}`
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })
        return { recipients: unique, problems }
      })

    const deadLetter = (reason: string): Outcome => ({
      status: "dead letter",
      step: { at: Date.now(), kind: "dead letter", detail: reason },
    })

    // Queues one copy per recipient, from the original sender, with its correlation id.
    const deliver = (
      message: Message,
      key: string,
      recipients: ReadonlyArray<Recipient>,
      by: string,
      options: { steer?: boolean; priority?: OperatorQueueStore.Priority; manager?: boolean; problems?: string[] } = {},
    ) =>
      Effect.gen(function* () {
        const problems = [...(options.problems ?? [])]
        if (recipients.length > MAX_RECIPIENTS)
          return deadLetter(`${by}: ${recipients.length} recipients; at most ${MAX_RECIPIENTS}`)
        const project = message.inbox ?? (yield* Effect.promise(() => projectIdOf(key)))
        const sender: OperatorQueueStore.Sender = {
          kind: message.from.kind,
          ...(message.from.agent ? { agent: message.from.agent } : {}),
          ...(message.from.session ? { sessionID: message.from.session } : {}),
          ...(message.from.project && message.from.project !== project ? { project: message.from.project } : {}),
        }
        const delivered: string[] = []
        for (const recipient of recipients) {
          const sent = yield* instances
            .provide(
              { directory: key },
              queue.send(
                recipient.agent,
                {
                  text: message.body.text,
                  ...(recipient.sessionID
                    ? { target: "session" as const, sessionID: recipient.sessionID }
                    : options.manager
                      ? { target: "main" as const }
                      : {}),
                  priority: Rules.raise(message.priority, options.priority),
                  steer: options.steer ?? message.steer,
                  correlationID: message.correlationID,
                  ...(message.replyTo ? { replyTo: message.replyTo } : {}),
                },
                sender,
                {
                  to: message.to,
                  body: message.body.type,
                  via: { id: message.id, ...(options.manager ? { manager: true } : {}) },
                  hops: message.hops,
                },
              ),
            )
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.sync(() => (problems.push(`${recipient.label}: ${error.message}`), false)),
              ),
            )
          if (sent) delivered.push(recipient.label)
        }
        if (!delivered.length)
          return deadLetter(`${by}: nobody could take it${problems.length ? ` (${problems.join("; ")})` : ""}`)
        const status: OperatorMessage.Status = options.manager ? "with manager" : "routed"
        return {
          status,
          routedBy: by,
          routedTo: delivered,
          step: {
            at: Date.now(),
            kind: status,
            detail: `${by}: to ${delivered.join(", ")}${problems.length ? `; not to ${problems.join("; ")}` : ""}`,
          },
        } satisfies Outcome
      })

    const toManager = (message: Message, key: string, manager: string) =>
      deliver(message, key, [{ agent: manager, label: manager }], "the manager", { manager: true })

    // An action of a rule (or of the routing order), applied.
    const act = (message: Message, key: string, action: Rules.Action, by: string, original?: Message) =>
      Effect.gen(function* () {
        const modifiers = {
          ...(action.steer !== undefined ? { steer: action.steer } : {}),
          ...(action.priority ? { priority: action.priority } : {}),
        }
        switch (action.kind) {
          case "as-addressed": {
            const asked = Rules.recipientOf(message)
            if (asked.type === "none" || !asked.id) return deadLetter(`${by}: it names no recipient`)
            const found = yield* resolve(key, [{ type: asked.type, id: asked.id }])
            if (!found.recipients.length) return deadLetter(`${by}: ${found.problems.join("; ")}`)
            return yield* deliver(message, key, found.recipients, by, { ...modifiers, problems: found.problems })
          }
          case "forward": {
            const found = yield* resolve(key, action.to ?? [])
            if (!found.recipients.length)
              return deadLetter(`${by}: ${found.problems.join("; ") || "nobody to forward to"}`)
            return yield* deliver(message, key, found.recipients, by, { ...modifiers, problems: found.problems })
          }
          case "manager": {
            const record = yield* Effect.promise(() => OperatorProjectRecords.get(key))
            if (!record.manager) return deadLetter(`${by}: to the manager, and the project has none`)
            return yield* deliver(message, key, [{ agent: record.manager, label: record.manager }], by, {
              ...modifiers,
              manager: true,
            })
          }
          case "dead-letter":
            return deadLetter(by)
          case "drop":
            return {
              status: "dropped",
              routedBy: by,
              step: { at: Date.now(), kind: "dropped", detail: by },
            } satisfies Outcome
          case "broadcast": {
            const members = (yield* membersOf(key)).filter(
              (agent) => !(message.from.agent === agent && message.from.project === message.inbox),
            )
            if (!members.length) return deadLetter(`${by}: the project has no members to broadcast to`)
            return yield* deliver(
              message,
              key,
              members.map((agent) => ({ agent, label: agent })),
              by,
              modifiers,
            )
          }
          case "to-sender": {
            if (!original?.from.agent || !original.from.session)
              return deadLetter(`${by}: the message it answers isn't known here`)
            return yield* deliver(
              message,
              key,
              [{ agent: original.from.agent, sessionID: original.from.session, label: original.from.agent }],
              by,
              modifiers,
            )
          }
        }
      })

    // The routing order (§8.1).
    const route = (message: Message, key: string) =>
      Effect.gen(function* () {
        const project = message.inbox!
        const inbox = yield* Effect.promise(() => OperatorProjectRecords.inboxOf(key))
        const original = originalOf(message, project)
        const rule = Rules.first(inbox.rules, { message, project, ...(original ? { original } : {}) })
        if (rule) return yield* act(message, key, rule.action, `rule ${rule.name}`, original)
        const record = yield* Effect.promise(() => OperatorProjectRecords.get(key))
        if (record.manager) return yield* toManager(message, key, record.manager)
        if (Rules.recipientOf(message).type !== "none")
          return yield* act(message, key, { kind: "as-addressed" }, "as addressed")
        if (inbox.unmatched === "broadcast") return yield* act(message, key, { kind: "broadcast" }, "broadcast")
        return deadLetter("no rule matched, the project has no manager, and it names no recipient")
      })

    // RabbitMQ, when configured, carries messages from other projects (and from outside) into inboxes (§9.4): they're
    // published, and routed here when consumed; their result is in the log before the broker hears they're done.
    const brokerURL = process.env.OPENCODE_OPERATOR_RABBITMQ_URL?.trim()
    const broker = brokerURL
      ? OperatorInboxTransport.rabbitmq(brokerURL, () => OperatorQueueStore.store().file)
      : undefined
    const crossing = (entry: Entry, project: string) =>
      entry.from.kind === "external" || (!!entry.from.project && entry.from.project !== project)

    // An outcome written to the log and announced; the message as it is now.
    const apply = (message: Message, outcome: Outcome, key: string): Message => {
      GlobalBus.emit("event", {
        directory: key,
        payload: { type: UPDATED, properties: { id: message.id, inbox: message.inbox, status: outcome.status } },
      })
      log().step(message.id, outcome.step, {
        status: outcome.status,
        ...(outcome.routedBy ? { routedBy: outcome.routedBy } : {}),
        ...(outcome.routedTo ? { routedTo: outcome.routedTo } : {}),
      })
      return {
        ...message,
        status: outcome.status,
        ...(outcome.routedBy ? { routedBy: outcome.routedBy } : {}),
        ...(outcome.routedTo ? { routedTo: outcome.routedTo } : {}),
        trail: [...message.trail, outcome.step],
      }
    }

    const enter = Effect.fn("OperatorProjectInbox.enter")(function* (entry: Entry) {
      const text = entry.body.text.trim()
      if (!text) return yield* new InvalidError({ message: "The message is empty" })
      const project = yield* Effect.promise(() => projectIdOf(entry.project))
      const id = entry.id ?? OperatorMessage.newId()
      const at = Date.now()
      const hops = (entry.hops ?? 0) + 1
      const who =
        entry.from.kind === "agent"
          ? `from ${entry.from.agent}`
          : entry.from.kind === "user"
            ? "from you"
            : `from ${entry.from.kind}`
      const message: Message = {
        id,
        project: entry.from.project ?? project,
        ...(entry.from.project === undefined || entry.from.project === project ? { folder: entry.project } : {}),
        from: { ...entry.from, project: entry.from.project ?? project },
        to: entry.to ?? { type: "inbox" },
        body: { type: entry.body.type, text },
        priority: entry.priority ?? "normal",
        steer: entry.steer ?? false,
        correlationID: entry.correlationID ?? id,
        ...(entry.replyTo ? { replyTo: entry.replyTo } : {}),
        hops,
        status: "queued",
        inbox: project,
        createdAt: at,
        trail: [{ at, kind: "entered the Project inbox", detail: who }],
      }
      log().write(message)
      if (hops > MAX_HOPS)
        return apply(message, deadLetter(`routing loop: more than ${MAX_HOPS} inboxes`), entry.project)
      if (broker && crossing(entry, project)) {
        const sent = yield* Effect.promise(() => broker.send(project, message))
        const step = {
          at: Date.now(),
          kind: sent === "published" ? "published" : "in the outbox",
          detail: sent === "published" ? "to RabbitMQ" : "RabbitMQ can't be reached: published when it's back",
        }
        log().step(message.id, step)
        return { ...message, trail: [...message.trail, step] }
      }
      return apply(message, yield* route(message, entry.project), entry.project)
    })

    const get = Effect.fn("OperatorProjectInbox.get")(function* (id: string) {
      const found = log().get(id)
      if (!found) return yield* new NotFoundError({ message: `No message ${id}` })
      return found
    })
    // A record: with an inbox message's routed copies and where they went.
    const record = Effect.fn("OperatorProjectInbox.record")(function* (id: string) {
      const found = yield* get(id)
      if (!found.inbox) return found
      const copies = log()
        .list({ via: found.id, limit: 100 })
        .map((copy) => ({
          id: copy.id,
          ...(copy.agent ? { agent: copy.agent } : {}),
          ...(copy.sessionID ? { sessionID: copy.sessionID } : {}),
          status: copy.status,
        }))
      return copies.length ? { ...found, copies } : found
    })

    // An inbox message a person or the manager acts on: given by its id or a routed copy's, of this project.
    const actionable = Effect.fnUntraced(function* (
      id: string,
      allowed: ReadonlyArray<OperatorMessage.Status>,
      project?: string,
    ) {
      const given = yield* get(id)
      const message = given.via ? yield* get(given.via) : given
      if (!message.inbox) return yield* new InvalidError({ message: `${id} didn't go through a Project inbox` })
      const key = yield* Effect.promise(() => projectKeyOf(message.inbox!))
      if (!key) return yield* new InvalidError({ message: `${id}'s project isn't known any more` })
      if (project && key !== project) return yield* new InvalidError({ message: `${id} isn't in this project's inbox` })
      if (!allowed.includes(message.status))
        return yield* new InvalidError({ message: `${message.id} is ${message.status}` })
      return { message, key }
    })

    const forward = Effect.fn("OperatorProjectInbox.forward")(function* (
      id: string,
      to: ReadonlyArray<Target>,
      by: By,
      project?: string,
    ) {
      if (!to.length) return yield* new InvalidError({ message: "Say where to forward it" })
      const { message, key } = yield* actionable(id, ["with manager", "dead letter"], project)
      const found = yield* resolve(key, to)
      if (!found.recipients.length) return yield* new InvalidError({ message: found.problems.join("; ") })
      const outcome = yield* deliver(message, key, found.recipients, `forwarded by ${byName(by)}`, {
        problems: found.problems,
      })
      if (outcome.status === "dead letter")
        return yield* new InvalidError({ message: outcome.step.detail ?? "Not sent" })
      return apply(message, outcome, key)
    })

    const drop = Effect.fn("OperatorProjectInbox.drop")(function* (
      id: string,
      reason: string,
      by: By,
      project?: string,
    ) {
      const { message, key } = yield* actionable(id, ["with manager", "dead letter"], project)
      const why = reason.trim() || "no reason given"
      return apply(
        message,
        {
          status: "dropped",
          routedBy: byName(by),
          step: { at: Date.now(), kind: "dropped", detail: `by ${byName(by)}: ${why}` },
        },
        key,
      )
    })

    const routeAgain = Effect.fn("OperatorProjectInbox.routeAgain")(function* (id: string) {
      const { message, key } = yield* actionable(id, ["with manager", "dead letter"])
      const outcome = yield* route(message, key)
      return apply(
        message,
        { ...outcome, step: { ...outcome.step, detail: `routed again: ${outcome.step.detail ?? outcome.status}` } },
        key,
      )
    })

    const broadcast = Effect.fn("OperatorProjectInbox.broadcast")(function* (id: string, by: By) {
      const { message, key } = yield* actionable(id, ["dead letter", "with manager"])
      const outcome = yield* act(message, key, { kind: "broadcast" }, `broadcast by ${byName(by)}`)
      if (outcome.status === "dead letter")
        return yield* new InvalidError({ message: outcome.step.detail ?? "Not sent" })
      return apply(message, outcome, key)
    })

    const remove = Effect.fn("OperatorProjectInbox.remove")(function* (id: string) {
      const { message, key } = yield* actionable(id, ["dead letter", "dropped"])
      const file = path.join(OperatorMessageLog.trashFolder(), `${message.id}.json`)
      yield* Effect.promise(async () => {
        await fs.mkdir(OperatorMessageLog.trashFolder(), { recursive: true })
        await fs.writeFile(file, JSON.stringify(message, null, 2) + "\n")
        await OperatorTrashFiles.put({
          kind: "message",
          name: message.body.text.split("\n")[0]!.slice(0, 80) || message.id,
          project: key,
          paths: [file],
        })
      })
      log().remove(message.id)
      GlobalBus.emit("event", {
        directory: key,
        payload: { type: UPDATED, properties: { id: message.id, inbox: message.inbox, status: "deleted" } },
      })
    })

    const inbox = (project: string) => Effect.promise(() => OperatorProjectRecords.inboxOf(project))

    const setRules = Effect.fn("OperatorProjectInbox.setRules")(function* (
      project: string,
      rules: ReadonlyArray<Rules.Rule>,
    ) {
      const problem = Rules.check(rules)
      if (problem) return yield* new InvalidError({ message: problem })
      return yield* Effect.promise(() => OperatorProjectRecords.setInbox(project, { rules: [...rules] }))
    })

    const setUnmatched = (project: string, unmatched: Rules.Unmatched) =>
      Effect.promise(() => OperatorProjectRecords.setInbox(project, { unmatched }))

    const test = Effect.fn("OperatorProjectInbox.test")(function* (
      project: string,
      sample: Sample,
      given?: ReadonlyArray<Rules.Rule>,
    ) {
      const id = yield* Effect.promise(() => projectIdOf(project))
      const saved = yield* inbox(project)
      const rules = given ?? saved.rules
      const message: Message = {
        id: "msg_sample",
        project: sample.fromProject ?? id,
        from: {
          kind: sample.fromKind ?? (sample.fromAgent ? "agent" : "user"),
          project: sample.fromProject ?? id,
          ...(sample.fromAgent ? { agent: sample.fromAgent } : {}),
          ...(sample.fromSession ? { session: sample.fromSession } : {}),
        },
        to: sample.to ?? { type: "inbox" },
        body: { type: sample.type ?? "text", text: sample.text },
        priority: sample.priority ?? "normal",
        steer: false,
        correlationID: sample.correlationID ?? "",
        ...(sample.replyTo ? { replyTo: sample.replyTo } : {}),
        hops: 1,
        status: "queued",
        inbox: id,
        createdAt: Date.now(),
        trail: [],
      }
      const original = originalOf(message, id)
      const rule = Rules.first(rules, { message, project: id, ...(original ? { original } : {}) })
      if (rule)
        return {
          by: "rule",
          rule: { id: rule.id, name: rule.name },
          detail: `${rule.name}: ${rule.action.kind}${rule.action.to?.length ? ` to ${rule.action.to.map((target) => target.id).join(", ")}` : ""}`,
        } satisfies TestResult
      const record = yield* Effect.promise(() => OperatorProjectRecords.get(project))
      if (record.manager)
        return { by: "manager", detail: `No rule matches: to the manager, ${record.manager}` } satisfies TestResult
      const asked = Rules.recipientOf(message)
      if (asked.type !== "none")
        return {
          by: "as addressed",
          detail: `No rule matches, no manager: to the ${asked.type} ${asked.id}`,
        } satisfies TestResult
      if (saved.unmatched === "broadcast")
        return {
          by: "broadcast",
          detail: "No rule matches, no manager, no recipient: to every member",
        } satisfies TestResult
      return {
        by: "dead letter",
        detail: "No rule matches, no manager, no recipient: dead letter",
      } satisfies TestResult
    })

    const messages = (project: string, filter: { status?: OperatorMessage.Status; from?: string; limit?: number }) =>
      Effect.promise(async () => {
        const id = await projectIdOf(project)
        return log().list({ inbox: id, ...filter, limit: filter.limit ?? 200 })
      })

    const conversation = Effect.fn("OperatorProjectInbox.conversation")(function* (correlationID: string) {
      const messages = log().list({ correlationID, limit: 500 }).toReversed()
      const ids = [
        ...new Set(
          messages.flatMap((message) => [message.from.session, message.sessionID].filter((id): id is string => !!id)),
        ),
      ]
      const sessions: Conversation["sessions"][number][] = []
      for (const id of ids) {
        const found = yield* seams.session(id)
        sessions.push({
          id,
          ...(found?.title ? { title: found.title } : {}),
          ...(found?.agent ? { agent: found.agent } : {}),
          ...(found ? { directory: found.directory } : {}),
          exists: !!found,
        })
      }
      return { correlationID, messages, sessions }
    })

    // A message RabbitMQ delivered: routed (once: a redelivery of one already routed is only acknowledged), with
    // its result written to the log before this resolves.
    const arrived: OperatorInboxTransport.Router = (message) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const current = log().get(message.id)
          if (current && current.status !== "queued") return
          const key = yield* Effect.promise(() => projectKeyOf(message.inbox ?? ""))
          if (!key) return yield* Effect.die(new Error(`No project ${message.inbox} here`))
          if (!current) log().write(message)
          const outcome = yield* route(message, key)
          apply(
            message,
            { ...outcome, step: { ...outcome.step, detail: `from RabbitMQ: ${outcome.step.detail ?? ""}` } },
            key,
          )
          log().flush()
        }),
      )
    if (broker)
      yield* Effect.acquireRelease(
        Effect.promise(async () => broker.start(await OperatorMessagePlaces.allIds(), arrived)),
        () => Effect.promise(() => broker.close()),
      )

    return Service.of({
      transport: () => (broker ? { kind: "rabbitmq" as const, ...broker.state() } : { kind: "sqlite" as const }),
      conversation,
      enter,
      messages,
      get,
      record,
      forward,
      drop,
      routeAgain,
      broadcast,
      remove,
      inbox,
      setRules,
      setUnmatched,
      test,
      counts: () => Effect.sync(() => log().counts()),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [InstanceStore.node, OperatorQueue.node, OperatorMessagingSeams.node],
})
